// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Settings of an installed app, opened from its dashboard tile: what it runs
// with now, changing its settings (an update with the current values filled
// in) and removing or releasing it.

import React, { useEffect, useState } from 'react';
import { Alert } from '@patternfly/react-core/dist/esm/components/Alert/index.js';
import { Button } from '@patternfly/react-core/dist/esm/components/Button/index.js';
import {
    DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm,
} from '@patternfly/react-core/dist/esm/components/DescriptionList/index.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal/index.js';
import { Spinner } from '@patternfly/react-core/dist/esm/components/Spinner/index.js';

import cockpit from 'cockpit';

import { BACKENDS, callHelper, type InstalledApp } from '../lib/apps';
import { loadCatalog, loadCompose, type Catalog } from '../lib/catalog/catalog';
import type { CatalogApp } from '../lib/catalog/validate';
import type { ComposeFile } from '../lib/compose/parse';
import { summarizeCompose, type ComposeSummary } from '../lib/compose/summary';
import { RemoveDialog } from './AppDetailsModal';
import { InstallDialog } from './InstallDialog';

const _ = cockpit.gettext;

interface Plan {
    compose?: ComposeFile;
    ports?: [number, string][];
}

interface CatalogSource {
    catalog: Catalog;
    app: CatalogApp;
    text: string;
    compose: ComposeFile;
}

export const AppSettingsDialog = ({ app, onClose, onRelease, onChanged }: {
    app: InstalledApp;
    onClose: () => void;
    onRelease: () => void;
    onChanged: () => void;
}) => {
    const title = app.app.title || app.id;
    const [summary, setSummary] = useState<ComposeSummary | null>(null);
    const [ports, setPorts] = useState<string[]>([]);
    const [dataDir, setDataDir] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [planError, setPlanError] = useState<string | null>(null);
    const [source, setSource] = useState<CatalogSource | null>(null);
    // why the settings cannot be changed, once that is known
    const [noChange, setNoChange] = useState<string | null>(null);
    const [dialog, setDialog] = useState<'change' | 'remove' | null>(null);

    useEffect(() => {
        let alive = true;
        callHelper<{ plan: Plan; dataDir: string }>(app.backend, 'get', { appId: app.id })
                .then(r => {
                    if (!alive)
                        return;
                    setDataDir(r.dataDir);
                    setLoaded(true);
                    if (r.plan.compose)
                        setSummary(summarizeCompose(r.plan.compose));
                    else
                        setPorts((r.plan.ports ?? []).map(([port, protocol]) => `${port}/${protocol}`));
                })
                .catch(e => { if (alive) setPlanError((e as Error).message); });

        if (app.adopted) {
            setNoChange(_("This app was taken over, not installed from the catalog, so its settings cannot be changed here."));
        } else if (!app.app.store) {
            setNoChange(_("PitStore does not know which catalog this app came from."));
        } else {
            loadCatalog(app.app.store)
                    .then(async catalog => {
                        const entry = catalog.apps.find(a => a.id === app.id);
                        if (!entry)
                            throw new Error(_("The app is no longer in its catalog, so its settings cannot be changed here."));
                        const src = await loadCompose(catalog, entry);
                        if (alive)
                            setSource({ catalog, app: entry, ...src });
                    })
                    .catch(e => { if (alive) setNoChange((e as Error).message); });
        }
        return () => { alive = false };
    }, [app]);

    const backend = BACKENDS.find(b => b.id === app.backend)?.label ?? app.backend;

    return (
        <Modal isOpen variant="medium" onClose={onClose} aria-labelledby="pitstore-settings-title">
            <ModalHeader title={cockpit.format(_("Settings of $0"), title)} labelId="pitstore-settings-title" />
            <ModalBody>
                {planError && <Alert variant="danger" isInline title={_("The settings could not be read")}>{planError}</Alert>}
                {!loaded && !planError && <Spinner size="lg" />}
                {loaded && (
                    <DescriptionList isHorizontal isCompact className="pitstore-compose-summary">
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Runs with")}</DescriptionListTerm>
                            <DescriptionListDescription>{backend}</DescriptionListDescription>
                        </DescriptionListGroup>
                        {app.app.version && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Version")}</DescriptionListTerm>
                                <DescriptionListDescription>{app.app.version}</DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Published ports")}</DescriptionListTerm>
                            <DescriptionListDescription>
                                {summary
                                    ? (summary.ports.length === 0
                                        ? _("none")
                                        : summary.ports.map((p, i) => (
                                            <div key={i}>{p.published || _("(random)")} → {p.target}/{p.protocol} ({p.service})</div>
                                        )))
                                    : (ports.length === 0 ? _("none") : ports.join(', '))}
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                        {summary && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Storage")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {summary.mounts.filter(m => m.type !== 'tmpfs').length === 0
                                        ? _("none")
                                        : summary.mounts.filter(m => m.type !== 'tmpfs').map((m, i) => (
                                            <div key={i}>
                                                {m.type === 'bind' ? <code>{m.source}</code> : _("volume")}
                                                {' → '}<code>{m.target}</code> ({m.service})
                                            </div>
                                        ))}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        {summary && summary.secretEnv.length > 0 && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Credentials")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {summary.secretEnv.map(s => <code key={s.service + s.key}>{s.key} </code>)}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        {dataDir && !app.adopted && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Data folder")}</DescriptionListTerm>
                                <DescriptionListDescription><code>{dataDir}</code></DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                    </DescriptionList>
                )}
                {noChange && <Alert variant="info" isInline isPlain title={noChange} className="pitstore-section-title" />}
            </ModalBody>
            <ModalFooter>
                {!app.adopted && (
                    <Button variant="primary" isDisabled={!source} isLoading={!source && !noChange} onClick={() => setDialog('change')}>
                        {_("Change settings…")}
                    </Button>
                )}
                {app.adopted === 'in-place'
                    ? <Button variant="secondary" onClick={onRelease}>{_("Release…")}</Button>
                    : <Button variant="danger" onClick={() => setDialog('remove')}>{_("Remove…")}</Button>}
                <Button variant="link" onClick={onClose}>{_("Close")}</Button>
            </ModalFooter>
            {dialog === 'change' && source && (
                <InstallDialog
catalog={source.catalog} app={source.app} compose={source.compose} composeText={source.text}
                               installed={app} settings onClose={() => setDialog(null)}
                               onDone={() => { setDialog(null); onChanged() }}
                />
            )}
            {dialog === 'remove' && (
                <RemoveDialog
title={title} installed={app} onClose={() => setDialog(null)}
                              onDone={() => { setDialog(null); onChanged() }}
                />
            )}
        </Modal>
    );
};
