// SPDX-License-Identifier: LGPL-2.1-or-later

import QUnit from 'qunit';

import { parseComposeYaml } from '../../src/lib/compose/parse';
import { buildCompose, initialForm, mapDataPath, requiredVariables, webPort, type InstallContext } from '../../src/lib/install';

const ctx: InstallContext = { appId: 'org.example.demo', dataRoot: '/var/lib/pitstore/data', puid: 1000, pgid: 1000, tz: 'UTC' };

const YAML = `
name: demo
services:
  web:
    image: example/web:1
    ports:
      - target: 80
        published: "8080"
        protocol: tcp
    volumes:
      - /DATA/AppData/$AppID/config:/config
      - /DATA/Media:/media:ro
    environment:
      DB_PASSWORD: casaos-placeholder
      DB_URL: postgres://app:casaos-placeholder@db/app
      ADMIN_PASSWORD: $DefaultPassword
      API_KEY: $OPENAI_KEY
    depends_on: [db]
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: casaos-placeholder
      SHORT_PASSWD: casaos
      PEER_HOST_PWD: casaos
x-casaos:
  id: org.example.demo
  main: web
  port_map: "8080"
`;

QUnit.module('install plan', () => {
    const compose = parseComposeYaml(YAML);

    QUnit.test('data paths map to the PitStore data root', assert => {
        assert.equal(mapDataPath('/DATA/AppData/org.example.demo/config', ctx), '/var/lib/pitstore/data/org.example.demo/config');
        assert.equal(mapDataPath('/DATA/Media', ctx), '/var/lib/pitstore/data/shared/Media');
        assert.equal(mapDataPath('/srv/x', ctx), '/srv/x');
    });

    QUnit.test('initial form', assert => {
        assert.deepEqual(requiredVariables(compose, ctx), ['OPENAI_KEY']);
        const form = initialForm(compose, ctx, 'podman-user');
        assert.deepEqual(form.ports.map(p => [p.service, p.target, p.published]), [['web', 80, '8080']]);
        assert.deepEqual(form.binds.map(b => b.source), [
            '/var/lib/pitstore/data/org.example.demo/config', '/var/lib/pitstore/data/shared/Media']);
        assert.deepEqual(form.secrets.map(s => `${s.service}/${s.key}`), ['web/DB_PASSWORD', 'db/SHORT_PASSWD']);
        assert.deepEqual(form.secrets[0].others, ['db/POSTGRES_PASSWORD'], 'same placeholder, one field');
        assert.deepEqual(form.secrets[1].others, ['db/PEER_HOST_PWD']);
        assert.ok(form.secrets.every(s => s.generate));
    });

    QUnit.test('placeholder secrets are replaced consistently across services', async assert => {
        const form = initialForm(compose, ctx, 'podman-user');
        form.variables.OPENAI_KEY = 'sk-test';
        const { compose: out, policy } = await buildCompose(compose, form, ctx);
        const web = out.services.web.environment as Record<string, string>;
        const db = out.services.db.environment as Record<string, string>;
        assert.ok(/^@@pitstore-secret:v[0-9a-f]{12}-24@@$/.test(web.DB_PASSWORD), 'generated placeholder with length');
        assert.ok(/^@@pitstore-secret:v[0-9a-f]{12}-24@@$/.test(db.SHORT_PASSWD), 'short placeholders too (PASSWD)');
        assert.equal(db.PEER_HOST_PWD, db.SHORT_PASSWD, 'same short placeholder, same secret');
        assert.equal(db.POSTGRES_PASSWORD, web.DB_PASSWORD, 'same literal, same secret');
        assert.equal(web.DB_URL, `postgres://app:${web.DB_PASSWORD}@db/app`, 'also as URL password');
        assert.equal(web.ADMIN_PASSWORD, '@@pitstore-secret:default@@');
        assert.equal(web.API_KEY, 'sk-test');
        assert.notOk(JSON.stringify(out).includes('casaos-placeholder'));
        assert.deepEqual(policy.findings, []);
    });

    QUnit.test('user values and edits are applied', async assert => {
        const form = initialForm(compose, ctx, 'podman-user');
        form.ports[0].published = '18080';
        form.binds[1].source = '/srv/media';
        form.secrets[0].generate = false;
        form.secrets[0].value = 'my own password';
        const { compose: out } = await buildCompose(compose, form, ctx);
        assert.deepEqual(out.services.web.ports, [{ target: 80, published: '18080', protocol: 'tcp' }]);
        assert.deepEqual(out.services.web.volumes, [
            { type: 'bind', source: '/var/lib/pitstore/data/org.example.demo/config', target: '/config', read_only: false },
            { type: 'bind', source: '/srv/media', target: '/media', read_only: true },
        ]);
        assert.equal((out.services.web.environment as Record<string, string>).DB_PASSWORD, 'my own password');
        assert.equal((out.services.db.environment as Record<string, string>).POSTGRES_PASSWORD, 'my own password',
                     'an own value applies to every variable with the same placeholder');
        assert.equal((out.services.web.environment as Record<string, string>).DB_URL, 'postgres://app:my own password@db/app');
        assert.equal(webPort(compose, form), '18080');
    });

    QUnit.test('short placeholders inside database URLs follow the generated secret', async assert => {
        const yaml = `
name: demo
services:
  app:
    image: example/app:1
    environment:
      DATABASE_URL: postgresql://postgres:abc123@db:5432/app
      IGDB_CLIENT_SECRET: '""'
      POSTGRES_USER: abc123x
      DB_HOST: abc123-db
      DB_USER: abc123
  db:
    image: postgres:16
    command: postgres -c password_encryption=abc123 --pass abc123
    environment:
      POSTGRES_PASSWORD: abc123
x-casaos:
  id: org.example.demo
  main: app
`;
        const c = parseComposeYaml(yaml);
        const form = initialForm(c, ctx, 'docker');
        assert.deepEqual(form.secrets.map(s => s.key), ['POSTGRES_PASSWORD'], 'quoted-empty values are not secrets');
        const { compose: out } = await buildCompose(c, form, ctx);
        const pw = (out.services.db.environment as Record<string, string>).POSTGRES_PASSWORD;
        const app = out.services.app.environment as Record<string, string>;
        assert.ok(pw.startsWith('@@pitstore-secret:'));
        assert.equal(app.DATABASE_URL, `postgresql://postgres:${pw}@db:5432/app`);
        assert.equal(app.POSTGRES_USER, 'abc123x', 'only the password part of a URL, not similar words');
        assert.equal(app.IGDB_CLIENT_SECRET, '""');
        assert.equal(app.DB_HOST, 'abc123-db', 'host names keep the word');
        assert.equal(app.DB_USER, 'abc123', 'non-credential variables keep the word');
        assert.equal(out.services.db.command, `postgres -c password_encryption=${pw} --pass ${pw}`, 'whole words in commands');
    });

    QUnit.test('editing a path into a system directory creates a finding', async assert => {
        const form = initialForm(compose, ctx, 'podman-user');
        form.binds[0].source = '/etc';
        const { policy } = await buildCompose(compose, form, ctx);
        assert.deepEqual(policy.findings.map(f => f.key), ['web/mount-sensitive:/etc']);
    });

    QUnit.test('an update keeps earlier choices', async assert => {
        const form = initialForm(compose, ctx, 'podman-user');
        form.ports[0].published = '18080';
        form.variables.OPENAI_KEY = 'sk-old';
        const { compose: previous } = await buildCompose(compose, form, ctx);
        const again = initialForm(compose, ctx, 'podman-user', previous);
        assert.equal(again.ports[0].published, '18080');
        assert.equal(again.variables.OPENAI_KEY, 'sk-old');
        assert.ok(again.secrets.every(s => s.generate), 'generated secrets stay generated');
    });
});
