import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IspStore } from '../store.mjs';

const probeModule = () => import('../probe.mjs');
const input = (count = 1) => ({
    format: 'HOST:PORT:USER:PASS',
    protocol: 'http',
    content: Array.from(
        { length: count },
        (_, i) => `node${i}.example:80:u:p`,
    ).join('\n'),
});
const success = () => ({
    status: 'online',
    auth: 'accepted',
    latencyMs: 12,
    exitIp: '203.0.113.8',
    checkedAt: new Date().toISOString(),
});
async function listen(t, server) {
    const sockets = new Set();
    server.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
    });
    server.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    t.after(async () => {
        for (const s of sockets) s.destroy();
        await new Promise((r) => server.close(r));
    });
    return server.address().port;
}
async function proxyFixture(
    t,
    {
        status = 200,
        body = '{"ip":"203.0.113.8"}',
        authStatus = 200,
        hang = false,
    } = {},
) {
    const received = [];
    const checker = http.createServer((req, res) => {
        received.push(req.headers);
        if (hang) return;
        res.writeHead(status);
        res.end(body);
    });
    const checkerPort = await listen(t, checker);
    const authHeaders = [];
    const proxy = http.createServer();
    proxy.on('connect', (req, socket, head) => {
        authHeaders.push(req.headers['proxy-authorization']);
        if (authStatus !== 200)
            return socket.end(
                `HTTP/1.1 ${authStatus} Rejected\r\nContent-Length: 0\r\n\r\n`,
            );
        const upstream = net.connect(checkerPort, '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.write(head);
            socket.pipe(upstream).pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('close', () => upstream.destroy());
        socket.on('error', () => upstream.destroy());
    });
    const port = await listen(t, proxy);
    return {
        node: {
            protocol: 'http',
            server: '127.0.0.1',
            port,
            username: 'literal%40',
            password: 'p:@%40',
        },
        target: `http://127.0.0.1:${checkerPort}/`,
        received,
        authHeaders,
    };
}
function storeFixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'isp-probe-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return new IspStore({ file: join(dir, 'store.json') });
}
async function eventually(fn) {
    for (let i = 0; i < 200; i++) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail('condition did not become true');
}
test('HTTP CONNECT checks exit IP with literal proxy credentials kept out of checker request', async (t) => {
    const { createProbe } = await probeModule();
    const fixture = await proxyFixture(t);
    const result = await createProbe({ target: fixture.target })(fixture.node);
    assert.equal(result.status, 'online');
    assert.equal(result.exitIp, '203.0.113.8');
    assert.equal(result.auth, 'accepted');
    assert.ok(result.latencyMs >= 0);
    assert.equal(
        fixture.authHeaders[0],
        'Basic ' + Buffer.from('literal%40:p:@%40').toString('base64'),
    );
    assert.equal(fixture.received[0]['proxy-authorization'], undefined);
    assert.equal(fixture.received[0].authorization, undefined);
    assert.ok(!JSON.stringify(result).includes(fixture.node.password));
});
test('probe distinguishes rejected authentication, timeout and checker failures', async (t) => {
    const { createProbe } = await probeModule();
    for (const [options, status] of [
        [{ authStatus: 407 }, 'auth_failed'],
        [{ hang: true }, 'timeout'],
        [{ status: 503 }, 'check_failed'],
        [{ body: 'not an IP' }, 'check_failed'],
        [{ body: 'x'.repeat(20000) }, 'check_failed'],
        [{ status: 302 }, 'check_failed'],
    ]) {
        const f = await proxyFixture(t, options);
        const result = await createProbe({ target: f.target, timeoutMs: 150 })(
            f.node,
        );
        assert.equal(result.status, status);
        assert.equal(result.exitIp, null);
        assert.ok(!JSON.stringify(result).includes(f.node.password));
    }
});
test('all imported IDs beyond preview limit can be checked, preview and skipped duplicates do not enqueue', () => {
    const store = new IspStore({
        file: join(tmpdir(), 'unused-preview-only.json'),
    });
    const seen = [];
    store.import(input(101), {
        preview: true,
        onImported: (ids) => seen.push(...ids),
    });
    assert.equal(seen.length, 0);
});
test('import reports committed IDs and changed connections invalidate health', async (t) => {
    const store = storeFixture(t);
    let ids = [];
    store.import(input(101), {
        onImported: (value) => {
            ids = value;
        },
    });
    assert.equal(ids.length, 101);
    const node = store.get(ids[0]);
    store.saveProbeResults([
        { id: node.id, revision: node.probeRevision, result: success() },
    ]);
    assert.equal(store.get(node.id).health.status, 'online');
    store.update(node.id, { name: 'Renamed', enabled: false });
    assert.equal(store.get(node.id).health.status, 'online');
    store.update(node.id, { password: 'new' });
    assert.equal(store.get(node.id).health, undefined);
    store.saveProbeResults([
        { id: node.id, revision: node.probeRevision, result: success() },
    ]);
    assert.equal(store.get(node.id).health, undefined);
    ids = ['should be replaced'];
    store.import(input(101), {
        onImported: (value) => {
            ids = value;
        },
    });
    assert.deepEqual(ids, []);
});
test('queue caps concurrency, coalesces repeats, preserves enable state, persists results', async (t) => {
    const { ProbeQueue } = await probeModule();
    const store = storeFixture(t);
    store.import(input(101));
    const ids = store.state.nodes.map((n) => n.id);
    store.update(ids[0], { enabled: false });
    let active = 0,
        max = 0,
        calls = 0;
    const queue = new ProbeQueue({
        store,
        concurrency: 3,
        probe: async () => {
            active++;
            calls++;
            max = Math.max(max, active);
            await new Promise((r) => setTimeout(r, 2));
            active--;
            return success();
        },
    });
    t.after(() => queue.close());
    assert.equal(queue.enqueue(ids).queued, 101);
    assert.equal(queue.enqueue(ids).queued, 0);
    await eventually(
        () => queue.summary().queued + queue.summary().checking === 0,
    );
    assert.equal(max, 3);
    assert.equal(calls, 101);
    const restarted = new IspStore({ file: store.file });
    assert.equal(
        restarted.state.nodes.filter((n) => n.health?.status === 'online')
            .length,
        101,
    );
    assert.equal(restarted.get(ids[0]).enabled, false);
    assert.throws(() => queue.enqueue([ids[0], 'missing']), /不存在/);
});
test('pending stale checks cannot overwrite edited or deleted nodes', async (t) => {
    const { ProbeQueue } = await probeModule();
    const store = storeFixture(t);
    store.import(input(2));
    const [a, b] = store.state.nodes;
    const releases = [];
    const queue = new ProbeQueue({
        store,
        concurrency: 2,
        probe: () => new Promise((r) => releases.push(r)),
    });
    t.after(() => queue.close());
    queue.enqueue([a.id, b.id]);
    await eventually(() => releases.length === 2);
    store.update(a.id, { password: 'rotated' });
    store.batch({ ids: [b.id], action: 'delete' });
    for (const r of releases) r(success());
    await eventually(() => queue.summary().checking === 0);
    assert.equal(store.get(a.id).health, undefined);
    assert.equal(store.state.nodes.length, 1);
});

test('SOCKS5 negotiates username/password and sends a request through the tunnel', async (t) => {
    const { createProbe } = await probeModule();
    for (const rejectAuth of [false, true]) {
        let credentials;
        const proxy = net.createServer((socket) => {
            let stage = 0,
                buffer = Buffer.alloc(0);
            socket.on('error', () => {});
            socket.on('data', function receive(data) {
                buffer = Buffer.concat([buffer, data]);
                if (stage === 0) {
                    if (buffer.length < 2 || buffer.length < 2 + buffer[1])
                        return;
                    buffer = buffer.subarray(2 + buffer[1]);
                    stage = 1;
                    socket.write(Buffer.from([5, 2]));
                }
                if (stage === 1) {
                    if (buffer.length < 2 || buffer.length < 3 + buffer[1])
                        return;
                    const userLength = buffer[1],
                        passLength = buffer[2 + userLength],
                        length = 3 + userLength + passLength;
                    if (buffer.length < length) return;
                    credentials = [
                        buffer.subarray(2, 2 + userLength).toString(),
                        buffer.subarray(3 + userLength, length).toString(),
                    ];
                    buffer = buffer.subarray(length);
                    stage = 2;
                    if (rejectAuth) return socket.end(Buffer.from([1, 1]));
                    socket.write(Buffer.from([1, 0]));
                }
                if (stage === 2) {
                    if (buffer.length < 5) return;
                    const length =
                        buffer[3] === 3
                            ? 7 + buffer[4]
                            : buffer[3] === 1
                            ? 10
                            : 22;
                    if (buffer.length < length) return;
                    buffer = buffer.subarray(length);
                    stage = 3;
                    socket.write(
                        Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]),
                    );
                }
                if (stage === 3 && buffer.includes('\r\n\r\n')) {
                    socket.removeListener('data', receive);
                    assert.ok(
                        !buffer
                            .toString()
                            .toLowerCase()
                            .includes('authorization'),
                    );
                    const body = '{"ip":"2001:db8::1"}';
                    socket.end(
                        `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
                    );
                }
            });
        });
        const port = await listen(t, proxy);
        const result = await createProbe({
            target: 'http://checker.example/',
            timeoutMs: 1000,
        })({
            protocol: 'socks5',
            server: '127.0.0.1',
            port,
            username: 'u%40',
            password: 'p:@%40',
        });
        assert.equal(result.status, rejectAuth ? 'auth_failed' : 'online');
        assert.deepEqual(credentials, ['u%40', 'p:@%40']);
        if (!rejectAuth) assert.equal(result.exitIp, '2001:db8::1');
    }
});

test('newer completed result survives an older in-flight check completing last', async (t) => {
    const { ProbeQueue } = await probeModule();
    const store = storeFixture(t);
    store.import(input());
    const id = store.state.nodes[0].id;
    const releases = [];
    const queue = new ProbeQueue({
        store,
        probe: () => new Promise((r) => releases.push(r)),
    });
    t.after(() => queue.close());
    queue.enqueue([id]);
    await eventually(() => releases.length === 1);
    store.update(id, { password: 'new' });
    queue.enqueue([id]);
    await eventually(() => releases.length === 2);
    releases[1]({ ...success(), exitIp: '203.0.113.9' });
    await eventually(() => queue.summary().checking === 1);
    releases[0](success());
    await eventually(() => queue.summary().checking === 0);
    assert.equal(store.get(id).health.exitIp, '203.0.113.9');
});

// Public test-only certificate/key; never used by the service.
test('HTTPS proxy and HTTPS destination validate certificates and tunnel successfully with a trusted CA', async (t) => {
    const certPath = fileURLToPath(
        new URL('./fixtures/probe-cert.pem', import.meta.url),
    );
    const options = {
        cert: readFileSync(certPath),
        key: readFileSync(new URL('./fixtures/probe-key.pem', import.meta.url)),
    };
    const checker = https.createServer(options, (req, res) => {
        assert.equal(req.headers['proxy-authorization'], undefined);
        res.end('{"ip":"203.0.113.7"}');
    });
    const targetPort = await listen(t, checker);
    const proxy = https.createServer(options);
    proxy.on('connect', (req, socket, head) => {
        const upstream = net.connect(targetPort, '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.write(head);
            socket.pipe(upstream).pipe(socket);
        });
        socket.on('close', () => upstream.destroy());
        socket.on('error', () => upstream.destroy());
        upstream.on('error', () => socket.destroy());
    });
    const port = await listen(t, proxy);
    const node = {
        protocol: 'https',
        server: 'localhost',
        port,
        username: 'u',
        password: 'p',
    };
    const target = `https://localhost:${targetPort}/`;
    const { createProbe } = await probeModule();
    assert.equal(
        (await createProbe({ target, timeoutMs: 500 })(node)).status,
        'unreachable',
    );
    const script = `import {createProbe} from ${JSON.stringify(
        new URL('../probe.mjs', import.meta.url).href,
    )};console.log(JSON.stringify(await createProbe({target:${JSON.stringify(
        target,
    )}})(${JSON.stringify(node)})));`;
    const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
            env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath },
            timeout: 15000,
        },
    );
    assert.equal(JSON.parse(stdout).status, 'online');
    assert.equal(JSON.parse(stdout).exitIp, '203.0.113.7');
});

test('probe results survive storage errors and retry without losing newer node data', async (t) => {
    const { ProbeQueue } = await probeModule();
    const store = storeFixture(t);
    store.import(input());
    const id = store.state.nodes[0].id;
    const queue = new ProbeQueue({ store, probe: async () => success() });
    t.after(() => queue.close());
    const original = store.file;
    store.file = join(store.file, 'invalid.json');
    queue.enqueue([id]);
    await eventually(
        () => queue.summary().checking + queue.summary().queued === 0,
    );
    assert.equal(queue.summary().storageError, true);
    assert.equal(queue.decorate(store.list().items[0]).health.status, 'online');
    store.file = original;
    store.update(id, { name: 'Retained' });
    queue.flush();
    assert.equal(queue.summary().storageError, false);
    const restored = new IspStore({ file: original });
    assert.equal(restored.get(id).health.status, 'online');
    assert.equal(restored.get(id).name, 'Retained');
});
