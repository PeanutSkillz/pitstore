// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Building an install plan from a catalog Compose file and the values the
// user entered in the install dialog. Pure functions, no Cockpit access.
//
// The plan is only a proposal: the helper validates everything again
// (policy, confirmations, ports, paths, environment) before it calls the
// container runtime.

import { catalogVariables, interpolateCompose, type Variables } from './compose/interpolate';
import type { ComposeFile, Json } from './compose/parse';
import { SECRET_KEY_RE } from './compose/summary';
import { evaluatePolicy, parseVolume, type PolicyResult } from './policy';

export type Backend = 'podman-user' | 'podman-system' | 'docker';

export const DEFAULT_PASSWORD_SECRET = '@@pitstore-secret:default@@';
const SECRET_MARK = /@@pitstore-secret:[a-z0-9-]{1,32}@@/;

export interface PortField { service: string; index: number; target: number; protocol: string; published: string }
export interface BindField { service: string; index: number; target: string; source: string; readOnly: boolean }
export interface SecretField { service: string; key: string; generate: boolean; value: string }

export interface InstallForm {
    backend: Backend;
    ports: PortField[];
    binds: BindField[];
    variables: Record<string, string>;
    secrets: SecretField[];
    confirmed: string[];
}

export interface InstallContext {
    appId: string;
    dataRoot: string; // e.g. /var/lib/pitstore/data
    puid: number;
    pgid: number;
    tz: string;
}

function asObject(v: Json | undefined): { [key: string]: Json } {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function vars(ctx: InstallContext, variables: Record<string, string>): Variables {
    return {
        ...variables,
        ...catalogVariables({ appId: ctx.appId, puid: ctx.puid, pgid: ctx.pgid, tz: ctx.tz, defaultPassword: DEFAULT_PASSWORD_SECRET }),
    };
}

/* Map CasaOS data paths to PitStore's data root. */
export function mapDataPath(source: string, ctx: InstallContext): string {
    const own = `/DATA/AppData/${ctx.appId}`;
    if (source === own || source.startsWith(own + '/'))
        return ctx.dataRoot + '/' + ctx.appId + source.slice(own.length);
    if (source.startsWith('/DATA/AppData/'))
        return ctx.dataRoot + '/' + ctx.appId + '/' + source.slice('/DATA/AppData/'.length);
    if (source.startsWith('/DATA/'))
        return ctx.dataRoot + '/shared/' + source.slice('/DATA/'.length);
    return source;
}

function parsePortEntry(entry: Json): { target: number; protocol: string; published: string } | null {
    if (typeof entry === 'string') {
        const [spec, protocol = 'tcp'] = entry.split('/');
        const parts = spec.split(':');
        return { target: Number(parts[parts.length - 1]), protocol, published: parts.length >= 2 ? parts[parts.length - 2] : '' };
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry))
        return { target: Number(entry.target), protocol: typeof entry.protocol === 'string' ? entry.protocol : 'tcp', published: entry.published == null ? '' : String(entry.published) };
    return null;
}

function envEntries(env: Json | undefined): [string, string][] {
    if (Array.isArray(env))
        return env.filter((e): e is string => typeof e === 'string' && e.includes('=')).map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]);
    return Object.entries(asObject(env)).filter(([, v]) => v !== null)
            .map(([k, v]) => [k, String(v)]);
}

/* Variables the compose file uses that PitStore does not define. */
export function requiredVariables(compose: ComposeFile, ctx: InstallContext): string[] {
    const missing = new Set<string>();
    interpolateCompose(compose, vars(ctx, {}), missing);
    return [...missing].sort();
}

/* Initial form values, optionally taken over from a previously installed
 * version (its stored compose, with the user's earlier choices).
 */
export function initialForm(compose: ComposeFile, ctx: InstallContext, backend: Backend, previous?: ComposeFile): InstallForm {
    const variables: Record<string, string> = {};
    for (const v of requiredVariables(compose, ctx))
        variables[v] = '';
    const resolved = interpolateCompose(compose, vars(ctx, variables));
    const form: InstallForm = { backend, ports: [], binds: [], variables, secrets: [], confirmed: [] };

    for (const [service, def] of Object.entries(resolved.services)) {
        const prev = previous?.services[service];
        (Array.isArray(def.ports) ? def.ports : []).forEach((entry, index) => {
            const p = parsePortEntry(entry);
            if (!p)
                return;
            const old = (Array.isArray(prev?.ports) ? prev.ports : []).map(parsePortEntry)
                    .find(o => o && o.target === p.target && o.protocol === p.protocol);
            form.ports.push({ service, index, target: p.target, protocol: p.protocol, published: old?.published || p.published });
        });
        (Array.isArray(def.volumes) ? def.volumes : []).forEach((entry, index) => {
            const m = parseVolume(entry);
            if (!m || m.type !== 'bind')
                return;
            const old = (Array.isArray(prev?.volumes) ? prev.volumes : []).map(parseVolume)
                    .find(o => o && o.type === 'bind' && o.target === m.target);
            form.binds.push({ service, index, target: m.target, source: old?.source ?? mapDataPath(m.source, ctx), readOnly: m.readOnly });
        });
        const prevEnv = new Map(envEntries(prev?.environment));
        for (const [key, value] of envEntries(def.environment)) {
            if (!SECRET_KEY_RE.test(key) || value === '' || value.includes(DEFAULT_PASSWORD_SECRET))
                continue;
            const old = prevEnv.get(key);
            const generate = old === undefined || SECRET_MARK.test(old);
            form.secrets.push({ service, key, generate, value: generate ? '' : old });
        }
        // variables used directly as an environment value keep their previous value
        const raw = new Map(envEntries(compose.services[service]?.environment));
        for (const [key, value] of raw) {
            const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value);
            if (m && m[1] in variables && prevEnv.has(key))
                variables[m[1]] = prevEnv.get(key) ?? '';
        }
    }
    return form;
}

async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/* Apply the form to the compose file. Returns the final compose that the
 * helper will receive (with secret placeholders) and its policy verdict.
 */
export async function buildCompose(compose: ComposeFile, form: InstallForm, ctx: InstallContext): Promise<{ compose: ComposeFile; policy: PolicyResult }> {
    const resolved = interpolateCompose(compose, vars(ctx, form.variables));
    const services: ComposeFile['services'] = {};

    // catalog placeholder secrets become helper-generated values; the same
    // literal is replaced everywhere so services that share it stay in sync
    const replacements: [string, string][] = [];
    for (const s of form.secrets) {
        const env = new Map(envEntries(resolved.services[s.service]?.environment));
        const literal = env.get(s.key);
        if (!literal)
            continue;
        if (s.generate) {
            // same length as the catalog's example value (some apps require an exact length)
            const length = Math.min(64, Math.max(24, literal.length));
            const key = 'v' + (await sha256Hex(literal)).slice(0, 12) + '-' + length;
            replacements.push([literal, `@@pitstore-secret:${key}@@`]);
        }
    }
    const longEnough = replacements.filter(([lit]) => lit.length >= 8);

    for (const [name, def] of Object.entries(resolved.services)) {
        const out: { [key: string]: Json } = { ...def };
        if (Array.isArray(def.ports)) {
            out.ports = def.ports.map((entry, index) => {
                const field = form.ports.find(p => p.service === name && p.index === index);
                const p = parsePortEntry(entry);
                if (!field || !p)
                    return entry;
                return { target: p.target, published: field.published.trim(), protocol: p.protocol };
            });
        }
        if (Array.isArray(def.volumes)) {
            out.volumes = def.volumes.map((entry, index) => {
                const field = form.binds.find(b => b.service === name && b.index === index);
                if (!field)
                    return entry;
                return { type: 'bind', source: field.source.trim(), target: field.target, read_only: field.readOnly };
            });
        }
        const env = envEntries(def.environment);
        if (env.length > 0) {
            const map: { [key: string]: Json } = {};
            for (const [key, value] of env) {
                const secret = form.secrets.find(s => s.service === name && s.key === key);
                let v = value;
                if (secret && !secret.generate)
                    v = secret.value;
                else if (secret)
                    v = replacements.find(([lit]) => lit === value)?.[1] ?? value;
                else
                    for (const [lit, mark] of longEnough)
                        v = v.split(lit).join(mark);
                map[key] = v;
            }
            out.environment = map;
        }
        services[name] = out;
    }
    const final = { ...resolved, services } as ComposeFile;
    return { compose: final, policy: evaluatePolicy(final) };
}

export function composeHash(text: string): Promise<string> {
    return sha256Hex(text);
}

/* The published host port of the app's web UI after the user's edits. */
export function webPort(compose: ComposeFile, form: InstallForm): string {
    const x = compose['x-casaos'];
    const portMap = typeof x.port_map === 'string' ? x.port_map : '';
    const main = typeof x.main === 'string' ? x.main : '';
    const original = form.ports.find(p => p.service === main && parsePortEntry((compose.services[main]?.ports as Json[] | undefined)?.[p.index] ?? null)?.published === portMap);
    return original ? original.published : portMap;
}
