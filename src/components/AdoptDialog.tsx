// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Take over an app that PitStore did not install. The helper analyses the
// running containers; every check is shown with its possible corrections.
// The helper validates the choices again before it changes anything.

import React, { useEffect, useMemo, useState } from 'react';
import { Alert } from '@patternfly/react-core/dist/esm/components/Alert/index.js';
import { Button } from '@patternfly/react-core/dist/esm/components/Button/index.js';
import { Form, FormGroup } from '@patternfly/react-core/dist/esm/components/Form/index.js';
import { Label } from '@patternfly/react-core/dist/esm/components/Label/index.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal/index.js';
import { Radio } from '@patternfly/react-core/dist/esm/components/Radio/index.js';
import { Spinner } from '@patternfly/react-core/dist/esm/components/Spinner/index.js';
import { TextInput } from '@patternfly/react-core/dist/esm/components/TextInput/index.js';
import { Title } from '@patternfly/react-core/dist/esm/components/Title/index.js';

import cockpit from 'cockpit';

import { callHelper, type AdoptAnalysis, type AdoptCheck, type ForeignGroup } from '../lib/apps';

const _ = cockpit.gettext;

const SEVERITY = {
    decision: { color: 'red', text: "Decide" },
    warning: { color: 'orange', text: "Warning" },
    info: { color: 'blue', text: "Info" },
} as const;

const APP_ID_RE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)+$/;

type Choices = Record<string, { choice: string; value?: string }>;

const CheckItem = ({ check, choice, onChange }: {
    check: AdoptCheck;
    choice: { choice: string; value?: string } | undefined;
    onChange: (c: { choice: string; value?: string }) => void;
}) => {
    const sev = SEVERITY[check.severity];
    const picked = choice?.choice ?? check.default;
    return (
        <div className="pitstore-check" id={`check-${check.id}`}>
            <div className="pitstore-check-title">
                <Label isCompact color={sev.color}>{_(sev.text)}</Label> <strong>{check.title}</strong>
            </div>
            {check.detail && <div className="pitstore-check-detail">{check.detail}</div>}
            {check.corrections.length > 1 && check.corrections.map(c => (
                <div key={c.id}>
                    <Radio
                        id={`choice-${check.id}-${c.id}`}
                        name={`choice-${check.id}`}
                        isChecked={picked === c.id}
                        onChange={() => onChange({ choice: c.id, ...(choice?.value !== undefined ? { value: choice.value } : {}) })}
                        label={c.label}
                    />
                    {c.input === 'port' && picked === c.id && (
                        <TextInput
                            id={`value-${check.id}`} type="number" className="pitstore-check-input"
                            aria-label={_("New host port")} value={choice?.value ?? ''}
                            onChange={(_e, v) => onChange({ choice: c.id, value: v })}
                        />
                    )}
                </div>
            ))}
        </div>
    );
};

export const AdoptDialog = ({ group, onClose, onDone }: {
    group: ForeignGroup;
    onClose: () => void;
    onDone: () => void;
}) => {
    const [analysis, setAnalysis] = useState<AdoptAnalysis | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [appId, setAppId] = useState('');
    const [title, setTitle] = useState(group.key);
    const [choices, setChoices] = useState<Choices>({});
    const [progress, setProgress] = useState<string[] | null>(null);

    useEffect(() => {
        callHelper<{ analysis: AdoptAnalysis }>(group.backend, 'analyze', { group: group.key })
                .then(r => { setAnalysis(r.analysis); setAppId(r.analysis.suggestedId) })
                .catch(e => setError((e as Error).message));
    }, [group]);

    const state = useMemo(() => {
        if (!analysis)
            return null;
        let recreate = false;
        let confirms = 0;
        const missing: string[] = [];
        for (const check of analysis.checks) {
            const picked = choices[check.id]?.choice ?? check.default;
            const corr = check.corrections.find(c => c.id === picked);
            if (check.corrections.length > 0 && !corr)
                missing.push(check.title);
            if (corr?.recreate)
                recreate = true;
            if (corr?.confirms)
                confirms++;
            if (corr?.input === 'port' && !/^[0-9]{1,5}$/.test(choices[check.id]?.value ?? ''))
                missing.push(check.title);
        }
        const blockers: string[] = [];
        if (recreate && !analysis.recreatePossible)
            blockers.push(_("A correction recreates the containers, but this app keeps data in an anonymous volume. Keep everything as it is to take it over without changes."));
        if (recreate) {
            for (const check of analysis.checks) {
                if (check.id.startsWith('unsupported:') && (choices[check.id]?.choice ?? check.default) !== 'remove')
                    blockers.push(cockpit.format(_("To recreate the containers, remove: $0"), check.title));
            }
        }
        return { recreate, confirms, missing, blockers };
    }, [analysis, choices]);

    const busy = progress !== null && error === null;
    const ready = analysis && state && state.missing.length === 0 && state.blockers.length === 0 &&
        APP_ID_RE.test(appId) && title.trim() !== '' && !busy;

    const takeOver = () => {
        setError(null);
        setProgress([]);
        callHelper(group.backend, 'adopt', { group: group.key, appId, title: title.trim(), choices },
                   m => setProgress(p => [...(p ?? []), m]))
                .then(() => onDone())
                .catch(e => setError((e as Error).message));
    };

    const order = { decision: 0, warning: 1, info: 2 };
    const checks = [...(analysis?.checks ?? [])].sort((a, b) => order[a.severity] - order[b.severity]);

    return (
        <Modal isOpen variant="large" onClose={busy ? undefined : onClose} aria-labelledby="pitstore-adopt-title">
            <ModalHeader title={cockpit.format(_("Take over $0"), group.key)} labelId="pitstore-adopt-title" />
            <ModalBody>
                {!analysis && !error && <Spinner size="lg" />}
                {analysis && progress === null && (
                    <>
                        <p className="pitstore-adopt-intro">
                            {_("PitStore analysed the running containers. Without corrections the app is taken over as it is: nothing changes, PitStore only starts, stops and shows it. Corrections recreate the containers with the same images, folders and volumes; the old containers are kept until the new ones run.")}
                        </p>
                        <Form isHorizontal>
                            <FormGroup label={_("Name")} fieldId="adopt-title" isRequired>
                                <TextInput id="adopt-title" value={title} onChange={(_e, v) => setTitle(v)} />
                            </FormGroup>
                            <FormGroup label={_("App ID")} fieldId="adopt-id" isRequired>
                                <TextInput
id="adopt-id" value={appId} validated={APP_ID_RE.test(appId) ? 'default' : 'error'}
                                           onChange={(_e, v) => setAppId(v)}
                                />
                            </FormGroup>
                        </Form>
                        <Title headingLevel="h2" size="lg" className="pitstore-section-title">
                            {cockpit.format(_("Checks ($0)"), checks.length)}
                        </Title>
                        {checks.length === 0 && <Alert variant="success" isInline title={_("No problems found")} />}
                        {checks.map(check => (
                            <CheckItem
key={check.id} check={check} choice={choices[check.id]}
                                       onChange={c => setChoices(prev => ({ ...prev, [check.id]: c }))}
                            />
                        ))}
                        {state && state.recreate && state.blockers.length === 0 && (
                            <Alert variant="warning" isInline title={_("The containers will be recreated")}>
                                {_("The app is briefly stopped. Folders and named volumes are reused; if anything fails, the original containers are restored.")}
                            </Alert>
                        )}
                        {state?.blockers.map(b => <Alert key={b} variant="danger" isInline title={b} />)}
                    </>
                )}
                {progress !== null && (
                    <div className="pitstore-progress" aria-live="polite">
                        {progress.map((m, i) => <div key={i}>{m}</div>)}
                        {busy && <Spinner size="md" />}
                    </div>
                )}
                {error && <Alert variant="danger" isInline title={_("Taking over failed")}>{error}</Alert>}
            </ModalBody>
            <ModalFooter>
                {progress === null && (
                    <Button variant={state && state.confirms > 0 ? 'danger' : 'primary'} isDisabled={!ready} onClick={takeOver}>
                        {state && state.confirms > 0 ? _("Take over with risky options") : _("Take over")}
                    </Button>
                )}
                {error && progress !== null && <Button variant="secondary" onClick={() => { setProgress(null); setError(null) }}>{_("Back")}</Button>}
                <Button variant="link" onClick={onClose} isDisabled={busy}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};
