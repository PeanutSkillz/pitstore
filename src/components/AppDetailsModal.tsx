// SPDX-License-Identifier: LGPL-2.1-or-later

import React, { useEffect, useMemo, useState } from 'react';
import { Alert } from '@patternfly/react-core/dist/esm/components/Alert/index.js';
import { Button } from '@patternfly/react-core/dist/esm/components/Button/index.js';
import { Content } from '@patternfly/react-core/dist/esm/components/Content/index.js';
import {
    DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm,
} from '@patternfly/react-core/dist/esm/components/DescriptionList/index.js';
import { Flex, FlexItem } from '@patternfly/react-core/dist/esm/layouts/Flex/index.js';
import { Label } from '@patternfly/react-core/dist/esm/components/Label/index.js';
import { List, ListItem } from '@patternfly/react-core/dist/esm/components/List/index.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal/index.js';
import { Spinner } from '@patternfly/react-core/dist/esm/components/Spinner/index.js';
import { Title } from '@patternfly/react-core/dist/esm/components/Title/index.js';

import cockpit from 'cockpit';

import { loadCompose, loadImage, loadMeta, type Catalog } from '../lib/catalog/catalog';
import type { AppMeta, CatalogApp } from '../lib/catalog/validate';
import { catalogVariables, interpolateCompose } from '../lib/compose/interpolate';
import { summarizeCompose, type ComposeSummary } from '../lib/compose/summary';
import { evaluatePolicy, FINDING_WARNINGS, type PolicyResult } from '../lib/policy';
import { AppIcon } from './AppIcon';
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
        Promise.all(paths.slice(0, 5).map(p => loadImage(catalog, p))).then(list => {
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

export const AppDetailsModal = ({ catalog, app, onClose }: {
    catalog: Catalog;
    app: CatalogApp;
    onClose: () => void;
}) => {
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
                .then(({ compose }) => { if (alive) setAnalysis(analyze(app, compose)); })
                .catch(e => { if (alive) setComposeError((e as Error).message); });
        return () => { alive = false };
    }, [catalog, app]);

    const tips = useMemo(() => Object.values(meta?.tips ?? {}).filter(t => t.trim()), [meta]);

    return (
        <Modal isOpen variant="large" onClose={onClose} aria-labelledby="pitstore-app-title">
            <ModalHeader labelId="pitstore-app-title">
                <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsMd' }}>
                    <FlexItem><AppIcon catalog={catalog} path={app.icon} size={56} /></FlexItem>
                    <FlexItem>
                        <Title headingLevel="h1" size="2xl" id="pitstore-app-title">{app.title}</Title>
                        <Content component="small">
                            {[app.version && cockpit.format(_("Version $0"), app.version), app.developer].filter(Boolean).join(' · ')}
                        </Content>
                        <div><Label isCompact>{app.category}</Label></div>
                    </FlexItem>
                </Flex>
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
                <Button variant="primary" isDisabled>{_("Install")}</Button>
                <Button variant="link" onClick={onClose}>{_("Close")}</Button>
                <Content component="small">{_("Installing apps is not available yet in this version of PitStore.")}</Content>
            </ModalFooter>
        </Modal>
    );
};
