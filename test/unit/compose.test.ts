// SPDX-License-Identifier: LGPL-2.1-or-later

import QUnit from 'qunit';

import { catalogVariables, interpolateCompose, interpolateString } from '../../src/lib/compose/interpolate';
import { ComposeError, parseComposeYaml } from '../../src/lib/compose/parse';

const VALID = `
name: demo
services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
    volumes:
      - /DATA/AppData/$AppID/config:/config
    environment:
      TZ: $TZ
      PASSWORD: \${DefaultPassword}
x-casaos:
  id: org.example.demo
  main: web
  index: /
  port_map: "8080"
  title:
    en_US: Demo
`;

const vars = catalogVariables({ appId: 'org.example.demo', puid: 1000, pgid: 1000, tz: 'Europe/Amsterdam', defaultPassword: 'S3cret' });

QUnit.module('compose parser', () => {
    QUnit.test('parses a valid catalog compose file', assert => {
        const compose = parseComposeYaml(VALID);
        assert.equal(compose.services.web.image, 'nginx:1.27');
        assert.equal(compose['x-casaos'].main, 'web');
    });

    const rejects: [string, string, RegExp][] = [
        ['multiple documents', VALID + '\n---\nfoo: 1\n', /exactly one YAML document/],
        ['duplicate keys', VALID.replace('  web:\n', '  web:\n    image: a\n'), /Invalid YAML/],
        ['custom tags', VALID.replace('nginx:1.27', '!!js/function "x"'), /Invalid YAML/],
        ['unknown local tags', VALID.replace('nginx:1.27', '!secret x'), /Invalid YAML/],
        ['billion laughs', 'a: &a [x,x,x,x,x,x,x,x,x,x]\n' +
            Array.from({ length: 9 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [` +
                Array(10).fill(`*${String.fromCharCode(97 + i)}`)
                        .join(',') + ']').join('\n') +
            '\nservices: {}\n', /Invalid YAML|alias/i],
        ['too large', 'x: "' + 'a'.repeat(300 * 1024) + '"\n', /too large/],
        ['missing x-casaos', 'services:\n  web:\n    image: x\n', /invalid/],
        ['main not a service', VALID.replace('main: web', 'main: db'), /x-casaos.main/],
        ['bad app id', VALID.replace('org.example.demo', 'demo'), /invalid/],
        ['prototype keys', VALID.replace('    image: nginx:1.27\n', '    image: nginx:1.27\n    __proto__: {privileged: true}\n'), /Forbidden key/],
    ];
    for (const [name, text, re] of rejects) {
        QUnit.test(`rejects ${name}`, assert => {
            assert.throws(() => parseComposeYaml(text), re);
        });
    }

    QUnit.test('core schema keeps timestamps and yes/no as strings', assert => {
        const compose = parseComposeYaml(VALID.replace('TZ: $TZ', 'TZ: 2001-12-14\n      FLAG: yes'));
        const env = compose.services.web.environment as Record<string, unknown>;
        assert.equal(env.TZ, '2001-12-14');
        assert.equal(env.FLAG, 'yes');
    });
});

QUnit.module('interpolation', () => {
    QUnit.test('known variables, defaults and escapes', assert => {
        assert.equal(interpolateString('/DATA/AppData/$AppID/x', vars), '/DATA/AppData/org.example.demo/x');
        assert.equal(interpolateString('${PUID}:${PGID}', vars), '1000:1000');
        assert.equal(interpolateString('${NOPE:-fallback}', vars), 'fallback');
        assert.equal(interpolateString('${NOPE-$TZ}', vars), 'Europe/Amsterdam');
        assert.equal(interpolateString('${TZ:+set}', vars), 'set');
        assert.equal(interpolateString('cost $$5', vars), 'cost $5');
    });

    QUnit.test('unknown variables are errors, not empty strings', assert => {
        assert.throws(() => interpolateString('$HOME/x', vars), ComposeError);
        assert.throws(() => interpolateString('${NOPE}', vars), /Unknown variable/);
        assert.throws(() => interpolateString('${NOPE:?must be set}', vars), /Required variable/);
        assert.throws(() => interpolateString('$1', vars), /Invalid variable syntax/);
        assert.throws(() => interpolateString('${bad name}', vars), /Invalid variable syntax/);
    });

    QUnit.test('preview mode collects unknown variables instead of failing', assert => {
        const missing = new Set<string>();
        assert.equal(interpolateString('key=$API_KEY ${TOKEN:?x} ${OPT:-d}', vars, '', missing), 'key=  d');
        assert.deepEqual([...missing].sort(), ['API_KEY', 'TOKEN']);
    });

    QUnit.test('single-service apps may omit x-casaos.main', assert => {
        assert.equal(parseComposeYaml(VALID.replace('  main: web\n', ''))['x-casaos'].main, 'web');
    });

    QUnit.test('environment is not inherited from the host', assert => {
        assert.throws(() => interpolateString('$PATH', vars), /Unknown variable/);
    });

    QUnit.test('interpolates services but not keys or x-casaos', assert => {
        const compose = parseComposeYaml(VALID.replace('  title:', '  tips: $TZ\n  title:'));
        const out = interpolateCompose(compose, vars);
        assert.deepEqual(out.services.web.volumes, ['/DATA/AppData/org.example.demo/config:/config']);
        assert.equal((out.services.web.environment as Record<string, string>).PASSWORD, 'S3cret');
        assert.equal(out['x-casaos'].tips, '$TZ');
    });
});
