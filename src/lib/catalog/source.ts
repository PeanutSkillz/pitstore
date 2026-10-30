// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Fetching catalog documents through the Cockpit bridge. The request is made
// by cockpit-bridge on the server (cockpit.http with TLS and system CA
// validation), not by the browser, so the page keeps connect-src 'self'.
// Redirects are not followed, and every response has a size limit.

import cockpit from 'cockpit';

import { CatalogError, type SourceUrl } from './validate';

const TIMEOUT_MS = 30000;

// cockpit.d.ts does not declare the streaming helpers of a request
interface StreamingRequest<T> extends Promise<T> {
    stream(callback: (data: T) => number): StreamingRequest<T>;
    response(callback: (status: number, headers: Record<string, string>) => void): StreamingRequest<T>;
    close(problem?: string): StreamingRequest<T>;
}

function header(headers: Record<string, string>, name: string): string {
    const key = Object.keys(headers).find(k => k.toLowerCase() === name);
    return key ? headers[key] : '';
}

async function fetchRaw<T extends string | Uint8Array>(
    source: SourceUrl, path: string, maxBytes: number, binary: boolean
): Promise<{ body: T; contentType: string }> {
    if (!/^\/[A-Za-z0-9._~@/-]*$/.test(path) || path.split('/').includes('..'))
        throw new CatalogError(`Refusing to fetch unexpected path ${path}`);

    const client = binary
        ? cockpit.http(String(source.port), { address: source.host, tls: {}, binary: true })
        : cockpit.http(String(source.port), { address: source.host, tls: {} });
    let contentType = '';
    let tooLarge = false;
    const request = client.request({
        method: 'GET',
        path: source.basePath + path,
        body: '',
        headers: { Accept: binary ? 'image/*' : 'application/json, text/yaml, text/plain' },
    }) as unknown as StreamingRequest<T>;

    request.response((_status, headers) => {
        contentType = header(headers ?? {}, 'content-type');
    });
    // the bridge hands us everything buffered so far; consuming nothing keeps
    // the whole body for the final result while we watch its size
    request.stream(data => {
        if (data.length > maxBytes) {
            tooLarge = true;
            request.close('too-large');
        }
        return 0;
    });
    const timer = window.setTimeout(() => request.close('timeout'), TIMEOUT_MS);

    try {
        const body = await request;
        if (body.length > maxBytes)
            tooLarge = true;
        if (tooLarge)
            throw new CatalogError(`${path} is larger than ${maxBytes} bytes`);
        return { body, contentType };
    } catch (e) {
        if (e instanceof CatalogError)
            throw e;
        if (tooLarge)
            throw new CatalogError(`${path} is larger than ${maxBytes} bytes`);
        const err = e as { problem?: string; status?: number; message?: string };
        if (err.problem === 'timeout')
            throw new CatalogError(`Timed out fetching ${path} from ${source.host}`);
        if (err.status)
            throw new CatalogError(`${source.host} answered HTTP ${err.status} for ${path}`);
        throw new CatalogError(`Could not fetch ${path} from ${source.host}: ${err.message ?? err.problem ?? String(e)}`);
    } finally {
        window.clearTimeout(timer);
        client.close();
    }
}

export async function fetchJson(source: SourceUrl, path: string, maxBytes: number): Promise<unknown> {
    const { body } = await fetchRaw<string>(source, path, maxBytes, false);
    try {
        return JSON.parse(body);
    } catch {
        throw new CatalogError(`${path} is not valid JSON`);
    }
}

export async function fetchText(source: SourceUrl, path: string, maxBytes: number): Promise<string> {
    return (await fetchRaw<string>(source, path, maxBytes, false)).body;
}

export async function fetchBytes(source: SourceUrl, path: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string }> {
    const { body, contentType } = await fetchRaw<Uint8Array>(source, path, maxBytes, true);
    return { bytes: body, contentType };
}
