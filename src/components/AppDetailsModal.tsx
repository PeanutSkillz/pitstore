// SPDX-License-Identifier: LGPL-2.1-or-later

import React, { useEffect, useMemo, useState } from 'react';
import { Alert } from '@patternfly/react-core/dist/esm/components/Alert/index.js';
import { Button } from '@patternfly/react-core/dist/esm/components/Button/index.js';
import { Checkbox } from '@patternfly/react-core/dist/esm/components/Checkbox/index.js';
import { Content } from '@patternfly/react-core/dist/esm/components/Content/index.js';
import {
    DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm,
} from '@patternfly/react-core/dist/esm/components/DescriptionList/index.js';
import { Label } from '@patternfly/react-core/dist/esm/components/Label/index.js';
import { List, ListItem } from '@patternfly/react-core/dist/esm/components/List/index.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal/index.js';
import { Spinner } from '@patternfly/react-core/dist/esm/components/Spinner/index.js';
import { Title } from '@patternfly/react-core/dist/esm/components/Title/index.js';

import cockpit from 'cockpit';

import { appState, appUrl, callHelper, type InstalledApp } from '../lib/apps';
import { loadCompose, loadImage, loadMeta, type Catalog } from '../lib/catalog/catalog';
import type { AppMeta, CatalogApp } from '../lib/catalog/validate';
import { catalogVariables, interpolateCompose } from '../lib/compose/interpolate';
import type { ComposeFile } from '../lib/compose/parse';
import { summarizeCompose, type ComposeSummary } from '../lib/compose/summary';
import { evaluatePolicy, FINDING_WARNINGS, type PolicyResult } from '../lib/policy';
import { AppIcon } from './AppIcon';
import { InstallDialog } from './InstallDialog';
import { Markdown } from './Markdown';

const _ = cockpit.gettext;

interface Analysis {
    summary: ComposeSummary;
    policy: PolicyResult;
    userVariables: string[];
}

function analyze(app: CatalogApp, compose: Parameters<typeof interpolateCompose>[0]): Analysis {
    // preview values; real values are chosen and validated at install time
    const vars = catalogVariables({
        appId: app.id, puid: 1000, pgid: 1000, tz: 'UTC', defaultPassword: 'generated-at-install',
    });
    const missing = new Set<string>();
    const resolved = interpolateCompose(compose, vars, missing);
    return {
        summary: summarizeCompose(resolved),
        policy: evaluatePolicy(resolved),
        userVariables: [...missing].sort(),
    };
}

const Screenshots = ({ catalog, paths }: { catalog: Catalog; paths: string[] }) => {
    const [urls, setUrls] = useState<string[]>([]);
    useEffect(() => {
        let alive = true;
        Promise.all(paths.slice(0, 5).map(p => loadImage(catalog.source, p))).then(list => {
            if (alive)
                setUrls(list.filter((u): u is string => u !== null));
        });
        return () => { alive = false };
    }, [catalog, paths]);
    if (urls.length === 0)
        return null;
    return (
        <div className="pitstore-screenshots">
            {urls.map((u, i) => <img key={i} src={u} alt={cockpit.format(_("Screenshot $0"), i + 1)} />)}
        </div>
    );
};

const SecurityReview = ({ policy }: { policy: PolicyResult }) => {
    if (policy.unsupported.length > 0) {
        return (
            <Alert variant="danger" isInline title={_("This app cannot be installed by PitStore")}>
                <List>
                    {policy.unsupported.map(u => <ListItem key={u.path}><code>{u.path}</code>: {u.reason}</ListItem>)}
                </List>
            </Alert>
        );
    }
    if (policy.findings.length > 0) {
        return (
            <Alert variant="warning" isInline title={_("This app asks for risky permissions")}>
                <p>{_("These options are blocked by default. Installing the app requires your explicit confirmation of each one.")}</p>
                <List>
                    {policy.findings.map(f => (
                        <ListItem key={f.key}>
                            <strong>{f.service}</strong>: <code>{f.detail ? `${f.kind} ${f.detail}` : f.kind}</code>
                            {' '}{FINDING_WARNINGS[f.kind]}
                        </ListItem>
                    ))}
                </List>
            </Alert>
        );
    }
    return <Alert variant="success" isInline title={_("No risky options found")} />;
};

const RemoveDialog = ({ app, installed, onClose, onDone }: {
    app: CatalogApp; installed: InstalledApp; onClose: () => void; onDone: () => void;
}) => {
    const [deleteData, setDeleteData] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const remove = () => {
        setBusy(true);
        callHelper(installed.backend, 'remove', { appId: app.id, deleteData })
                .then(onDone)
                .catch(e => { setError((e as Error).message); setBusy(false) });
    };
    return (
        <Modal isOpen variant="small" onClose={busy ? undefined : onClose} aria-labelledby="pitstore-remove-title">
            <ModalHeader title={cockpit.format(_("Remove $0?"), app.title)} labelId="pitstore-remove-title" titleIconVariant="warning" />
            <ModalBody>
                <p>{_("The app's containers are removed. Its data is kept unless you choose otherwise.")}</p>
                <Checkbox
id="pitstore-delete-data" isChecked={deleteData} onChange={(_e, v) => setDeleteData(v)}
                          label={_("Also delete the app's data")}
                          description={_("Deletes the app's own data directory and volumes. This cannot be undone.")}
                />
                {error && <Alert variant="danger" isInline title={_("Removing failed")}>{error}</Alert>}
            </ModalBody>
            <ModalFooter>
                <Button variant="danger" onClick={remove} isLoading={busy} isDisabled={busy}>{_("Remove")}</Button>
                <Button variant="link" onClick={onClose} isDisabled={busy}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

export const AppDetailsModal = ({ catalog, app, installed, onClose, onChanged }: {
    catalog: Catalog;
    app: CatalogApp;
    installed: InstalledApp | null;
    onClose: () => void;
    onChanged: () => void;
}) => {
    const [source, setSource] = useState<{ text: string; compose: ComposeFile } | null>(null);
    const [dialog, setDialog] = useState<'install' | 'remove' | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [meta, setMeta] = useState<AppMeta | null>(null);
    const [metaError, setMetaError] = useState<string | null>(null);
    const [analysis, setAnalysis] = useState<Analysis | null>(null);
    const [composeError, setComposeError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        loadMeta(catalog, app)
                .then(m => { if (alive) setMeta(m); })
                .catch(e => { if (alive) setMetaError((e as Error).message); });
        loadCompose(catalog, app)
                .then(src => { if (alive) { setSource(src); setAnalysis(analyze(app, src.compose)) } })
                .catch(e => { if (alive) setComposeError((e as Error).message); });
        return () => { alive = false };
    }, [catalog, app]);

    const tips = useMemo(() => Object.values(meta?.tips ?? {}).filter(t => t.trim()), [meta]);

    const lifecycle = (verb: 'start' | 'stop' | 'restart') => {
        if (!installed)
            return;
        setBusy(true);
        setActionError(null);
        callHelper(installed.backend, verb, { appId: app.id })
                .then(onChanged)
                .catch(e => setActionError((e as Error).message))
                .finally(() => setBusy(false));
    };
    const state = installed ? appState(installed) : null;
    const url = installed ? appUrl(installed) : null;
    const updatable = installed !== null && installed.app.contentHash !== app.contentHash;
    const installable = analysis !== null && analysis.policy.unsupported.length === 0 && source !== null;

    return (
        <Modal isOpen variant="large" onClose={onClose} aria-labelledby="pitstore-app-title">
            <ModalHeader labelId="pitstore-app-title">
                <div className="pitstore-app-card-header">
                    <AppIcon source={catalog.source} path={app.icon} size={56} />
                    <div>
                        <Title headingLevel="h1" size="2xl" id="pitstore-app-title">{app.title}</Title>
                        <Content component="small">
                            {[app.version && cockpit.format(_("Version $0"), app.version), app.developer].filter(Boolean).join(' · ')}
                        </Content>
                        <div><Label isCompact>{app.category}</Label></div>
                    </div>
                </div>
            </ModalHeader>
            <ModalBody>
                {app.tagline && <Content component="p" className="pitstore-tagline">{app.tagline}</Content>}
                {analysis && analysis.policy.findings.length + analysis.policy.unsupported.length > 0 &&
                    <SecurityReview policy={analysis.policy} />}

                {metaError && <Alert variant="warning" isInline title={_("Details could not be loaded")}>{metaError}</Alert>}
                {!meta && !metaError && <Spinner size="lg" />}
                {meta && (
                    <>
                        <Screenshots catalog={catalog} paths={meta.screenshots} />
                        {meta.description && <Markdown text={meta.description} />}
                        {tips.length > 0 && (
                            <Alert variant="info" isInline title={_("Before you install")}>
                                {tips.map((t, i) => <Markdown key={i} text={t} />)}
                            </Alert>
                        )}
                        {meta.releaseNote && (
                            <>
                                <Title headingLevel="h2" size="lg">{_("Release notes")}</Title>
                                <Markdown text={meta.releaseNote} />
                            </>
                        )}
                        {meta.links.length > 0 && (
                            <p className="pitstore-links">
                                {meta.links.map((l, i) => (
                                    <React.Fragment key={l.label}>
                                        {i > 0 && ' · '}
                                        <a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a>
                                    </React.Fragment>
                                ))}
                            </p>
                        )}
                    </>
                )}

                <Title headingLevel="h2" size="lg" className="pitstore-section-title">{_("What will run")}</Title>
                {composeError && <Alert variant="danger" isInline title={_("The app definition is invalid")}>{composeError}</Alert>}
                {!analysis && !composeError && <Spinner size="lg" />}
                {analysis && (
                    <>
                        {analysis.policy.findings.length + analysis.policy.unsupported.length === 0 &&
                            <SecurityReview policy={analysis.policy} />}
                        <DescriptionList isHorizontal isCompact className="pitstore-compose-summary">
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Images")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {analysis.summary.services.map(s => <div key={s.name}><code>{s.image}</code> ({s.name})</div>)}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Published ports")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {analysis.summary.ports.length === 0
                                        ? _("none")
                                        : analysis.summary.ports.map((p, i) => (
                                            <div key={i}>{p.published || _("(random)")} → {p.target}/{p.protocol} ({p.service})</div>
                                        ))}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Storage")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {analysis.summary.mounts.length === 0
                                        ? _("none")
                                        : analysis.summary.mounts.map((m, i) => (
                                            <div key={i}>
                                                {m.type === 'bind' ? <code>{m.source}</code> : m.type === 'volume' ? _("volume") : 'tmpfs'}
                                                {' → '}<code>{m.target}</code> ({m.service})
                                            </div>
                                        ))}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            {(analysis.userVariables.length > 0 || analysis.summary.secretEnv.length > 0) && (
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Settings")}</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        {analysis.userVariables.length > 0 &&
                                            <div>{_("You will be asked for:")} {analysis.userVariables.map(v => <code key={v}>{v} </code>)}</div>}
                                        {analysis.summary.secretEnv.length > 0 &&
                                            <div>{_("Generated at install unless you enter your own:")} {analysis.summary.secretEnv.map(s => <code key={s.service + s.key}>{s.key} </code>)}</div>}
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                            )}
                        </DescriptionList>
                    </>
                )}
            </ModalBody>
            <ModalFooter>
                {actionError && <Alert variant="danger" isInline title={actionError} />}
                {!installed && (
                    <Button variant="primary" isDisabled={!installable} onClick={() => setDialog('install')}>{_("Install")}</Button>
                )}
                {installed && (
                    <>
                        <Label color={state === 'running' ? 'green' : state === 'partial' ? 'orange' : 'grey'}>
                            {state === 'running' ? _("Running") : state === 'partial' ? _("Partly running") : _("Stopped")}
                        </Label>
                        {url && state === 'running' && (
                            <Button component="a" href={url} target="_blank" rel="noopener noreferrer" variant="primary">{_("Open")}</Button>
                        )}
                        {state === 'running'
                            ? <Button variant="secondary" isDisabled={busy} onClick={() => lifecycle('stop')}>{_("Stop")}</Button>
                            : <Button variant="secondary" isDisabled={busy} onClick={() => lifecycle('start')}>{_("Start")}</Button>}
                        <Button variant="secondary" isDisabled={busy} onClick={() => lifecycle('restart')}>{_("Restart")}</Button>
                        {updatable && (
                            <Button variant="secondary" isDisabled={busy || !installable} onClick={() => setDialog('install')}>
                                {cockpit.format(_("Update to $0"), app.version || _("the latest version"))}
                            </Button>
                        )}
                        <Button variant="danger" isDisabled={busy} onClick={() => setDialog('remove')}>{_("Remove")}</Button>
                    </>
                )}
                <Button variant="link" onClick={onClose}>{_("Close")}</Button>
            </ModalFooter>
            {dialog === 'install' && source && (
                <InstallDialog
catalog={catalog} app={app} compose={source.compose} composeText={source.text}
                               installed={installed} onClose={() => setDialog(null)}
                               onDone={() => { setDialog(null); onChanged() }}
                />
            )}
            {dialog === 'remove' && installed && (
                <RemoveDialog
app={app} installed={installed} onClose={() => setDialog(null)}
                              onDone={() => { setDialog(null); onChanged() }}
                />
            )}
        </Modal>
    );
};
