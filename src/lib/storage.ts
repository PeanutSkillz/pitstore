// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Per-user files of PitStore, read and written through the Cockpit bridge as
// the logged-in user:
//   ~/.config/pitstore/settings.json   user settings (no secrets)
//   ~/.cache/pitstore/                  catalog cache (catalog data only)

import cockpit from 'cockpit';

let homePromise: Promise<string> | null = null;

function home(): Promise<string> {
    if (!homePromise) {
        homePromise = cockpit.user().then(user => {
            if (!user.home || !user.home.startsWith('/'))
                throw new Error("cannot determine the home directory");
            return user.home;
        });
    }
    return homePromise;
}

export async function configPath(name: string): Promise<string> {
    return `${await home()}/.config/pitstore/${name}`;
}

export async function cachePath(name: string): Promise<string> {
    return `${await home()}/.cache/pitstore/${name}`;
}

async function ensureParent(path: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf('/'));
    // argv array, no shell; mode 0700 keeps the files private to the user
    await cockpit.spawn(['mkdir', '-p', '-m', '0700', '--', dir], { err: 'message' });
}

export async function readJson<T>(path: string): Promise<T | null> {
    const file = cockpit.file(path, { syntax: JSON });
    try {
        return (await file.read()) as T | null;
    } catch {
        // missing or unparsable: treat as empty
        return null;
    } finally {
        file.close();
    }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
    await ensureParent(path);
    const file = cockpit.file(path, { syntax: JSON });
    try {
        await file.replace(data as cockpit.JsonValue);
    } finally {
        file.close();
    }
}
