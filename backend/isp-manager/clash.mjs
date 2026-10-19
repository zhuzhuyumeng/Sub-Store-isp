import { stringify } from 'yaml';
import { IspError } from './parser.mjs';

export function exportClash(nodes, provider = false) {
    if (!nodes.length) throw new IspError('该订阅暂无启用的节点', 404);
    const used = new Set([
        'ISP',
        'DIRECT',
        'REJECT',
        'GLOBAL',
        'REJECT-DROP',
        'PASS',
        'COMPATIBLE',
    ]);
    const uniqueName = (base) => {
        let name = base, suffix = 2;
        while (used.has(name)) name = `${base} (${suffix++})`;
        used.add(name);
        return name;
    };
    const regions = nodes.map((node) => {
        const location = node.health?.location;
        return location?.status === 'located' && location.country
            ? location.country : '位置未知';
    });
    const groups = new Map();
    if (!provider) {
        for (const region of regions) {
            if (!groups.has(region))
                groups.set(region, { name: uniqueName(region), type: 'select', proxies: [] });
        }
    }
    const proxies = nodes.map((node, index) => {
        const location = node.health?.location;
        const place = location?.status === 'located'
            ? [...new Set([location.country, location.city].filter(Boolean))].join(' · ')
            : '';
        const host = node.server.includes(':') ? `[${node.server}]` : node.server;
        const base = `${place || '位置未知'}｜${host}:${node.port}`;
        const name = uniqueName(base);
        if (!provider) groups.get(regions[index]).proxies.push(name);
        return {
            name,
            type: node.protocol === 'socks5' ? 'socks5' : 'http',
            server: node.server,
            port: node.port,
            username: node.username,
            password: node.password,
            ...(node.protocol === 'https' ? { tls: true } : {}),
        };
    });
    return stringify(
        provider
            ? { proxies }
            : {
                  'mixed-port': 7890,
                  'allow-lan': false,
                  mode: 'rule',
                  'log-level': 'info',
                  proxies,
                  'proxy-groups': [
                      {
                          name: 'ISP',
                          type: 'select',
                          proxies: [...groups.values()].map((group) => group.name),
                      },
                      ...groups.values(),
                  ],
                  rules: ['MATCH,ISP'],
              },
        { lineWidth: 0 },
    );
}
