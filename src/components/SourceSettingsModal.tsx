// SPDX-License-Identifier: LGPL-2.1-or-later

import React, { useState } from 'react';
import { Alert } from '@patternfly/react-core/dist/esm/components/Alert/index.js';
import { Button } from '@patternfly/react-core/dist/esm/components/Button/index.js';
import { Checkbox } from '@patternfly/react-core/dist/esm/components/Checkbox/index.js';
import { Form, FormGroup, FormHelperText } from '@patternfly/react-core/dist/esm/components/Form/index.js';
import { HelperText, HelperTextItem } from '@patternfly/react-core/dist/esm/components/HelperText/index.js';
import { InputGroup, InputGroupItem } from '@patternfly/react-core/dist/esm/components/InputGroup/index.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal/index.js';
import { TextInput } from '@patternfly/react-core/dist/esm/components/TextInput/index.js';
import { Title } from '@patternfly/react-core/dist/esm/components/Title/index.js';

import cockpit from 'cockpit';

import { parseSourceUrl } from '../lib/catalog/validate';
import { MAX_SOURCES, PRESET_SOURCES, presetFor, saveSettings, type Settings } from '../lib/settings';

const _ = cockpit.gettext;

const PRESETS = PRESET_SOURCES.map(p => ({ ...p, href: parseSourceUrl(p.url).href }));

export const SourceSettingsModal = ({ settings, onClose, onSaved }: {
    settings: Settings;
    onClose: () => void;
    onSaved: (settings: Settings) => void;
}) => {
    const [enabled, setEnabled] = useState(() => new Set(settings.sources.filter(u => presetFor(u))));
    const [custom, setCustom] = useState(() => settings.sources.filter(u => !presetFor(u)));
    const [url, setUrl] = useState('');
    const [urlError, setUrlError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const toggle = (href: string, on: boolean) => setEnabled(prev => {
        const next = new Set(prev);
        if (on)
            next.add(href);
        else
            next.delete(href);
        return next;
    });

    const add = () => {
        try {
            const href = parseSourceUrl(url.trim()).href;
            if (presetFor(href))
                toggle(href, true);
            else if (!custom.includes(href))
                setCustom([...custom, href]);
            setUrl('');
            setUrlError(null);
        } catch (e) {
            setUrlError((e as Error).message);
        }
    };

    const sources = [...PRESETS.filter(p => enabled.has(p.href)).map(p => p.href), ...custom];

    const save = () => {
        setBusy(true);
        setError(null);
        saveSettings({ sources })
                .then(saved => onSaved(saved))
                .catch(e => {
                    setError((e as Error).message);
                    setBusy(false);
                });
    };

    return (
        <Modal isOpen variant="medium" onClose={onClose} aria-labelledby="pitstore-source-title">
            <ModalHeader
title={_("App catalogs")} labelId="pitstore-source-title"
                         description={_("All chosen catalogs are shown as one overview. An app offered by several of them is shown once; its details let you pick the catalog to install it from. Catalogs are fetched by the server, not by your browser, and every app goes through the same security checks.")}
            />
            <ModalBody>
                <Form onSubmit={e => { e.preventDefault(); add() }}>
                    <FormGroup role="group" label={_("Known catalogs")} fieldId="pitstore-presets">
                        {PRESETS.map((p, i) => (
                            <Checkbox
                                key={p.href} id={`pitstore-source-${i}`}
                                isChecked={enabled.has(p.href)}
                                onChange={(_e, on) => toggle(p.href, on)}
                                label={_(p.name)}
                                description={<>{_(p.description)} <code>{p.href.replace(/^https:\/\//, '')}</code></>}
                            />
                        ))}
                    </FormGroup>
                    {custom.length > 0 && (
                        <FormGroup role="group" label={_("Your catalogs")} fieldId="pitstore-custom">
                            {custom.map(href => (
                                <div key={href} className="pitstore-custom-source">
                                    <code>{href}</code>
                                    <Button variant="link" isInline onClick={() => setCustom(custom.filter(c => c !== href))}>{_("Remove")}</Button>
                                </div>
                            ))}
                        </FormGroup>
                    )}
                    <FormGroup label={_("Add a catalog")} fieldId="pitstore-store-url">
                        <InputGroup>
                            <InputGroupItem isFill>
                                <TextInput
                                    id="pitstore-store-url" value={url} placeholder="https://"
                                    validated={urlError ? 'error' : 'default'}
                                    onChange={(_event, value) => { setUrl(value); setUrlError(null) }}
                                />
                            </InputGroupItem>
                            <InputGroupItem>
                                <Button variant="secondary" onClick={add} isDisabled={!url.trim() || sources.length >= MAX_SOURCES}>{_("Add")}</Button>
                            </InputGroupItem>
                        </InputGroup>
                        <FormHelperText>
                            <HelperText>
                                <HelperTextItem variant={urlError ? 'error' : 'default'}>
                                    {urlError ?? _("An https:// address that serves store.json and index.json (app catalog protocol v2).")}
                                </HelperTextItem>
                            </HelperText>
                        </FormHelperText>
                    </FormGroup>
                </Form>
                {sources.length === 0 && <Alert variant="warning" isInline isPlain title={_("Choose at least one catalog")} />}
                {error && <Alert variant="danger" isInline title={_("The catalogs could not be saved")}>{error}</Alert>}
                <Title headingLevel="h3" size="md" className="pitstore-section-title">{_("Order")}</Title>
                <p>{_("When an app is in several catalogs, the first one in this list is shown, unless you installed it from another one.")}</p>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={save} isLoading={busy} isDisabled={busy || sources.length === 0}>{_("Save")}</Button>
                <Button variant="link" onClick={onClose}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};
