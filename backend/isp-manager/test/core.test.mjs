import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    mkdtempSync,
    rmSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseImport } from '../parser.mjs';
import { IspStore } from '../store.mjs';

const formats = [
    ['HOST:PORT:USER:PASS', 'proxy.example:12323:alice:p:a@ss'],
    ['HOST:PORT@USER:PASS', 'proxy.example:12323@alice:p:a@ss'],
    ['USER:PASS:HOST:PORT', 'alice:p:a@ss:proxy.example:12323'],
    ['USER:PASS@HOST:PORT', 'alice:p:a@ss@proxy.example:12323'],
];
for (const [format, content] of formats)
    test(`parses ${format} preserving literal credentials`, () => {
        const result = parseImport({
            format,
            content,
            protocol: 'https',
            group: '美国',
        });
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.rows[0].node, {
            protocol: 'https',
            server: 'proxy.example',
            port: 12323,
            username: 'alice',
            password: 'p:a@ss',
            group: '美国',
        });
    });
test('parses bracketed IPv6 for every selectable format', () => {
    for (const [format, content] of [
        ['HOST:PORT:USER:PASS', '[2001:db8::1]:8080:u:p'],
        ['HOST:PORT@USER:PASS', '[2001:db8::1]:8080@u:p'],
        ['USER:PASS:HOST:PORT', 'u:p:[2001:db8::1]:8080'],
        ['USER:PASS@HOST:PORT', 'u:p@[2001:db8::1]:8080'],
    ]) {
        const result = parseImport({ format, content, protocol: 'socks5' });
        assert.equal(result.rows[0]?.node.server, '2001:db8::1');
    }
});
test('ignores blank lines, reports original line numbers without credentials', () => {
    const result = parseImport({
        format: formats[0][0],
        protocol: 'http',
        content:
            '\nproxy.example:80:u:00%40\r\n\nbad:99999:secret:secret\nnope',
    });
    assert.equal(result.total, 3);
    assert.equal(result.rows[0].node.password, '00%40');
    assert.deepEqual(
        result.errors.map((e) => e.line),
        [4, 5],
    );
    assert.ok(!JSON.stringify(result.errors).includes('secret'));
});
test('rejects bad ports, hosts, blank credentials and unknown formats', () => {
    for (const line of [
        'h:0:u:p',
        'h:65536:u:p',
        'http://h:80:u:p',
        'bad host:80:u:p',
        '999.1.1.1:80:u:p',
        'h:80::p',
        'h:80:u:',
        '2001:db8::1:80:u:p',
    ]) {
        assert.equal(
            parseImport({
                format: formats[0][0],
                protocol: 'http',
                content: line,
            }).errors.length,
            1,
            line,
        );
    }
    assert.throws(() =>
        parseImport({ format: 'unknown', protocol: 'http', content: 'x' }),
    );
    assert.throws(() =>
        parseImport({ format: formats[0][0], protocol: 'bad', content: 'x' }),
    );
});
function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'isp-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return { dir, file: join(dir, 'store.json') };
}
const input = (content, extra = {}) => ({
    format: formats[0][0],
    protocol: 'http',
    content,
    ...extra,
});
test('preview is side effect free; import is idempotent and persists across restart', (t) => {
    const { file } = fixture(t);
    const store = new IspStore({ file });
    assert.equal(store.import(input('h:80:u:p'), { preview: true }).created, 1);
    assert.equal(store.list({}).total, 0);
    store.import(input('h:80:u:p\nh:80:u:p'));
    assert.equal(store.list({}).total, 1);
    assert.equal(new IspStore({ file }).list({}).total, 1);
    assert.equal(store.import(input('h:80:u:p')).skipped, 1);
});
test('update-duplicates preserves identity and enabled state while rotating password', (t) => {
    const { file } = fixture(t);
    const store = new IspStore({ file });
    store.import(input('h:80:u:p'));
    const id = store.list({}).items[0].id;
    store.update(id, { enabled: false, name: 'Custom' });
    const result = store.import(
        input('h:80:u:new', { duplicate: 'update', group: 'UK' }),
    );
    assert.equal(result.updated, 1);
    const node = store.get(id);
    assert.equal(node.password, 'new');
    assert.equal(node.enabled, false);
    assert.equal(node.name, 'Custom');
    assert.equal(node.group, 'UK');
    assert.ok(!JSON.stringify(store.list({})).includes('"password"'));
});
test('valid lines import despite errors; batch validates all ids before changes', (t) => {
    const { file } = fixture(t);
    const store = new IspStore({ file });
    const result = store.import(input('h:80:u:p\ninvalid'));
    assert.equal(result.created, 1);
    assert.equal(result.errors.length, 1);
    const id = store.list({}).items[0].id;
    assert.throws(() =>
        store.batch({ ids: [id, 'missing'], action: 'delete' }),
    );
    assert.equal(store.list({}).total, 1);
    store.batch({ ids: [id], action: 'disable' });
    assert.equal(store.get(id).enabled, false);
    store.batch({ ids: [id], action: 'group', group: 'Group A' });
    assert.equal(store.list({ group: 'Group A' }).total, 1);
});
test('10k imports and filters paginate without exposing credentials', (t) => {
    const { file } = fixture(t);
    const store = new IspStore({ file });
    const content = Array.from(
        { length: 10000 },
        (_, i) => `host-${i}.example:80:user:private`,
    ).join('\n');
    assert.equal(store.import(input(content)).created, 10000);
    const result = store.list({ page: '2', pageSize: '100' });
    assert.equal(result.items.length, 100);
    assert.equal(result.total, 10000);
    assert.equal(store.list({ q: 'host-9999.example' }).total, 1);
    assert.ok(!JSON.stringify(result).includes('private'));
});
test('failed persistence leaves in-memory state intact and corrupt stores are never reset', (t) => {
    const { dir, file } = fixture(t);
    const store = new IspStore({ file });
    store.import(input('h:80:u:p'));
    rmSync(file);
    mkdirSync(file);
    assert.throws(() => store.import(input('h2:80:u:p')));
    assert.equal(store.list({}).total, 1);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, 'broken');
    assert.throws(() => new IspStore({ file: bad }));
    assert.equal(readFileSync(bad, 'utf8'), 'broken');
});
test('shares resolve live scope, disabled nodes, expiry and revocation', (t) => {
    const { file } = fixture(t);
    const store = new IspStore({ file });
    store.import(input('h:80:u:p', { group: 'US' }));
    store.import(input('other:80:u:p', { group: 'UK' }));
    const share = store.createShare({
        name: 'US only',
        scope: 'group',
        group: 'US',
    });
    assert.equal(store.resolveShare(share.token).nodes.length, 1);
    const node = store.list({ group: 'US' }).items[0];
    store.update(node.id, { enabled: false });
    assert.equal(store.resolveShare(share.token).nodes.length, 0);
    store.revokeShare(share.id);
    assert.throws(() => store.resolveShare(share.token));
    assert.throws(() =>
        store.createShare({
            name: 'Bad',
            scope: 'all',
            expiresAt: '2020-01-01T00:00:00.000Z',
        }),
    );
    assert.throws(() =>
        store.createShare({ name: 'Bad', scope: 'selected', ids: [] }),
    );
});

test('long valid hostnames survive persistence and restart', (t) => {
    const { file } = fixture(t);
    const store = new IspStore({ file });
    const host = Array.from({ length: 4 }, () => 'a'.repeat(60)).join('.');
    store.import(input(`${host}:80:u:p`));
    assert.equal(new IspStore({ file }).list({}).total, 1);
});

test('IPRoyal metadata is saved atomically, visible without passwords, and survives restart', (t) => {
    const { file } = fixture(t);
    const store = new IspStore({ file });
    store.import(input('203.0.113.10:12323:u:p'));
    const id = store.list({}).items[0].id;
    const syncedAt = '2026-10-16T12:00:00.000Z';
    const result = store.saveIprRoyalSync(
        {
            [id]: {
                orderId: 420,
                status: 'expired',
                expiresAt: '2020-04-20T10:25:12.000Z',
                syncedAt,
                syncStatus: 'expired',
            },
        },
        { fetchedOrders: 1, unmatched: 0, syncedAt },
    );
    assert.deepEqual(result, { matched: 1, unmatched: 0 });
    assert.equal(store.get(id).iproyal.orderId, 420);
    assert.equal(store.get(id).enabled, true);
    assert.equal(store.list({}).items[0].password, undefined);
    assert.equal(new IspStore({ file }).get(id).iproyal.syncStatus, 'expired');
    assert.equal(store.iproyalSyncState().status, 'ok');
});

test('IPRoyal sync failure records only a sanitized status and preserves node metadata', (t) => {
    const { file } = fixture(t);
    const store = new IspStore({ file });
    store.import(input('203.0.113.10:12323:u:p'));
    const id = store.list({}).items[0].id;
    store.saveIprRoyalSync(
        {
            [id]: {
                orderId: 420,
                status: 'confirmed',
                expiresAt: '2099-04-20T10:25:12.000Z',
                syncedAt: '2026-10-16T12:00:00.000Z',
                syncStatus: 'matched',
            },
        },
        { fetchedOrders: 1, unmatched: 0, syncedAt: '2026-10-16T12:00:00.000Z' },
    );
    store.recordIprRoyalSyncFailure('request failed [redacted]', '2026-10-16T12:01:00.000Z');
    assert.equal(store.get(id).iproyal.orderId, 420);
    assert.equal(store.iproyalSyncState().status, 'error');
    assert.equal(store.iproyalSyncState().error, 'request failed [redacted]');
});
