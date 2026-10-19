import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'undici';

export const DEFAULT_GEO_URL = 'https://ipwho.is/';
const names = new Intl.DisplayNames(['zh-CN'], {
    type: 'region',
    fallback: 'none',
});
export function countryName(code) {
    if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code) || code === 'ZZ')
        return null;
    return names.of(code) || null;
}
const normalizedIp = (ip) =>
    isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip;
const clean = (value) =>
    typeof value === 'string' &&
    value.length <= 200 &&
    !/[\x00-\x1f\x7f]/.test(value)
        ? value.trim()
        : '';
const failed = (status) => ({
    status,
    source: 'ipwho.is',
    checkedAt: new Date().toISOString(),
});

export function createGeoLookup({
    baseUrl = DEFAULT_GEO_URL,
    timeoutMs = 5000,
    minIntervalMs = 700,
} = {}) {
    const base = new URL(baseUrl);
    if (
        !['http:', 'https:'].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
    )
        throw new Error(
            'ISP_GEO_URL 必须为不含凭据、查询或片段的 HTTP(S) 根地址',
        );
    if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 50 ||
        timeoutMs > 60000 ||
        !Number.isInteger(minIntervalMs) ||
        minIntervalMs < 0 ||
        minIntervalMs > 60000
    )
        throw new Error('归属地查询时限或间隔无效');
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    const cache = new Map(),
        inflight = new Map();
    let nextStart = 0,
        cooldownUntil = 0;
    let startGate = Promise.resolve();
    async function fetchLocation(ip, stopSignal) {
        try {
            // Serialize request starts, while allowing in-flight requests to overlap.
            const turn = startGate.then(async () => {
                const wait = Math.max(0, nextStart - Date.now());
                if (wait) await delay(wait, undefined, { signal: stopSignal });
                stopSignal?.throwIfAborted();
                nextStart = Date.now() + minIntervalMs;
            });
            startGate = turn.catch(() => {});
            await turn;
            if (Date.now() < cooldownUntil) return failed('rate_limited');
            const signal = AbortSignal.any([
                AbortSignal.timeout(timeoutMs),
                ...(stopSignal ? [stopSignal] : []),
            ]);
            try {
                const { statusCode, headers, body } = await request(
                    new URL(encodeURIComponent(ip), base),
                    {
                        method: 'GET',
                        signal,
                        maxRedirections: 0,
                        headersTimeout: timeoutMs,
                        bodyTimeout: timeoutMs,
                        headers: { accept: 'application/json' },
                    },
                );
                body.on('error', () => {});
                if (statusCode !== 200) {
                    body.destroy();
                    if (statusCode === 429) {
                        const seconds = Number(headers['retry-after']);
                        cooldownUntil =
                            Date.now() +
                            Math.min(
                                3600000,
                                Math.max(
                                    60000,
                                    Number.isFinite(seconds)
                                        ? seconds * 1000
                                        : 0,
                                ),
                            );
                        return failed('rate_limited');
                    }
                    return failed('unavailable');
                }
                const chunks = [];
                let size = 0;
                for await (const chunk of body) {
                    size += chunk.length;
                    if (size > 8192) {
                        body.destroy();
                        return failed('unavailable');
                    }
                    chunks.push(chunk);
                }
                const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                const country = countryName(data.country_code);
                if (
                    data.success !== true ||
                    !isIP(data.ip || '') ||
                    normalizedIp(data.ip) !== normalizedIp(ip) ||
                    !country
                )
                    return failed('unavailable');
                return {
                    status: 'located',
                    countryCode: data.country_code,
                    country,
                    region: clean(data.region),
                    city: clean(data.city),
                    isp: clean(data.connection?.isp),
                    asn:
                        Number.isSafeInteger(data.connection?.asn) &&
                        data.connection.asn > 0
                            ? data.connection.asn
                            : null,
                    source: base.hostname,
                    checkedAt: new Date().toISOString(),
                };
            } catch {
                return failed(
                    signal.aborted && !stopSignal?.aborted
                        ? 'timeout'
                        : 'unavailable',
                );
            }
        } catch {
            return failed('unavailable');
        }
    }
    return async (ip, { signal } = {}) => {
        if (typeof ip !== 'string' || !isIP(ip) || signal?.aborted)
            return failed('unavailable');
        const key = normalizedIp(ip);
        const cached = cache.get(key);
        if (cached && cached.expiresAt > Date.now())
            return structuredClone(cached.result);
        cache.delete(key);
        if (Date.now() < cooldownUntil) return failed('rate_limited');
        if (!inflight.has(key)) {
            const task = fetchLocation(ip, signal)
                .then((result) => {
                    cache.set(key, {
                        result,
                        expiresAt:
                            Date.now() +
                            (result.status === 'located' ? 3600000 : 60000),
                    });
                    if (cache.size > 5000)
                        cache.delete(cache.keys().next().value);
                    return result;
                })
                .finally(() => inflight.delete(key));
            inflight.set(key, task);
        }
        return structuredClone(await inflight.get(key));
    };
}
