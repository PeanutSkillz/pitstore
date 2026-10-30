// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Talking to pitstore-helper through the Cockpit bridge. The helper runs as
// the logged-in user (rootless Podman) or, for the system Podman and Docker,
// as root through Cockpit's superuser mechanism. The argv is fixed; the
// request travels as JSON on stdin.

import cockpit from 'cockpit';
import { superuser } from 'superuser';

import type { Backend } from './install';

export const HELPER = '/usr/share/cockpit/pitstore/helper/pitstore-helper';

export const BACKENDS: { id: Backend; label: string; admin: boolean }[] = [
    { id: 'podman-user', label: 'Podman (your user, rootless)', admin: false },
    { id: 'podman-system', label: 'Podman (system)', admin: true },
    { id: 'docker', label: 'Docker', admin: true },
];

export interface InstalledApp {
    id: string;
    backend: Backend;
    app: {
        id: string; title?: string; version?: string; icon?: string; store?: string; contentHash?: string;
        main?: string; portMap?: string; scheme?: string; index?: string;
    };
    containers: { name: string; service: string; state: string; status: string; image: string }[];
    installedAt?: string;
}

function target(backend: Backend) {
    return {
        backend: backend === 'docker' ? 'docker' : 'podman',
        scope: backend === 'podman-user' ? 'user' : 'system',
    };
}

export async function callHelper<T = Record<string, unknown>>(
    backend: Backend, verb: string, request: Record<string, unknown>, onProgress?: (message: string) => void
): Promise<T> {
    const proc = cockpit.spawn([HELPER, verb], {
        err: 'message',
        ...(backend === 'podman-user' ? {} : { superuser: 'require' as const }),
    });
    let buffer = '';
    let result: T | null = null;
    let error: string | null = null;
    proc.stream(chunk => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (!line.trim())
                continue;
            try {
                const msg = JSON.parse(line);
                if (msg.type === 'progress')
                    onProgress?.(String(msg.message));
                else if (msg.type === 'result')
                    result = msg as T;
                else if (msg.type === 'error')
                    error = String(msg.message);
            } catch {
                // not ours; ignore
            }
        }
    });
    proc.input(JSON.stringify({ ...request, ...target(backend) }));
    try {
        await proc;
    } catch (e) {
        throw new Error(error ?? (e as Error).message);
    }
    if (error)
        throw new Error(error);
    if (!result)
        throw new Error("The helper returned no result");
    return result;
}

/* Whether this page can currently open superuser channels (Cockpit's
 * "administrative access"). */
export function adminAllowed(): Promise<boolean> {
    return new Promise(resolve => {
        if (superuser.allowed !== null) {
            resolve(superuser.allowed === true);
            return;
        }
        const done = () => {
            superuser.removeEventListener('changed', done);
            resolve(superuser.allowed === true);
        };
        superuser.addEventListener('changed', done);
    });
}

export async function dockerAvailable(): Promise<boolean> {
    try {
        await cockpit.spawn(['test', '-S', '/run/docker.sock'], { err: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/* Make sure the runtime's API socket runs, and that rootless containers
 * survive logout and reboot. Returns warnings for the UI.
 */
export async function prepareRuntime(backend: Backend): Promise<string[]> {
    const warnings: string[] = [];
    if (backend === 'docker')
        return warnings;
    if (backend === 'podman-system') {
        await cockpit.spawn(['systemctl', 'enable', '--now', 'podman.socket'], { superuser: 'require', err: 'message' });
        await cockpit.spawn(['systemctl', 'enable', 'podman-restart.service'], { superuser: 'require', err: 'message' })
                .catch(e => warnings.push(`Apps may not start after a reboot: ${(e as Error).message}`));
        return warnings;
    }
    await cockpit.spawn(['systemctl', '--user', 'enable', '--now', 'podman.socket'], { err: 'message' });
    await cockpit.spawn(['systemctl', '--user', 'enable', 'podman-restart.service'], { err: 'message' })
            .catch(e => warnings.push(`Apps may not start after a reboot: ${(e as Error).message}`));
    const user = await cockpit.user();
    const linger = await cockpit.spawn(['loginctl', 'show-user', user.name, '--property=Linger', '--value'], { err: 'message' })
            .catch(() => '');
    if (linger.trim() !== 'yes') {
        await cockpit.spawn(['loginctl', 'enable-linger', user.name], { err: 'message' })
                .catch(() => warnings.push("Your apps stop when you log out, because lingering could not be enabled for your user. An administrator can run: loginctl enable-linger " + user.name));
    }
    return warnings;
}

export async function listInstalled(backends: Backend[]): Promise<{ apps: InstalledApp[]; errors: string[] }> {
    const apps: InstalledApp[] = [];
    const errors: string[] = [];
    await Promise.all(backends.map(async backend => {
        try {
            const r = await callHelper<{ apps: Omit<InstalledApp, 'backend'>[] }>(backend, 'list', {});
            for (const a of r.apps)
                apps.push({ ...a, app: a.app ?? { id: a.id }, backend });
        } catch (e) {
            const msg = (e as Error).message;
            // a runtime that is not set up yet simply has no apps
            if (!/does not exist|not reachable/.test(msg))
                errors.push(`${backend}: ${msg}`);
        }
    }));
    apps.sort((a, b) => (a.app.title ?? a.id).localeCompare(b.app.title ?? b.id));
    return { apps, errors };
}

/* Overall state of an app: running when every container runs. */
export function appState(app: InstalledApp): 'running' | 'stopped' | 'partial' | 'missing' {
    if (app.containers.length === 0)
        return 'missing';
    const running = app.containers.filter(c => c.state === 'running').length;
    return running === app.containers.length ? 'running' : running === 0 ? 'stopped' : 'partial';
}

export function appUrl(app: InstalledApp): string | null {
    const port = app.app.portMap ?? '';
    if (!/^[0-9]{1,5}$/.test(port))
        return null;
    const scheme = app.app.scheme === 'https' ? 'https' : 'http';
    const index = app.app.index && app.app.index.startsWith('/') ? app.app.index : '/';
    const host = window.location.hostname.includes(':') ? `[${window.location.hostname}]` : window.location.hostname;
    return `${scheme}://${host}:${port}${index}`;
}
