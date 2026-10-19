import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'public/index.html'), 'utf8');
const js = readFileSync(join(root, 'public/app.js'), 'utf8');

test('existing ISP Manager page includes IPRoyal sync controls and expiry labels', () => {
    assert.match(html, /id="iproyal-sync"/);
    assert.match(html, /IPRoyal/);
    assert.match(html, /订单到期/);
    assert.match(js, /iproyal\/status/);
    assert.match(js, /iproyal\/sync/);
});

test('existing page can connect without a browser admin token', () => {
    assert.match(js, /state\.connected/);
    assert.match(js, /if \(!state\.connected\)/);
    assert.doesNotMatch(js, /if \(!state\.token\) return open\('login-dialog'\)/);
});
