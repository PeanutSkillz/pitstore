// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Validation of untrusted catalog documents (store.json, index.json,
// meta.json) of a CasaOS AppStore protocol v2 store. Everything returned
// from here has passed the JSON schemas in schemas/ plus the extra checks
// that JSON schema cannot express.

import {
    validate_index, validate_index_app, validate_meta, validate_store,
    type Validator,
} from './validators.gen.js';

export class CatalogError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CatalogError';
    }
}

export interface SourceUrl {
    host: string;
    port: number;
    // path prefix without trailing slash, "" for the root
    basePath: string;
    // normalized form, e.g. "https://cdn.example.com/store"
    href: string;
}

export interface StoreInfo {
    id: string;
    name: string;
    description: string;
    maintainer: string;
}

export interface CatalogApp {
    id: string;
    title: string;
    tagline: string;
    category: string;
    author: string;
    developer: string;
    architectures: string[];
    icon: string | null;
    thumbnail: string | null;
    composePath: string;
    metaPath: string;
    contentHash: string;
    version: string;
}

export interface RejectedApp {
    id: string;
    reason: string;
}

export interface AppMeta {
    tagline: string;
    description: string;
    screenshots: string[];
    tips: Record<string, string>;
    releaseNote: string;
    updatedAt: string;
    links: { label: string; url: string }[];
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const PATH_RE = /^(?:\/[A-Za-z0-9._~@-]+)*$/;

/* Parse and normalize a store source URL. Only https:// with a DNS host name
 * is accepted: no credentials, query, fragment, IP literals or odd paths.
 */
export function parseSourceUrl(input: string): SourceUrl {
    let url: URL;
    try {
        url = new URL(input.trim());
    } catch {
        throw new CatalogError("The store URL is not a valid URL.");
    }
    if (url.protocol !== 'https:')
        throw new CatalogError("The store URL must start with https://.");
    if (url.username || url.password)
        throw new CatalogError("The store URL must not contain credentials.");
    if (url.search || url.hash)
        throw new CatalogError("The store URL must not contain a query or fragment.");
    const host = url.hostname.toLowerCase();
    if (!HOST_RE.test(host))
        throw new CatalogError("The store URL must use a DNS host name.");
    const basePath = url.pathname.replace(/\/+$/, '');
    if (!PATH_RE.test(basePath) || basePath.split('/').some(seg => seg === '.' || seg === '..'))
        throw new CatalogError("The store URL path contains unsupported characters.");
    const port = url.port ? Number(url.port) : 443;
    const href = `https://${host}${url.port ? ':' + url.port : ''}${basePath}`;
    return { host, port, basePath, href };
}

function check(validator: Validator, data: unknown, what: string): void {
    if (!validator(data)) {
        const e = validator.errors?.[0];
        throw new CatalogError(`${what} is invalid: ${e ? `${e.instancePath || '/'} ${e.message ?? e.keyword}` : 'schema mismatch'}`);
    }
}

function localized(value: unknown, locale: string): string {
    if (typeof value === 'string')
        return value;
    if (value && typeof value === 'object') {
        const map = value as Record<string, string>;
        return map[locale] ?? map.en_US ?? Object.values(map)[0] ?? '';
    }
    return '';
}

/* Store-relative asset path: must live in the app's own directory. */
function appPath(path: unknown, appId: string): string | null {
    if (typeof path !== 'string')
        return null;
    if (!path.startsWith(`/apps/${appId}/`) || path.split('/').some(seg => seg === '.' || seg === '..'))
        return null;
    return path;
}

function httpsUrl(value: unknown): string | null {
    if (typeof value !== 'string' || !value)
        return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch {
        return null;
    }
}

export function parseStore(data: unknown, locale = 'en_US'): StoreInfo {
    check(validate_store, data, "store.json");
    const store = data as Record<string, unknown>;
    return {
        id: String(store.store_id).toLowerCase(),
        name: localized(store.name, locale),
        description: localized(store.description, locale),
        maintainer: typeof store.maintainer === 'string' ? store.maintainer : '',
    };
}

/* Validate index.json. A broken document throws; broken app entries are
 * dropped and reported in `rejected`, so one bad app cannot hide the store.
 */
export function parseIndex(data: unknown): { apps: CatalogApp[]; rejected: RejectedApp[] } {
    check(validate_index, data, "index.json");
    const apps: CatalogApp[] = [];
    const rejected: RejectedApp[] = [];
    const seen = new Set<string>();

    for (const entry of (data as { apps: Record<string, unknown>[] }).apps) {
        const id = typeof entry.id === 'string' ? entry.id.slice(0, 128) : '(no id)';
        if (!validate_index_app(entry)) {
            const e = validate_index_app.errors?.[0];
            rejected.push({ id, reason: e ? `${e.instancePath || '/'} ${e.message ?? e.keyword}` : 'schema mismatch' });
            continue;
        }
        if (seen.has(id)) {
            rejected.push({ id, reason: "duplicate app id" });
            continue;
        }
        const composePath = appPath(entry.compose_url, id);
        const metaPath = appPath(entry.meta_url, id);
        if (!composePath || !metaPath) {
            rejected.push({ id, reason: "compose or meta path outside the app directory" });
            continue;
        }
        seen.add(id);
        apps.push({
            id,
            title: entry.title as string,
            tagline: (entry.tagline as string | undefined) ?? '',
            category: entry.category as string,
            author: (entry.author as string | undefined) ?? '',
            developer: (entry.developer as string | undefined) ?? '',
            architectures: (entry.architectures as string[] | undefined) ?? [],
            icon: appPath(entry.icon, id),
            thumbnail: appPath(entry.thumbnail, id),
            composePath,
            metaPath,
            contentHash: entry.content_hash as string,
            version: (entry.version as string | undefined) ?? '',
        });
    }
    return { apps, rejected };
}

/* The index.json form of a validated app, used to re-validate cached data. */
export function appToIndexEntry(app: CatalogApp): Record<string, unknown> {
    return {
        id: app.id,
        title: app.title,
        tagline: app.tagline,
        category: app.category,
        author: app.author,
        developer: app.developer,
        architectures: app.architectures,
        ...(app.icon ? { icon: app.icon } : {}),
        ...(app.thumbnail ? { thumbnail: app.thumbnail } : {}),
        compose_url: app.composePath,
        meta_url: app.metaPath,
        content_hash: app.contentHash,
        ...(app.version ? { version: app.version } : {}),
    };
}

/* Tips are usually {before_install: text}; some catalog entries put the
 * locales directly in the object, of which only en_US is kept.
 */
function tipsOf(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object')
        return {};
    return Object.fromEntries(Object.entries(value as Record<string, string>)
            .filter(([key]) => key === 'en_US' || !/^[a-z]{2}_[A-Z]{2}$/.test(key)));
}

const LINK_FIELDS: [string, string][] = [
    ['website', 'Website'], ['repo', 'Source code'], ['support', 'Support'], ['docs', 'Documentation'],
];

export function parseMeta(data: unknown, appId: string): AppMeta {
    check(validate_meta, data, "meta.json");
    const meta = data as Record<string, unknown>;
    const links = [];
    for (const [field, label] of LINK_FIELDS) {
        const url = httpsUrl(meta[field]);
        if (url)
            links.push({ label, url });
    }
    return {
        tagline: (meta.tagline as string | undefined) ?? '',
        description: (meta.description as string | undefined) ?? '',
        screenshots: ((meta.screenshot_link as string[] | undefined) ?? [])
                .map(p => appPath(p, appId))
                .filter((p): p is string => p !== null),
        tips: tipsOf(meta.tips),
        releaseNote: (meta.release_note as string | undefined) ?? '',
        updatedAt: (meta.update_at as string | undefined) ?? '',
        links,
    };
}
