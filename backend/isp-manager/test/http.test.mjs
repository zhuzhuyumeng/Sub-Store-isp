import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { IspStore } from '../store.mjs';
import { createApp } from '../app.mjs';

const adminToken = 'test-admin-token-01234567890123456789';
async function setup(t, options = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'isp-http-'));
    const store = new IspStore({ file: join(dir, 'store.json') });
    const app = createApp({ store, adminToken, ...options });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    t.after(async () => {
        await new Promise((r) => server.close(r));
        rmSync(dir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, body, method = 'POST', auth = true) =>
        fetch(base + path, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(auth ? { Authorization: `Bearer ${adminToken}` } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    return { store, base, request };
}
const payload = {
    format: 'HOST:PORT:USER:PASS',
    protocol: 'https',
    content: 'proxy.example:8080:alice:00%40:a@ss',
    group: 'US',
};
test('management requires token, even when body is malformed; static page remains public', async (t) => {
    const { base, request } = await setup(t);
    assert.equal(
        (await request('/api/isp/nodes', undefined, 'GET', false)).status,
        401,
    );
    const bad = await fetch(base + '/api/isp/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '"secret',
    });
    assert.equal(bad.status, 401);
    assert.ok(!(await bad.text()).includes('secret'));
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(
        page.headers.get('content-security-policy'),
        /default-src 'self'/,
    );
    const noCors = await request('/api/isp/nodes', undefined, 'GET');
    assert.equal(noCors.headers.get('access-control-allow-origin'), null);
});
test('full flow previews, imports, exports lossless Clash config/provider and revokes', async (t) => {
    const { base, request } = await setup(t, {
        publicBaseUrl: 'https://isp.example/manager',
    });
    let response = await request('/api/isp/import/preview', payload);
    assert.equal(response.status, 200);
    let data = (await response.json()).data;
    assert.equal(data.created, 1);
    assert.ok(!JSON.stringify(data).includes(payload.content));
    assert.equal(
        (await (await request('/api/isp/nodes', undefined, 'GET')).json()).data
            .total,
        0,
    );
    assert.equal((await request('/api/isp/import', payload)).status, 200);
    const nodes = (
        await (await request('/api/isp/nodes', undefined, 'GET')).json()
    ).data.items;
    assert.equal(nodes[0].hasPassword, true);
    assert.equal(nodes[0].password, undefined);
    response = await request('/api/isp/shares', {
        name: 'Client A',
        scope: 'selected',
        ids: [nodes[0].id],
    });
    assert.equal(response.status, 201);
    const share = (await response.json()).data;
    assert.equal(
        share.clashUrl,
        `https://isp.example/manager/s/${share.token}/clash.yaml`,
    );
    response = await fetch(base + `/s/${share.token}/clash.yaml`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const config = parse(await response.text());
    assert.equal(config.proxies.length, 1);
    assert.equal(config.proxies[0].type, 'http');
    assert.equal(config.proxies[0].tls, true);
    assert.equal(config.proxies[0].password, '00%40:a@ss');
    assert.equal(config.rules[0], 'MATCH,ISP');
    const provider = parse(
        await (await fetch(base + `/s/${share.token}/provider.yaml`)).text(),
    );
    assert.deepEqual(Object.keys(provider), ['proxies']);
    await request(`/api/isp/nodes/${nodes[0].id}`, { enabled: false }, 'PATCH');
    assert.equal(
        (await fetch(base + `/s/${share.token}/clash.yaml`)).status,
        404,
    );
    await request(
        `/api/isp/nodes/${nodes[0].id}`,
        { enabled: true, password: 'rotated' },
        'PATCH',
    );
    assert.equal(
        parse(await (await fetch(base + `/s/${share.token}/clash.yaml`)).text())
            .proxies[0].password,
        'rotated',
    );
    await request(`/api/isp/shares/${share.id}`, undefined, 'DELETE');
    assert.equal(
        (await fetch(base + `/s/${share.token}/clash.yaml`)).status,
        404,
    );
});
test('share scope cannot be widened by queries and duplicate node names stay valid', async (t) => {
    const { base, request, store } = await setup(t);
    store.import(payload);
    store.import({
        ...payload,
        content: 'other.example:80:bob:secret',
        group: 'UK',
    });
    const nodes = store.list({}).items;
    for (const n of nodes) store.update(n.id, { name: 'ISP' });
    const share = store.createShare({
        name: 'Scoped',
        scope: 'group',
        group: 'US',
    });
    const config = parse(
        await (
            await fetch(
                base + `/s/${share.token}/clash.yaml?scope=all&group=UK`,
            )
        ).text(),
    );
    assert.equal(config.proxies.length, 1);
    assert.equal(config.proxies[0].server, 'proxy.example');
    assert.notEqual(config.proxies[0].name, 'ISP');
    const all = store.createShare({ name: 'All', scope: 'all' });
    const allConfig = parse(
        await (await fetch(base + `/s/${all.token}/clash.yaml`)).text(),
    );
    assert.equal(new Set(allConfig.proxies.map((p) => p.name)).size, 2);
    assert.equal(
        (await request('/api/isp/nodes?group[bad]=x', undefined, 'GET')).status,
        400,
    );
});
test('malformed bodies and invalid IDs return sanitized errors', async (t) => {
    const { base, request } = await setup(t);
    const malformed = await fetch(base + '/api/isp/import', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
        },
        body: '{password:SECRET',
    });
    assert.equal(malformed.status, 400);
    assert.ok(!(await malformed.text()).includes('SECRET'));
    assert.equal(
        (await request('/api/isp/nodes/batch', { ids: [], action: 'delete' }))
            .status,
        400,
    );
    assert.equal(
        (await request('/api/isp/nodes/missing', {}, 'PATCH')).status,
        404,
    );
    const badToken = await fetch(base + '/s/nope/clash.yaml');
    assert.equal(badToken.status, 404);
});
test('expiry is enforced and selected scope follows IDs through group edits', async (t) => {
    const { base, store } = await setup(t);
    store.import(payload);
    const node = store.list({}).items[0];
    const share = store.createShare({
        name: 'Selected',
        scope: 'selected',
        ids: [node.id],
        expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    store.update(node.id, { group: 'New' });
    assert.equal(
        (await fetch(base + `/s/${share.token}/clash.yaml`)).status,
        200,
    );
    store.transaction((s) => {
        s.shares[0].expiresAt = '2000-01-01T00:00:00.000Z';
    });
    assert.equal(
        (await fetch(base + `/s/${share.token}/clash.yaml`)).status,
        404,
    );
});

test('permanent share deletion removes active, revoked and expired records without deleting nodes', async (t) => {
    const { store, base, request } = await setup(t);
    store.import(payload);
    const active = store.createShare({ name: 'Active', scope: 'all' });
    const revoked = store.createShare({ name: 'Revoked', scope: 'all' });
    const expired = store.createShare({ name: 'Expired', scope: 'all' });
    const retained = store.createShare({ name: 'Retained', scope: 'all' });
    store.revokeShare(revoked.id);
    store.transaction((s) => {
        s.shares.find((item) => item.id === expired.id).expiresAt =
            '2000-01-01T00:00:00.000Z';
    });
    const unauthorized = await request(
        `/api/isp/shares/${active.id}?mode=permanent`,
        undefined,
        'DELETE',
        false,
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(store.listShares().length, 4);
    const invalid = await request(
        `/api/isp/shares/${active.id}?mode=typo`,
        undefined,
        'DELETE',
    );
    assert.equal(invalid.status, 400);
    assert.equal(store.resolveShare(active.token).nodes.length, 1);
    for (const share of [active, revoked, expired]) {
        const response = await request(
            `/api/isp/shares/${share.id}?mode=permanent`,
            undefined,
            'DELETE',
        );
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).data, { deleted: true });
        for (const file of ['clash.yaml', 'provider.yaml']) {
            assert.equal(
                (await fetch(`${base}/s/${share.token}/${file}`)).status,
                404,
            );
        }
    }
    const listed = (
        await (await request('/api/isp/shares', undefined, 'GET')).json()
    ).data;
    assert.deepEqual(
        listed.map((s) => s.id),
        [retained.id],
    );
    const restarted = new IspStore({ file: store.file });
    assert.deepEqual(
        restarted.listShares().map((s) => s.id),
        [retained.id],
    );
    assert.equal(restarted.list({}).total, 1);
    assert.equal(
        (await fetch(`${base}/s/${retained.token}/clash.yaml`)).status,
        200,
    );
    assert.equal(
        (
            await request(
                `/api/isp/shares/${active.id}?mode=permanent`,
                undefined,
                'DELETE',
            )
        ).status,
        404,
    );
});
