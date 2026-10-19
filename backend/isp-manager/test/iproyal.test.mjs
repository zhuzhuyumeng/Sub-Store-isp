import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createIprRoyalClient } from '../iproyal.mjs';

function listen(t, handler) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return new Promise((resolve) =>
        server.once('listening', () => resolve(server.address().port)),
    );
}

const nodes = [
    {
        id: 'node-1',
        protocol: 'http',
        server: '203.0.113.10',
        port: 12323,
    },
    {
        id: 'node-2',
        protocol: 'socks5',
        server: '203.0.113.11',
        port: 12324,
    },
    {
        id: 'node-3',
        protocol: 'http',
        server: '203.0.113.99',
        port: 12323,
    },
];

test('IPRoyal client paginates with token and matches HTTP and SOCKS nodes', async (t) => {
    const requests = [];
    const port = await listen(t, (req, res) => {
        requests.push({ url: req.url, token: req.headers['x-access-token'] });
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname.endsWith('/products')) {
            res.setHeader('content-type', 'application/json');
            return res.end(JSON.stringify({ data: [
                { id: 42, name: 'Static Residential' },
                { id: 99, name: 'Datacenter' },
            ] }));
        }
        if (url.searchParams.get('product_id') !== '42') {
            res.writeHead(422, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'The product id field is required.' } }));
        }
        const page = new URL(req.url, 'http://127.0.0.1').searchParams.get(
            'page',
        );
        const body =
            page === '1'
                ? {
                      data: [
                          {
                              id: 420,
                              status: 'confirmed',
                              expire_date: '2099-04-20 10:25:12',
                              proxy_data: {
                                  ports: { 'http|https': 12323 },
                                  proxies: ['203.0.113.10'],
                              },
                          },
                      ],
                      meta: { current_page: 1, last_page: 2 },
                  }
                : {
                      data: [
                          {
                              id: 421,
                              status: 'expired',
                              expire_date: '2000-04-20 10:25:12',
                              proxy_data: {
                                  ports: { socks5: 12324 },
                                  proxies: [{ ip: '203.0.113.11' }],
                              },
                          },
                      ],
                      meta: { current_page: 2, last_page: 2 },
                  };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
    });
    const client = createIprRoyalClient({
        baseUrl: `http://127.0.0.1:${port}/v1/reseller`,
        token: 'secret-token',
    });
    const result = await client.syncNodes(nodes);
    assert.equal(requests.length, 3);
    assert.deepEqual(
        requests.map((item) => item.token),
        ['secret-token', 'secret-token', 'secret-token'],
    );
    assert.equal(result.fetchedOrders, 2);
    assert.equal(result.updates['node-1'].orderId, 420);
    assert.equal(result.updates['node-1'].syncStatus, 'matched');
    assert.equal(result.updates['node-2'].orderId, 421);
    assert.equal(result.updates['node-2'].syncStatus, 'expired');
    assert.equal(result.updates['node-3'].syncStatus, 'unmatched');
    assert.match(result.updates['node-1'].expiresAt, /^2099-04-20T10:25:12/);
});

test('IPRoyal client reports unconfigured state without making a request', async () => {
    const client = createIprRoyalClient({ token: '' });
    assert.equal(client.configured, false);
    await assert.rejects(() => client.listOrders(), /未配置/);
});

test('missing ISP product fails without querying unrelated orders or clearing matches', async (t) => {
    const requests = [];
    const port = await listen(t, (req, res) => {
        requests.push(req.url);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 6, name: 'Residential' }] }));
    });
    const client = createIprRoyalClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'secret-token' });
    await assert.rejects(client.syncNodes(nodes), { code: 'IPROYAL_ISP_PRODUCT_UNAVAILABLE' });
    assert.deepEqual(requests, ['/products']);
});

test('IPRoyal client sanitizes API failures and never includes the token', async (t) => {
    const port = await listen(t, (req, res) => {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: 'bad secret-token' }));
    });
    const client = createIprRoyalClient({
        baseUrl: `http://127.0.0.1:${port}/v1/reseller`,
        token: 'secret-token',
    });
    await assert.rejects(
        () => client.listOrders(),
        (error) => {
            assert.equal(error.code, 'IPROYAL_API_ERROR');
            assert.ok(!error.message.includes('secret-token'));
            return true;
        },
    );
});
