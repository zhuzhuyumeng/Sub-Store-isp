import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IspStore } from './store.mjs';
import { createApp } from './app.mjs';
import { createProbe, ProbeQueue } from './probe.mjs';
import { createGeoLookup } from './geo.mjs';
import { createIprRoyalSettings } from './iproyal-settings.mjs';
import { createIprRoyalSync } from './iproyal-sync.mjs';

try {
    const dir = resolve(
        process.env.ISP_DATA_DIR ||
            fileURLToPath(new URL('./.data/', import.meta.url)),
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const port = Number(process.env.ISP_PORT || 3100);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('ISP_PORT 必须为 1–65535');
    const host = process.env.ISP_HOST || '127.0.0.1';
    const store = new IspStore({ file: join(dir, 'store.json') });
    const prober = new ProbeQueue({
        store,
        locate: createGeoLookup({ baseUrl: process.env.ISP_GEO_URL }),
        probe: createProbe({
            target: process.env.ISP_PROBE_URL,
            timeoutMs: Number(process.env.ISP_PROBE_TIMEOUT_MS || 10000),
        }),
        concurrency: Number(process.env.ISP_PROBE_CONCURRENCY || 5),
    });
    const iproyalSettings = createIprRoyalSettings({
        file: join(dir, 'iproyal.json'),
        baseUrl: process.env.IPROYAL_API_URL,
        token: process.env.IPROYAL_API_TOKEN,
        timeoutMs: Number(process.env.IPROYAL_API_TIMEOUT_MS || 15000),
    });
    const iproyalSync = createIprRoyalSync({
        store,
        client: iproyalSettings.client,
        configureClient: iproyalSettings.save,
    });
    const rawSyncInterval = process.env.IPROYAL_SYNC_INTERVAL_MS;
    const syncInterval =
        rawSyncInterval === undefined ? 21600000 : Number(rawSyncInterval);
    iproyalSync.start(syncInterval);
    if (iproyalSettings.client.configured) {
        setTimeout(() => void iproyalSync.run(), 0).unref?.();
    }
    const app = createApp({
        prober,
        store,
        adminToken: process.env.ISP_ADMIN_TOKEN || null,
        publicBaseUrl: process.env.ISP_PUBLIC_BASE_URL,
        iproyalSync,
    });
    const server = app.listen(port, host, () => {
        console.log(
            `ISP Manager 已启动：http://${
                host.includes(':') ? `[${host}]` : host
            }:${port}`,
        );
        console.log(`数据目录：${dir}`);
        console.log(
            process.env.ISP_ADMIN_TOKEN
                ? '管理口令来自 ISP_ADMIN_TOKEN'
                : '管理 API 未启用口令鉴权',
        );
        console.log(
            iproyalSettings.client.configured
                ? 'IPRoyal API 已配置，将同步订单有效期'
                : 'IPRoyal API 未配置，跳过订单有效期同步',
        );
    });
    server.on('error', () => {
        console.error('服务启动失败，请检查监听地址及端口是否被占用');
        process.exitCode = 1;
    });
    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        const closed = new Promise((resolve) => server.close(resolve));
        await iproyalSync.close();
        await prober.close();
        await closed;
        process.exit(prober.storageError ? 1 : 0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
} catch (error) {
    console.error(
        error.code ? 'ISP Manager 启动失败，请检查数据目录权限' : error.message,
    );
    process.exitCode = 1;
}
