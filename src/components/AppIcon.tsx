// SPDX-License-Identifier: LGPL-2.1-or-later

import React, { useEffect, useState } from 'react';
import { CubesIcon } from '@patternfly/react-icons/dist/esm/icons/cubes-icon.js';

import { loadImage } from '../lib/catalog/catalog';
import type { SourceUrl } from '../lib/catalog/validate';

/* App icon, fetched through the bridge and validated; a placeholder while
 * loading and when the icon is missing or rejected.
 */
export const AppIcon = ({ source, path, size = 48 }: { source: SourceUrl | null; path: string | null; size?: number }) => {
    const [src, setSrc] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        setSrc(null);
        (source ? loadImage(source, path) : Promise.resolve(null)).then(url => {
            if (alive)
                setSrc(url);
        });
        return () => { alive = false };
    }, [source, path]);

    const style = { width: size, height: size };
    return src
        ? <img className="pitstore-app-icon" src={src} alt="" style={style} />
        : <span className="pitstore-app-icon pitstore-app-icon-placeholder" style={style}><CubesIcon /></span>;
};
