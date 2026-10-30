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
import type { Backend } from '../lib/install';
import type { CatalogApp } from '../lib/catalog/validate';
import { loadSettings, type Settings } from '../lib/settings';

const _ = cockpit.gettext;

const AppCard = ({ catalog, app, installed, onOpen }: {
    catalog: Catalog; app: CatalogApp; installed: InstalledApp | undefined; onOpen: () => void;
}) => (
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
        </CardBody>
    </Card>
);

export const AppstorePage = () => {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [catalog, setCatalog] = useState<Catalog | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [category, setCategory] = useState('');
    const [selected, setSelected] = useState<CatalogApp | null>(null);
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
        loadCatalog(s.storeUrl, refresh)
                .then(c => setCatalog(c))
                .catch(e => { setCatalog(null); setError((e as Error).message) })
                .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        loadSettings()
                .then(s => { setSettings(s); load(s, false) })
                .catch(e => { setError((e as Error).message); setLoading(false) });
    }, [load]);

    const categories = useMemo(
        () => [...new Set(catalog?.apps.map(a => a.category) ?? [])].sort(),
        [catalog]);

    const visible = useMemo(() => {
        const q = search.trim().toLowerCase();
        return (catalog?.apps ?? [])
                .filter(a => !category || a.category === category)
                .filter(a => !q || [a.title, a.tagline, a.developer, a.id].some(f => f.toLowerCase().includes(q)))
                .sort((a, b) => a.title.localeCompare(b.title));
    }, [catalog, search, category]);

    return (
        <Page className='pf-m-no-sidebar'>
            <PageSection>
                <Content component="h1">{_("Appstore")}</Content>
                {catalog && (
                    <Content component="small">
                        {cockpit.format(_("$0 · $1 apps"), catalog.source.host, catalog.apps.length)}
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
                                {_("Catalog source")}
                            </Button>
                        </ToolbarItem>
                    </ToolbarContent>
                </Toolbar>

                {catalog?.staleReason && (
                    <Alert variant="warning" isInline title={_("Showing the cached catalog; refreshing failed")}>
                        {catalog.staleReason}
                    </Alert>
                )}
                {installedErrors.map(e => <Alert key={e} variant="warning" isInline title={_("Installed apps could not be listed")}>{e}</Alert>)}
                {catalog && catalog.rejected.length > 0 && (
                    <ExpandableSection toggleText={cockpit.format(_("$0 catalog entries were invalid and are hidden"), catalog.rejected.length)}>
                        <ul>
                            {catalog.rejected.map((r, i) => <li key={i}><code>{r.id}</code>: {r.reason}</li>)}
                        </ul>
                    </ExpandableSection>
                )}

                {loading && !catalog && <EmptyState headingLevel="h2" titleText={_("Loading catalog")} icon={Spinner} />}
                {error && !catalog && (
                    <EmptyState headingLevel="h2" titleText={_("The catalog could not be loaded")} icon={CatalogIcon} status="danger">
                        <EmptyStateBody>{error}</EmptyStateBody>
                    </EmptyState>
                )}
                {catalog && visible.length === 0 && (
                    <EmptyState headingLevel="h2" titleText={_("No matching apps")} icon={SearchIcon} />
                )}
                {catalog && visible.length > 0 && (
                    <Gallery hasGutter minWidths={{ default: '240px' }} className="pitstore-gallery">
                        {visible.map(app => (
                            <AppCard
key={app.id} catalog={catalog} app={app} onOpen={() => setSelected(app)}
                                     installed={installed.find(i => i.id === app.id)}
                            />
                        ))}
                    </Gallery>
                )}
            </PageSection>

            {catalog && selected && (
                <AppDetailsModal
catalog={catalog} app={selected} onClose={() => setSelected(null)}
                                 installed={installed.find(i => i.id === selected.id) ?? null}
                                 onChanged={() => { loadInstalled() }}
                />
            )}
            {settings && editSource && (
                <SourceSettingsModal
                    settings={settings}
                    onClose={() => setEditSource(false)}
                    onSaved={s => { setSettings(s); setEditSource(false); load(s, true) }}
                />
            )}
        </Page>
    );
};
