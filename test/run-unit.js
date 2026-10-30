#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Bundle the TypeScript unit tests in test/unit/ with esbuild and run them
// with the QUnit CLI in Node. No browser or Cockpit session is needed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import esbuild from 'esbuild';

import { generateValidators } from '../schemas/generate.js';

const outdir = 'node_modules/.cache/pitstore-unit';
const tests = fs.readdirSync('test/unit')
        .filter(f => f.endsWith('.test.ts'))
        .map(f => path.join('test/unit', f));

generateValidators('src/lib/catalog/validators.gen.js');
fs.rmSync(outdir, { recursive: true, force: true });
await esbuild.build({
    entryPoints: tests,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outdir,
    outExtension: { '.js': '.cjs' },
    nodePaths: ['pkg/lib'],
    external: ['qunit'],
    logLevel: 'warning',
});

const bundles = fs.readdirSync(outdir).map(f => path.join(outdir, f));
const result = spawnSync('node_modules/.bin/qunit', bundles, { stdio: 'inherit' });
process.exit(result.status ?? 1);
