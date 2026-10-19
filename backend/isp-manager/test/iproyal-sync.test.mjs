import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IspStore } from '../store.mjs';
import { createIprRoyalSync } from '../iproyal-sync.mjs';

function setup(t) {
    const dir = mkdtempSync(join(tmpdir(), 'isp-iproyal-sync-'));
    const store = new IspStore({ file: join(dir, 'store.json') });
    store.import({
        format: 'HOST:PORT:USER:PASS',
        protocol: 'http',
        content: '203.0.113.10:12323:u:p',
    });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return store;
}

test('IPRoyal synchronizer saves matches and exposes non-secret status', async (t) => {
    const store = setup(t);
    const node = store.providerNodes()[0];
    const sync = createIprRoyalSync({
        store,
        client: {
            configured: true,
            syncNodes: async () => ({
                updates: {
                    [node.id]: {
                        orderId: 420,
                        status: 'confirmed',
                        expiresAt: '2099-04-20T10:25:12.000Z',
                        syncedAt: '2026-10-16T12:00:00.000Z',
                        syncStatus: 'matched',
                    },
                },
                fetchedOrders: 1,
                unmatched: 0,
                syncedAt: '2026-10-16T12:00:00.000Z',
            }),
        },
    });
    const result = await sync.run();
    assert.equal(result.status, 'ok');
    assert.equal(store.get(node.id).iproyal.orderId, 420);
    assert.equal(sync.status().status, 'ok');
    assert.ok(!JSON.stringify(sync.status()).includes('token'));
});

test('IPRoyal synchronizer preserves previous metadata when API fails', async (t) => {
    const store = setup(t);
    const node = store.providerNodes()[0];
    store.saveIprRoyalSync(
        {
            [node.id]: {
                orderId: 420,
                status: 'confirmed',
                expiresAt: '2099-04-20T10:25:12.000Z',
                syncedAt: '2026-10-16T12:00:00.000Z',
                syncStatus: 'matched',
            },
        },
        { fetchedOrders: 1, unmatched: 0 },
    );
    const sync = createIprRoyalSync({
        store,
        client: {
            configured: true,
            syncNodes: async () => {
                throw new Error('secret-token must not escape');
            },
        },
    });
    const result = await sync.run();
    assert.equal(result.status, 'error');
    assert.equal(store.get(node.id).iproyal.orderId, 420);
    assert.ok(!result.error.includes('secret-token'));
});

test('unconfigured IPRoyal synchronizer does nothing', async (t) => {
    const store = setup(t);
    const sync = createIprRoyalSync({
        store,
        client: { configured: false },
    });
    assert.deepEqual(await sync.run(), { status: 'not_configured' });
    assert.equal(sync.status().status, 'not_configured');
});
