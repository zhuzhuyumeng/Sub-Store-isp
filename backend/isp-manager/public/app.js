'use strict';
const $ = (id) => document.getElementById(id);
const state = {
    token: sessionStorage.getItem('isp-admin') || '',
    connected: false,
    tab: 'nodes',
    page: 1,
    pageSize: 50,
    nodes: [],
    groups: [],
    selected: new Set(),
    total: 0,
    stats: {},
    shares: [],
    editId: '',
    preview: '',
    batch: null,
    requestVersion: 0,
    session: 0,
    checkAllPending: false,
    probesRemaining: 0,
};
const apiBase = new URL('./api/isp/', location.href);
let toastTimer, searchTimer, probeTimer;
function toast(message, error = false) {
    $('toast').textContent = message;
    $('toast').classList.toggle('error-toast', error);
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        $('toast').hidden = true;
    }, 4500);
}
function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function open(id) {
    if (!$(id).open) $(id).showModal();
}
function close(id) {
    $(id).close();
}
function loggedOut() {
    state.token = '';
    state.connected = false;
    state.session++;
    state.requestVersion++;
    sessionStorage.removeItem('isp-admin');
    state.nodes = [];
    state.shares = [];
    state.groups = [];
    state.selected.clear();
    state.preview = '';
    state.checkAllPending = false;
    state.probesRemaining = 0;
    clearTimeout(searchTimer);
    clearTimeout(probeTimer);
    $('nodes-body').replaceChildren();
    $('shares-list').replaceChildren();
    $('import-preview').replaceChildren();
    $('import-form').reset();
    $('edit-form').reset();
    $('admin-token').value = '';
    $('clash-link').value = '';
    $('provider-link').value = '';
    for (const dialog of document.querySelectorAll('dialog[open]'))
        dialog.close();
    $('workspace').hidden = true;
    $('logout').hidden = true;
    $('connection').textContent = '未连接';
    $('connection').classList.remove('online');
    open('login-dialog');
}
class CancelledRequest extends Error {}
async function api(path, body, method = 'GET') {
    const session = state.session;
    const token = state.token;
    const headers = {
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    };
    const response = await fetch(new URL(path, apiBase), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (session !== state.session || token !== state.token)
        throw new CancelledRequest();
    if (response.status === 401) {
        loggedOut();
        throw new Error('管理口令无效，请重新连接');
    }
    const payload = await response.json();
    if (session !== state.session || token !== state.token)
        throw new CancelledRequest();
    if (!response.ok)
        throw new Error(payload.error?.message || payload.data?.error || '请求失败，请稍后重试');
    return payload.data;
}
async function run(task, errorId, button) {
    if (button) button.disabled = true;
    if (errorId) $(errorId).textContent = '';
    try {
        await task();
    } catch (error) {
        if (error instanceof CancelledRequest) return;
        if (errorId) $(errorId).textContent = error.message;
        else toast(error.message, true);
    } finally {
        if (button) button.disabled = false;
    }
}
function option(value, text) {
    const opt = element('option', '', text);
    opt.value = value;
    return opt;
}
function updateGroups() {
    const selected = $('group-filter').value;
    const shareGroup = $('share-group').value;
    $('group-filter').replaceChildren(
        option('*', '全部分组'),
        ...state.groups.map((g) => option(g ? `g:${g}` : 'g:', g || '未分组')),
    );
    if (selected === 'g:' && !state.groups.includes(''))
        $('group-filter').append(option('g:', '未分组'));
    if ([...$('group-filter').options].some((o) => o.value === selected))
        $('group-filter').value = selected;
    $('share-group').replaceChildren(
        ...state.groups.filter(Boolean).map((g) => option(g, g)),
    );
    if (state.groups.includes(shareGroup)) $('share-group').value = shareGroup;
    $('group-options').replaceChildren(
        ...state.groups.filter(Boolean).map((g) => option(g, g)),
    );
}
async function loadNodes() {
    const version = ++state.requestVersion,
        session = state.session;
    const query = new URLSearchParams({
        page: state.page,
        pageSize: state.pageSize,
        q: $('search').value,
    });
    if ($('group-filter').value !== '*')
        query.set('group', $('group-filter').value.slice(2));
    if ($('status-filter').value)
        query.set('enabled', $('status-filter').value);
    const data = await api(`nodes?${query}`);
    if (version !== state.requestVersion || session !== state.session) return;
    const maxPage = Math.max(1, Math.ceil(data.total / state.pageSize));
    if (state.page > maxPage) {
        state.page = maxPage;
        return loadNodes();
    }
    Object.assign(state, {
        nodes: data.items,
        groups: data.groups,
        total: data.total,
        stats: data.stats,
    });
    state.selected.clear();
    updateGroups();
    renderNodes();
    showProbeProgress(data.probes);
}
function formatIproyalExpiry(metadata) {
    if (!metadata) return 'IPRoyal 未同步';
    if (metadata.syncStatus === 'unmatched') return 'IPRoyal 未匹配';
    if (metadata.syncStatus === 'error') return 'IPRoyal 同步失败';
    if (metadata.syncStatus === 'not_configured') return 'IPRoyal 未配置';
    if (!metadata.expiresAt) return `IPRoyal · ${metadata.status || '已匹配'}`;
    const date = new Date(metadata.expiresAt);
    const remaining = date.getTime() - Date.now();
    if (metadata.syncStatus === 'expired' || remaining <= 0)
        return `IPRoyal 已过期 · ${date.toLocaleDateString('zh-CN')}`;
    const days = Math.ceil(remaining / 86400000);
    return `IPRoyal · ${days} 天后到期`;
}
function renderIprRoyal(cell, node) {
    const status = node.iproyal?.syncStatus || 'unknown';
    const detail = element(
        'span',
        `probe-detail iproyal-detail iproyal-${status}`,
        formatIproyalExpiry(node.iproyal),
    );
    if (node.iproyal?.expiresAt)
        detail.title = `订单 ${node.iproyal.orderId || '未知'} · 到期：${new Date(
            node.iproyal.expiresAt,
        ).toLocaleString('zh-CN')}`;
    cell.append(detail);
}
async function loadIprRoyalStatus() {
    const status = await api('iproyal/status');
    const labels = {
        ok: status.syncedAt
            ? `IPRoyal 已同步 · ${new Date(status.syncedAt).toLocaleString('zh-CN')}`
            : 'IPRoyal 已同步',
        error: `IPRoyal 同步失败${status.error ? ` · ${status.error}` : ''}`,
        not_configured: 'IPRoyal 未配置',
        never: 'IPRoyal 尚未同步',
    };
    $('iproyal-status').textContent = labels[status.status] || 'IPRoyal 状态未知';
}
function iproyalConfigDialog() {
    $('iproyal-config-form').reset();
    $('iproyal-config-error').textContent = '';
    open('iproyal-config-dialog');
}
async function syncIprRoyal() {
    const result = await api('iproyal/sync', undefined, 'POST');
    await loadIprRoyalStatus();
    await loadNodes();
    if (result.status === 'not_configured') iproyalConfigDialog();
    else if (result.status === 'error') toast(result.error || 'IPRoyal 同步失败', true);
    else toast(`IPRoyal 已同步：匹配 ${result.matched} 个节点`);
}
const healthLabels = {
    online: '可用',
    auth_failed: '认证失败',
    timeout: '连接超时',
    unreachable: '连接失败',
    check_failed: '检测服务异常',
    queued: '等待检测',
    checking: '检测中',
};
function renderHealth(cell, node) {
    cell.replaceChildren();
    const status = node.probeState || node.health?.status;
    cell.append(
        element(
            'span',
            `probe-status ${status || 'unchecked'}`,
            healthLabels[status] || '未检测',
        ),
    );
    if (!node.probeState && node.health) {
        const result = node.health;
        if (result.latencyMs !== null)
            cell.append(
                element('span', 'probe-detail', `${result.latencyMs} ms`),
            );
        if (result.exitIp)
            cell.append(element('span', 'probe-detail exit-ip', result.exitIp));
        const location = result.location;
        if (location?.status === 'located') {
            const detail = element(
                'span',
                'probe-detail',
                [location.country, location.city].filter(Boolean).join(' · '),
            );
            detail.title = `IP 归属地（大致位置）${
                location.isp ? ` · ${location.isp}` : ''
            }${location.asn ? ` · AS${location.asn}` : ''}`;
            cell.append(detail);
        } else if (location) {
            const message =
                {
                    timeout: '定位超时',
                    rate_limited: '定位服务限流',
                    unavailable: '定位暂不可用',
                }[location.status] || '定位暂不可用';
            cell.append(
                element('span', 'probe-detail', `${message} · 保留原分组`),
            );
        }
        const auth = {
            accepted: '代理接受连接凭据',
            rejected: '代理拒绝认证',
            unknown: '认证状态未知',
        }[result.auth];
        cell.title = `${auth || ''} · ${new Date(
            result.checkedAt,
        ).toLocaleString('zh-CN')}`;
    } else
        cell.title = node.probeState
            ? '检测完成后自动更新'
            : '点击检测以获取连通性和出口 IP';
    renderIprRoyal(cell, node);
}
function showProbeProgress(probes) {
    clearTimeout(probeTimer);
    const remaining = (probes?.queued || 0) + (probes?.checking || 0);
    state.probesRemaining = remaining;
    updateCheckAllButton();
    $('probe-progress').textContent = probes?.storageError
        ? '检测结果暂未保存，将自动重试。请检查数据目录权限。'
        : remaining
        ? `正在检测 ${probes.checking} 个 · 排队 ${probes.queued} 个`
        : '检测成功后按国家覆盖分组 · 定位失败保留原分组';
    if (
        state.connected &&
        state.tab === 'nodes' &&
        (remaining || probes?.storageError)
    ) {
        probeTimer = setTimeout(() => run(pollProbes), 1500);
    }
}
async function pollProbes() {
    if (!state.connected || state.tab !== 'nodes') return;
    const version = state.requestVersion;
    const query = new URLSearchParams({
        page: state.page,
        pageSize: state.pageSize,
        q: $('search').value,
    });
    if ($('group-filter').value !== '*')
        query.set('group', $('group-filter').value.slice(2));
    if ($('status-filter').value)
        query.set('enabled', $('status-filter').value);
    let data;
    try {
        data = await api(`nodes?${query}`);
    } catch (error) {
        if (
            !(error instanceof CancelledRequest) &&
            state.connected &&
            state.tab === 'nodes'
        ) {
            $('probe-progress').textContent = '检测状态刷新失败，正在重试…';
            probeTimer = setTimeout(() => run(pollProbes), 5000);
        }
        return;
    }
    if (version !== state.requestVersion || state.tab !== 'nodes') return;
    const maxPage = Math.max(1, Math.ceil(data.total / state.pageSize));
    if (state.page > maxPage) {
        state.page = maxPage;
        return pollProbes();
    }
    const changedRows =
        state.nodes.length !== data.items.length ||
        state.nodes.some((node, i) => node.id !== data.items[i].id);
    const changedGroups =
        JSON.stringify(state.groups) !== JSON.stringify(data.groups);
    Object.assign(state, {
        groups: data.groups,
        total: data.total,
        stats: data.stats,
    });
    if (changedGroups) updateGroups();
    if (changedRows) {
        // A country change can move nodes out of the current filter/page.
        const visible = new Set(data.items.map((node) => node.id));
        state.selected = new Set(
            [...state.selected].filter((id) => visible.has(id)),
        );
        state.nodes = data.items;
        renderNodes();
        showProbeProgress(data.probes);
        return;
    }
    // Keep existing rows, selection, keyboard focus and open forms intact.
    const updates = new Map(data.items.map((node) => [node.id, node]));
    for (const node of state.nodes) {
        const fresh = updates.get(node.id);
        if (!fresh) continue;
        node.health = fresh.health;
        node.probeState = fresh.probeState;
        node.group = fresh.group;
        const cell = document.querySelector(`[data-health-id="${node.id}"]`);
        if (cell) renderHealth(cell, node);
        const group = document.querySelector(`[data-group-id="${node.id}"]`);
        if (group) group.textContent = node.group || '未分组';
        const button = document.querySelector(`[data-probe-id="${node.id}"]`);
        if (button) button.disabled = Boolean(node.probeState);
    }
    updateNodeSummary();
    showProbeProgress(data.probes);
}
function updateCheckAllButton() {
    const button = $('check-all');
    button.disabled =
        state.checkAllPending ||
        state.probesRemaining > 0 ||
        !state.stats.total;
    button.textContent = state.checkAllPending
        ? '正在提交…'
        : state.probesRemaining > 0
        ? '检测中…'
        : '一键检测全部';
}
async function checkAllNodes() {
    if (
        state.checkAllPending ||
        state.probesRemaining > 0 ||
        !state.stats.total
    )
        return;
    const session = state.session;
    state.checkAllPending = true;
    updateCheckAllButton();
    try {
        const result = await api('nodes/check-all', undefined, 'POST');
        // Keep accepted work busy even if the first status refresh fails.
        state.probesRemaining = Math.max(
            state.probesRemaining,
            result.queued + result.checking,
        );
        await pollProbes();
        if (session !== state.session) return;
        toast(
            result.queued
                ? `已加入检测队列：${result.queued} 个节点（全部已导入节点）`
                : '没有需要新加入检测队列的节点',
        );
    } finally {
        if (session === state.session) {
            state.checkAllPending = false;
            updateCheckAllButton();
        }
    }
}
async function checkNodes(ids) {
    const result = await api('nodes/check', { ids }, 'POST');
    await pollProbes();
    toast(
        result.queued
            ? `已加入检测队列：${result.queued} 个节点`
            : '所选节点已在检测队列中',
    );
}
function updateNodeSummary() {
    $('node-count').textContent = state.stats.total.toLocaleString();
    $(
        'stats',
    ).textContent = `${state.stats.enabled.toLocaleString()} 个已启用 · ${(
        state.stats.total - state.stats.enabled
    ).toLocaleString()} 个已停用 · ${
        state.groups.filter(Boolean).length
    } 个分组`;
    $('empty-nodes').hidden = state.stats.total !== 0;
    $('empty-filter').hidden = state.total !== 0 || state.stats.total === 0;
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    $('page-number').textContent = `${state.page} / ${pages}`;
    $('page-summary').textContent = `共 ${state.total.toLocaleString()} 个节点`;
    $('previous').disabled = state.page <= 1;
    $('next').disabled = state.page >= pages;
    updateSelection();
}
function renderNodes() {
    $('nodes-body').replaceChildren(
        ...state.nodes.map((node) => {
            const row = element('tr');
            const checkCell = element('td', 'check-cell'),
                check = element('input');
            check.type = 'checkbox';
            check.checked = state.selected.has(node.id);
            check.setAttribute('aria-label', `选择 ${node.name}`);
            check.addEventListener('change', () => {
                if (check.checked) state.selected.add(node.id);
                else state.selected.delete(node.id);
                updateSelection();
            });
            checkCell.append(check);
            const nameCell = element('td', 'node-cell');
            const name = element('span', 'node-name', node.name);
            name.title = node.name;
            const host = node.server.includes(':')
                ? `[${node.server}]`
                : node.server;
            nameCell.append(
                name,
                element('span', 'node-address', `${host}:${node.port}`),
            );
            const protocol = element('td');
            protocol.append(
                element('span', 'tag', protocolLabel(node.protocol)),
            );
            const account = element('td', 'account');
            account.append(
                document.createTextNode(node.username),
                element('small', '', '••••••••'),
            );
            account.title = node.username;
            const group = element('td', 'group-pill', node.group || '未分组');
            group.dataset.groupId = node.id;
            const status = element('td');
            status.append(
                element(
                    'span',
                    `status${node.enabled ? '' : ' off'}`,
                    node.enabled ? '已启用' : '已停用',
                ),
            );
            const health = element('td', 'health-cell');
            health.dataset.healthId = node.id;
            renderHealth(health, node);
            const actions = element('td', 'align-right');
            const probe = element('button', 'row-action', '检测');
            probe.dataset.probeId = node.id;
            probe.disabled = Boolean(node.probeState);
            probe.addEventListener('click', () =>
                run(() => checkNodes([node.id]), null, probe),
            );
            const edit = element('button', 'row-action', '编辑');
            edit.addEventListener('click', () => editNode(node));
            const toggle = element(
                'button',
                'row-action',
                node.enabled ? '停用' : '启用',
            );
            toggle.addEventListener('click', () =>
                run(
                    async () => {
                        await api(
                            `nodes/${node.id}`,
                            { enabled: !node.enabled },
                            'PATCH',
                        );
                        await loadNodes();
                        toast(node.enabled ? '节点已停用' : '节点已启用');
                    },
                    null,
                    toggle,
                ),
            );
            actions.append(probe, edit, toggle);
            row.append(
                checkCell,
                nameCell,
                health,
                protocol,
                account,
                group,
                status,
                actions,
            );
            return row;
        }),
    );
    updateNodeSummary();
}
function updateSelection() {
    const count = state.selected.size;
    $('bulk-bar').hidden = !count;
    $('selected-count').textContent = `已选 ${count} 项（本页）`;
    $('select-all').checked = count > 0 && count === state.nodes.length;
    $('select-all').indeterminate = count > 0 && count < state.nodes.length;
}
async function loadShares() {
    const session = state.session;
    const data = await api('shares');
    if (session !== state.session) return;
    state.shares = data;
    $('share-count').textContent = data.length;
    $('empty-shares').hidden = data.length !== 0;
    $('shares-list').replaceChildren(
        ...data.map((share) => {
            const expired =
                    share.expiresAt &&
                    Date.parse(share.expiresAt) <= Date.now(),
                active = share.enabled && !expired;
            const card = element(
                    'article',
                    `share-card${active ? '' : ' revoked'}`,
                ),
                top = element('div', 'share-card-top');
            top.append(
                element('h3', '', share.name),
                element(
                    'span',
                    `status${active ? '' : ' off'}`,
                    !share.enabled ? '已撤销' : expired ? '已到期' : '有效',
                ),
            );
            card.append(top);
            card.append(
                element(
                    'p',
                    'share-scope',
                    share.scope === 'all'
                        ? '全部启用节点 · 自动包含新增'
                        : share.scope === 'group'
                        ? `分组：${share.group} · 随分组更新`
                        : `所选 ${share.ids.length} 个节点`,
                ),
            );
            card.append(
                element(
                    'p',
                    'share-date',
                    share.expiresAt
                        ? `到期：${new Date(share.expiresAt).toLocaleString(
                              'zh-CN',
                          )}`
                        : '长期有效 · 可随时撤销',
                ),
            );
            const actions = element('div', 'share-actions'),
                links = element('button', '', '查看 / 复制链接');
            links.disabled = !active;
            links.addEventListener('click', () => showLinks(share));
            const rename = element('button', 'quiet', '重命名');
            rename.addEventListener('click', () => {
                $('share-rename-form').dataset.shareId = share.id;
                $('share-rename-name').value = share.name;
                $('share-rename-error').textContent = '';
                open('share-rename-dialog');
            });
            actions.append(links, rename);
            if (share.enabled) {
                const revoke = element('button', 'quiet danger-text', '撤销');
                revoke.addEventListener('click', () =>
                    batchDialog('revoke', share),
                );
                actions.append(revoke);
            }
            const remove = element('button', 'quiet danger-text', '删除');
            remove.addEventListener('click', () =>
                batchDialog('delete-share', share),
            );
            actions.append(remove);
            card.append(actions);
            return card;
        }),
    );
}
function setTab(tab) {
    if (!state.connected) return open('login-dialog');
    state.tab = tab;
    clearTimeout(probeTimer);
    for (const t of ['nodes', 'shares', 'help'])
        $(`${t}-panel`).hidden = t !== tab;
    for (const button of document.querySelectorAll('[data-tab]')) {
        const active = button.dataset.tab === tab;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    }
    $('page-title').textContent = {
        nodes: 'ISP 管理',
        shares: '分享订阅',
        help: '使用说明',
    }[tab];
    if (tab === 'shares') run(loadShares);
    else if (tab === 'nodes') run(loadNodes);
}
const examples = [
    'proxy.example:8080:user:password',
    'proxy.example:8080@user:password',
    'user:password:proxy.example:8080',
    'user:password@proxy.example:8080',
];
function protocolFromForm(prefix) {
    return $(`${prefix}-protocol`).value === 'socks5'
        ? 'socks5'
        : $(`${prefix}-tls`).checked
        ? 'https'
        : 'http';
}
function syncProtocolOptions(prefix) {
    $(`${prefix}-tls-options`).hidden =
        $(`${prefix}-protocol`).value !== 'http';
}
function protocolLabel(protocol) {
    return protocol === 'socks5'
        ? 'SOCKS5'
        : protocol === 'https'
        ? 'HTTP / HTTPS · TLS'
        : 'HTTP / HTTPS';
}
function importInput() {
    return {
        format: $('import-format').value,
        protocol: protocolFromForm('import'),
        content: $('import-content').value,
        group: $('import-group').value,
        duplicate: $('import-duplicate').value,
    };
}
function invalidatePreview() {
    syncProtocolOptions('import');
    state.preview = '';
    $('import-preview').hidden = true;
    $('commit-import').disabled = true;
    $('format-example').textContent =
        examples[$('import-format').selectedIndex];
}
function importDialog() {
    if (!state.connected) return open('login-dialog');
    invalidatePreview();
    $('import-error').textContent = '';
    open('import-dialog');
}
function renderPreview(data) {
    const root = $('import-preview');
    root.replaceChildren();
    root.hidden = false;
    const summary = element('div', 'preview-stats');
    for (const [key, label] of [
        ['created', '条新增'],
        ['updated', '条更新'],
        ['skipped', '条跳过'],
        ['errorCount', '条错误'],
    ]) {
        const item = element('span');
        item.append(
            element('strong', '', String(data[key])),
            document.createTextNode(label),
        );
        summary.append(item);
    }
    root.append(summary);
    if (data.errors.length) {
        const errors = element('div', 'preview-errors');
        for (const err of data.errors)
            errors.append(
                element('p', '', `第 ${err.line} 行：${err.message}`),
            );
        if (data.errorCount > data.errors.length)
            errors.append(
                element('p', '', `仅显示前 ${data.errors.length} 条错误`),
            );
        root.append(errors);
    }
    if (data.sample.length) {
        const wrapper = element('div', 'preview-table'),
            table = element('table'),
            head = element('thead'),
            row = element('tr');
        for (const name of ['行', '处理', '主机', '端口', '协议'])
            row.append(element('th', '', name));
        head.append(row);
        table.append(head);
        const body = element('tbody');
        for (const item of data.sample.slice(0, 10)) {
            const row = element('tr');
            for (const value of [
                item.line,
                item.action,
                item.server,
                item.port,
                protocolLabel(item.protocol),
            ])
                row.append(element('td', '', String(value)));
            body.append(row);
        }
        table.append(body);
        wrapper.append(table);
        root.append(
            wrapper,
            element(
                'p',
                'hint',
                '预览显示前 10 条，不显示密码。错误行会跳过，其余有效行可导入。',
            ),
        );
    }
}
function editNode(node) {
    state.editId = node.id;
    for (const key of [
        'name',
        'server',
        'port',
        'protocol',
        'group',
        'username',
    ])
        $(`edit-${key}`).value = node[key];
    $('edit-protocol').value = node.protocol === 'socks5' ? 'socks5' : 'http';
    $('edit-tls').checked = node.protocol === 'https';
    syncProtocolOptions('edit');
    $('edit-enabled').checked = node.enabled;
    $('edit-password').value = '';
    $('edit-error').textContent = '';
    open('edit-dialog');
}
function scopeChanged() {
    const scope = $('share-scope').value;
    $('share-group-label').hidden = scope !== 'group';
    $('share-selected-info').hidden = scope !== 'selected';
    $(
        'share-selected-info',
    ).textContent = `当前选中 ${state.selected.size} 个节点。所选范围在创建后保持固定。`;
}
function shareDialog(selected = false) {
    if (!state.stats.total) {
        toast('请先导入 ISP 节点');
        return;
    }
    $('share-form').reset();
    $('share-error').textContent = '';
    $('share-scope').querySelector('[value="selected"]').disabled =
        !state.selected.size;
    $('share-scope').querySelector('[value="group"]').disabled =
        !state.groups.filter(Boolean).length;
    $('share-scope').value = selected ? 'selected' : 'all';
    scopeChanged();
    open('share-dialog');
}
function showLinks(share) {
    // Relative service paths follow the page's deployment prefix.
    const link = (path) =>
        /^https?:\/\//.test(path)
            ? path
            : new URL(`.${path}`, new URL('./', location.href)).href;
    $('clash-link').value = link(share.clashUrl);
    $('provider-link').value = link(share.providerUrl);
    const host = new URL($('clash-link').value).hostname;
    $('link-warning').textContent = [
        'localhost',
        '127.0.0.1',
        '[::1]',
    ].includes(host)
        ? '当前链接仅本机可访问。部署到可访问的 HTTPS 地址后再分享给其他人。'
        : '复制完整配置链接，在 Clash 的订阅 / 配置页面导入。';
    open('link-dialog');
}
async function copyLink(id) {
    try {
        await navigator.clipboard.writeText($(id).value);
        toast('链接已复制');
    } catch {
        $(id).focus();
        $(id).select();
        toast('请按 Ctrl+C / ⌘C 复制选中的链接');
    }
}
function batchDialog(action, share) {
    if (!['revoke', 'delete-share'].includes(action) && !state.selected.size)
        return;
    state.batch = { action, ids: [...state.selected], share };
    const labels = {
        enable: '批量启用',
        disable: '批量停用',
        group: '移动分组',
        delete: '删除节点',
        revoke: '撤销订阅',
        'delete-share': '删除订阅',
    };
    $('batch-title').textContent = labels[action];
    $('batch-group-label').hidden = action !== 'group';
    $('batch-group').value = '';
    $('batch-error').textContent = '';
    $('batch-description').textContent =
        action === 'delete-share'
            ? `将永久删除“${share.name}”的分享记录，对应链接立即失效。ISP 节点保留。此操作无法撤销。`
            : action === 'revoke'
            ? `撤销“${share.name}”后，此链接将无法继续下载。已下载的配置不受影响。`
            : action === 'delete'
            ? `将永久删除所选的 ${state.selected.size} 个节点。关联订阅将不再包含这些节点。`
            : `将对选中的 ${state.selected.size} 个节点执行“${labels[action]}”。`;
    $('batch-confirm').textContent = labels[action];
    $('batch-confirm').className = [
        'delete',
        'revoke',
        'delete-share',
    ].includes(action)
        ? 'danger'
        : 'primary';
    open('batch-dialog');
}
$('login-dialog').addEventListener('cancel', (event) => event.preventDefault());
$('login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const button = event.submitter;
    run(
        async () => {
            state.token = $('admin-token').value.trim();
            await loadNodes();
            state.connected = true;
            if (state.token) sessionStorage.setItem('isp-admin', state.token);
            else sessionStorage.removeItem('isp-admin');
            $('admin-token').value = '';
            close('login-dialog');
            $('workspace').hidden = false;
            $('logout').hidden = !state.token;
            $('connection').textContent = '已连接';
            $('connection').classList.add('online');
            setTab(state.tab);
            await loadIprRoyalStatus().catch(() => {});
        },
        'login-error',
        button,
    );
});
$('logout').addEventListener('click', loggedOut);
$('share-rename-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
        const id = $('share-rename-form').dataset.shareId;
        await api(`shares/${id}`, { name: $('share-rename-name').value.trim() }, 'PATCH');
        close('share-rename-dialog');
        await loadShares();
        toast('订阅名称已更新');
    }, 'share-rename-error', event.submitter);
});
$('iproyal-config-open').addEventListener('click', iproyalConfigDialog);
$('iproyal-config-dialog').addEventListener('close', () => {
    $('iproyal-config-form').reset();
});
$('iproyal-config-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
        await api('iproyal/config', { token: $('iproyal-api-token').value.trim() }, 'PUT');
        $('iproyal-api-token').value = '';
        close('iproyal-config-dialog');
        toast('API Token 已保存，正在同步…');
        await run(syncIprRoyal, null, $('iproyal-sync'));
        await loadIprRoyalStatus().catch(() => {});
    }, 'iproyal-config-error', event.submitter);
});
$('iproyal-sync').addEventListener('click', () =>
    run(() => syncIprRoyal(), null, $('iproyal-sync')),
);
for (const button of document.querySelectorAll('[data-close]'))
    button.addEventListener('click', () => close(button.dataset.close));
for (const button of document.querySelectorAll('[data-tab]'))
    button.addEventListener('click', () => setTab(button.dataset.tab));
for (const id of ['import-open', 'top-import', 'empty-import'])
    $(id).addEventListener('click', importDialog);
$('refresh').addEventListener('click', () => {
    if (!state.connected) return open('login-dialog');
    run(async () => {
        await loadNodes();
        if (state.tab === 'shares') await loadShares();
        toast('已刷新');
    });
});
$('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        state.page = 1;
        run(loadNodes);
    }, 250);
});
for (const id of ['group-filter', 'status-filter'])
    $(id).addEventListener('change', () => {
        state.page = 1;
        run(loadNodes);
    });
$('clear-filter').addEventListener('click', () => {
    $('search').value = '';
    $('group-filter').value = '*';
    $('status-filter').value = '';
    state.page = 1;
    run(loadNodes);
});
$('page-size').addEventListener('change', () => {
    state.pageSize = Number($('page-size').value);
    state.page = 1;
    run(loadNodes);
});
$('previous').addEventListener('click', () => {
    if (state.page > 1) {
        state.page--;
        run(loadNodes);
    }
});
$('next').addEventListener('click', () => {
    state.page++;
    run(loadNodes);
});
$('select-all').addEventListener('change', () => {
    state.selected = new Set(
        $('select-all').checked ? state.nodes.map((n) => n.id) : [],
    );
    renderNodes();
});
for (const action of ['enable', 'disable', 'group', 'delete'])
    $(`bulk-${action}`).addEventListener('click', () => batchDialog(action));
$('bulk-check').addEventListener('click', () =>
    run(() => checkNodes([...state.selected]), null, $('bulk-check')),
);
$('check-all').addEventListener('click', () => run(checkAllNodes));
$('bulk-share').addEventListener('click', () => shareDialog(true));
for (const id of ['share-open', 'empty-share'])
    $(id).addEventListener('click', () => shareDialog());
$('share-scope').addEventListener('change', scopeChanged);
$('edit-protocol').addEventListener('change', () =>
    syncProtocolOptions('edit'),
);
$('import-form').addEventListener('input', invalidatePreview);
$('import-form').addEventListener('change', invalidatePreview);
$('import-file').addEventListener('change', () =>
    run(async () => {
        const session = state.session;
        const file = $('import-file').files[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024)
            throw new Error('文件最大 8 MiB，请分批导入');
        const content = await file.text();
        if (session !== state.session) return;
        $('import-content').value = content;
        invalidatePreview();
    }, 'import-error'),
);
$('import-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(
        async () => {
            const input = importInput(),
                fingerprint = JSON.stringify(input),
                session = state.session;
            const result = await api('import/preview', input, 'POST');
            if (
                session !== state.session ||
                fingerprint !== JSON.stringify(importInput())
            )
                return;
            renderPreview(result);
            state.preview = fingerprint;
            $('commit-import').disabled = !(result.created + result.updated);
        },
        'import-error',
        event.submitter,
    );
});
$('commit-import').addEventListener('click', () =>
    run(
        async () => {
            const input = importInput();
            if (state.preview !== JSON.stringify(input))
                throw new Error('内容已变化，请重新预览');
            const result = await api('import', input, 'POST');
            close('import-dialog');
            $('import-content').value = '';
            $('import-file').value = '';
            invalidatePreview();
            state.page = 1;
            await loadNodes();
            toast(
                `导入完成：新增 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped}，错误 ${result.errorCount}；${result.probesQueued} 个节点已排队检测`,
            );
        },
        'import-error',
        $('commit-import'),
    ),
);
$('edit-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(
        async () => {
            const data = {};
            for (const key of [
                'name',
                'server',
                'protocol',
                'group',
                'username',
            ])
                data[key] = $(`edit-${key}`).value;
            data.protocol = protocolFromForm('edit');
            data.port = Number($('edit-port').value);
            data.enabled = $('edit-enabled').checked;
            if ($('edit-password').value !== '')
                data.password = $('edit-password').value;
            await api(`nodes/${state.editId}`, data, 'PATCH');
            $('edit-password').value = '';
            close('edit-dialog');
            await loadNodes();
            toast('节点已保存');
        },
        'edit-error',
        event.submitter,
    );
});
$('share-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(
        async () => {
            const data = {
                name: $('share-name').value,
                scope: $('share-scope').value,
                group: $('share-group').value,
                ids: [...state.selected],
            };
            if ($('share-expiry').value)
                data.expiresAt = new Date(
                    $('share-expiry').value,
                ).toISOString();
            const share = await api('shares', data, 'POST');
            close('share-dialog');
            setTab('shares');
            showLinks(share);
            toast('订阅已创建');
        },
        'share-error',
        event.submitter,
    );
});
$('batch-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(
        async () => {
            const { action, ids, share } = state.batch;
            if (['revoke', 'delete-share'].includes(action)) {
                const suffix =
                    action === 'delete-share' ? '?mode=permanent' : '';
                await api(`shares/${share.id}${suffix}`, undefined, 'DELETE');
                $('clash-link').value = '';
                $('provider-link').value = '';
                state.batch = null;
                await loadShares();
            } else {
                await api(
                    'nodes/batch',
                    { action, ids, group: $('batch-group').value },
                    'POST',
                );
                await loadNodes();
            }
            close('batch-dialog');
            toast(
                action === 'delete-share'
                    ? '订阅已删除'
                    : action === 'revoke'
                    ? '订阅已撤销'
                    : '批量操作已完成',
            );
        },
        'batch-error',
        event.submitter,
    );
});
$('copy-clash').addEventListener('click', () => copyLink('clash-link'));
$('copy-provider').addEventListener('click', () => copyLink('provider-link'));
run(async () => {
    try {
        await loadNodes();
        state.connected = true;
        $('workspace').hidden = false;
        $('logout').hidden = !state.token;
        $('connection').textContent = '已连接';
        $('connection').classList.add('online');
        await loadIprRoyalStatus().catch(() => {});
        setTab(state.tab);
    } catch (error) {
        loggedOut();
        $('login-error').textContent = error.message;
    }
});
