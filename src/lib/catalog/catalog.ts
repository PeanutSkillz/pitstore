// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Loading the app catalog: fetch through the bridge, validate, cache.
// The cache holds validated catalog data only, never user input or secrets.

import { parseComposeYaml, MAX_COMPOSE_BYTES, type ComposeFile } from '../compose/parse';
import { cachePath, readJson, writeJson } from '../storage';
import { detectImage, MAX_IMAGE_BYTES, toDataUrl } from './images';
import { fetchBytes, fetchJson, fetchText } from './source';
import {
    appToIndexEntry, parseIndex, parseMeta, parseSourceUrl, parseStore,
    type AppMeta, type CatalogApp, type RejectedApp, type SourceUrl, type StoreInfo,
} from './validate';

const MAX_STORE_BYTES = 64 * 1024;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_META_BYTES = 256 * 1024;
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CACHE_VERSION = 1;

export interface Catalog {
    source: SourceUrl;
    store: StoreInfo;
    apps: CatalogApp[];
    rejected: RejectedApp[];
    fetchedAt: number;
    // set when a refresh failed and cached data is shown instead
    staleReason: string | null;
}

interface CachedCatalog {
    version: number;
    source: string;
    store: StoreInfo;
    apps: CatalogApp[];
    rejected: RejectedApp[];
    fetchedAt: number;
}

async function sourceKey(source: SourceUrl): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source.href));
    return Array.from(new Uint8Array(digest).slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}

/* Cached entries are re-validated on load: the cache directory is writable by
 * the user and must not become a way around validation.
 */
function revalidate(cached: CachedCatalog | null, source: SourceUrl): CachedCatalog | null {
    if (!cached || cached.version !== CACHE_VERSION || cached.source !== source.href)
        return null;
    try {
        const { apps } = parseIndex({ version: 2, apps: cached.apps.map(appToIndexEntry) });
        return { ...cached, apps };
    } catch {
        return null;
    }
}

export async function loadCatalog(storeUrl: string, refresh = false): Promise<Catalog> {
    const source = parseSourceUrl(storeUrl);
    const file = await cachePath(`catalog-${await sourceKey(source)}.json`);
    const cached = revalidate(await readJson<CachedCatalog>(file), source);

    if (cached && !refresh && Date.now() - cached.fetchedAt < CACHE_MAX_AGE_MS)
        return { ...cached, source, staleReason: null };

    try {
        const store = parseStore(await fetchJson(source, '/store.json', MAX_STORE_BYTES));
        const { apps, rejected } = parseIndex(await fetchJson(source, '/index.json', MAX_INDEX_BYTES));
        const fresh: CachedCatalog = { version: CACHE_VERSION, source: source.href, store, apps, rejected, fetchedAt: Date.now() };
        await writeJson(file, fresh);
        return { ...fresh, source, staleReason: null };
    } catch (e) {
        if (cached)
            return { ...cached, source, staleReason: (e as Error).message };
        throw e;
    }
}

// per-session memory caches; the HTTP layer is the slow part
const metaCache = new Map<string, Promise<AppMeta>>();
const composeCache = new Map<string, Promise<{ text: string; compose: ComposeFile }>>();
const imageCache = new Map<string, Promise<string | null>>();

export function loadMeta(catalog: Catalog, app: CatalogApp): Promise<AppMeta> {
    const key = `${catalog.source.href}|${app.metaPath}|${app.contentHash}`;
    let p = metaCache.get(key);
    if (!p) {
        p = fetchJson(catalog.source, app.metaPath, MAX_META_BYTES).then(data => parseMeta(data, app.id));
        p.catch(() => metaCache.delete(key));
        metaCache.set(key, p);
    }
    return p;
}

export function loadCompose(catalog: Catalog, app: CatalogApp): Promise<{ text: string; compose: ComposeFile }> {
    const key = `${catalog.source.href}|${app.composePath}|${app.contentHash}`;
    let p = composeCache.get(key);
    if (!p) {
        p = fetchText(catalog.source, app.composePath, MAX_COMPOSE_BYTES).then(text => {
            const compose = parseComposeYaml(text);
            if (compose['x-casaos'].id !== app.id)
                throw new Error(`Compose file belongs to ${String(compose['x-casaos'].id)}, not ${app.id}`);
            return { text, compose };
        });
        p.catch(() => composeCache.delete(key));
        composeCache.set(key, p);
    }
    return p;
}

// at most this many image downloads at a time through the bridge
const IMAGE_SLOTS = 8;
let imageSlots = IMAGE_SLOTS;
const imageWaiting: (() => void)[] = [];

async function withImageSlot<T>(task: () => Promise<T>): Promise<T> {
    if (imageSlots === 0)
        await new Promise<void>(resolve => imageWaiting.push(resolve));
    else
        imageSlots--;
    try {
        return await task();
    } finally {
        const next = imageWaiting.shift();
        if (next)
            next();
        else
            imageSlots++;
    }
}

/* Fetch and validate a catalog image; null when it is missing or rejected. */
export function loadImage(source: SourceUrl, path: string | null): Promise<string | null> {
    if (!path)
        return Promise.resolve(null);
    const key = `${source.href}|${path}`;
    let p = imageCache.get(key);
    if (!p) {
        p = withImageSlot(() => fetchBytes(source, path, MAX_IMAGE_BYTES))
                .then(({ bytes, contentType }) => toDataUrl(bytes, detectImage(bytes, contentType)))
                .catch(e => {
                    console.warn(`pitstore: image ${path} rejected:`, (e as Error).message);
                    return null;
                });
        imageCache.set(key, p);
    }
    return p;
}
