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
    const proxies = nodes.map((node) => {
        const base = node.name;
        let name = base,
            suffix = 2;
        while (used.has(name)) name = `${base} (${suffix++})`;
        used.add(name);
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
                          proxies: proxies.map((p) => p.name),
                      },
                  ],
                  rules: ['MATCH,ISP'],
              },
        { lineWidth: 0 },
    );
}
