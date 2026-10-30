// SPDX-License-Identifier: LGPL-2.1-or-later

import React from 'react';
import { EmptyState, EmptyStateBody } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Page, PageSection } from '@patternfly/react-core/dist/esm/components/Page/index.js';
import { Content } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import { CubesIcon } from '@patternfly/react-icons/dist/esm/icons/cubes-icon.js';

import cockpit from 'cockpit';

const _ = cockpit.gettext;

export const DashboardPage = () => (
    <Page className='pf-m-no-sidebar'>
        <PageSection>
            <Content component="h1">{_("Dashboard")}</Content>
        </PageSection>
        <PageSection>
            <EmptyState headingLevel="h2" titleText={_("No apps installed")} icon={CubesIcon}>
                <EmptyStateBody>{_("Apps you install from the Appstore will appear here.")}</EmptyStateBody>
            </EmptyState>
        </PageSection>
    </Page>
);
