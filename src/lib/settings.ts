// SPDX-License-Identifier: LGPL-2.1-or-later

import { parseSourceUrl } from './catalog/validate';
import { configPath, readJson, writeJson } from './storage';

export const DEFAULT_STORE_URL = 'https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@gh-pages';

/* Known catalogs in the same format (protocol v2, verified 2026-10-30). The
 * order is the priority when an app is offered by several of them. */
export const PRESET_SOURCES: { url: string; name: string; description: string }[] = [
    {
        url: DEFAULT_STORE_URL,
        name: 'Default catalog',
        description: 'The reference catalog of the app format (IceWhaleTech, Apache-2.0).',
    },
    {
        url: 'https://cdn.jsdelivr.net/gh/WisdomSky/LinuxServer-AppStore@gh-pages',
        name: 'LinuxServer.io apps',
        description: 'Community catalog of LinuxServer.io images (WisdomSky, GPL-3.0).',
    },
    {
        url: 'https://cdn.jsdelivr.net/gh/bigbeartechworld/big-bear-casaos@gh-pages',
        name: 'Big Bear',
        description: 'Large community catalog (BigBearTechWorld, MIT).',
    },
    {
        url: 'https://cdn.jsdelivr.net/gh/WisdomSky/CasaOS-Coolstore@gh-pages',
        name: 'Coolstore',
        description: 'Community catalog (WisdomSky, no license stated).',
    },
];

export const MAX_SOURCES = 10;

export interface Settings {
    // enabled catalog URLs in priority order: presets and custom ones
    sources: string[];
}

function normalize(urls: unknown[]): string[] {
    const out: string[] = [];
    for (const u of urls) {
        if (typeof u !== 'string')
            continue;
        try {
            const href = parseSourceUrl(u).href;
            if (!out.includes(href))
                out.push(href);
        } catch {
            // an invalid stored URL is dropped
        }
    }
    return out.slice(0, MAX_SOURCES);
}

export function defaultSettings(): Settings {
    return { sources: PRESET_SOURCES.map(p => parseSourceUrl(p.url).href) };
}

export async function loadSettings(): Promise<Settings> {
    const data = await readJson<{ sources?: unknown; storeUrl?: unknown }>(await configPath('settings.json'));
    if (data && Array.isArray(data.sources)) {
        const sources = normalize(data.sources);
        return sources.length > 0 ? { sources } : defaultSettings();
    }
    // settings of 0.1.0 pre-releases had one URL; a custom one stays first
    if (data && typeof data.storeUrl === 'string') {
        const custom = normalize([data.storeUrl]);
        if (custom.length > 0 && custom[0] !== parseSourceUrl(DEFAULT_STORE_URL).href)
            return { sources: normalize([...custom, ...defaultSettings().sources]) };
    }
    return defaultSettings();
}

/* Throws a CatalogError when a URL is not acceptable. */
export async function saveSettings(settings: Settings): Promise<Settings> {
    for (const u of settings.sources)
        parseSourceUrl(u);
    const normalized = { sources: normalize(settings.sources) };
    if (normalized.sources.length === 0)
        throw new Error('Choose at least one catalog');
    await writeJson(await configPath('settings.json'), normalized);
    return normalized;
}

export function presetFor(url: string) {
    return PRESET_SOURCES.find(p => parseSourceUrl(p.url).href === url) ?? null;
}
