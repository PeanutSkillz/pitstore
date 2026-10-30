// SPDX-License-Identifier: LGPL-2.1-or-later

import { parseSourceUrl } from './catalog/validate';
import { configPath, readJson, writeJson } from './storage';

export const DEFAULT_STORE_URL = 'https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@gh-pages';

export interface Settings {
    storeUrl: string;
}

export async function loadSettings(): Promise<Settings> {
    const data = await readJson<Partial<Settings>>(await configPath('settings.json'));
    let storeUrl = DEFAULT_STORE_URL;
    if (data && typeof data.storeUrl === 'string') {
        try {
            storeUrl = parseSourceUrl(data.storeUrl).href;
        } catch {
            // an invalid stored URL falls back to the default
        }
    }
    return { storeUrl };
}

/* Throws a CatalogError when the URL is not acceptable. */
export async function saveSettings(settings: Settings): Promise<Settings> {
    const normalized = { storeUrl: parseSourceUrl(settings.storeUrl).href };
    await writeJson(await configPath('settings.json'), normalized);
    return normalized;
}
