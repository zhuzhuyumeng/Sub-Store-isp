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
import { IspStore } from '../store.mjs';

const input = (content, group = '') => ({
    format: 'HOST:PORT:USER:PASS',
    protocol: 'http',
    content,
    group,
});
function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'isp-groups-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'store.json');
    return { file, store: new IspStore({ file }) };
}

test('empty groups persist, reject invalid or duplicate names, and accept future nodes', (t) => {
    const { file, store } = fixture(t);
    store.createGroup('  香港 / 家宽  ');
    assert.deepEqual(new IspStore({ file }).listGroups(), [
        { name: '香港 / 家宽', nodeCount: 0, shareCount: 0 },
    ]);
    assert.deepEqual(store.list().groups, ['香港 / 家宽']);
    for (const name of ['', '   ', '\n', 'a'.repeat(101), null, [], 12]) {
        assert.throws(() => store.createGroup(name));
    }
    assert.throws(() => store.createGroup('香港 / 家宽'), /已存在/);
    const share = store.createShare({
        name: '预留分组',
        scope: 'group',
        group: '香港 / 家宽',
    });
    assert.equal(store.resolveShare(share.token).nodes.length, 0);
    store.import(input('first.example:80:u:p', '香港 / 家宽'));
    assert.equal(store.resolveShare(share.token).nodes.length, 1);
    const id = store.list().items[0].id;
    store.batch({ ids: [id], action: 'delete' });
    assert.deepEqual(new IspStore({ file }).listGroups(), [
        { name: '香港 / 家宽', nodeCount: 0, shareCount: 1 },
    ]);
});

test('legacy groups migrate without changing nodes, subscriptions or the file on read', (t) => {
    const { file, store } = fixture(t);
    store.import(input('h:80:u:p', 'US'));
    const share = store.createShare({
        name: 'Old',
        scope: 'group',
        group: 'US',
    });
    store.update(store.list().items[0].id, { group: 'UK' });
    const legacy = JSON.parse(readFileSync(file, 'utf8'));
    delete legacy.groups;
    writeFileSync(file, JSON.stringify(legacy));
    const before = readFileSync(file, 'utf8');
    const migrated = new IspStore({ file });
    assert.deepEqual(migrated.list().groups, ['UK', 'US']);
    assert.deepEqual(migrated.state.nodes, legacy.nodes);
    assert.equal(migrated.listShares()[0].token, share.token);
    assert.equal(readFileSync(file, 'utf8'), before);
    migrated.createGroup('New');
    assert.deepEqual(new IspStore({ file }).list().groups, ['New', 'UK', 'US']);
});

test('rename updates disabled nodes and all group shares atomically without changing credentials or health', (t) => {
    const { file, store } = fixture(t);
    store.import(input('a:80:u:p\nb:80:u:p', 'Old'));
    store.import(input('c:80:u:p', 'Other'));
    const [a, b] = store.list({ group: 'Old' }).items;
    store.update(b.id, { enabled: false });
    const healthy = {
        status: 'online',
        auth: 'accepted',
        exitIp: '203.0.113.8',
        latencyMs: 10,
        checkedAt: new Date().toISOString(),
    };
    store.saveProbeResults([
        { id: a.id, revision: store.get(a.id).probeRevision, result: healthy },
    ]);
    const share = store.createShare({
        name: 'Group',
        scope: 'group',
        group: 'Old',
    });
    const revoked = store.createShare({
        name: 'Revoked',
        scope: 'group',
        group: 'Old',
    });
    store.revokeShare(revoked.id);
    const before = store.get(a.id);
    store.renameGroup('Old', '  New  ');
    assert.equal(store.get(a.id).group, 'New');
    assert.equal(store.get(b.id).group, 'New');
    assert.equal(store.get(b.id).enabled, false);
    assert.equal(store.get(a.id).password, before.password);
    assert.equal(store.get(a.id).probeRevision, before.probeRevision);
    assert.deepEqual(store.get(a.id).health, healthy);
    assert.deepEqual(
        store.resolveShare(share.token).nodes.map((n) => n.id),
        [a.id],
    );
    assert.ok(store.listShares().every((s) => s.group === 'New'));
    assert.equal(
        store.listShares().find((s) => s.id === revoked.id).enabled,
        false,
    );
    assert.deepEqual(new IspStore({ file }).list().groups, ['New', 'Other']);
    const snapshot = structuredClone(store.state);
    assert.throws(() => store.renameGroup('New', 'Other'), /已存在/);
    assert.throws(() => store.renameGroup('Missing', 'New'), /不存在/);
    assert.throws(() => store.renameGroup('New', ' '), /无效/);
    assert.deepEqual(store.state, snapshot);
});

test('delete keeps nodes and unrelated shares, and old group links stay revoked after recreation', (t) => {
    const { file, store } = fixture(t);
    store.import(input('a:80:u:p\nb:80:u:p', 'US'));
    store.import(input('c:80:u:p', 'Other'));
    const ids = store.list({ group: 'US' }).items.map((n) => n.id);
    store.update(ids[1], { enabled: false });
    const groupShare = store.createShare({
        name: 'Group',
        scope: 'group',
        group: 'US',
    });
    const all = store.createShare({ name: 'All', scope: 'all' });
    const selected = store.createShare({
        name: 'Selected',
        scope: 'selected',
        ids: [ids[0]],
    });
    store.deleteGroup('US');
    assert.equal(store.list().total, 3);
    assert.equal(store.list({ group: '' }).total, 2);
    assert.equal(store.get(ids[1]).enabled, false);
    assert.throws(() => store.resolveShare(groupShare.token), /已失效/);
    assert.equal(store.resolveShare(all.token).nodes.length, 2);
    assert.deepEqual(
        store.resolveShare(selected.token).nodes.map((n) => n.id),
        [ids[0]],
    );
    assert.deepEqual(store.list().groups, ['', 'Other']);
    assert.equal(
        new IspStore({ file }).listGroups().some((g) => g.name === 'US'),
        false,
    );
    store.createGroup('US');
    store.batch({ action: 'group', ids: [ids[0]], group: 'US' });
    assert.throws(() => store.resolveShare(groupShare.token), /已失效/);
    assert.throws(() => store.deleteGroup(''), /无效/);
    assert.throws(() => store.deleteGroup('Missing'), /不存在/);
});

test('import, edits and batch moves register groups; previews and skipped imports do not', (t) => {
    const { store } = fixture(t);
    store.import(input('a:80:u:p', 'Preview'), { preview: true });
    assert.deepEqual(store.listGroups(), []);
    store.import(input('a:80:u:p', 'Imported'));
    store.import(input('a:80:u:p', 'Skipped'));
    store.import({ ...input('a:80:u:p2', 'Updated'), duplicate: 'update' });
    const id = store.list().items[0].id;
    store.update(id, { group: 'Edited' });
    store.batch({ ids: [id], action: 'group', group: 'Moved' });
    assert.deepEqual(store.list().groups, [
        'Edited',
        'Imported',
        'Moved',
        'Updated',
    ]);
});

test('group writes roll back on failure and invalid group registries reject startup', (t) => {
    const { file, store } = fixture(t);
    store.import(input('a:80:u:p', 'US'));
    store.createShare({ name: 'Group', scope: 'group', group: 'US' });
    const snapshot = structuredClone(store.state);
    rmSync(file);
    mkdirSync(file);
    for (const action of [
        () => store.createGroup('New'),
        () => store.renameGroup('US', 'New'),
        () => store.deleteGroup('US'),
    ]) {
        assert.throws(action);
        assert.deepEqual(store.state, snapshot);
    }
    rmSync(file, { recursive: true });
    for (const groups of [null, {}, [''], ['US', 'US'], [' US '], [12]]) {
        writeFileSync(file, JSON.stringify({ ...snapshot, groups }));
        assert.throws(() => new IspStore({ file }), /数据格式无效/);
    }
});
