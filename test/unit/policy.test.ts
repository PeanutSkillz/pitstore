// SPDX-License-Identifier: LGPL-2.1-or-later

import fs from 'node:fs';
import QUnit from 'qunit';

import type { ComposeFile } from '../../src/lib/compose/parse';
import { evaluatePolicy, FINDING_WARNINGS, normalizePath } from '../../src/lib/policy';

interface Vector {
    description: string;
    compose: ComposeFile;
    findings: string[];
    unsupported: string[];
}

const vectors: Vector[] = JSON.parse(fs.readFileSync('test/policy-vectors/compose.json', 'utf8'));

QUnit.module('policy', () => {
    QUnit.test('shared vectors (same as helper/tests/test_policy.py)', assert => {
        assert.ok(vectors.length > 20, 'vectors loaded');
        for (const v of vectors) {
            const result = evaluatePolicy(v.compose);
            assert.deepEqual(result.findings.map(f => f.key), v.findings, `${v.description}: findings`);
            assert.deepEqual(result.unsupported.map(u => u.path), v.unsupported, `${v.description}: unsupported`);
        }
    });

    QUnit.test('privileged: true is a blocked finding', assert => {
        const compose = {
            services: { app: { image: 'x', privileged: true } },
            'x-casaos': { id: 'a.b', main: 'app', port_map: '80' },
        } as ComposeFile;
        const result = evaluatePolicy(compose);
        assert.deepEqual(result.findings.map(f => f.key), ['app/privileged']);
        assert.equal(result.findings[0].kind, 'privileged');
    });

    QUnit.test('every finding kind has a warning text', assert => {
        for (const v of vectors) {
            for (const f of evaluatePolicy(v.compose).findings)
                assert.ok(FINDING_WARNINGS[f.kind], `warning for ${f.kind}`);
        }
    });

    QUnit.test('normalizePath', assert => {
        assert.equal(normalizePath('//a/./b/../c/'), '/a/c');
        assert.equal(normalizePath('/../../etc'), '/etc');
        assert.equal(normalizePath('/'), '/');
    });
});
