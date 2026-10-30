// SPDX-License-Identifier: LGPL-2.1-or-later

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from '@patternfly/react-core/dist/esm/components/Button/index.js';
import { Card, CardBody, CardHeader, CardTitle } from '@patternfly/react-core/dist/esm/components/Card/index.js';
import { Content } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import { EmptyState, EmptyStateBody } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { ExpandableSection } from '@patternfly/react-core/dist/esm/components/ExpandableSection/index.js';
import { FormSelect, FormSelectOption } from '@patternfly/react-core/dist/esm/components/FormSelect/index.js';
import { Gallery } from '@patternfly/react-core/dist/esm/layouts/Gallery/index.js';
import { Label } from '@patternfly/react-core/dist/esm/components/Label/index.js';
import { Page, PageSection } from '@patternfly/react-core/dist/esm/components/Page/index.js';
import { SearchInput } from '@patternfly/react-core/dist/esm/components/SearchInput/index.js';
import { Spinner } from '@patternfly/react-core/dist/esm/components/Spinner/index.js';
import { Toolbar, ToolbarContent, ToolbarItem } from '@patternfly/react-core/dist/esm/components/Toolbar/index.js';
import { CatalogIcon } from '@patternfly/react-icons/dist/esm/icons/catalog-icon.js';
import { SearchIcon } from '@patternfly/react-icons/dist/esm/icons/search-icon.js';

import cockpit from 'cockpit';

import { AppDetailsModal } from '../components/AppDetailsModal';
import { AppIcon } from '../components/AppIcon';
import { SourceSettingsModal } from '../components/SourceSettingsModal';
import { adminAllowed, dockerAvailable, listInstalled, type InstalledApp } from '../lib/apps';
import { loadCatalog, type Catalog } from '../lib/catalog/catalog';
import { mergeCatalogs, type Listing as MergedListing } from '../lib/catalog/merge';
import type { Backend } from '../lib/install';
import { loadSettings, presetFor, type Settings } from '../lib/settings';

const _ = cockpit.gettext;

type Listing = MergedListing<Catalog>;

function sourceName(catalog: Catalog): string {
    const preset = presetFor(catalog.source.href);
    return preset ? _(preset.name) : catalog.store.name || catalog.source.host;
}

const AppCard = ({ listing, installed, showSource, onOpen }: {
    listing: Listing; installed: InstalledApp | undefined; showSource: boolean; onOpen: () => void;
}) => {
    const { app, catalog } = listing.primary;
    return (
        <Card isCompact isClickable className="pitstore-app-card" id={`app-${app.id}`}>
            <CardHeader selectableActions={{ onClickAction: onOpen, selectableActionAriaLabelledby: `app-title-${app.id}` }}>
                <div className="pitstore-app-card-header">
                    <AppIcon source={catalog.source} path={app.icon} />
                    <CardTitle id={`app-title-${app.id}`}>{app.title}</CardTitle>
                </div>
            </CardHeader>
            <CardBody>
                <Content component="p" className="pitstore-app-card-tagline">{app.tagline}</Content>
                <Label isCompact>{app.category}</Label>
                {installed && <Label isCompact color="green" className="pitstore-installed">{installed.app.contentHash !== app.contentHash ? _("Update available") : _("Installed")}</Label>}
                {showSource && (
                    <Content component="small" className="pitstore-app-source">
                        {listing.offers.length > 1
                            ? cockpit.format(_("$0 · also in $1 more"), sourceName(catalog), listing.offers.length - 1)
                            : sourceName(catalog)}
                    </Content>
                )}
            </CardBody>
        </Card>
    );
};

export const AppstorePage = () => {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [catalogs, setCatalogs] = useState<Catalog[]>([]);
    const [sourceErrors, setSourceErrors] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [category, setCategory] = useState('');
    const [sourceFilter, setSourceFilter] = useState('');
    // the listing whose details are open, and which of its offers is shown
    const [selected, setSelected] = useState<{ listing: Listing; offer: number } | null>(null);
    const [editSource, setEditSource] = useState(false);
    const [installed, setInstalled] = useState<InstalledApp[]>([]);
    const [installedErrors, setInstalledErrors] = useState<string[]>([]);

    const loadInstalled = useCallback(async () => {
        const [admin, docker] = await Promise.all([adminAllowed(), dockerAvailable()]);
        const backends: Backend[] = ['podman-user'];
        if (admin)
            backends.push('podman-system');
        if (admin && docker)
            backends.push('docker');
        const r = await listInstalled(backends);
        setInstalled(r.apps);
        setInstalledErrors(r.errors);
    }, []);

    useEffect(() => { loadInstalled() }, [loadInstalled]);

    const load = useCallback((s: Settings, refresh: boolean) => {
        setLoading(true);
        setError(null);
        Promise.allSettled(s.sources.map(url => loadCatalog(url, refresh))).then(results => {
            const ok: Catalog[] = [];
            const errors: string[] = [];
            results.forEach((r, i) => {
                if (r.status === 'fulfilled')
                    ok.push(r.value);
                else
                    errors.push(`${s.sources[i]}: ${(r.reason as Error).message}`);
            });
            setCatalogs(ok);
            setSourceErrors(errors);
            if (ok.length === 0)
                setError(errors.join('; ') || _("No catalog is configured"));
            setLoading(false);
        });
    }, []);

    useEffect(() => {
        loadSettings()
                .then(s => { setSettings(s); load(s, false) })
                .catch(e => { setError((e as Error).message); setLoading(false) });
    }, [load]);

    const listings = useMemo(
        () => mergeCatalogs(catalogs, new Set(installed.map(i => i.id))),
        [catalogs, installed]);

    const categories = useMemo(
        () => [...new Set(catalogs.flatMap(c => c.apps.map(a => a.category)))].sort(),
        [catalogs]);

    const visible = useMemo(() => {
        const q = search.trim().toLowerCase();
        return listings
                // with a source filter, show that catalog's offer of each app
                .map(l => {
                    if (!sourceFilter)
                        return l;
                    const offer = l.offers.find(o => o.catalog.source.href === sourceFilter);
                    return offer ? { ...l, primary: offer } : null;
                })
                .filter((l): l is Listing => l !== null)
                .filter(l => !category || l.primary.app.category === category)
                .filter(l => !q || l.offers.some(({ app: a }) =>
                    [a.title, a.tagline, a.developer, a.id].some(f => f.toLowerCase().includes(q))))
                .sort((a, b) => a.primary.app.title.localeCompare(b.primary.app.title));
    }, [listings, search, category, sourceFilter]);

    const total = listings.length;
    const rejected = catalogs.flatMap(c => c.rejected.map(r => ({ ...r, source: sourceName(c) })));
    const offer = selected ? selected.listing.offers[selected.offer] : null;

    return (
        <Page className='pf-m-no-sidebar no-masthead-sidebar'>
            <PageSection>
                <Content component="h1">{_("Appstore")}</Content>
                {catalogs.length > 0 && (
                    <Content component="small">
                        {catalogs.length === 1
                            ? cockpit.format(_("$0 · $1 apps"), sourceName(catalogs[0]), total)
                            : cockpit.format(_("$0 apps from $1 catalogs"), total, catalogs.length)}
                    </Content>
                )}
            </PageSection>
            <PageSection>
                <Toolbar>
                    <ToolbarContent>
                        <ToolbarItem>
                            <SearchInput
                                placeholder={_("Search apps")}
                                value={search}
                                onChange={(_event, value) => setSearch(value)}
                                onClear={() => setSearch('')}
                                aria-label={_("Search apps")}
                            />
                        </ToolbarItem>
                        <ToolbarItem>
                            <FormSelect
                                value={category}
                                onChange={(_event, value) => setCategory(value)}
                                aria-label={_("Category")}
                            >
                                <FormSelectOption value="" label={_("All categories")} />
                                {categories.map(c => <FormSelectOption key={c} value={c} label={c} />)}
                            </FormSelect>
                        </ToolbarItem>
                        {catalogs.length > 1 && (
                            <ToolbarItem>
                                <FormSelect
                                    id="pitstore-source-filter"
                                    value={sourceFilter}
                                    onChange={(_event, value) => setSourceFilter(value)}
                                    aria-label={_("Catalog")}
                                >
                                    <FormSelectOption value="" label={_("All catalogs")} />
                                    {catalogs.map(c => <FormSelectOption key={c.source.href} value={c.source.href} label={sourceName(c)} />)}
                                </FormSelect>
                            </ToolbarItem>
                        )}
                        <ToolbarItem>
                            <Button
variant="secondary" isDisabled={!settings || loading}
                                    onClick={() => settings && load(settings, true)}
                            >
                                {_("Refresh")}
                            </Button>
                        </ToolbarItem>
                        <ToolbarItem>
                            <Button variant="link" isDisabled={!settings} onClick={() => setEditSource(true)}>
                                {_("Catalogs")}
                            </Button>
                        </ToolbarItem>
                    </ToolbarContent>
                </Toolbar>

                {catalogs.filter(c => c.staleReason).map(c => (
                    <Alert key={c.source.href} variant="warning" isInline title={cockpit.format(_("$0: showing the cached catalog; refreshing failed"), sourceName(c))}>
                        {c.staleReason}
                    </Alert>
                ))}
                {catalogs.length > 0 && sourceErrors.map(e => (
                    <Alert key={e} variant="warning" isInline title={_("A catalog could not be loaded")}>{e}</Alert>
                ))}
                {installedErrors.map(e => <Alert key={e} variant="warning" isInline title={_("Installed apps could not be listed")}>{e}</Alert>)}
                {rejected.length > 0 && (
                    <ExpandableSection toggleText={cockpit.format(_("$0 catalog entries were invalid and are hidden"), rejected.length)}>
                        <ul>
                            {rejected.map((r, i) => <li key={i}>{r.source}: <code>{r.id}</code>: {r.reason}</li>)}
                        </ul>
                    </ExpandableSection>
                )}

                {loading && catalogs.length === 0 && <EmptyState headingLevel="h2" titleText={_("Loading catalog")} icon={Spinner} />}
                {error && catalogs.length === 0 && (
                    <EmptyState headingLevel="h2" titleText={_("The catalog could not be loaded")} icon={CatalogIcon} status="danger">
                        <EmptyStateBody>{error}</EmptyStateBody>
                    </EmptyState>
                )}
                {catalogs.length > 0 && visible.length === 0 && (
                    <EmptyState headingLevel="h2" titleText={_("No matching apps")} icon={SearchIcon} />
                )}
                {visible.length > 0 && (
                    <Gallery hasGutter minWidths={{ default: '240px' }} className="pitstore-gallery">
                        {visible.map(l => (
                            <AppCard
key={l.primary.app.id} listing={l} showSource={catalogs.length > 1}
                                     installed={installed.find(i => i.id === l.primary.app.id)}
                                     onOpen={() => setSelected({ listing: l, offer: l.offers.indexOf(l.primary) })}
                            />
                        ))}
                    </Gallery>
                )}
            </PageSection>

            {selected && offer && (
                <AppDetailsModal
                    key={offer.app.id}
                    catalog={offer.catalog} app={offer.app} onClose={() => setSelected(null)}
                    installed={installed.find(i => i.id === offer.app.id) ?? null}
                    onChanged={() => { loadInstalled() }}
                    offers={selected.listing.offers.length > 1
                        ? {
                            names: selected.listing.offers.map(o => sourceName(o.catalog)),
                            current: selected.offer,
                            installed: selected.listing.offers.map(o => installed.some(i => i.id === o.app.id)),
                            onSelect: i => setSelected({ ...selected, offer: i }),
                        }
                        : undefined}
                />
            )}
            {settings && editSource && (
                <SourceSettingsModal
                    settings={settings}
                    onClose={() => setEditSource(false)}
                    onSaved={s => { setSettings(s); setEditSource(false); setSourceFilter(''); load(s, false) }}
                />
            )}
        </Page>
    );
};
