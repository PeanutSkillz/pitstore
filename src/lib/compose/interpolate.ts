// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Compose variable interpolation ($VAR, ${VAR}, ${VAR:-default}, $$) with a
// closed set of variables. Unlike docker compose, an unknown variable without
// a default is an error instead of an empty string.

import { ComposeError, type ComposeFile, type Json } from './parse';

export type Variables = Readonly<Record<string, string>>;

/* The variables CasaOS defines for catalog apps (CasaOS-AppManagement
 * service/compose_service.go baseInterpolationMap, plus AppID).
 */
export function catalogVariables(ctx: {
    appId: string; puid: number; pgid: number; tz: string; defaultPassword: string;
}): Variables {
    return {
        AppID: ctx.appId,
        PUID: String(ctx.puid),
        PGID: String(ctx.pgid),
        TZ: ctx.tz,
        DefaultUserName: 'admin',
        DefaultPassword: ctx.defaultPassword,
    };
}

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const TOKEN = new RegExp(`\\$(?:(\\$)|(${NAME})|\\{(${NAME})(?:(:?[-?+])([^}]*))?\\})|\\$`, 'g');

/* With `missing`, unknown variables are recorded there and replaced by an
 * empty string (used for previews, where the user has not entered values
 * yet). Without it, unknown variables are an error.
 */
export function interpolateString(input: string, vars: Variables, where = '', missing?: Set<string>): string {
    return input.replace(TOKEN, (match, dollar, bare, braced, op, arg) => {
        if (dollar)
            return '$';
        const name = bare ?? braced;
        if (name === undefined)
            throw new ComposeError(`Invalid variable syntax at ${where || '/'}: ${input.slice(0, 80)}`);
        const has = Object.prototype.hasOwnProperty.call(vars, name);
        const value = has ? vars[name] : undefined;
        const set = value !== undefined && (op?.startsWith(':') ? value !== '' : true);

        switch (op) {
        case undefined: case ':?': case '?':
            if (value !== undefined && (op === undefined || set))
                return value;
            if (missing && !has) {
                missing.add(name);
                return '';
            }
            throw new ComposeError(op === undefined
                ? `Unknown variable $${name} at ${where || '/'}`
                : `Required variable $${name} is not set at ${where || '/'}`);
        case ':-': case '-':
            return set ? value : interpolateString(arg, vars, where, missing);
        case ':+': case '+':
            return set ? interpolateString(arg, vars, where, missing) : '';
        default:
            throw new ComposeError(`Invalid variable syntax at ${where || '/'}: ${match}`);
        }
    });
}

function walk(value: Json, vars: Variables, path: string, missing?: Set<string>): Json {
    if (typeof value === 'string')
        return interpolateString(value, vars, path, missing);
    if (Array.isArray(value))
        return value.map((v, i) => walk(v, vars, `${path}/${i}`, missing));
    if (value !== null && typeof value === 'object') {
        const out: { [key: string]: Json } = {};
        for (const [k, v] of Object.entries(value))
            out[k] = walk(v, vars, `${path}/${k}`, missing);
        return out;
    }
    return value;
}

/* Interpolate the runtime parts of a Compose file. Keys are not interpolated,
 * and the x-casaos metadata is left as it is.
 */
export function interpolateCompose(compose: ComposeFile, vars: Variables, missing?: Set<string>): ComposeFile {
    const out: { [key: string]: Json } = { ...compose };
    for (const key of ['services', 'volumes', 'networks']) {
        if (key in compose)
            out[key] = walk(compose[key], vars, `/${key}`, missing);
    }
    return out as ComposeFile;
}
