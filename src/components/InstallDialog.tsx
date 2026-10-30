// SPDX-License-Identifier: LGPL-2.1-or-later

import React, { useEffect, useState } from 'react';
import { Alert } from '@patternfly/react-core/dist/esm/components/Alert/index.js';
import { Button } from '@patternfly/react-core/dist/esm/components/Button/index.js';
import { Checkbox } from '@patternfly/react-core/dist/esm/components/Checkbox/index.js';
import { Form, FormGroup, FormSection } from '@patternfly/react-core/dist/esm/components/Form/index.js';
import { FormSelect, FormSelectOption } from '@patternfly/react-core/dist/esm/components/FormSelect/index.js';
import { List, ListItem } from '@patternfly/react-core/dist/esm/components/List/index.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal/index.js';
import { Spinner } from '@patternfly/react-core/dist/esm/components/Spinner/index.js';
import { TextInput } from '@patternfly/react-core/dist/esm/components/TextInput/index.js';

import cockpit from 'cockpit';

import {
    adminAllowed, BACKENDS, callHelper, dockerAvailable, prepareRuntime, type InstalledApp,
} from '../lib/apps';
import type { Catalog } from '../lib/catalog/catalog';
import type { CatalogApp } from '../lib/catalog/validate';
import type { ComposeFile } from '../lib/compose/parse';
import {
    buildCompose, composeHash, initialForm, webPort,
    type Backend, type InstallContext, type InstallForm,
} from '../lib/install';
import { FINDING_WARNINGS, type PolicyResult } from '../lib/policy';

const _ = cockpit.gettext;

async function contextFor(appId: string, backend: Backend): Promise<InstallContext> {
    const user = await cockpit.user();
    const tz = (await cockpit.file('/etc/timezone').read()
            .catch(() => null))?.trim() || 'UTC';
    return {
        appId,
        dataRoot: backend === 'podman-user' ? `${user.home}/.local/share/pitstore/data` : '/var/lib/pitstore/data',
        puid: 1000,
        pgid: 1000,
        tz: /^[A-Za-z0-9_+/-]{1,64}$/.test(tz) ? tz : 'UTC',
    };
}

export const InstallDialog = ({ catalog, app, compose, composeText, installed, onClose, onDone }: {
    catalog: Catalog;
    app: CatalogApp;
    compose: ComposeFile;
    composeText: string;
    installed: InstalledApp | null;
    onClose: () => void;
    onDone: () => void;
}) => {
    const isUpdate = installed !== null;
    const [backends, setBackends] = useState<Backend[] | null>(null);
    const [ctx, setCtx] = useState<InstallContext | null>(null);
    const [form, setForm] = useState<InstallForm | null>(null);
    const [verdict, setVerdict] = useState<PolicyResult | null>(null);
    const [buildError, setBuildError] = useState<string | null>(null);
    const [progress, setProgress] = useState<string[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [warnings, setWarnings] = useState<string[]>([]);

    // available backends; an update stays on the backend it was installed with
    useEffect(() => {
        if (installed) {
            setBackends([installed.backend]);
            return;
        }
        Promise.all([adminAllowed(), dockerAvailable()]).then(([admin, docker]) => {
            setBackends(BACKENDS.filter(b => (!b.admin || admin) && (b.id !== 'docker' || docker)).map(b => b.id));
        });
    }, [installed]);

    const setBackend = async (backend: Backend) => {
        const c = await contextFor(app.id, backend);
        let previous: ComposeFile | undefined;
        if (installed) {
            const r = await callHelper<{ plan: { compose: ComposeFile } }>(backend, 'get', { appId: app.id });
            previous = r.plan.compose;
        }
        setCtx(c);
        setForm(initialForm(compose, c, backend, previous));
    };

    useEffect(() => {
        if (backends && backends.length > 0 && !form)
            setBackend(backends[0]).catch(e => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [backends]);

    // re-evaluate the policy on every edit: a changed path can create a finding
    useEffect(() => {
        if (!form || !ctx)
            return;
        buildCompose(compose, form, ctx)
                .then(r => { setVerdict(r.policy); setBuildError(null) })
                .catch(e => { setVerdict(null); setBuildError((e as Error).message) });
    }, [form, ctx, compose]);

    const update = (patch: (f: InstallForm) => void) => setForm(f => {
        if (!f)
            return f;
        const copy = structuredClone(f);
        patch(copy);
        return copy;
    });

    const findings = verdict?.findings ?? [];
    const allConfirmed = findings.every(f => form?.confirmed.includes(f.key));
    const blocked = !verdict || verdict.unsupported.length > 0 || buildError !== null;
    const busy = progress !== null && error === null;

    const install = async () => {
        if (!form || !ctx)
            return;
        setError(null);
        setProgress([]);
        const log = (m: string) => setProgress(p => [...(p ?? []), m].slice(-200));
        try {
            log(_("Preparing the container runtime"));
            setWarnings(await prepareRuntime(form.backend));
            const { compose: final } = await buildCompose(compose, form, ctx);
            const x = compose['x-casaos'];
            await callHelper(form.backend, 'install', {
                app: {
                    id: app.id,
                    title: app.title,
                    version: app.version,
                    icon: app.icon ?? '',
                    store: catalog.source.href,
                    contentHash: app.contentHash,
                    main: typeof x.main === 'string' ? x.main : '',
                    portMap: webPort(compose, form),
                    scheme: x.scheme === 'https' ? 'https' : 'http',
                    index: typeof x.index === 'string' && x.index ? x.index : '/',
                },
                compose: final,
                composeSha256: await composeHash(composeText),
                confirmed: form.confirmed,
                update: isUpdate,
            }, log);
            log(_("Done"));
            onDone();
        } catch (e) {
            setError((e as Error).message);
        }
    };

    const title = isUpdate ? cockpit.format(_("Update $0"), app.title) : cockpit.format(_("Install $0"), app.title);
    const ready = form && ctx && backends;

    return (
        <Modal isOpen variant="large" onClose={busy ? undefined : onClose} aria-labelledby="pitstore-install-title">
            <ModalHeader title={title} labelId="pitstore-install-title" />
            <ModalBody>
                {backends && backends.length === 0 && <Alert variant="danger" isInline title={_("No container runtime is available")} />}
                {!ready && !error && <Spinner size="lg" />}
                {ready && progress === null && (
                    <Form isHorizontal>
                        <FormGroup label={_("Run with")} fieldId="pitstore-backend">
                            <FormSelect
id="pitstore-backend" value={form.backend} isDisabled={isUpdate}
                                        onChange={(_e, v) => { setBackend(v as Backend).catch(err => setError((err as Error).message)) }}
                            >
                                {BACKENDS.filter(b => backends.includes(b.id)).map(b => <FormSelectOption key={b.id} value={b.id} label={b.label} />)}
                            </FormSelect>
                        </FormGroup>

                        {form.ports.length > 0 && (
                            <FormSection title={_("Ports")}>
                                {form.ports.map((p, i) => (
                                    <FormGroup key={i} label={cockpit.format(_("$0: $1/$2"), p.service, p.target, p.protocol)} fieldId={`port-${i}`}>
                                        <TextInput
id={`port-${i}`} value={p.published} type="number" aria-label={_("Host port")}
                                                   onChange={(_e, v) => update(f => { f.ports[i].published = v })}
                                        />
                                    </FormGroup>
                                ))}
                            </FormSection>
                        )}

                        {form.binds.length > 0 && (
                            <FormSection title={_("Storage on this server")}>
                                {form.binds.map((b, i) => (
                                    <FormGroup key={i} label={`${b.service}: ${b.target}${b.readOnly ? ' (' + _("read-only") + ')' : ''}`} fieldId={`bind-${i}`}>
                                        <TextInput
id={`bind-${i}`} value={b.source} aria-label={_("Host path")}
                                                   onChange={(_e, v) => update(f => { f.binds[i].source = v })}
                                        />
                                    </FormGroup>
                                ))}
                            </FormSection>
                        )}

                        {(Object.keys(form.variables).length > 0 || form.secrets.length > 0) && (
                            <FormSection title={_("Settings")}>
                                {Object.keys(form.variables).map(name => (
                                    <FormGroup key={name} label={name} fieldId={`var-${name}`}>
                                        <TextInput
id={`var-${name}`} value={form.variables[name]}
                                                   onChange={(_e, v) => update(f => { f.variables[name] = v })}
                                        />
                                    </FormGroup>
                                ))}
                                {form.secrets.map((s, i) => (
                                    <FormGroup key={`${s.service}/${s.key}`} fieldId={`secret-${i}`} label={`${s.service}: ${s.key}`}>
                                        <Checkbox
                                            id={`secret-gen-${i}`} isChecked={s.generate}
                                            label={_("Generate a random value (recommended)")}
                                            description={s.others.length > 0 ? cockpit.format(_("Also used by $0"), s.others.join(', ')) : ''}
                                            onChange={(_e, v) => update(f => { f.secrets[i].generate = v })}
                                        />
                                        {!s.generate && (
                                            <TextInput
                                                id={`secret-${i}`} type="password" value={s.value} aria-label={s.key}
                                                onChange={(_e, v) => update(f => { f.secrets[i].value = v })}
                                            />
                                        )}
                                    </FormGroup>
                                ))}
                            </FormSection>
                        )}

                        {buildError && <Alert variant="danger" isInline title={_("Invalid settings")}>{buildError}</Alert>}
                        {verdict && verdict.unsupported.length > 0 && (
                            <Alert variant="danger" isInline title={_("This app cannot be installed by PitStore")}>
                                <List>{verdict.unsupported.map(u => <ListItem key={u.path}><code>{u.path}</code>: {u.reason}</ListItem>)}</List>
                            </Alert>
                        )}
                        {findings.length > 0 && (
                            <Alert variant="danger" isInline title={_("Risky permissions: confirm each one to continue")}>
                                {findings.map(f => (
                                    <Checkbox
                                        key={f.key}
                                        id={`confirm-${f.key}`}
                                        className="pitstore-confirm"
                                        isChecked={form.confirmed.includes(f.key)}
                                        onChange={(_e, checked) => update(fm => {
                                            fm.confirmed = checked ? [...fm.confirmed, f.key] : fm.confirmed.filter(k => k !== f.key);
                                        })}
                                        label={<><strong>{f.service}</strong>: <code>{f.detail ? `${f.kind} ${f.detail}` : f.kind}</code></>}
                                        description={FINDING_WARNINGS[f.kind]}
                                    />
                                ))}
                            </Alert>
                        )}
                    </Form>
                )}

                {progress !== null && (
                    <div className="pitstore-progress" aria-live="polite">
                        {progress.map((m, i) => <div key={i}>{m}</div>)}
                        {busy && <Spinner size="md" />}
                    </div>
                )}
                {warnings.map(w => <Alert key={w} variant="warning" isInline title={w} />)}
                {error && <Alert variant="danger" isInline title={isUpdate ? _("Update failed") : _("Installation failed")}>{error}</Alert>}
            </ModalBody>
            <ModalFooter>
                {progress === null && (
                    <Button
                        variant={findings.length > 0 ? 'danger' : 'primary'}
                        isDisabled={!ready || blocked || !allConfirmed}
                        onClick={() => { install() }}
                    >
                        {findings.length > 0
                            ? (isUpdate ? _("Update with risky permissions") : _("Install with risky permissions"))
                            : (isUpdate ? _("Update") : _("Install"))}
                    </Button>
                )}
                {error && <Button variant="secondary" onClick={() => { setProgress(null); setError(null) }}>{_("Back")}</Button>}
                <Button variant="link" onClick={onClose} isDisabled={busy}>{progress !== null && !error ? _("Close") : _("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};
