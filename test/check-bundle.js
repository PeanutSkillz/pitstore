#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Fail if the built bundles contain dynamic code evaluation, which Cockpit's
// Content-Security-Policy forbids and which PitStore must never need.

import fs from 'node:fs';
import process from 'node:process';
import zlib from 'node:zlib';

const FORBIDDEN = [/\beval\s*\(/, /new\s+Function\s*\(/, /[^\w$.]Function\s*\(\s*["'`]/];
let failed = false;
for (const name of fs.readdirSync('dist')) {
    if (!/\.js(\.gz)?$/.test(name))
        continue;
    let code = fs.readFileSync(`dist/${name}`);
    if (name.endsWith('.gz'))
        code = zlib.gunzipSync(code);
    for (const re of FORBIDDEN) {
        if (re.test(code.toString('utf8'))) {
            console.error(`${name}: forbidden construct ${re}`);
            failed = true;
        }
    }
    console.log(`checked ${name}`);
}
process.exit(failed ? 1 : 0);
