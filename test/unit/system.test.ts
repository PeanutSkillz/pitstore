// SPDX-License-Identifier: LGPL-2.1-or-later

import QUnit from 'qunit';

import {
    cpuPercent, formatBytes, formatUptime, parseDf, parseMeminfo, parseProcStat, parseUptime,
} from '../../src/lib/system';

QUnit.module('system summary', () => {
    QUnit.test('cpu usage from two /proc/stat samples', assert => {
        const a = parseProcStat('cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3\n');
        const b = parseProcStat('cpu  150 0 150 750 100 0 0 0 0 0\n');
        assert.equal(cpuPercent(a, b), (100 / 150) * 100);
        assert.equal(cpuPercent(a, a), 0);
        assert.throws(() => parseProcStat('intr 1 2'), /no cpu line/);
    });

    QUnit.test('memory', assert => {
        const m = parseMeminfo('MemTotal:        4000 kB\nMemFree:  100 kB\nMemAvailable:    1000 kB\n');
        assert.deepEqual(m, { total: 4000 * 1024, used: 3000 * 1024 });
    });

    QUnit.test('disk', assert => {
        assert.deepEqual(parseDf('     1B-blocks        Used Mounted on\n 20000000000 5000000000 /\n'),
                         { size: 20000000000, used: 5000000000, mount: '/' });
    });

    QUnit.test('uptime and formatting', assert => {
        assert.equal(parseUptime('93784.55 180000.1\n'), 93784);
        assert.equal(formatUptime(93784), '1d 2h');
        assert.equal(formatUptime(3700), '1h 1m');
        assert.equal(formatUptime(59), '0m');
        assert.equal(formatBytes(512), '512 B');
        assert.equal(formatBytes(1536), '1.5 KiB');
        assert.equal(formatBytes(20 * 1024 ** 3), '20 GiB');
    });
});
