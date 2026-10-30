// SPDX-License-Identifier: LGPL-2.1-or-later
//
// One overview of several catalogs. App ids never collide between catalogs
// (each uses its own namespace), but the same app is often offered by more
// than one of them; those entries are grouped by their normalized title into
// one listing with the other offers as alternatives.

import type { CatalogApp } from './validate';

export interface Offer<C> {
    app: CatalogApp;
    catalog: C;
}

export interface Listing<C> {
    // the offer shown: the installed one, else the one from the first catalog
    primary: Offer<C>;
    // every offer of this app, in catalog order (primary included)
    offers: Offer<C>[];
}

/* "Airsonic advanced (LinuxServer.io)" and "Airsonic Advanced" are one app:
 * a trailing note in parentheses is ignored, as are case and punctuation. */
export function titleKey(title: string): string {
    return title.replace(/\s*\([^()]*\)\s*$/u, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/* catalogs: in priority order. installed: ids of installed apps. */
export function mergeCatalogs<C extends { apps: CatalogApp[] }>(catalogs: C[], installed: ReadonlySet<string>): Listing<C>[] {
    const byKey = new Map<string, Offer<C>[][]>();
    const order: Offer<C>[][] = [];
    for (const catalog of catalogs) {
        for (const app of catalog.apps) {
            const key = titleKey(app.title) || app.id;
            const groups = byKey.get(key) ?? [];
            // one offer per catalog in a group; a catalog listing the same title
            // twice keeps both as separate listings
            let group = groups.find(g => !g.some(o => o.catalog === catalog));
            if (!group) {
                group = [];
                groups.push(group);
                order.push(group);
                byKey.set(key, groups);
            }
            group.push({ app, catalog });
        }
    }
    return order.map(offers => ({
        primary: offers.find(o => installed.has(o.app.id)) ?? offers[0],
        offers,
    }));
}
