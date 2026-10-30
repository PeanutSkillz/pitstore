// SPDX-License-Identifier: LGPL-2.1-or-later

import QUnit from 'qunit';

import { checkSvg, detectImage, toDataUrl } from '../../src/lib/catalog/images';
import { appToIndexEntry, CatalogError, parseIndex, parseMeta, parseSourceUrl, parseStore } from '../../src/lib/catalog/validate';

function app(id: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        title: 'Demo',
        tagline: 'A demo app',
        category: 'Productivity',
        author: 'someone',
        developer: 'upstream',
        architectures: ['amd64', 'arm64'],
        icon: `/apps/${id}/assets/icon.svg`,
        compose_url: `/apps/${id}/docker-compose.yml`,
        meta_url: `/apps/${id}/meta.json`,
        content_hash: 'abc123',
        version: '1.0.0',
        ...extra,
    };
}

QUnit.module('source url', () => {
    QUnit.test('accepts and normalizes https store URLs', assert => {
        const src = parseSourceUrl('https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@gh-pages/');
        assert.equal(src.host, 'cdn.jsdelivr.net');
        assert.equal(src.port, 443);
        assert.equal(src.basePath, '/gh/IceWhaleTech/CasaOS-AppStore@gh-pages');
        assert.equal(src.href, 'https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@gh-pages');
        assert.equal(parseSourceUrl('https://store.example.org:8443').port, 8443);
    });

    for (const bad of [
        'http://store.example.org', 'ftp://store.example.org', 'https://user:pw@store.example.org',
        'https://store.example.org/?x=1', 'https://store.example.org/#a', 'https://127.0.0.1/',
        'https://[::1]/', 'https://localhost/', 'https://store.example.org/a b', 'not a url', 'javascript:alert(1)',
    ]) {
        QUnit.test(`rejects ${bad}`, assert => {
            assert.throws(() => parseSourceUrl(bad), CatalogError);
        });
    }
});

QUnit.module('store and index', () => {
    QUnit.test('store.json with localized name', assert => {
        const store = parseStore({ version: 2, store_id: 'My-Store', name: { nl_NL: 'Winkel', en_US: 'Store' }, maintainer: 'me' }, 'nl_NL');
        assert.equal(store.id, 'my-store');
        assert.equal(store.name, 'Winkel');
    });

    QUnit.test('store.json must be protocol v2', assert => {
        assert.throws(() => parseStore({ version: 1, store_id: 'x', name: 'x' }), /invalid/);
    });

    QUnit.test('valid apps are kept, broken apps are dropped and reported', assert => {
        const { apps, rejected } = parseIndex({
            version: 2,
            apps: [
                app('org.example.good'),
                app('org.example.good'),
                app('BadID'),
                app('org.example.escape', { compose_url: '/apps/org.example.other/docker-compose.yml' }),
                app('org.example.dots', { meta_url: '/apps/org.example.dots/../../etc/passwd' }),
                app('org.example.abs', { icon: 'https://evil.example/icon.svg' }),
                app('org.example.long', { title: 'x'.repeat(500) }),
                { id: 'org.example.missing' },
            ],
        });
        assert.deepEqual(apps.map(a => a.id), ['org.example.good', 'org.example.abs']);
        assert.deepEqual(rejected.map(r => r.id), [
            'org.example.good', 'BadID', 'org.example.escape', 'org.example.dots',
            'org.example.long', 'org.example.missing',
        ]);
        assert.equal(apps[0].icon, '/apps/org.example.good/assets/icon.svg');
        assert.equal(apps[1].icon, null, 'icons outside the app directory are dropped');
    });

    QUnit.test('validated apps survive a round trip through the cache form', assert => {
        const first = parseIndex({
            version: 2,
            apps: [app('org.example.a'), app('org.example.noversion', { version: undefined, icon: '' })],
        });
        assert.equal(first.apps.length, 2);
        const second = parseIndex({ version: 2, apps: first.apps.map(appToIndexEntry) });
        assert.deepEqual(second.apps, first.apps);
        assert.deepEqual(second.rejected, []);
    });

    QUnit.test('a broken index document is rejected as a whole', assert => {
        assert.throws(() => parseIndex({ version: 2 }), /index.json is invalid/);
        assert.throws(() => parseIndex({ version: 2, apps: 'x' }), /index.json is invalid/);
        assert.throws(() => parseIndex([]), /index.json is invalid/);
    });
});

QUnit.module('meta', () => {
    QUnit.test('keeps https links and app-local screenshots only', assert => {
        const meta = parseMeta({
            description: '**Bold** text',
            website: 'https://example.org',
            repo: 'javascript:alert(1)',
            support: 'http://insecure.example.org',
            docs: 'https://user:pw@example.org',
            screenshot_link: ['/apps/org.example.a/assets/s1.webp', '/apps/org.example.b/assets/s2.webp'],
        }, 'org.example.a');
        assert.deepEqual(meta.links, [{ label: 'Website', url: 'https://example.org/' }]);
        assert.deepEqual(meta.screenshots, ['/apps/org.example.a/assets/s1.webp']);
    });

    QUnit.test('tolerates empty thumbnails and odd tips seen in the live catalog', assert => {
        assert.deepEqual(parseMeta({ thumbnail: '', tips: null }, 'org.example.a').tips, {});
        const meta = parseMeta({ thumbnail: '', tips: { before_install: 'a', en_US: 'b', zh_CN: 'c', de_DE: 'd' } }, 'org.example.a');
        assert.deepEqual(meta.tips, { before_install: 'a', en_US: 'b' });
    });

    QUnit.test('rejects oversized descriptions', assert => {
        assert.throws(() => parseMeta({ description: 'x'.repeat(70000) }, 'org.example.a'), /meta.json is invalid/);
    });
});

const enc = (s: string) => new TextEncoder().encode(s);

QUnit.module('images', () => {
    QUnit.test('detects raster images by magic bytes', assert => {
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
        assert.equal(detectImage(png, 'image/png'), 'image/png');
        assert.equal(detectImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg; charset=x'), 'image/jpeg');
        const webp = enc('RIFF\0\0\0\0WEBPVP8 ');
        assert.equal(detectImage(webp, 'image/webp'), 'image/webp');
    });

    QUnit.test('declared type must match the content', assert => {
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        assert.throws(() => detectImage(png, 'image/svg+xml'), /does not match/);
        assert.throws(() => detectImage(enc('<html><script>x</script>'), 'text/html'), /not an SVG/);
        assert.throws(() => detectImage(new Uint8Array(600 * 1024), 'image/png'), /out of range/);
    });

    QUnit.test('accepts a plain SVG with internal references', assert => {
        const svg = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
            '<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/><use xlink:href=\'#g\'/></svg>';
        assert.equal(detectImage(enc(svg), 'image/svg+xml'), 'image/svg+xml');
    });

    for (const [name, svg] of [
        ['script', '<svg><script>alert(1)</script></svg>'],
        ['event handler', '<svg onload="alert(1)"></svg>'],
        ['foreignObject', '<svg><foreignObject><div/></foreignObject></svg>'],
        ['external href', '<svg><image href="https://evil.example/x.png"/></svg>'],
        ['unquoted external href', '<svg><a href=https://evil.example>x</a></svg>'],
        ['javascript url', '<svg><a xlink:href="javascript:alert(1)">x</a></svg>'],
        ['external css url', '<svg><rect style="fill:url(https://evil.example/x)"/></svg>'],
        ['css import', '<svg><style>@import "https://evil.example/x.css";</style></svg>'],
        ['entities', '<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>'],
        ['svg data url', '<svg><image href="data:image/svg+xml;base64,PHN2Zz4="/></svg>'],
    ]) {
        QUnit.test(`rejects SVG with ${name}`, assert => {
            assert.throws(() => checkSvg(svg));
        });
    }

    QUnit.test('data URLs', assert => {
        assert.equal(toDataUrl(enc('<svg/>'), 'image/svg+xml'), 'data:image/svg+xml;base64,PHN2Zy8+');
    });
});
