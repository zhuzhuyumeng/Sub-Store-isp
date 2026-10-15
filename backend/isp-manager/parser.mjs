import { isIP } from 'node:net';

export class IspError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
export const FORMATS = [
    'HOST:PORT:USER:PASS',
    'HOST:PORT@USER:PASS',
    'USER:PASS:HOST:PORT',
    'USER:PASS@HOST:PORT',
];
export const PROTOCOLS = ['http', 'https', 'socks5'];
export const MAX_LINES = 50000;
const hostPattern = '(\\[[^\\]]+\\]|[^:@\\s\\[\\]]+)';
const patterns = [
    new RegExp(`^${hostPattern}:(\\d+):([^:]+):(.+)$`),
    new RegExp(`^${hostPattern}:(\\d+)@([^:]+):(.+)$`),
    new RegExp(`^([^:]+):(.+):${hostPattern}:(\\d+)$`),
    new RegExp(`^([^:]+):(.+)@${hostPattern}:(\\d+)$`),
];
export function textField(value, label, max = 200, allowEmpty = false) {
    if (
        typeof value !== 'string' ||
        value.length > max ||
        /[\x00-\x1f\x7f]/.test(value) ||
        (!allowEmpty && !value.trim())
    )
        throw new IspError(`${label}无效`);
    return value;
}
export function validateNode(node) {
    if (!PROTOCOLS.includes(node.protocol))
        throw new IspError('请选择 HTTP、HTTPS 或 SOCKS5');
    let server = textField(node.server, '主机', 253).toLowerCase();
    const bracketed = server.startsWith('[') && server.endsWith(']');
    if (bracketed) server = server.slice(1, -1);
    if (!isIP(server)) {
        if (
            bracketed ||
            /^[\d.]+$/.test(server) ||
            !server
                .split('.')
                .every((label) =>
                    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
                )
        )
            throw new IspError('主机地址无效');
    }
    if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535)
        throw new IspError('端口必须为 1–65535');
    return {
        protocol: node.protocol,
        server,
        port: node.port,
        username: textField(node.username, '用户名', 1024),
        password: textField(node.password, '密码', 4096),
        group: textField(node.group ?? '', '分组', 100, true).trim(),
    };
}
export function parseImport(input) {
    if (!input || typeof input !== 'object')
        throw new IspError('请提供导入内容');
    const { content, format, protocol, group = '' } = input;
    const index = FORMATS.indexOf(format);
    if (index < 0) throw new IspError('请选择导入格式');
    if (!PROTOCOLS.includes(protocol)) throw new IspError('请选择代理协议');
    textField(group, '分组', 100, true);
    if (
        typeof content !== 'string' ||
        Buffer.byteLength(content) > 8 * 1024 * 1024
    )
        throw new IspError('导入文本最大 8 MiB');
    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines.length > MAX_LINES + 1)
        throw new IspError('一次最多导入 50,000 行');
    const rows = [],
        errors = [];
    let total = 0;
    lines.forEach((raw, i) => {
        if (!raw.trim()) return;
        total++;
        try {
            const match = patterns[index].exec(raw);
            if (!match)
                throw new IspError('与所选格式不匹配，请检查字段与分隔符');
            const [, a, b, c, d] = match;
            const [server, port, username, password] =
                index < 2 ? [a, b, c, d] : [c, d, a, b];
            rows.push({
                line: i + 1,
                node: validateNode({
                    server,
                    port: Number(port),
                    username,
                    password,
                    protocol,
                    group,
                }),
            });
        } catch (error) {
            errors.push({
                line: i + 1,
                message:
                    error instanceof IspError ? error.message : '该行格式无效',
            });
        }
    });
    if (!total) throw new IspError('请粘贴至少一行代理');
    if (total > MAX_LINES) throw new IspError('一次最多导入 50,000 行');
    return { rows, errors, total };
}
