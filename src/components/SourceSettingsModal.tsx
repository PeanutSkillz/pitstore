// SPDX-License-Identifier: LGPL-2.1-or-later

import React, { useState } from 'react';
import { Button } from '@patternfly/react-core/dist/esm/components/Button/index.js';
import { Form, FormGroup, FormHelperText } from '@patternfly/react-core/dist/esm/components/Form/index.js';
import { HelperText, HelperTextItem } from '@patternfly/react-core/dist/esm/components/HelperText/index.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core/dist/esm/components/Modal/index.js';
import { TextInput } from '@patternfly/react-core/dist/esm/components/TextInput/index.js';

import cockpit from 'cockpit';

import { DEFAULT_STORE_URL, saveSettings, type Settings } from '../lib/settings';

const _ = cockpit.gettext;

export const SourceSettingsModal = ({ settings, onClose, onSaved }: {
    settings: Settings;
    onClose: () => void;
    onSaved: (settings: Settings) => void;
}) => {
    const [url, setUrl] = useState(settings.storeUrl);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const save = () => {
        setBusy(true);
        saveSettings({ storeUrl: url })
                .then(saved => onSaved(saved))
                .catch(e => {
                    setError((e as Error).message);
                    setBusy(false);
                });
    };

    return (
        <Modal isOpen variant="medium" onClose={onClose} aria-labelledby="pitstore-source-title">
            <ModalHeader title={_("App catalog source")} labelId="pitstore-source-title" />
            <ModalBody>
                <Form onSubmit={e => { e.preventDefault(); save() }}>
                    <FormGroup label={_("Store URL")} fieldId="pitstore-store-url" isRequired>
                        <TextInput
                            id="pitstore-store-url"
                            value={url}
                            validated={error ? 'error' : 'default'}
                            onChange={(_event, value) => { setUrl(value); setError(null) }}
                        />
                        <FormHelperText>
                            <HelperText>
                                <HelperTextItem variant={error ? 'error' : 'default'}>
                                    {error ?? _("An https:// address that serves store.json and index.json (CasaOS AppStore protocol v2). The catalog is fetched by the server, not by your browser.")}
                                </HelperTextItem>
                            </HelperText>
                        </FormHelperText>
                    </FormGroup>
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={save} isLoading={busy} isDisabled={busy}>{_("Save")}</Button>
                <Button variant="secondary" onClick={() => { setUrl(DEFAULT_STORE_URL); setError(null) }}>{_("Use default")}</Button>
                <Button variant="link" onClick={onClose}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};
