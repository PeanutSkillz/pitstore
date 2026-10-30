// SPDX-License-Identifier: LGPL-2.1-or-later

import React, { useEffect, useRef, useState } from 'react';
import { CubesIcon } from '@patternfly/react-icons/dist/esm/icons/cubes-icon.js';

import { loadImage } from '../lib/catalog/catalog';
import type { SourceUrl } from '../lib/catalog/validate';

/* App icon, fetched through the bridge and validated; a placeholder while
 * loading and when the icon is missing or rejected.
 */
export const AppIcon = ({ source, path, size = 48 }: { source: SourceUrl | null; path: string | null; size?: number }) => {
    const [src, setSrc] = useState<string | null>(null);
    const [visible, setVisible] = useState(false);
    const ref = useRef<HTMLSpanElement>(null);

    // fetch only once the icon is (nearly) on screen: catalogs have hundreds
    useEffect(() => {
        const el = ref.current;
        if (!el || visible)
            return;
        if (typeof IntersectionObserver === 'undefined') {
            setVisible(true);
            return;
        }
        const observer = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) {
                setVisible(true);
                observer.disconnect();
            }
        }, { rootMargin: '200px' });
        observer.observe(el);
        return () => observer.disconnect();
    }, [visible]);

    useEffect(() => {
        if (!visible)
            return;
        let alive = true;
        setSrc(null);
        (source ? loadImage(source, path) : Promise.resolve(null)).then(url => {
            if (alive)
                setSrc(url);
        });
        return () => { alive = false };
    }, [source, path, visible]);

    const style = { width: size, height: size };
    return src
        ? <img className="pitstore-app-icon" src={src} alt="" style={style} />
        : <span ref={ref} className="pitstore-app-icon pitstore-app-icon-placeholder" style={style}><CubesIcon /></span>;
};
