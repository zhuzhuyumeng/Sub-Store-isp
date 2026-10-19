import { IspError } from './parser.mjs';

export const DEFAULT_IPROYAL_API_URL =
    'https://apid.iproyal.com/v1/reseller';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PAGE_SIZE = 100;
const STATUS_RANK = new Map([
    ['confirmed', 5],
    ['in-progress', 4],
    ['expired', 3],
    ['refunded', 2],
    ['unpaid', 1],
]);

function safeMessage(error, token) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replaceAll(token, '[redacted]').slice(0, 300);
}

function apiError(message, code = 'IPROYAL_API_ERROR', status = 502) {
    const error = new IspError(message, status);
    error.code = code;
    return error;
}

function normalizeBaseUrl(value) {
    const base = value || DEFAULT_IPROYAL_API_URL;
    let url;
    try {
        url = new URL(base.endsWith('/') ? base : `${base}/`);
    } catch {
        throw new Error('IPROYAL_API_URL 必须是 HTTP(S) 地址');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('IPROYAL_API_URL 必须是无凭据的 HTTP(S) 地址');
    return url;
}

function normalizeHost(value) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/^\[|\]$/g, '').toLowerCase();
}

function normalizeDate(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const raw = value.trim();
    const parsed = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function portValues(ports, protocol) {
    if (!ports || typeof ports !== 'object') return [];
    if (protocol === 'socks5')
        return [ports.socks5, ports.socks, ports['socks5|socks']];
    return [ports['http|https'], ports.http, ports.https];
}

function entryHost(entry) {
    if (typeof entry === 'string') return normalizeHost(entry);
    if (!entry || typeof entry !== 'object') return '';
    return normalizeHost(
        entry.ip ?? entry.host ?? entry.server ?? entry.address ?? entry.proxy,
    );
}

function entryPorts(entry, order, protocol) {
    if (entry && typeof entry === 'object') {
        const direct = [entry.port, entry.ports?.[protocol]];
        if (direct.some((value) => Number.isInteger(Number(value))))
            return direct;
    }
    return portValues(order.proxy_data?.ports, protocol);
}

function orderMatches(order, node) {
    const expectedHost = normalizeHost(node.server);
    const expectedPort = Number(node.port);
    const proxies = Array.isArray(order.proxy_data?.proxies)
        ? order.proxy_data.proxies
        : [];
    return proxies.some((entry) => {
        const host = entryHost(entry);
        return (
            host === expectedHost &&
            entryPorts(entry, order, node.protocol).some(
                (port) => Number(port) === expectedPort,
            )
        );
    });
}

function orderMetadata(order, syncedAt) {
    const expiresAt = normalizeDate(order.expire_date ?? order.expires_at);
    const status = String(order.status ?? 'unknown').toLowerCase();
    const expired =
        status === 'expired' ||
        (expiresAt && Date.parse(expiresAt) <= Date.now());
    return {
        orderId: order.id,
        status,
        expiresAt,
        syncedAt,
        syncStatus: expired ? 'expired' : 'matched',
    };
}

function chooseOrder(orders) {
    return [...orders].sort((a, b) => {
        const aExpiry = a.expiresAt ? Date.parse(a.expiresAt) : -Infinity;
        const bExpiry = b.expiresAt ? Date.parse(b.expiresAt) : -Infinity;
        return (
            bExpiry - aExpiry ||
            (STATUS_RANK.get(b.status) ?? 0) - (STATUS_RANK.get(a.status) ?? 0) ||
            Number(b.orderId) - Number(a.orderId)
        );
    })[0];
}

export function createIprRoyalClient({
    baseUrl,
    token = '',
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const apiBase = normalizeBaseUrl(baseUrl);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
        throw new Error('IPROYAL_API_TIMEOUT_MS 必须为 100–60000');
    const configured = typeof token === 'string' && token.trim().length > 0;
    if (typeof fetchImpl !== 'function') throw new Error('缺少 fetch 实现');

    async function request(path, params = {}) {
        if (!configured) throw apiError('IPRoyal API 未配置 Token', 'IPROYAL_NOT_CONFIGURED', 503);
        const url = new URL(path.replace(/^\/+/, ''), apiBase);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            response = await fetchImpl(url, {
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'X-Access-Token': token,
                },
                signal: controller.signal,
            });
        } catch (error) {
            throw apiError(
                `IPRoyal API 请求失败：${safeMessage(error, token)}`,
                'IPROYAL_API_ERROR',
                502,
            );
        } finally {
            clearTimeout(timer);
        }
        const text = await response.text();
        if (text.length > MAX_RESPONSE_BYTES)
            throw apiError('IPRoyal API 响应过大');
        if (!response.ok)
            throw apiError(`IPRoyal API 返回 HTTP ${response.status}`, 'IPROYAL_API_ERROR', response.status === 401 ? 502 : 502);
        let body;
        try {
            body = JSON.parse(text);
        } catch {
            throw apiError('IPRoyal API 返回内容不是有效 JSON');
        }
        if (!body || !Array.isArray(body.data))
            throw apiError('IPRoyal API 返回格式无效');
        return body;
    }

    async function listOrders() {
        const products = await request('products');
        const productIds = [...new Set(products.data
            .filter((product) => /\bISP\b|static residential/i.test(product.name || ''))
            .map((product) => product.id))];
        if (!productIds.length || productIds.some((id) => !Number.isSafeInteger(id) || id < 1))
            throw apiError('IPRoyal 未返回可用的 ISP 产品', 'IPROYAL_ISP_PRODUCT_UNAVAILABLE');
        const orders = [];
        for (const productId of productIds) {
            let page = 1;
            let lastPage = 1;
            do {
                const body = await request('orders', {
                    product_id: productId,
                    page,
                    per_page: PAGE_SIZE,
                });
                orders.push(...body.data);
                lastPage = Math.max(
                    page,
                    Number(body.meta?.last_page) ||
                        (body.data.length === PAGE_SIZE ? page + 1 : page),
                );
                page++;
                if (page > 1000) throw apiError('IPRoyal API 分页数量异常');
            } while (page <= lastPage);
        }
        return orders;
    }

    async function syncNodes(nodes) {
        const syncedAt = new Date().toISOString();
        const orders = await listOrders();
        const updates = {};
        let unmatched = 0;
        for (const node of nodes) {
            const matches = orders
                .filter((order) => orderMatches(order, node))
                .map((order) => orderMetadata(order, syncedAt));
            const selected = chooseOrder(matches);
            if (selected) updates[node.id] = selected;
            else {
                updates[node.id] = {
                    expiresAt: null,
                    syncedAt,
                    syncStatus: 'unmatched',
                };
                unmatched++;
            }
        }
        return {
            updates,
            unmatched,
            fetchedOrders: orders.length,
            syncedAt,
        };
    }

    return { configured, listOrders, syncNodes };
}
