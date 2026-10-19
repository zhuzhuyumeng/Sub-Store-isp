import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createIprRoyalClient } from './iproyal.mjs';
import { IspError } from './parser.mjs';

function normalizeToken(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 ||
        !/^[\x21-\x7e]+$/.test(value.trim()))
        throw new IspError('请输入有效的 IPRoyal API Token（不含空白，最多 4096 个字符）');
    return value.trim();
}

export function createIprRoyalSettings({ file, token = '', ...clientOptions }) {
    let saved;
    try {
        saved = normalizeToken(JSON.parse(readFileSync(file, 'utf8')).token);
    } catch (error) {
        if (error.code !== 'ENOENT')
            throw new Error('IPRoyal 配置读取失败，请检查配置文件及权限');
    }
    const client = createIprRoyalClient({ ...clientOptions, token: saved ?? token });

    function save(value) {
        const token = normalizeToken(value);
        const next = createIprRoyalClient({ ...clientOptions, token });
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        let fd;
        try {
            fd = openSync(temporary, 'wx', 0o600);
            writeFileSync(fd, JSON.stringify({ token }));
            fsyncSync(fd);
            closeSync(fd);
            fd = undefined;
            renameSync(temporary, file);
        } finally {
            if (fd !== undefined) closeSync(fd);
            rmSync(temporary, { force: true });
        }
        return next;
    }
    return { client, save };
}
