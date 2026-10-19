import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { exportClash } from '../clash.mjs';

const node = {
    name: 'old label', protocol: 'http', server: '203.0.113.10', port: 12323,
    username: 'user', password: 'secret',
    health: { location: { status: 'located', country: '美国', city: 'Los Angeles' } },
};

test('Clash and provider exports name nodes by location and address, keeping group references valid', () => {
    for (const provider of [false, true]) {
        const config = parse(exportClash([node, { ...node, username: 'second' }], provider));
        assert.deepEqual(config.proxies.map((p) => p.name), [
            '美国 · Los Angeles｜203.0.113.10:12323',
            '美国 · Los Angeles｜203.0.113.10:12323 (2)',
        ]);
        assert.equal(config.proxies[0].username, 'user');
        assert.equal(config.proxies[0].password, 'secret');
        assert.equal(node.name, 'old label');
        if (!provider) {
            assert.deepEqual(config['proxy-groups'][0].proxies, ['美国']);
            assert.deepEqual(config['proxy-groups'][1].proxies, config.proxies.map((p) => p.name));
        } else assert.deepEqual(Object.keys(config), ['proxies']);
    }
});

test('full subscriptions nest nodes by detected country under ISP, including unknown locations', () => {
    const config = parse(exportClash([
        { ...node, group: '手动业务组' },
        { ...node, server: '203.0.113.11', health: { location: { status: 'located', country: '日本', city: 'Tokyo' } } },
        { ...node, server: '203.0.113.12', health: { location: { status: 'located', country: '美国', city: 'New York' } } },
        { ...node, server: '203.0.113.13', group: '美国', health: { location: { status: 'unavailable', country: '美国' } } },
    ]));
    const names = config.proxies.map((p) => p.name);
    assert.deepEqual(config['proxy-groups'], [
        { name: 'ISP', type: 'select', proxies: ['美国', '日本', '位置未知'] },
        { name: '美国', type: 'select', proxies: [names[0], names[2]] },
        { name: '日本', type: 'select', proxies: [names[1]] },
        { name: '位置未知', type: 'select', proxies: [names[3]] },
    ]);
    assert.deepEqual(config.rules, ['MATCH,ISP']);
});

test('region labels cannot collide with built-in targets, other groups or node names', () => {
    const countries = ['ISP', 'DIRECT', 'ISP (2)', '美国｜203.0.113.10:12323', '美国'];
    const config = parse(exportClash(countries.map((country) => ({
        ...node, health: { location: { status: 'located', country } },
    }))));
    const groups = config['proxy-groups'];
    assert.equal(groups.length, countries.length + 1);
    const names = [...groups, ...config.proxies].map((p) => p.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(!names.includes('DIRECT'));
    assert.equal(groups[0].proxies.length, countries.length);
    for (const group of groups.slice(1)) {
        assert.equal(group.proxies.length, 1);
        assert.ok(config.proxies.some((p) => p.name === group.proxies[0]));
    }
});

test('unknown location and IPv6 addresses have unambiguous names', () => {
    const config = parse(exportClash([{ ...node, server: '2001:db8::1', health: { location: { status: 'unavailable' } } }]));
    assert.equal(config.proxies[0].name, '位置未知｜[2001:db8::1]:12323');
});
