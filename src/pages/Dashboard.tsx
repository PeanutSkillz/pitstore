// SPDX-License-Identifier: LGPL-2.1-or-later

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from '@patternfly/react-core/dist/esm/components/Button/index.js';
import { Card, CardBody, CardFooter, CardHeader, CardTitle } from '@patternfly/react-core/dist/esm/components/Card/index.js';
import { Content } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import { EmptyState, EmptyStateBody, EmptyStateFooter } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Gallery } from '@patternfly/react-core/dist/esm/layouts/Gallery/index.js';
import { Label } from '@patternfly/react-core/dist/esm/components/Label/index.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal/index.js';
import { Title } from '@patternfly/react-core/dist/esm/components/Title/index.js';
import { Page, PageSection } from '@patternfly/react-core/dist/esm/components/Page/index.js';
import { Progress, ProgressSize } from '@patternfly/react-core/dist/esm/components/Progress/index.js';
import { Spinner } from '@patternfly/react-core/dist/esm/components/Spinner/index.js';
import { CubesIcon } from '@patternfly/react-icons/dist/esm/icons/cubes-icon.js';

import cockpit from 'cockpit';
import { superuser } from 'superuser';

import { AdoptDialog } from '../components/AdoptDialog';
import { AppIcon } from '../components/AppIcon';
import {
    adminAllowed, appState, appUrl, BACKENDS, callHelper, dockerAvailable, listForeign, listInstalled,
    type ForeignGroup, type InstalledApp,
} from '../lib/apps';
import { parseSourceUrl, type SourceUrl } from '../lib/catalog/validate';
import type { Backend } from '../lib/install';
import {
    cpuPercent, formatBytes, formatUptime, parseDf, parseMeminfo, parseProcStat, parseUptime, type CpuSample,
} from '../lib/system';

const _ = cockpit.gettext;
const APPS_REFRESH_MS = 10000;
const SYSTEM_REFRESH_MS = 5000;

interface Summary {
    cpu: number | null;
    memory: { total: number; used: number } | null;
    disk: { size: number; used: number; mount: string } | null;
    uptime: number | null;
}

async function readText(path: string): Promise<string> {
    const file = cockpit.file(path);
    try {
        return (await file.read()) ?? '';
    } finally {
        file.close();
    }
}

/* Calls fn now and then every `ms` while the page is visible. */
function usePolling(fn: () => void, ms: number) {
    useEffect(() => {
        fn();
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible')
                fn();
        }, ms);
        return () => window.clearInterval(timer);
    }, [fn, ms]);
}

const SystemSummary = () => {
    const [summary, setSummary] = useState<Summary>({ cpu: null, memory: null, disk: null, uptime: null });
    // CPU usage needs the previous /proc/stat sample
    const lastCpu = useRef<CpuSample | null>(null);

    const refresh = useCallback(() => {
        Promise.all([
            readText('/proc/stat').then(parseProcStat)
                    .catch(() => null),
            readText('/proc/meminfo').then(parseMeminfo)
                    .catch(() => null),
            cockpit.spawn(['df', '-B1', '--output=size,used,target', '/'], { err: 'ignore' }).then(parseDf)
                    .catch(() => null),
            readText('/proc/uptime').then(parseUptime)
                    .catch(() => null),
        ]).then(([cpu, memory, disk, uptime]) => {
            const prev = lastCpu.current;
            lastCpu.current = cpu;
            setSummary({ cpu: prev && cpu ? cpuPercent(prev, cpu) : null, memory, disk, uptime });
        });
    }, []);
    usePolling(refresh, SYSTEM_REFRESH_MS);

    const percent = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);
    const tiles = [
        {
            id: 'cpu',
            title: _("CPU"),
            value: summary.cpu,
            text: summary.cpu === null ? '' : `${summary.cpu.toFixed(0)} %`,
            page: '/system',
        },
        {
            id: 'memory',
            title: _("Memory"),
            value: summary.memory ? percent(summary.memory.used, summary.memory.total) : null,
            text: summary.memory ? `${formatBytes(summary.memory.used)} / ${formatBytes(summary.memory.total)}` : '',
            page: '/system',
        },
        {
            id: 'disk',
            title: cockpit.format(_("Disk $0"), summary.disk?.mount ?? '/'),
            value: summary.disk ? percent(summary.disk.used, summary.disk.size) : null,
            text: summary.disk ? `${formatBytes(summary.disk.used)} / ${formatBytes(summary.disk.size)}` : '',
            page: '/storage',
        },
    ];

    return (
        <Gallery hasGutter minWidths={{ default: '200px' }} className="pitstore-summary" aria-label={_("System summary")}>
            {tiles.map(t => (
                <Card key={t.id} isCompact id={`pitstore-summary-${t.id}`}>
                    <CardTitle>
                        <Button variant="link" isInline onClick={() => cockpit.jump(t.page)}>{t.title}</Button>
                    </CardTitle>
                    <CardBody>
                        {t.value === null
                            ? <Spinner size="md" />
                            : (
                                <>
                                    <div className="pitstore-summary-value">{t.text}</div>
                                    <Progress
                                        value={t.value} size={ProgressSize.sm}
                                        aria-label={t.title} measureLocation="none"
                                        variant={t.value > 90 ? 'danger' : t.value > 75 ? 'warning' : undefined}
                                    />
                                </>
                            )}
                    </CardBody>
                </Card>
            ))}
            <Card isCompact id="pitstore-summary-uptime">
                <CardTitle>
                    <Button variant="link" isInline onClick={() => cockpit.jump('/system')}>{_("Uptime")}</Button>
                </CardTitle>
                <CardBody>
                    {summary.uptime === null
                        ? <Spinner size="md" />
                        : <div className="pitstore-summary-value">{formatUptime(summary.uptime)}</div>}
                </CardBody>
            </Card>
        </Gallery>
    );
};

const STATE_LABELS = {
    running: { color: 'green', text: "Running" },
    partial: { color: 'orange', text: "Partly running" },
    stopped: { color: 'grey', text: "Stopped" },
    missing: { color: 'red', text: "No containers" },
} as const;

const AppTile = ({ app, source, busy, onAction, onRelease }: {
    app: InstalledApp;
    source: SourceUrl | null;
    busy: boolean;
    onAction: (verb: 'start' | 'stop' | 'restart') => void;
    onRelease: () => void;
}) => {
    const state = appState(app);
    const url = appUrl(app);
    const label = STATE_LABELS[state];
    const backend = BACKENDS.find(b => b.id === app.backend)?.label ?? app.backend;
    return (
        <Card isCompact className="pitstore-tile" id={`tile-${app.id}`}>
            <CardHeader>
                <div className="pitstore-app-card-header">
                    <AppIcon source={source} path={app.app.icon || null} />
                    <div>
                        <CardTitle>{app.app.title || app.id}</CardTitle>
                        <Content component="small">{app.app.version ? cockpit.format(_("Version $0"), app.app.version) : app.id}</Content>
                    </div>
                </div>
            </CardHeader>
            <CardBody>
                <Label isCompact color={label.color} className="pitstore-state">{_(label.text)}</Label>
                {app.adopted && <Label isCompact color="purple" className="pitstore-installed">{_("Taken over")}</Label>}
                <Content component="small" className="pitstore-backend">{backend}</Content>
            </CardBody>
            <CardFooter className="pitstore-tile-actions">
                {url && state === 'running' && (
                    <Button component="a" href={url} target="_blank" rel="noopener noreferrer" variant="primary" size="sm">{_("Open")}</Button>
                )}
                {state === 'running' || state === 'partial'
                    ? <Button variant="secondary" size="sm" isDisabled={busy} onClick={() => onAction('stop')}>{_("Stop")}</Button>
                    : <Button variant="secondary" size="sm" isDisabled={busy || state === 'missing'} onClick={() => onAction('start')}>{_("Start")}</Button>}
                <Button variant="secondary" size="sm" isDisabled={busy || state === 'missing'} onClick={() => onAction('restart')}>{_("Restart")}</Button>
                {app.adopted === 'in-place' &&
                    <Button variant="link" size="sm" isDisabled={busy} onClick={onRelease}>{_("Release")}</Button>}
                {busy && <Spinner size="md" aria-label={_("Working")} />}
            </CardFooter>
        </Card>
    );
};

const ForeignCard = ({ group, onTakeOver }: { group: ForeignGroup; onTakeOver: () => void }) => {
    const running = group.containers.filter(c => c.state === 'running').length;
    const backend = BACKENDS.find(b => b.id === group.backend)?.label ?? group.backend;
    const ports = group.containers.flatMap(c => c.ports.map(p => `${p.published}/${p.protocol}`));
    return (
        <Card isCompact className="pitstore-tile" id={`foreign-${group.backend}-${group.key}`}>
            <CardHeader>
                <div>
                    <CardTitle>{group.key}</CardTitle>
                    <Content component="small">
                        {cockpit.format(_("$0 of $1 containers running"), running, group.containers.length)}
                    </Content>
                </div>
            </CardHeader>
            <CardBody>
                {group.managedBy && <Label isCompact color="orange" className="pitstore-state">{group.managedBy}</Label>}
                <Content component="small" className="pitstore-backend">{backend}</Content>
                <Content component="small">{group.containers.map(c => c.image).join(', ')}</Content>
                {ports.length > 0 && <Content component="small">{cockpit.format(_("Ports: $0"), ports.join(', '))}</Content>}
            </CardBody>
            <CardFooter className="pitstore-tile-actions">
                <Button variant="secondary" size="sm" onClick={onTakeOver}>{_("Take over…")}</Button>
            </CardFooter>
        </Card>
    );
};

export const DashboardPage = () => {
    const [apps, setApps] = useState<InstalledApp[] | null>(null);
    const [errors, setErrors] = useState<string[]>([]);
    const [admin, setAdmin] = useState<boolean | null>(null);
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [actionError, setActionError] = useState<string | null>(null);
    const [foreign, setForeign] = useState<ForeignGroup[]>([]);
    const [adopting, setAdopting] = useState<ForeignGroup | null>(null);
    const [releasing, setReleasing] = useState<InstalledApp | null>(null);

    const load = useCallback(async () => {
        const [isAdmin, docker] = await Promise.all([adminAllowed(), dockerAvailable()]);
        const backends: Backend[] = ['podman-user'];
        if (isAdmin)
            backends.push('podman-system');
        if (isAdmin && docker)
            backends.push('docker');
        const [r, f] = await Promise.all([listInstalled(backends), listForeign(backends)]);
        setAdmin(isAdmin);
        setApps(r.apps);
        setForeign(f.groups);
        setErrors([...r.errors, ...f.errors]);
    }, []);
    usePolling(load, APPS_REFRESH_MS);

    useEffect(() => {
        const changed = () => { load() };
        superuser.addEventListener('changed', changed);
        return () => superuser.removeEventListener('changed', changed);
    }, [load]);

    // one parsed source per store URL, so icons are cached and effects stay stable
    const sources = useMemo(() => {
        const map = new Map<string, SourceUrl | null>();
        for (const a of apps ?? []) {
            const href = a.app.store ?? '';
            if (!map.has(href)) {
                try {
                    map.set(href, parseSourceUrl(href));
                } catch {
                    map.set(href, null);
                }
            }
        }
        return map;
    }, [apps]);

    const act = (app: InstalledApp, verb: 'start' | 'stop' | 'restart') => {
        const key = `${app.backend}/${app.id}`;
        setBusy(b => ({ ...b, [key]: true }));
        setActionError(null);
        callHelper(app.backend, verb, { appId: app.id })
                .catch(e => setActionError(`${app.app.title || app.id}: ${(e as Error).message}`))
                .finally(() => {
                    setBusy(b => ({ ...b, [key]: false }));
                    load();
                });
    };

    const running = (apps ?? []).filter(a => appState(a) === 'running').length;

    return (
        <Page className='pf-m-no-sidebar'>
            <PageSection>
                <Content component="h1">{_("Dashboard")}</Content>
                {apps && apps.length > 0 && (
                    <Content component="small" id="pitstore-app-count">
                        {cockpit.format(_("$0 of $1 apps running"), running, apps.length)}
                    </Content>
                )}
            </PageSection>
            <PageSection>
                <SystemSummary />
            </PageSection>
            <PageSection>
                {admin === false && (
                    <Alert
variant="info" isInline isPlain
                           title={_("Apps on the system Podman or Docker are shown with administrative access.")}
                    />
                )}
                {errors.map(e => <Alert key={e} variant="warning" isInline title={_("Some apps could not be listed")}>{e}</Alert>)}
                {actionError && <Alert variant="danger" isInline title={actionError} />}
                {apps === null && <EmptyState headingLevel="h2" titleText={_("Loading apps")} icon={Spinner} />}
                {apps && apps.length === 0 && (
                    <EmptyState headingLevel="h2" titleText={_("No apps installed")} icon={CubesIcon}>
                        <EmptyStateBody>{_("Apps you install from the Appstore will appear here.")}</EmptyStateBody>
                        <EmptyStateFooter>
                            <Button variant="primary" onClick={() => cockpit.jump('/pitstore/appstore')}>{_("Open the Appstore")}</Button>
                        </EmptyStateFooter>
                    </EmptyState>
                )}
                {apps && apps.length > 0 && (
                    <Gallery hasGutter minWidths={{ default: '260px' }} className="pitstore-gallery">
                        {apps.map(app => (
                            <AppTile
key={`${app.backend}/${app.id}`} app={app}
                                     source={sources.get(app.app.store ?? '') ?? null}
                                     busy={busy[`${app.backend}/${app.id}`] === true}
                                     onAction={verb => act(app, verb)}
                                     onRelease={() => setReleasing(app)}
                            />
                        ))}
                    </Gallery>
                )}
            </PageSection>
            {foreign.length > 0 && (
                <PageSection>
                    <Title headingLevel="h2" size="xl">{_("Other apps on this server")}</Title>
                    <Content component="p" className="pitstore-tagline">
                        {_("Containers that PitStore did not install. PitStore does not change them unless you take them over.")}
                    </Content>
                    <Gallery hasGutter minWidths={{ default: '260px' }} className="pitstore-gallery">
                        {foreign.map(g => <ForeignCard key={`${g.backend}/${g.key}`} group={g} onTakeOver={() => setAdopting(g)} />)}
                    </Gallery>
                </PageSection>
            )}
            {adopting && (
                <AdoptDialog
group={adopting} onClose={() => setAdopting(null)}
                             onDone={() => { setAdopting(null); load() }}
                />
            )}
            {releasing && (
                <Modal isOpen variant="small" onClose={() => setReleasing(null)} aria-labelledby="pitstore-release-title">
                    <ModalHeader title={cockpit.format(_("Release $0?"), releasing.app.title || releasing.id)} labelId="pitstore-release-title" />
                    <ModalBody>{_("PitStore stops managing this app. Its containers keep running and nothing is deleted.")}</ModalBody>
                    <ModalFooter>
                        <Button
variant="primary" onClick={() => {
    const app = releasing;
    setReleasing(null);
    callHelper(app.backend, 'release', { appId: app.id })
            .catch(e => setActionError((e as Error).message))
            .finally(() => load());
}}
                        >{_("Release")}
                        </Button>
                        <Button variant="link" onClick={() => setReleasing(null)}>{_("Cancel")}</Button>
                    </ModalFooter>
                </Modal>
            )}
        </Page>
    );
};
