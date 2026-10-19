import { IspError } from './parser.mjs';

function publicError(error) {
    if (error?.code === 'IPROYAL_NOT_CONFIGURED') return 'IPRoyal API 未配置 Token';
    if (error?.code === 'IPROYAL_ISP_PRODUCT_UNAVAILABLE') return 'IPRoyal 账户未返回可用的 ISP 产品，请确认产品权限';
    if (error?.code === 'IPROYAL_API_ERROR') return 'IPRoyal API 请求失败，请稍后重试';
    return 'IPRoyal 同步失败，请检查 API 配置';
}

export function createIprRoyalSync({ store, client, configureClient }) {
    let pending = null;
    let timer = null;
    let interval = 0;

    function status() {
        const current = store.iproyalSyncState();
        if (!client?.configured)
            return { ...current, status: 'not_configured', configured: false, running: false };
        return { ...current, configured: true, running: Boolean(pending) };
    }

    async function run() {
        if (!client?.configured) return { status: 'not_configured' };
        if (pending) return pending;
        pending = (async () => {
            try {
                const result = await client.syncNodes(store.providerNodes());
                const saved = store.saveIprRoyalSync(result.updates, result);
                return {
                    status: 'ok',
                    ...saved,
                    fetchedOrders: result.fetchedOrders,
                    syncedAt: result.syncedAt,
                };
            } catch (error) {
                const message = publicError(error);
                const state = store.recordIprRoyalSyncFailure(message);
                return { status: 'error', error: message, syncedAt: state.syncedAt };
            } finally {
                pending = null;
            }
        })();
        return pending;
    }

    function start(intervalMs = 0) {
        if (!Number.isInteger(intervalMs) || (intervalMs !== 0 && intervalMs < 60000))
            throw new Error('IPROYAL_SYNC_INTERVAL_MS 必须为 0 或至少 60000');
        interval = intervalMs;
        if (timer) clearInterval(timer);
        timer = null;
        if (!client?.configured || !intervalMs) return;
        timer = setInterval(() => void run(), intervalMs);
        timer.unref?.();
    }

    function configure(token) {
        if (!configureClient) throw new IspError('此服务未启用页面配置', 503);
        if (pending) throw new IspError('正在同步，请等待完成后再修改 Token', 409);
        client = configureClient(token);
        start(interval);
        return { configured: client.configured };
    }

    async function close() {
        if (timer) clearInterval(timer);
        timer = null;
        await pending;
    }

    return { run, start, close, status, configure };
}
