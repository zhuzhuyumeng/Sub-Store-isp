import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IspStore } from '../store.mjs';
import { ProbeQueue } from '../probe.mjs';

const geoModule = () => import('../geo.mjs');
const ip = '203.0.113.8';
const payload = (code = 'US', address = ip) => ({
    success: true,
    ip: address,
    country_code: code,
    country: 'Untrusted country label',
    city: 'Montrose',
    region: 'Colorado',
    connection: { isp: 'Example Network', asn: 8175 },
});
async function fixture(t, handler) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}/`;
}
function storeFixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'isp-geo-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return new IspStore({ file: join(dir, 'store.json') });
}
const online = (location) => ({
    status: 'online',
    auth: 'accepted',
    exitIp: ip,
    latencyMs: 10,
    checkedAt: new Date().toISOString(),
    ...(location ? { location } : {}),
});
const location = (code) => ({
    status: 'located',
    countryCode: code,
    country: code === 'US' ? '美国' : '日本',
    city: 'Example',
});
async function eventually(fn) {
    for (let i = 0; i < 200; i++) {
        if (fn()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('condition did not become true');
}
test('geo looks up the exit IP without credentials, normalizes country and caches concurrent lookups', async (t) => {
    const { createGeoLookup } = await geoModule();
    let requests = 0;
    const baseUrl = await fixture(t, (req, res) => {
        requests++;
        assert.equal(decodeURIComponent(req.url), `/${ip}`);
        assert.equal(req.headers.authorization, undefined);
        assert.equal(req.headers['proxy-authorization'], undefined);
        res.end(JSON.stringify(payload()));
    });
    const lookup = createGeoLookup({ baseUrl, minIntervalMs: 0 });
    const results = await Promise.all([lookup(ip), lookup(ip)]);
    assert.equal(results[0].status, 'located');
    assert.equal(results[0].country, '美国');
    assert.equal(results[0].countryCode, 'US');
    assert.equal(results[0].city, 'Montrose');
    assert.equal(results[0].isp, 'Example Network');
    results[0].country = 'tampered';
    assert.equal((await lookup(ip)).country, '美国');
    assert.equal(requests, 1);
});
test('geo accepts equivalent IPv6 addresses and rejects mismatched or invalid location data', async (t) => {
    const { createGeoLookup } = await geoModule();
    let body = payload('JP', '2001:db8::1');
    const baseUrl = await fixture(t, (req, res) =>
        res.end(JSON.stringify(body)),
    );
    assert.equal(
        (
            await createGeoLookup({ baseUrl, minIntervalMs: 0 })(
                '2001:0db8:0:0:0:0:0:1',
            )
        ).country,
        '日本',
    );
    for (const invalid of [
        payload('US', '203.0.113.9'),
        { ...payload(), success: false },
        { ...payload(), country_code: '???' },
        { ...payload(), country_code: 'ZZ' },
    ]) {
        body = invalid;
        assert.equal(
            (await createGeoLookup({ baseUrl, minIntervalMs: 0 })(ip)).status,
            'unavailable',
        );
    }
});
test('geo isolates timeouts, invalid JSON, redirects and oversized responses', async (t) => {
    const { createGeoLookup } = await geoModule();
    for (const [handler, expected] of [
        [() => {}, 'timeout'],
        [(req, res) => res.end('not json'), 'unavailable'],
        [
            (req, res) => {
                res.writeHead(302, { location: '/redirect' });
                res.end();
            },
            'unavailable',
        ],
        [(req, res) => res.end(' '.repeat(9000)), 'unavailable'],
    ]) {
        const baseUrl = await fixture(t, handler);
        assert.equal(
            (
                await createGeoLookup({
                    baseUrl,
                    timeoutMs: 70,
                    minIntervalMs: 0,
                })(ip)
            ).status,
            expected,
        );
    }
});
test('geo backs off after rate limiting and spaces distinct IP requests', async (t) => {
    const { createGeoLookup } = await geoModule();
    let requests = 0;
    const limited = await fixture(t, (req, res) => {
        requests++;
        res.writeHead(429);
        res.end();
    });
    const lookup = createGeoLookup({ baseUrl: limited, minIntervalMs: 0 });
    assert.equal((await lookup(ip)).status, 'rate_limited');
    assert.equal((await lookup('203.0.113.9')).status, 'rate_limited');
    assert.equal(requests, 1);
    const starts = [];
    const baseUrl = await fixture(t, (req, res) => {
        starts.push(performance.now());
        res.end(JSON.stringify(payload('US', req.url.slice(1))));
    });
    const spaced = createGeoLookup({ baseUrl, minIntervalMs: 60 });
    await Promise.all([spaced(ip), spaced('203.0.113.9')]);
    assert.ok(starts[1] - starts[0] >= 45);
});
test('geo rejects invalid targets and aborts queued lookups promptly', async (t) => {
    const { createGeoLookup } = await geoModule();
    for (const baseUrl of [
        'ftp://test/',
        'https://user:pass@test/',
        'https://test/#x',
        'https://test/?x=1',
    ])
        assert.throws(() => createGeoLookup({ baseUrl }));
    let requests = 0;
    const baseUrl = await fixture(t, (req, res) => {
        requests++;
        res.end(JSON.stringify(payload()));
    });
    const lookup = createGeoLookup({ baseUrl, minIntervalMs: 2000 });
    assert.equal((await lookup('not-an-ip')).status, 'unavailable');
    await lookup(ip);
    const controller = new AbortController();
    const queued = lookup('203.0.113.9', { signal: controller.signal });
    controller.abort();
    assert.equal((await queued).status, 'unavailable');
    assert.equal(requests, 1);
});
test('each successful probe overwrites manual grouping by country and updates group subscriptions', async (t) => {
    const store = storeFixture(t);
    store.import({
        format: 'HOST:PORT:USER:PASS',
        protocol: 'http',
        content: 'h:80:u:p',
        group: '手动分组',
    });
    const id = store.list().items[0].id;
    store.createGroup('美国');
    const old = store.createShare({
        name: 'Old',
        scope: 'group',
        group: '手动分组',
    });
    const usa = store.createShare({
        name: 'US',
        scope: 'group',
        group: '美国',
    });
    const selected = store.createShare({
        name: 'Selected',
        scope: 'selected',
        ids: [id],
    });
    let code = 'US';
    const queue = new ProbeQueue({
        store,
        probe: async () => online(),
        locate: async (address) => {
            assert.equal(address, ip);
            return location(code);
        },
    });
    t.after(() => queue.close());
    queue.enqueue([id]);
    await eventually(
        () => queue.summary().queued + queue.summary().checking === 0,
    );
    assert.equal(store.get(id).group, '美国');
    assert.equal(store.get(id).health.location.country, '美国');
    assert.equal(store.resolveShare(old.token).nodes.length, 0);
    assert.equal(store.resolveShare(usa.token).nodes.length, 1);
    store.update(id, { group: '新手动分组', enabled: false });
    code = 'JP';
    queue.enqueue([id]);
    await eventually(
        () => queue.summary().queued + queue.summary().checking === 0,
    );
    assert.equal(store.get(id).group, '日本');
    assert.equal(store.get(id).enabled, false);
    assert.equal(store.get(id).password, 'p');
    assert.equal(
        store.listGroups().find((g) => g.name === '日本').nodeCount,
        1,
    );
    assert.equal(
        store.listShares().find((s) => s.id === selected.id).enabled,
        true,
    );
    assert.equal(new IspStore({ file: store.file }).get(id).group, '日本');
});
test('location failures retain manual group and online health; unreachable nodes do not trigger geolocation', async (t) => {
    const store = storeFixture(t);
    store.import({
        format: 'HOST:PORT:USER:PASS',
        protocol: 'http',
        content: 'h:80:u:p',
        group: 'Keep',
    });
    const id = store.list().items[0].id;
    let calls = 0;
    let result = online();
    const queue = new ProbeQueue({
        store,
        probe: async () => result,
        locate: async () => {
            calls++;
            throw new Error('provider unavailable');
        },
    });
    t.after(() => queue.close());
    queue.enqueue([id]);
    await eventually(
        () => queue.summary().queued + queue.summary().checking === 0,
    );
    assert.equal(calls, 1);
    assert.equal(store.get(id).health.status, 'online');
    assert.equal(store.get(id).health.location.status, 'unavailable');
    assert.equal(store.get(id).group, 'Keep');
    result = { ...online(), status: 'timeout', exitIp: null };
    queue.enqueue([id]);
    await eventually(
        () => queue.summary().queued + queue.summary().checking === 0,
    );
    assert.equal(calls, 1);
    assert.equal(store.get(id).group, 'Keep');
});
test('stale or deleted probe results never change groups; failed writes persist neither country nor group', (t) => {
    const store = storeFixture(t);
    store.import({
        format: 'HOST:PORT:USER:PASS',
        protocol: 'http',
        content: 'h:80:u:p',
        group: 'Keep',
    });
    const id = store.list().items[0].id;
    const revision = store.get(id).probeRevision;
    const item = { id, revision, result: online(location('US')) };
    const file = store.file;
    store.file = join(file, 'invalid');
    assert.throws(() => store.saveProbeResults([item]));
    assert.equal(store.get(id).group, 'Keep');
    assert.equal(store.get(id).health, undefined);
    store.file = file;
    store.saveProbeResults([item]);
    assert.equal(store.get(id).group, '美国');
    store.update(id, { password: 'new', group: 'New' });
    store.saveProbeResults([item]);
    assert.equal(store.get(id).group, 'New');
    store.batch({ ids: [id], action: 'delete' });
    store.saveProbeResults([item]);
    assert.equal(store.list().total, 0);
});
