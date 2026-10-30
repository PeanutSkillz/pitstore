// SPDX-License-Identifier: LGPL-2.1-or-later

import React from 'react';
import { EmptyState, EmptyStateBody } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Page, PageSection } from '@patternfly/react-core/dist/esm/components/Page/index.js';
import { Content } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import { CatalogIcon } from '@patternfly/react-icons/dist/esm/icons/catalog-icon.js';

import cockpit from 'cockpit';

const _ = cockpit.gettext;

export const AppstorePage = () => (
    <Page className='pf-m-no-sidebar'>
        <PageSection>
            <Content component="h1">{_("Appstore")}</Content>
        </PageSection>
        <PageSection>
            <EmptyState headingLevel="h2" titleText={_("Catalog not loaded yet")} icon={CatalogIcon}>
                <EmptyStateBody>{_("The app catalog will be shown here.")}</EmptyStateBody>
            </EmptyState>
        </PageSection>
    </Page>
);
