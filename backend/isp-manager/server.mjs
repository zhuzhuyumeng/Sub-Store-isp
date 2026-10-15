import { randomBytes } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    chmodSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IspStore } from './store.mjs';
import { createApp } from './app.mjs';
import { createProbe, ProbeQueue } from './probe.mjs';

try {
    const dir = resolve(
        process.env.ISP_DATA_DIR ||
            fileURLToPath(new URL('./.data/', import.meta.url)),
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tokenFile = join(dir, 'admin-token');
    let token = process.env.ISP_ADMIN_TOKEN;
    if (!token) {
        if (!existsSync(tokenFile))
            writeFileSync(tokenFile, randomBytes(32).toString('hex'), {
                flag: 'wx',
                mode: 0o600,
            });
        chmodSync(tokenFile, 0o600);
        token = readFileSync(tokenFile, 'utf8').trim();
    }
    const port = Number(process.env.ISP_PORT || 3100);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('ISP_PORT 必须为 1–65535');
    const host = process.env.ISP_HOST || '127.0.0.1';
    const store = new IspStore({ file: join(dir, 'store.json') });
    const prober = new ProbeQueue({
        store,
        probe: createProbe({
            target: process.env.ISP_PROBE_URL,
            timeoutMs: Number(process.env.ISP_PROBE_TIMEOUT_MS || 10000),
        }),
        concurrency: Number(process.env.ISP_PROBE_CONCURRENCY || 5),
    });
    const app = createApp({
        prober,
        store,
        adminToken: token,
        publicBaseUrl: process.env.ISP_PUBLIC_BASE_URL,
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
                : `管理口令文件：${tokenFile}`,
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
