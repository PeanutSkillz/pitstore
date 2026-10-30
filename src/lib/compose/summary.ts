// SPDX-License-Identifier: LGPL-2.1-or-later
//
// A human-readable summary of what a catalog Compose file would run, for the
// app details view: images, published ports, mounts and settings the user
// will have to provide.

import { parseVolume } from '../policy';
import type { ComposeFile, Json } from './parse';

export interface ComposeSummary {
    services: { name: string; image: string }[];
    ports: { service: string; published: string; target: string; protocol: string }[];
    mounts: { service: string; type: 'bind' | 'volume' | 'tmpfs'; source: string; target: string }[];
    secretEnv: { service: string; key: string }[];
}

// environment keys that hold credentials; the catalog ships placeholders
export const SECRET_KEY_RE = /(?:PASS(?:WORD)?|SECRET|TOKEN|KEY|SALT)$/i;

function parsePort(entry: Json): { published: string; target: string; protocol: string } | null {
    if (typeof entry === 'number')
        return { published: '', target: String(entry), protocol: 'tcp' };
    if (typeof entry === 'string') {
        const [spec, protocol = 'tcp'] = entry.split('/');
        const parts = spec.split(':');
        const target = parts[parts.length - 1];
        const published = parts.length >= 2 ? parts[parts.length - 2] : '';
        return { published, target, protocol };
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        return {
            published: entry.published === undefined || entry.published === null ? '' : String(entry.published),
            target: String(entry.target ?? ''),
            protocol: typeof entry.protocol === 'string' ? entry.protocol : 'tcp',
        };
    }
    return null;
}

export function summarizeCompose(compose: ComposeFile): ComposeSummary {
    const summary: ComposeSummary = { services: [], ports: [], mounts: [], secretEnv: [] };
    for (const [name, def] of Object.entries(compose.services)) {
        summary.services.push({ name, image: String(def.image) });

        for (const entry of Array.isArray(def.ports) ? def.ports : []) {
            const port = parsePort(entry);
            if (port)
                summary.ports.push({ service: name, ...port });
        }
        for (const entry of Array.isArray(def.volumes) ? def.volumes : []) {
            const mount = parseVolume(entry);
            if (mount)
                summary.mounts.push({ service: name, ...mount });
        }

        const env = def.environment;
        const keys = Array.isArray(env)
            ? env.map(e => (typeof e === 'string' ? e.split('=')[0] : ''))
            : env && typeof env === 'object' ? Object.keys(env) : [];
        for (const key of keys) {
            if (SECRET_KEY_RE.test(key))
                summary.secretEnv.push({ service: name, key });
        }
    }
    return summary;
}
