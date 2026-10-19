import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { IspStore } from '../store.mjs';
import { createApp } from '../app.mjs';
import { ProbeQueue } from '../probe.mjs';

const adminToken = 'test-admin-token-01234567890123456789';
async function setup(t, options = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'isp-http-'));
    const store = new IspStore({ file: join(dir, 'store.json') });
    const { probe, ...appOptions } = options;
    const prober = probe ? new ProbeQueue({ store, probe }) : options.prober;
    const app = createApp({ store, adminToken, ...appOptions, prober });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    t.after(async () => {
        await new Promise((r) => server.close(r));
        await prober?.close?.();
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
    return { store, base, request, prober };
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

test('management API is open when no admin token is configured', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'isp-http-open-'));
    const store = new IspStore({ file: join(dir, 'store.json') });
    const app = createApp({ store, adminToken: null });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    t.after(async () => {
        await new Promise((r) => server.close(r));
        rmSync(dir, { recursive: true, force: true });
    });
    const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/isp/iproyal/status`,
    );
    assert.equal(response.status, 200);
});

test('IPRoyal status and manual sync are exposed through the existing management API', async (t) => {
    const sync = {
        status: () => ({ status: 'ok', syncedAt: '2026-10-16T12:00:00.000Z' }),
        run: async () => ({ status: 'ok', matched: 1, unmatched: 0 }),
    };
    const { request } = await setup(t, { iproyalSync: sync });
    const status = await request('/api/isp/iproyal/status', undefined, 'GET');
    assert.equal(status.status, 200);
    assert.equal((await status.json()).data.status, 'ok');
    const result = await request('/api/isp/iproyal/sync');
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).data, {
        status: 'ok',
        matched: 1,
        unmatched: 0,
    });
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
test('share rename preserves links and scope, and exports the chosen Unicode title', async (t) => {
    const { base, request, store } = await setup(t);
    store.import(payload);
    const share = store.createShare({ name: 'Old', scope: 'all' });
    const name = '美国 ISP · 私人线路';
    assert.equal((await request(`/api/isp/shares/${share.id}`, { name }, 'PATCH', false)).status, 401);
    const response = await request(`/api/isp/shares/${share.id}`, { name: ` ${name} ` }, 'PATCH');
    assert.equal(response.status, 200);
    const updated = (await response.json()).data;
    assert.equal(updated.name, name);
    assert.equal(updated.token, share.token);
    assert.equal(updated.scope, share.scope);
    assert.equal(new IspStore({ file: store.file }).listShares()[0].name, name);
    for (const file of ['clash.yaml', 'provider.yaml']) {
        const download = await fetch(`${base}/s/${share.token}/${file}`);
        assert.equal(download.status, 200);
        const title = download.headers.get('profile-title');
        assert.ok(title.startsWith('base64:'));
        assert.equal(Buffer.from(title.slice(7), 'base64').toString('utf8'), name);
        const disposition = download.headers.get('content-disposition');
        assert.ok(disposition.includes(`filename=${file}`));
        assert.ok(disposition.includes(`filename*=UTF-8''${encodeURIComponent(name)}.yaml`));
        assert.ok(!disposition.includes('\\'));
    }
    for (const invalid of ['', ' ', 'bad\r\nheader', 'x'.repeat(201)])
        assert.equal((await request(`/api/isp/shares/${share.id}`, { name: invalid }, 'PATCH')).status, 400);
    assert.equal((await request(`/api/isp/shares/${share.id}`, { name: 'Changed', scope: 'selected' }, 'PATCH')).status, 400);
    assert.equal(store.listShares()[0].name, name);
    assert.equal((await request('/api/isp/shares/missing', { name }, 'PATCH')).status, 404);
});

test('malformed Unicode in saved titles does not break subscription downloads', async (t) => {
    const { base, store } = await setup(t);
    store.import(payload);
    const share = store.createShare({ name: 'Broken\uD800', scope: 'all' });
    const response = await fetch(`${base}/s/${share.token}/clash.yaml`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-disposition').includes('Broken%EF%BF%BD.yaml'));
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

test('subscription card expiry follows the earliest included node or share expiry for both exports', async (t) => {
    const { base, store } = await setup(t);
    store.import({ ...payload, content: '203.0.113.10:80:u:p\n203.0.113.11:80:u:p\n203.0.113.12:80:u:p' });
    const [first, second, excluded] = store.list({}).items;
    const metadata = (expiresAt) => ({ orderId: 420, status: 'confirmed', expiresAt, syncedAt: '2026-10-19T00:00:00.000Z', syncStatus: 'matched' });
    store.saveIprRoyalSync({
        [first.id]: metadata('2099-01-02T00:00:00.000Z'),
        [second.id]: metadata('2099-01-01T00:00:00.000Z'),
        [excluded.id]: metadata('2098-01-01T00:00:00.000Z'),
    }, { fetchedOrders: 3, unmatched: 0 });
    const share = store.createShare({ name: 'Selected', scope: 'selected', ids: [first.id, second.id] });
    const getHeader = async (token, file = 'clash.yaml') =>
        (await fetch(`${base}/s/${token}/${file}`)).headers.get('subscription-userinfo');
    for (const file of ['clash.yaml', 'provider.yaml'])
        assert.equal(await getHeader(share.token, file), 'expire=4070908800');
    store.update(second.id, { enabled: false });
    assert.equal(await getHeader(share.token), 'expire=4070995200');
    const shorter = store.createShare({ name: 'Shorter', scope: 'selected', ids: [first.id], expiresAt: '2098-01-01T00:00:00.000Z' });
    assert.equal(await getHeader(shorter.token), 'expire=4039372800');
    store.saveIprRoyalSync({ [first.id]: metadata('2099-01-03T00:00:00.000Z') }, { fetchedOrders: 1, unmatched: 0 });
    assert.equal(await getHeader(share.token), 'expire=4071081600');
});

test('unknown expiry is omitted, share-only expiry is advertised, expired nodes stay in export', async (t) => {
    const { base, store } = await setup(t);
    store.import(payload);
    const node = store.list({}).items[0];
    const share = store.createShare({ name: 'No expiry', scope: 'all' });
    let response = await fetch(`${base}/s/${share.token}/clash.yaml`);
    assert.equal(response.headers.get('subscription-userinfo'), null);
    const limited = store.createShare({ name: 'Share only', scope: 'all', expiresAt: '2099-01-01T00:00:00.000Z' });
    response = await fetch(`${base}/s/${limited.token}/clash.yaml`);
    assert.equal(response.headers.get('subscription-userinfo'), 'expire=4070908800');
    store.saveIprRoyalSync({ [node.id]: { orderId: 420, status: 'expired', syncStatus: 'expired', expiresAt: '2000-01-01T00:00:00.000Z', syncedAt: '2026-10-19T00:00:00.000Z' } }, { fetchedOrders: 1, unmatched: 0 });
    response = await fetch(`${base}/s/${share.token}/clash.yaml`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('subscription-userinfo'), 'expire=946684800');
    assert.equal(parse(await response.text()).proxies.length, 1);
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

test('import schedules all changed nodes; protected manual checks and status do not change subscriptions', async (t) => {
    const { ProbeQueue } = await import('../probe.mjs');
    let queue;
    const prober = {
        enqueue: (ids) => queue.enqueue(ids),
        summary: () => queue.summary(),
        decorate: (node) => queue.decorate(node),
    };
    const { store, request, base } = await setup(t, { prober });
    const waiting = [];
    queue = new ProbeQueue({
        store,
        probe: () => new Promise((resolve) => waiting.push(resolve)),
    });
    t.after(async () => {
        for (const resolve of waiting)
            resolve({
                status: 'timeout',
                auth: 'unknown',
                exitIp: null,
                latencyMs: null,
                checkedAt: new Date().toISOString(),
            });
        await queue.close();
    });
    assert.equal(
        (await request('/api/isp/import/preview', payload)).status,
        200,
    );
    assert.equal(queue.summary().queued, 0);
    const imported = await (
        await request('/api/isp/import', {
            ...payload,
            content: Array.from(
                { length: 60 },
                (_, i) => `proxy${i}.example:80:u:p`,
            ).join('\n'),
        })
    ).json();
    assert.equal(imported.data.probesQueued, 60);
    assert.equal(queue.summary().queued + queue.summary().checking, 60);
    const listed = (
        await (await request('/api/isp/nodes', undefined, 'GET')).json()
    ).data;
    assert.ok(['queued', 'checking'].includes(listed.items[0].probeState));
    assert.equal(listed.probes.queued + listed.probes.checking, 60);
    const id = listed.items[0].id;
    assert.equal(
        (await request('/api/isp/nodes/check', { ids: [id] }, 'POST', false))
            .status,
        401,
    );
    assert.equal(
        (await request('/api/isp/nodes/check', { ids: ['missing'] })).status,
        409,
    );
    assert.equal((await request('/api/isp/nodes/check', {})).status, 400);
    const checked = await request('/api/isp/nodes/check', { ids: [id] });
    assert.equal(checked.status, 202);
    assert.equal((await checked.json()).data.queued, 0);
    const share = store.createShare({ name: 'Unaffected', scope: 'all' });
    assert.equal(
        parse(await (await fetch(`${base}/s/${share.token}/clash.yaml`)).text())
            .proxies.length,
        60,
    );
});

test('check-all requires authentication and queues every page including disabled nodes once', async (t) => {
    const { store, request, prober } = await setup(t, {
        probe: (node, { signal }) =>
            new Promise((resolve) => {
                signal.addEventListener('abort', () => resolve({}), {
                    once: true,
                });
            }),
    });
    store.import({
        ...payload,
        content: Array.from(
            { length: 61 },
            (_, i) => `proxy${i}.example:80:u:p`,
        ).join('\n'),
    });
    const ids = store.state.nodes.map((node) => node.id);
    store.update(ids[60], { enabled: false, group: 'UK' });
    const before = structuredClone(store.state);
    assert.equal(
        (await request('/api/isp/nodes/check-all', undefined, 'POST', false))
            .status,
        401,
    );
    assert.equal(prober.summary().queued + prober.summary().checking, 0);

    const response = await request('/api/isp/nodes/check-all');
    assert.equal(response.status, 202);
    assert.equal((await response.json()).data.queued, 61);
    assert.equal(prober.summary().queued + prober.summary().checking, 61);
    assert.equal(prober.view(store.get(ids[60])), 'queued');
    const lastPage = (
        await (await request('/api/isp/nodes?page=2', undefined, 'GET')).json()
    ).data;
    assert.equal(lastPage.items.length, 11);
    assert.ok(lastPage.items.every((node) => node.probeState === 'queued'));
    const repeated = await request('/api/isp/nodes/check-all');
    assert.equal((await repeated.json()).data.queued, 0);
    assert.deepEqual(store.state, before);
});

test('check-all handles an empty store and reports an unavailable prober', async (t) => {
    const { request, prober } = await setup(t, {
        probe: async () => assert.fail('empty store must not probe'),
    });
    const response = await request('/api/isp/nodes/check-all');
    assert.equal(response.status, 202);
    assert.equal((await response.json()).data.queued, 0);
    assert.equal(prober.summary().checking, 0);
    const unavailable = await setup(t);
    assert.equal(
        (await unavailable.request('/api/isp/nodes/check-all')).status,
        503,
    );
});

test('group management is authenticated and renaming keeps subscription URLs while deletion revokes them', async (t) => {
    const { store, request, base } = await setup(t);
    for (const [method, body] of [
        ['GET', undefined],
        ['POST', { name: 'US' }],
        ['PATCH', { name: 'US', newName: 'New' }],
        ['DELETE', { name: 'US' }],
    ]) {
        assert.equal(
            (await request('/api/isp/groups', body, method, false)).status,
            401,
        );
    }
    const name = '香港 / 家宽 ? #';
    assert.equal((await request('/api/isp/groups', { name })).status, 201);
    assert.deepEqual(
        (await (await request('/api/isp/groups', undefined, 'GET')).json())
            .data,
        [{ name, nodeCount: 0, shareCount: 0 }],
    );
    assert.equal((await request('/api/isp/groups', { name })).status, 409);
    for (const body of [undefined, {}, [], { name: ' ' }, { name: 1 }]) {
        assert.equal((await request('/api/isp/groups', body)).status, 400);
    }
    store.import({ ...payload, group: name });
    const share = store.createShare({
        name: 'Group link',
        scope: 'group',
        group: name,
    });
    const link = `${base}/s/${share.token}/provider.yaml`;
    assert.equal((await fetch(link)).status, 200);
    assert.equal(
        (await request('/api/isp/groups', { name, newName: 'New' }, 'PATCH'))
            .status,
        200,
    );
    assert.equal((await fetch(link)).status, 200);
    assert.equal(store.list().items[0].group, 'New');
    assert.equal(
        (
            await request(
                '/api/isp/groups',
                { name: 'Missing', newName: 'New' },
                'PATCH',
            )
        ).status,
        404,
    );
    assert.equal(
        (await request('/api/isp/groups', { name: 'New' }, 'DELETE')).status,
        200,
    );
    assert.equal((await fetch(link)).status, 404);
    assert.equal(store.list().items[0].group, '');
    assert.equal(
        (await request('/api/isp/groups', { name: 'New' }, 'DELETE')).status,
        404,
    );
    assert.equal(
        (await request('/api/isp/groups', { name: '' }, 'DELETE')).status,
        400,
    );
});
