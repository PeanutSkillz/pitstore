// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Static checks on the shipped package: menu entries and the
// Content-Security-Policy model of Cockpit.

import fs from 'node:fs';
import QUnit from 'qunit';

const manifest = JSON.parse(fs.readFileSync('src/manifest.json', 'utf8'));
const pages = ['dashboard', 'appstore'];

QUnit.module('manifest', () => {
    QUnit.test('registers exactly the Dashboard and Appstore menu entries', assert => {
        assert.deepEqual(Object.keys(manifest.menu).sort(), ['appstore', 'dashboard']);
        assert.equal(manifest.menu.dashboard.label, 'Dashboard');
        assert.equal(manifest.menu.appstore.label, 'Appstore');
    });

    QUnit.test('adds nothing besides its own menu entries', assert => {
        assert.deepEqual(Object.keys(manifest).sort(), ['menu', 'requires']);
    });

    QUnit.test('keeps the default Cockpit Content-Security-Policy', assert => {
        assert.notOk('content-security-policy' in manifest, 'manifest has no CSP override');
    });
});

QUnit.module('html pages', () => {
    for (const page of pages) {
        const html = fs.readFileSync(`src/${page}.html`, 'utf8');

        QUnit.test(`${page}.html has no inline scripts or handlers`, assert => {
            const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
            assert.ok(scripts.length > 0, 'page loads scripts');
            for (const [, attrs, body] of scripts) {
                assert.ok(/\bsrc="[^":]+"/.test(attrs), 'script uses a relative src');
                assert.equal(body.trim(), '', 'script element has no inline body');
            }
            assert.notOk(/\son[a-z]+\s*=/i.test(html), 'no inline event handlers');
            assert.notOk(/\b(?:src|href)="(?:https?:)?\/\//i.test(html), 'no external resources');
        });
    }
});
