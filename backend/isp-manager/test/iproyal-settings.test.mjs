import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createIprRoyalSettings } from '../iproyal-settings.mjs';
import { createIprRoyalSync } from '../iproyal-sync.mjs';
import { IspStore } from '../store.mjs';
import { createApp } from '../app.mjs';

async function setup(t, adminToken = null) {
    const dir = mkdtempSync(join(tmpdir(), 'isp-settings-'));
    const received = [];
    const provider = createServer((req, res) => {
        if (req.url.startsWith('/products')) {
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ data: [{ id: 42, name: 'ISP Dedicated' }] }));
        }
        received.push(req.headers['x-access-token']);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [], meta: { last_page: 1 } }));
    });
    await new Promise((r) => provider.listen(0, '127.0.0.1', r));
    const options = {
        file: join(dir, 'iproyal.json'),
        baseUrl: `http://127.0.0.1:${provider.address().port}/`,
    };
    const settings = createIprRoyalSettings(options);
    const store = new IspStore({ file: join(dir, 'store.json') });
    const sync = createIprRoyalSync({ store, client: settings.client, configureClient: settings.save });
    const app = createApp({ store, iproyalSync: sync, adminToken });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    t.after(async () => {
        await sync.close();
        await Promise.all([server, provider].map((s) => new Promise((r) => s.close(r))));
        rmSync(dir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const save = (token) => fetch(`${base}/api/isp/iproyal/config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
    });
    return { base, options, received, save, sync };
}

test('page configuration activates sync, persists privately and survives restart without returning the token', async (t) => {
    const { base, options, received, save } = await setup(t);
    const token = 'private-provider-token';
    const saved = await save(` ${token} `);
    assert.equal(saved.status, 200);
    const body = await saved.text();
    assert.equal(JSON.parse(body).data.configured, true);
    assert.ok(!body.includes(token));
    assert.equal(statSync(options.file).mode & 0o777, 0o600);
    const synced = await fetch(`${base}/api/isp/iproyal/sync`, { method: 'POST' });
    assert.equal((await synced.json()).data.status, 'ok');
    const restarted = createIprRoyalSettings({ ...options, token: 'environment-fallback' });
    await restarted.client.listOrders();
    assert.deepEqual(received, [token, token]);
    const status = await (await fetch(`${base}/api/isp/iproyal/status`)).text();
    assert.ok(!status.includes(token));
    assert.equal(JSON.parse(status).data.configured, true);
    assert.equal((await fetch(`${base}/.data/iproyal.json`)).status, 404);
});

test('invalid configuration and failed writes preserve the working token', async (t) => {
    const { options, received, save, sync } = await setup(t);
    assert.equal((await save('working-token')).status, 200);
    for (const token of ['', '   ', 'bad\nheader', {}, 'x'.repeat(4097)])
        assert.equal((await save(token)).status, 400);
    assert.equal(JSON.parse(readFileSync(options.file, 'utf8')).token, 'working-token');
    rmSync(options.file);
    mkdirSync(options.file);
    assert.equal((await save('replacement-token')).status, 500);
    assert.equal((await sync.run()).status, 'ok');
    assert.deepEqual(received, ['working-token']);
});

test('configuration follows management authentication', async (t) => {
    const { save } = await setup(t, 'admin-token-at-least-24-characters');
    const response = await save('must-not-be-saved');
    assert.equal(response.status, 401);
});
