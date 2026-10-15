import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { ProxyAgent, request } from 'undici';
import { socksDispatcher } from 'fetch-socks';
import { IspError } from './parser.mjs';
import { validIds } from './store.mjs';

export const DEFAULT_PROBE_URL = 'https://api.ipify.org?format=json';
const failed = (status, auth = 'unknown') => ({
    status,
    auth,
    latencyMs: null,
    exitIp: null,
    checkedAt: new Date().toISOString(),
});
function failureStatus(error, signal) {
    if (
        signal.aborted ||
        /TIMEOUT/.test(error.code || '') ||
        error.message === 'Proxy connection timed out'
    )
        return 'timeout';
    // Compare dependency messages only; never return raw errors containing proxy details.
    if (
        error.message === 'Proxy response (407) !== 200 when HTTP Tunneling' ||
        error.message === 'Socks5 Authentication failed'
    )
        return 'auth_failed';
    return 'unreachable';
}
export function createProbe({
    target = DEFAULT_PROBE_URL,
    timeoutMs = 10000,
} = {}) {
    const url = new URL(target);
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
    )
        throw new Error('ISP_PROBE_URL 必须为不含凭据和片段的 HTTP(S) 地址');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 60000)
        throw new Error('ISP_PROBE_TIMEOUT_MS 必须为 50–60000');
    return async (node, { signal: stopSignal } = {}) => {
        const signal = AbortSignal.any([
            AbortSignal.timeout(timeoutMs),
            ...(stopSignal ? [stopSignal] : []),
        ]);
        let dispatcher,
            responseReceived = false;
        const started = performance.now();
        try {
            const host = node.server.includes(':')
                ? `[${node.server}]`
                : node.server;
            dispatcher =
                node.protocol === 'socks5'
                    ? socksDispatcher(
                          {
                              type: 5,
                              host: node.server,
                              port: node.port,
                              userId: node.username,
                              password: node.password,
                          },
                          { connect: { timeout: timeoutMs }, connections: 1 },
                      )
                    : new ProxyAgent({
                          uri: `${node.protocol}://${host}:${node.port}`,
                          token: `Basic ${Buffer.from(
                              `${node.username}:${node.password}`,
                          ).toString('base64')}`,
                          proxyTunnel: true,
                          connectTimeout: timeoutMs,
                          connections: 1,
                      });
            const { statusCode, body } = await request(url, {
                dispatcher,
                signal,
                method: 'GET',
                maxRedirections: 0,
                headersTimeout: timeoutMs,
                bodyTimeout: timeoutMs,
                headers: { accept: 'application/json, text/plain' },
            });
            responseReceived = true;
            body.on('error', () => {});
            if (statusCode !== 200) {
                body.destroy();
                return failed('check_failed', 'accepted');
            }
            const chunks = [];
            let length = 0;
            for await (const chunk of body) {
                length += chunk.length;
                if (length > 8192) {
                    body.destroy();
                    return failed('check_failed', 'accepted');
                }
                chunks.push(chunk);
            }
            const text = Buffer.concat(chunks).toString('utf8').trim();
            let ip = text;
            if (text.startsWith('{')) {
                try {
                    ip = JSON.parse(text).ip;
                } catch {
                    ip = null;
                }
            }
            if (typeof ip !== 'string' || !isIP(ip))
                return failed('check_failed', 'accepted');
            return {
                status: 'online',
                auth: 'accepted',
                latencyMs: Math.round(performance.now() - started),
                exitIp: ip,
                checkedAt: new Date().toISOString(),
            };
        } catch (error) {
            const status = failureStatus(error, signal);
            return failed(
                status,
                status === 'auth_failed'
                    ? 'rejected'
                    : responseReceived
                    ? 'accepted'
                    : 'unknown',
            );
        } finally {
            if (dispatcher) await dispatcher.destroy().catch(() => {});
        }
    };
}

export class ProbeQueue {
    constructor({
        store,
        probe = createProbe(),
        concurrency = 5,
        flushMs = 1000,
    }) {
        if (
            !Number.isInteger(concurrency) ||
            concurrency < 1 ||
            concurrency > 20
        )
            throw new Error('ISP_PROBE_CONCURRENCY 必须为 1–20');
        this.store = store;
        this.probe = probe;
        this.concurrency = concurrency;
        this.pending = new Map();
        this.running = new Set();
        this.latest = new Map();
        this.results = new Map();
        this.controller = new AbortController();
        this.closed = false;
        this.storageError = false;
        this.timer = setInterval(() => this.flush(), flushMs);
        this.timer.unref();
    }
    enqueue(ids) {
        if (this.closed) throw new IspError('检测服务正在停止', 503);
        const selected = validIds(ids, this.store.state.nodes);
        let queued = 0;
        for (const id of selected) {
            const node = this.store.get(id),
                old = this.latest.get(id);
            if (old && old.revision === node.probeRevision) continue;
            const job = { id, revision: node.probeRevision, status: 'queued' };
            this.pending.set(id, job);
            this.latest.set(id, job);
            queued++;
        }
        queueMicrotask(() => this.pump());
        return { ...this.summary(), queued };
    }
    summary() {
        return {
            queued: this.pending.size,
            checking: this.running.size,
            storageError: this.storageError,
        };
    }
    decorate(node) {
        const current = this.store.get(node.id);
        const buffered = this.results.get(node.id);
        return {
            ...node,
            ...(buffered && buffered.revision === current.probeRevision
                ? { health: buffered.result }
                : {}),
            probeState: this.view(node),
        };
    }
    view(node) {
        const job = this.latest.get(node.id);
        if (!job) return null;
        const current = this.store.get(node.id);
        return current.probeRevision === job.revision ? job.status : null;
    }
    pump() {
        if (this.closed) return;
        while (this.running.size < this.concurrency && this.pending.size) {
            const [id, job] = this.pending.entries().next().value;
            this.pending.delete(id);
            let node;
            try {
                node = this.store.get(id);
            } catch {
                this.latest.delete(id);
                continue;
            }
            if (node.probeRevision !== job.revision) {
                if (this.latest.get(id) === job) this.latest.delete(id);
                continue;
            }
            job.status = 'checking';
            const task = this.execute(job, node);
            this.running.add(task);
            task.finally(() => {
                this.running.delete(task);
                this.pump();
                if (!this.running.size && !this.pending.size) this.flush();
            });
        }
    }
    async execute(job, node) {
        let result;
        try {
            result = await this.probe(node, { signal: this.controller.signal });
        } catch {
            result = failed('unreachable');
        }
        if (!this.closed) {
            try {
                if (this.store.get(job.id).probeRevision === job.revision)
                    this.results.set(job.id, {
                        id: job.id,
                        revision: job.revision,
                        result,
                    });
            } catch {
                /* Deleted while the request was in flight. */
            }
        }
        if (this.latest.get(job.id) === job) this.latest.delete(job.id);
    }
    flush() {
        if (!this.results.size) return;
        try {
            this.store.saveProbeResults([...this.results.values()]);
            this.results.clear();
            this.storageError = false;
        } catch {
            this.storageError = true;
        }
    }
    async close() {
        this.closed = true;
        clearInterval(this.timer);
        this.pending.clear();
        this.controller.abort();
        await Promise.all([...this.running]);
        this.flush();
        this.latest.clear();
    }
}
