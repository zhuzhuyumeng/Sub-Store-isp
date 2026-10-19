import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { IspError } from './parser.mjs';
import { exportClash } from './clash.mjs';

const digest = (text) => createHash('sha256').update(text).digest();
export function normalizePublicBase(value = '') {
    if (!value) return '';
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('ISP_PUBLIC_BASE_URL 必须是 HTTP(S) URL');
    }
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    )
        throw new Error('ISP_PUBLIC_BASE_URL 不允许凭据、查询或片段');
    return url.href.replace(/\/+$/, '');
}
export function createApp({
    store,
    adminToken = null,
    publicBaseUrl = '',
    prober,
    iproyalSync,
}) {
    const authEnabled = adminToken !== null && adminToken !== undefined;
    if (
        authEnabled &&
        (typeof adminToken !== 'string' ||
            adminToken.length < 24 ||
            /\s/.test(adminToken))
    )
        throw new Error('管理口令至少需要 24 位且不包含空白');
    const base = normalizePublicBase(publicBaseUrl),
        expected = authEnabled ? digest(adminToken) : null;
    const app = express();
    app.disable('x-powered-by');
    app.set('query parser', 'simple');
    app.use((req, res, next) => {
        res.set({
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy':
                "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        });
        next();
    });
    app.use('/api/isp', (req, res, next) => {
        if (!authEnabled) return next();
        const auth = req.get('authorization');
        if (
            !auth?.startsWith('Bearer ') ||
            !timingSafeEqual(digest(auth.slice(7)), expected)
        )
            return res
                .status(401)
                .json({ error: { message: '管理口令无效，请重新连接' } });
        next();
    });
    app.use('/api/isp', express.json({ limit: '8mb', strict: true }));
    const ok = (res, data, status = 200) => res.status(status).json({ data });
    const shareView = (s) => ({
        ...s,
        clashUrl: `${base}/s/${s.token}/clash.yaml`,
        providerUrl: `${base}/s/${s.token}/provider.yaml`,
    });
    app.get('/api/isp/nodes', (req, res) => {
        const allowed = ['q', 'group', 'enabled', 'page', 'pageSize'];
        if (Object.keys(req.query).some((k) => !allowed.includes(k)))
            throw new IspError('不支持的筛选参数');
        const data = store.list(req.query);
        if (prober) {
            data.items = data.items.map((node) => prober.decorate(node));
            data.probes = prober.summary();
        }
        ok(res, data);
    });
    app.post('/api/isp/import/preview', (req, res) =>
        ok(res, store.import(req.body, { preview: true })),
    );
    app.post('/api/isp/import', (req, res) => {
        let probesQueued = 0;
        const result = store.import(req.body, {
            onImported: (ids) => {
                if (prober && ids.length)
                    probesQueued = prober.enqueue(ids).queued;
            },
        });
        ok(res, { ...result, probesQueued });
    });
    app.post('/api/isp/nodes/check', (req, res) => {
        if (!prober) throw new IspError('检测服务未启用', 503);
        ok(res, prober.enqueue(req.body?.ids), 202);
    });
    app.post('/api/isp/nodes/check-all', (req, res) => {
        if (!prober) throw new IspError('检测服务未启用', 503);
        ok(res, prober.enqueueAll(), 202);
    });
    app.get('/api/isp/iproyal/status', (req, res) =>
        ok(res, iproyalSync?.status?.() ?? { status: 'not_configured' }),
    );
    app.put('/api/isp/iproyal/config', (req, res) => {
        if (!iproyalSync?.configure) throw new IspError('此服务未启用页面配置', 503);
        ok(res, iproyalSync.configure(req.body?.token));
    });
    app.post('/api/isp/iproyal/sync', async (req, res) => {
        const result = iproyalSync
            ? await iproyalSync.run()
            : { status: 'not_configured' };
        ok(res, result, result.status === 'error' ? 502 : 200);
    });
    app.patch('/api/isp/nodes/:id', (req, res) =>
        ok(res, store.update(req.params.id, req.body)),
    );
    app.post('/api/isp/nodes/batch', (req, res) => {
        if (!req.body || Array.isArray(req.body))
            throw new IspError('请提供批量操作内容');
        ok(res, store.batch(req.body));
    });
    app.get('/api/isp/groups', (req, res) => ok(res, store.listGroups()));
    app.post('/api/isp/groups', (req, res) =>
        ok(res, store.createGroup(req.body?.name), 201),
    );
    app.patch('/api/isp/groups', (req, res) =>
        ok(res, store.renameGroup(req.body?.name, req.body?.newName)),
    );
    app.delete('/api/isp/groups', (req, res) =>
        ok(res, store.deleteGroup(req.body?.name)),
    );
    app.get('/api/isp/shares', (req, res) =>
        ok(res, store.listShares().map(shareView)),
    );
    app.post('/api/isp/shares', (req, res) =>
        ok(res, shareView(store.createShare(req.body)), 201),
    );
    app.delete('/api/isp/shares/:id', (req, res) => {
        const mode = req.query.mode ?? 'revoke';
        if (!['revoke', 'permanent'].includes(mode))
            throw new IspError('不支持的分享删除方式');
        ok(
            res,
            mode === 'permanent'
                ? store.deleteShare(req.params.id)
                : store.revokeShare(req.params.id),
        );
    });
    app.patch('/api/isp/shares/:id', (req, res) =>
        ok(res, shareView(store.renameShare(req.params.id, req.body))),
    );
    app.get('/s/:token/:file', (req, res) => {
        if (!['clash.yaml', 'provider.yaml'].includes(req.params.file))
            throw new IspError('订阅不存在', 404);
        const { share, nodes } = store.resolveShare(req.params.token);
        const content = exportClash(nodes, req.params.file === 'provider.yaml');
        const expiries = [share.expiresAt, ...nodes.map((node) => node.iproyal?.expiresAt)]
            .map((value) => Date.parse(value))
            .filter(Number.isFinite);
        if (expiries.length) {
            const earliest = expiries.reduce((a, b) => Math.min(a, b));
            res.set('subscription-userinfo', `expire=${Math.floor(earliest / 1000)}`);
        }
        res.set({
            'Content-Type': 'text/yaml; charset=utf-8',
            'Content-Disposition': `inline; filename=${req.params.file}; filename*=UTF-8''${encodeURIComponent(share.name.toWellFormed().replace(/[\\/]/g, '_')).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase())}.yaml`,
            'profile-title': `base64:${Buffer.from(share.name, 'utf8').toString('base64')}`,
            'profile-update-interval': '6',
        }).send(content);
    });
    const publicPath = fileURLToPath(new URL('./public/', import.meta.url));
    app.use(
        express.static(publicPath, {
            dotfiles: 'deny',
            etag: false,
            lastModified: false,
        }),
    );
    app.get('/subs', (req, res) =>
        res.sendFile('index.html', { root: publicPath }),
    );
    app.use((req, res) =>
        res.status(404).json({ error: { message: '页面或接口不存在' } }),
    );
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const status =
            error instanceof IspError
                ? error.status
                : error.type === 'entity.too.large'
                ? 413
                : error.type === 'entity.parse.failed'
                ? 400
                : 500;
        const message =
            error instanceof IspError
                ? error.message
                : status === 413
                ? '请求过大，请分批导入（每批小于 8 MiB）'
                : status === 400
                ? '请求内容必须是有效的 JSON'
                : '保存或读取失败，请检查服务器数据目录';
        res.status(status).json({ error: { message } });
    });
    return app;
}
