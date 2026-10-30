// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Security policy for catalog Compose files.
//
// This is the UI copy of the policy: it decides what the install dialog
// shows. The authoritative copy runs in the helper (helper/pitstore/policy.py)
// before anything reaches the container runtime. Both implement the same
// rules and are tested against the same vectors in test/policy-vectors/.
//
// Result:
//  - findings: options that are blocked by default and need an explicit,
//    per-app confirmation (privileged, host namespaces, capabilities, ...).
//    Each finding has a stable key "<service>/<id>".
//  - unsupported: constructs PitStore cannot run safely or at all; these
//    can never be confirmed.

import type { ComposeFile, Json } from './compose/parse';

export type FindingKind =
    'privileged' | 'net-host' | 'pid-host' | 'ipc-host' | 'ns-host' | 'cap-add' | 'device' |
    'security-opt' | 'sysctl' | 'mount-runtime-socket' | 'mount-sensitive';

export interface Finding {
    key: string; // "<service>/<id>", stable for confirmations
    service: string;
    kind: FindingKind;
    detail: string;
}

export interface Unsupported {
    path: string;
    reason: string;
}

export interface PolicyResult {
    findings: Finding[];
    unsupported: Unsupported[];
}

export const SENSITIVE_PATHS = [
    '/etc', '/root', '/var/run', '/run', '/proc', '/sys', '/dev', '/boot',
    '/var/lib/docker', '/var/lib/containers',
];
export const RUNTIME_SOCKETS = ['docker.sock', 'podman.sock', 'containerd.sock'];

const TOP_LEVEL_KEYS = new Set(['name', 'services', 'x-casaos', 'networks', 'volumes', 'version']);

// service keys PitStore can translate; everything else is unsupported
const SERVICE_KEYS = new Set([
    'image', 'container_name', 'command', 'entrypoint', 'environment', 'ports', 'volumes',
    'restart', 'depends_on', 'healthcheck', 'network_mode', 'networks', 'user', 'working_dir',
    'hostname', 'labels', 'tty', 'stdin_open', 'stop_signal', 'stop_grace_period', 'shm_size',
    'ulimits', 'sysctls', 'deploy', 'cpu_shares', 'extra_hosts', 'init', 'expose', 'cap_drop',
    'tmpfs', 'logging', 'x-casaos',
    // keys that are evaluated as findings below
    'privileged', 'pid', 'ipc', 'uts', 'userns_mode', 'cgroup', 'cap_add', 'devices', 'security_opt',
]);

const UNSUPPORTED_REASONS: Record<string, string> = {
    build: "building images is not supported",
    env_file: "environment files are not supported",
    configs: "Compose configs are not supported",
    secrets: "Compose secrets are not supported",
    profiles: "Compose profiles are not supported",
    extends: "extends is not supported",
    runtime: "alternative container runtimes are not supported",
    volumes_from: "volumes_from is not supported",
    links: "links are not supported",
    external_links: "external links are not supported",
    group_add: "additional groups are not supported",
};

const NO_NEW_PRIVILEGES = new Set(['no-new-privileges', 'no-new-privileges:true', 'no-new-privileges=true']);
const LOG_DRIVERS = new Set(['json-file', 'journald', 'local', 'k8s-file']);

/* Lexically normalize an absolute POSIX path ("//a/./b/../c/" -> "/a/c"). */
export function normalizePath(path: string): string {
    const out: string[] = [];
    for (const seg of path.split('/')) {
        if (seg === '' || seg === '.')
            continue;
        if (seg === '..')
            out.pop();
        else
            out.push(seg);
    }
    return '/' + out.join('/');
}

function isUnder(path: string, prefix: string): boolean {
    return prefix === '/' || path === prefix || path.startsWith(prefix + '/');
}

/* Parse one entry of services.<s>.volumes into a mount description. */
export function parseVolume(entry: Json): { type: 'bind' | 'volume' | 'tmpfs'; source: string; target: string } | null {
    if (typeof entry === 'string') {
        const parts = entry.split(':');
        if (parts.length === 1)
            return { type: 'volume', source: '', target: parts[0] };
        if (parts.length > 3)
            return null;
        const [source, target] = parts;
        if (!source || !target)
            return null;
        const type = source.startsWith('/') || source.startsWith('.') || source.startsWith('~') ? 'bind' : 'volume';
        return { type, source, target };
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const type = entry.type;
        const source = typeof entry.source === 'string' ? entry.source : '';
        const target = typeof entry.target === 'string' ? entry.target : '';
        if (!target || (type !== 'bind' && type !== 'volume' && type !== 'tmpfs'))
            return null;
        if (type === 'bind' && !source)
            return null;
        return { type, source, target };
    }
    return null;
}

function asList(value: Json | undefined): Json[] {
    if (value === undefined || value === null)
        return [];
    return Array.isArray(value) ? value : [value];
}

export function evaluatePolicy(compose: ComposeFile): PolicyResult {
    const findings: Finding[] = [];
    const unsupported: Unsupported[] = [];
    const finding = (service: string, kind: FindingKind, detail: string) => {
        const id = detail ? `${kind}:${detail}` : kind;
        findings.push({ key: `${service}/${id}`, service, kind, detail });
    };
    const reject = (path: string, reason: string) => unsupported.push({ path, reason });

    for (const key of Object.keys(compose)) {
        if (!TOP_LEVEL_KEYS.has(key))
            reject(key, UNSUPPORTED_REASONS[key] ?? "unknown top-level key");
    }

    // top-level named volumes: no drivers or driver options (driver_opts can
    // turn a named volume into an arbitrary bind mount)
    for (const [name, def] of Object.entries(asObject(compose.volumes))) {
        if (def === null)
            continue;
        if (typeof def !== 'object' || Array.isArray(def)) {
            reject(`volumes.${name}`, "invalid volume definition");
            continue;
        }
        for (const k of Object.keys(def)) {
            if (k !== 'name')
                reject(`volumes.${name}.${k}`, "volume drivers and options are not supported");
        }
    }

    for (const [name, def] of Object.entries(asObject(compose.networks))) {
        if (def === null)
            continue;
        if (typeof def !== 'object' || Array.isArray(def)) {
            reject(`networks.${name}`, "invalid network definition");
            continue;
        }
        for (const [k, v] of Object.entries(def)) {
            // internal: true only removes outside access, so it is safe
            if (k === 'name' || (k === 'driver' && v === 'bridge') || (k === 'internal' && typeof v === 'boolean'))
                continue;
            reject(`networks.${name}.${k}`, "only plain bridge networks are supported");
        }
    }

    for (const [svc, def] of Object.entries(compose.services)) {
        const p = `services.${svc}`;

        for (const key of Object.keys(def)) {
            if (!SERVICE_KEYS.has(key))
                reject(`${p}.${key}`, UNSUPPORTED_REASONS[key] ?? "unknown service key");
        }

        if (def.privileged === true)
            finding(svc, 'privileged', '');
        else if (def.privileged !== undefined && def.privileged !== false)
            reject(`${p}.privileged`, "privileged must be a boolean");

        const net = def.network_mode;
        if (net === 'host')
            finding(svc, 'net-host', '');
        else if (net !== undefined && net !== 'bridge' && net !== 'default' && net !== 'none')
            reject(`${p}.network_mode`, "only bridge, default, none or host networking is supported");

        for (const [key, kind] of [['pid', 'pid-host'], ['ipc', 'ipc-host']] as const) {
            const v = def[key];
            if (v === 'host')
                finding(svc, kind, '');
            else if (v !== undefined && !(key === 'ipc' && (v === 'private' || v === 'shareable')))
                reject(`${p}.${key}`, `${key} mode ${String(v)} is not supported`);
        }
        for (const key of ['uts', 'userns_mode', 'cgroup']) {
            const v = def[key];
            if (v === 'host')
                finding(svc, 'ns-host', key);
            else if (v !== undefined && !(key === 'cgroup' && v === 'private'))
                reject(`${p}.${key}`, `${key} mode ${String(v)} is not supported`);
        }

        for (const cap of asList(def.cap_add)) {
            if (typeof cap !== 'string' || !/^(?:CAP_)?[A-Za-z_]+$/.test(cap)) {
                reject(`${p}.cap_add`, "invalid capability");
                continue;
            }
            finding(svc, 'cap-add', cap.toUpperCase().replace(/^CAP_/, ''));
        }

        for (const dev of asList(def.devices)) {
            const host = typeof dev === 'string' ? dev.split(':')[0] : '';
            if (!host.startsWith('/')) {
                reject(`${p}.devices`, "invalid device mapping");
                continue;
            }
            finding(svc, 'device', normalizePath(host));
        }

        for (const opt of asList(def.security_opt)) {
            if (typeof opt !== 'string') {
                reject(`${p}.security_opt`, "invalid security option");
                continue;
            }
            if (!NO_NEW_PRIVILEGES.has(opt))
                finding(svc, 'security-opt', opt);
        }

        const sysctls = def.sysctls;
        if (sysctls !== undefined) {
            const keys = Array.isArray(sysctls)
                ? sysctls.map(s => (typeof s === 'string' ? s.split('=')[0] : ''))
                : Object.keys(asObject(sysctls));
            for (const k of keys) {
                if (!/^[a-z0-9_.]+$/i.test(k))
                    reject(`${p}.sysctls`, "invalid sysctl");
                else if (!k.startsWith('net.'))
                    finding(svc, 'sysctl', k);
            }
        }

        for (const entry of asList(def.volumes)) {
            const mount = parseVolume(entry);
            if (!mount) {
                reject(`${p}.volumes`, "invalid volume entry");
                continue;
            }
            if (mount.type !== 'bind')
                continue;
            if (!mount.source.startsWith('/')) {
                reject(`${p}.volumes`, `relative bind mount ${mount.source} is not supported`);
                continue;
            }
            const source = normalizePath(mount.source);
            const base = source.split('/').pop() ?? '';
            if (RUNTIME_SOCKETS.includes(base)) {
                finding(svc, 'mount-runtime-socket', source);
                continue;
            }
            // a system directory, anything below it, or a parent of it (like / or /var)
            if (SENSITIVE_PATHS.some(s => isUnder(source, s) || isUnder(s, source)))
                finding(svc, 'mount-sensitive', source);
        }

        const deploy = def.deploy;
        if (deploy !== undefined) {
            const d = asObject(deploy);
            for (const k of Object.keys(d)) {
                if (k !== 'resources')
                    reject(`${p}.deploy.${k}`, "only deploy.resources is supported");
            }
            const res = asObject(d.resources);
            for (const k of Object.keys(res)) {
                if (k !== 'limits' && k !== 'reservations') {
                    reject(`${p}.deploy.resources.${k}`, "unknown resource key");
                    continue;
                }
                for (const rk of Object.keys(asObject(res[k]))) {
                    if (rk !== 'memory' && rk !== 'cpus')
                        reject(`${p}.deploy.resources.${k}.${rk}`, "only memory and cpus resources are supported");
                }
            }
        }

        if (def.logging !== undefined) {
            const driver = asObject(def.logging).driver;
            if (driver !== undefined && !(typeof driver === 'string' && LOG_DRIVERS.has(driver)))
                reject(`${p}.logging`, "only local log drivers are supported");
        }

        for (const n of asList(Array.isArray(def.networks) ? def.networks : Object.keys(asObject(def.networks)))) {
            if (typeof n !== 'string' || (n !== 'default' && !(n in asObject(compose.networks))))
                reject(`${p}.networks`, `network ${String(n)} is not defined`);
        }
    }

    // deduplicate and sort by code unit, exactly like the Python helper
    const byKey = new Map(findings.map(f => [f.key, f]));
    const byPath = new Map<string, Unsupported>();
    for (const u of unsupported) {
        if (!byPath.has(u.path))
            byPath.set(u.path, u);
    }
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return {
        findings: [...byKey.values()].sort((a, b) => cmp(a.key, b.key)),
        unsupported: [...byPath.values()].sort((a, b) => cmp(a.path, b.path)),
    };
}

function asObject(value: Json | undefined): { [key: string]: Json } {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/* Fixed English risk warnings for the UI, one per finding kind. */
export const FINDING_WARNINGS: Record<FindingKind, string> = {
    privileged: "Runs the container with all privileges. A compromised app can take over the whole server.",
    'net-host': "Uses the host network directly. The app can listen on any port and see all network traffic of the server.",
    'pid-host': "Shares the process list of the host. The app can see and signal every process on the server.",
    'ipc-host': "Shares inter-process communication with the host.",
    'ns-host': "Shares a kernel namespace with the host, which weakens container isolation.",
    'cap-add': "Grants an extra Linux capability, which weakens container isolation.",
    device: "Gives the container direct access to a host device.",
    'security-opt': "Changes or disables a security confinement (AppArmor, SELinux, seccomp).",
    sysctl: "Changes a kernel setting that is not limited to the container's network namespace.",
    'mount-runtime-socket': "Mounts the container runtime socket. This gives the app full control over the server (root access).",
    'mount-sensitive': "Mounts a system directory of the host into the container.",
};
