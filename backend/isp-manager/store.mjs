import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    openSync,
    writeFileSync,
    fsyncSync,
    closeSync,
    renameSync,
    unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { IspError, parseImport, textField, validateNode } from './parser.mjs';

const identity = (n) =>
    JSON.stringify([n.protocol, n.server, n.port, n.username]);
const visible = ({ password, ...rest }) => ({ ...rest, hasPassword: true });
const now = () => new Date().toISOString();
function validIds(ids, nodes) {
    if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 50000 ||
        ids.some((id) => typeof id !== 'string')
    )
        throw new IspError('请选择 1–50,000 个节点');
    const selected = new Set(ids),
        all = new Set(nodes.map((n) => n.id));
    if ([...selected].some((id) => !all.has(id)))
        throw new IspError('部分节点已不存在，请刷新列表', 409);
    return selected;
}
function validShape(state) {
    if (
        !state ||
        state.version !== 1 ||
        !Array.isArray(state.nodes) ||
        !Array.isArray(state.shares)
    )
        return false;
    try {
        const ids = new Set(),
            identities = new Set();
        for (const node of state.nodes) {
            validateNode(node);
            textField(node.name, '名称');
            if (
                typeof node.id !== 'string' ||
                ids.has(node.id) ||
                identities.has(identity(node)) ||
                typeof node.enabled !== 'boolean'
            )
                return false;
            ids.add(node.id);
            identities.add(identity(node));
        }
        const tokens = new Set(),
            shareIds = new Set();
        for (const s of state.shares) {
            if (
                typeof s.id !== 'string' ||
                shareIds.has(s.id) ||
                !/^[a-f0-9]{64}$/.test(s.token) ||
                tokens.has(s.token) ||
                !['all', 'group', 'selected'].includes(s.scope) ||
                typeof s.enabled !== 'boolean'
            )
                return false;
            textField(s.name, '名称');
            if (s.scope === 'group') textField(s.group, '分组', 100);
            if (
                s.scope === 'selected' &&
                (!Array.isArray(s.ids) ||
                    !s.ids.length ||
                    s.ids.some((id) => typeof id !== 'string'))
            )
                return false;
            if (
                s.expiresAt !== null &&
                !Number.isFinite(Date.parse(s.expiresAt))
            )
                return false;
            tokens.add(s.token);
            shareIds.add(s.id);
        }
        return true;
    } catch {
        return false;
    }
}
export class IspStore {
    constructor({ file }) {
        this.file = file;
        this.state = { version: 1, nodes: [], shares: [] };
        if (existsSync(file)) {
            try {
                this.state = JSON.parse(readFileSync(file, 'utf8'));
            } catch {
                throw new Error('ISP 数据文件无法读取，请检查文件或恢复备份');
            }
            if (!validShape(this.state))
                throw new Error('ISP 数据格式无效，请检查文件或恢复备份');
        }
    }
    transaction(mutator) {
        const next = structuredClone(this.state);
        const result = mutator(next);
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        let fd;
        try {
            fd = openSync(temporary, 'wx', 0o600);
            writeFileSync(fd, JSON.stringify(next));
            fsyncSync(fd);
            closeSync(fd);
            fd = undefined;
            renameSync(temporary, this.file);
        } finally {
            if (fd !== undefined) closeSync(fd);
            if (existsSync(temporary)) unlinkSync(temporary);
        }
        this.state = next;
        return result;
    }
    import(input, { preview = false } = {}) {
        if (!['skip', 'update'].includes(input?.duplicate ?? 'skip'))
            throw new IspError('重复处理方式无效');
        const parsed = parseImport(input);
        const apply = (state) => {
            const map = new Map(state.nodes.map((n) => [identity(n), n]));
            const summary = {
                total: parsed.total,
                valid: parsed.rows.length,
                created: 0,
                updated: 0,
                skipped: 0,
                errorCount: parsed.errors.length,
                errors: parsed.errors.slice(0, 100),
                sample: [],
            };
            const timestamp = now();
            for (const { line, node } of parsed.rows) {
                const existing = map.get(identity(node));
                let result, action;
                if (existing) {
                    result = existing;
                    if (input.duplicate === 'update') {
                        Object.assign(existing, {
                            password: node.password,
                            group: node.group,
                            updatedAt: timestamp,
                        });
                        summary.updated++;
                        action = '更新';
                    } else {
                        summary.skipped++;
                        action = '跳过';
                    }
                } else {
                    const id = randomUUID();
                    result = {
                        ...node,
                        id,
                        name: `${node.server.slice(0, 180)}:${
                            node.port
                        } · ${id.slice(0, 8)}`,
                        enabled: true,
                        createdAt: timestamp,
                        updatedAt: timestamp,
                    };
                    map.set(identity(node), result);
                    state.nodes.push(result);
                    summary.created++;
                    action = '新增';
                }
                if (summary.sample.length < 50)
                    summary.sample.push({ line, action, ...visible(result) });
            }
            return summary;
        };
        if (preview) return apply(structuredClone(this.state));
        return this.transaction(apply);
    }
    list(query = {}) {
        const integer = (v, fallback, max) => {
            if (v === undefined) return fallback;
            if (
                !/^\d+$/.test(String(v)) ||
                !Number.isSafeInteger(Number(v)) ||
                Number(v) < 1 ||
                Number(v) > max
            )
                throw new IspError('分页参数无效');
            return Number(v);
        };
        const page = integer(query.page, 1, 1000000),
            pageSize = integer(query.pageSize, 50, 200);
        const q = textField(query.q ?? '', '搜索', 200, true).toLowerCase();
        if (query.group !== undefined)
            textField(query.group, '分组', 100, true);
        if (
            query.enabled !== undefined &&
            !['true', 'false', ''].includes(query.enabled)
        )
            throw new IspError('状态筛选无效');
        const nodes = this.state.nodes.filter(
            (n) =>
                (!q ||
                    [n.name, n.server, n.username, n.group].some((v) =>
                        v.toLowerCase().includes(q),
                    )) &&
                (query.group === undefined || n.group === query.group) &&
                (!query.enabled || n.enabled === (query.enabled === 'true')),
        );
        return {
            items: nodes
                .slice((page - 1) * pageSize, page * pageSize)
                .map(visible),
            total: nodes.length,
            page,
            pageSize,
            groups: [...new Set(this.state.nodes.map((n) => n.group))].sort(),
            stats: {
                total: this.state.nodes.length,
                enabled: this.state.nodes.filter((n) => n.enabled).length,
                shares: this.state.shares.filter(
                    (s) =>
                        s.enabled &&
                        (!s.expiresAt || Date.parse(s.expiresAt) > Date.now()),
                ).length,
            },
        };
    }
    get(id) {
        const node = this.state.nodes.find((n) => n.id === id);
        if (!node) throw new IspError('节点不存在', 404);
        return structuredClone(node);
    }
    update(id, patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch))
            throw new IspError('更新内容无效');
        const allowed = [
            'name',
            'protocol',
            'server',
            'port',
            'username',
            'password',
            'group',
            'enabled',
        ];
        if (Object.keys(patch).some((k) => !allowed.includes(k)))
            throw new IspError('包含不支持的节点字段');
        const existing = this.get(id),
            merged = { ...existing, ...patch };
        const clean = validateNode(merged);
        textField(merged.name, '名称');
        if (typeof merged.enabled !== 'boolean')
            throw new IspError('启用状态无效');
        if (
            this.state.nodes.some(
                (n) => n.id !== id && identity(n) === identity(clean),
            )
        )
            throw new IspError('该账号已存在', 409);
        return this.transaction((state) => {
            const node = state.nodes.find((n) => n.id === id);
            Object.assign(node, clean, {
                name: merged.name,
                enabled: merged.enabled,
                updatedAt: now(),
            });
            return visible(node);
        });
    }
    batch({ ids, action, group }) {
        const selected = validIds(ids, this.state.nodes);
        if (!['enable', 'disable', 'delete', 'group'].includes(action))
            throw new IspError('批量操作无效');
        if (action === 'group')
            group = textField(group, '分组', 100, true).trim();
        return this.transaction((state) => {
            if (action === 'delete')
                state.nodes = state.nodes.filter((n) => !selected.has(n.id));
            else
                for (const node of state.nodes)
                    if (selected.has(node.id)) {
                        if (action === 'group') node.group = group;
                        else node.enabled = action === 'enable';
                        node.updatedAt = now();
                    }
            return { affected: selected.size };
        });
    }
    createShare(input) {
        if (!input || typeof input !== 'object')
            throw new IspError('分享内容无效');
        const name = textField(input.name, '分享名称').trim();
        if (!['all', 'group', 'selected'].includes(input.scope))
            throw new IspError('请选择分享范围');
        const group =
            input.scope === 'group'
                ? textField(input.group, '分组', 100).trim()
                : '';
        if (
            input.scope === 'group' &&
            !this.state.nodes.some((n) => n.group === group)
        )
            throw new IspError('分组不存在');
        const ids =
            input.scope === 'selected'
                ? [...validIds(input.ids, this.state.nodes)]
                : [];
        let expiresAt = null;
        if (input.expiresAt) {
            if (
                typeof input.expiresAt !== 'string' ||
                !Number.isFinite(Date.parse(input.expiresAt)) ||
                Date.parse(input.expiresAt) <= Date.now()
            )
                throw new IspError('到期时间必须晚于现在');
            expiresAt = new Date(input.expiresAt).toISOString();
        }
        const share = {
            id: randomUUID(),
            name,
            scope: input.scope,
            group,
            ids,
            expiresAt,
            enabled: true,
            token: randomBytes(32).toString('hex'),
            createdAt: now(),
        };
        return this.transaction((state) => {
            state.shares.push(share);
            return structuredClone(share);
        });
    }
    listShares() {
        return structuredClone(this.state.shares).reverse();
    }
    revokeShare(id) {
        if (!this.state.shares.some((s) => s.id === id))
            throw new IspError('分享不存在', 404);
        return this.transaction((state) => {
            state.shares.find((s) => s.id === id).enabled = false;
            return { revoked: true };
        });
    }
    deleteShare(id) {
        if (!this.state.shares.some((s) => s.id === id))
            throw new IspError('分享不存在', 404);
        return this.transaction((state) => {
            state.shares = state.shares.filter((s) => s.id !== id);
            return { deleted: true };
        });
    }
    resolveShare(token) {
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
            throw new IspError('订阅不存在或已失效', 404);
        const share = this.state.shares.find((s) =>
            timingSafeEqual(Buffer.from(s.token), Buffer.from(token)),
        );
        if (
            !share ||
            !share.enabled ||
            (share.expiresAt && Date.parse(share.expiresAt) <= Date.now())
        )
            throw new IspError('订阅不存在或已失效', 404);
        const ids = new Set(share.ids);
        const nodes = this.state.nodes.filter(
            (n) =>
                n.enabled &&
                (share.scope === 'all' ||
                    (share.scope === 'group' && n.group === share.group) ||
                    (share.scope === 'selected' && ids.has(n.id))),
        );
        return structuredClone({ share, nodes });
    }
}
