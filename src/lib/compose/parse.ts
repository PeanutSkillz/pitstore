// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Strict parsing of untrusted catalog Compose files.

import { parseAllDocuments } from 'yaml';

import { validate_compose } from '../catalog/validators.gen.js';

export const MAX_COMPOSE_BYTES = 256 * 1024;
const MAX_ALIASES = 100;

export class ComposeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ComposeError';
    }
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ComposeFile = { [key: string]: Json } & {
    services: { [name: string]: { [key: string]: Json } };
    'x-casaos': { [key: string]: Json };
};

/* Parse YAML text into plain JSON data. Rejects multiple documents, custom
 * tags, duplicate keys, alias bombs and anything the parser warns about.
 */
export function parseComposeYaml(text: string): ComposeFile {
    if (text.length > MAX_COMPOSE_BYTES)
        throw new ComposeError("Compose file is too large");

    const docs = parseAllDocuments(text, {
        schema: 'core',
        merge: true,
        uniqueKeys: true,
        prettyErrors: false,
        strict: true,
    });
    if (!Array.isArray(docs))
        throw new ComposeError("Compose file is empty");
    if (docs.length !== 1)
        throw new ComposeError("Compose file must contain exactly one YAML document");
    const doc = docs[0];
    const problem = doc.errors[0] ?? doc.warnings[0];
    if (problem)
        throw new ComposeError(`Invalid YAML: ${problem.message}`);

    let data: unknown;
    try {
        data = doc.toJS({ maxAliasCount: MAX_ALIASES });
    } catch (e) {
        throw new ComposeError(`Invalid YAML: ${(e as Error).message}`);
    }
    checkPlainJson(data, '');

    if (!validate_compose(data)) {
        const e = validate_compose.errors?.[0];
        throw new ComposeError(`Compose file is invalid: ${e ? `${e.instancePath || '/'} ${e.message ?? e.keyword}` : 'schema mismatch'}`);
    }
    const compose = data as ComposeFile;
    const services = Object.keys(compose.services);
    // single-service apps in the catalog often omit main
    if (compose['x-casaos'].main === undefined && services.length === 1)
        compose['x-casaos'].main = services[0];
    const main = compose['x-casaos'].main;
    if (typeof main !== 'string' || !services.includes(main))
        throw new ComposeError("x-casaos.main does not name a service");
    return compose;
}

/* After toJS() only plain JSON values may remain: no Dates, Maps, Sets or
 * binary data from YAML extensions, and no prototype-polluting keys.
 */
function checkPlainJson(value: unknown, path: string): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new ComposeError(`Unsupported number at ${path || '/'}`);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((v, i) => checkPlainJson(v, `${path}/${i}`));
        return;
    }
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        for (const [k, v] of Object.entries(value)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype')
                throw new ComposeError(`Forbidden key ${k} at ${path || '/'}`);
            checkPlainJson(v, `${path}/${k}`);
        }
        return;
    }
    throw new ComposeError(`Unsupported YAML value at ${path || '/'}`);
}
