# Sub-Store ISP Manager

独立 ISP 管理模块，新增文件即可运行。页面参考 Sub-Store 的浅灰背景、居中页头、白色表单、蓝色操作按钮和底部导航，增加 ISP 批量管理。

## 启动

需要 Node.js 24+，依赖使用上层 backend/package.json 中已有的 Express、yaml、undici 和 fetch-socks。

```sh
cd backend
pnpm install --frozen-lockfile
node isp-manager/server.mjs
```

打开 http://127.0.0.1:3100 。首次启动会生成 `isp-manager/.data/admin-token`；读取该文件，将内容粘贴到页面的管理口令框。口令不会打印到日志。已有依赖时可直接运行第二条启动命令。

```sh
cat isp-manager/.data/admin-token
```

在本次开发机器上，Node 24 的绝对路径为：
`/Users/olifod/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`。

## 使用

1. 点击 **批量导入**，选择代理列表格式与代理协议，可粘贴文本或导入 TXT 文件。
2. 点击 **预览校验**，查看新增、更新、跳过和错误行。确认后导入有效行，错误行不会入库。新增和更新的节点会自动排队检测；跳过的重复节点不检测。
3. 搜索、筛选分组，或勾选本页节点批量检测、启停、移动分组、删除。分页每页最多 200 条；切换筛选、页码或刷新会清除选择。编辑时密码留空表示不变。
4. 到 **分享订阅** 创建链接，或在节点列表批选后创建。复制 Clash 完整配置链接，粘贴到客户端订阅/配置页面。已有自定义配置时可使用 Provider 链接。

每次拉取订阅都会读取当前启用节点，不需要重新创建链接。全部/分组分享自动包含后续新增的匹配节点；所选节点分享按固定 ID 跟踪，修改名称或分组不影响范围。删除节点后不会自动用新 ID 替代。分享卡片提供“撤销”和“删除”：撤销保留记录，删除永久移除分享记录并使链接立即失效；已撤销、已到期订阅也可删除，ISP 节点不受影响。撤销和到期阻止后续下载，已下载的配置仍然有效；要立即阻断代理连接，需要在 ISP 供应商侧修改账号密码。订阅为空时返回 404，避免下发没有可用节点的配置。

## 导入格式

| 选项 | 示例 |
| --- | --- |
| HOST:PORT:USER:PASS | proxy.example:8080:alice:p:a@ss |
| HOST:PORT@USER:PASS | proxy.example:8080@alice:p:a@ss |
| USER:PASS:HOST:PORT | alice:p:a@ss:proxy.example:8080 |
| USER:PASS@HOST:PORT | alice:p:a@ss@proxy.example:8080 |

- 协议选项合并为 **HTTP / HTTPS** 和 **SOCKS5**。HTTP / HTTPS 默认使用普通 HTTP 代理连接，也能访问 HTTPS 网站。仅当供应商明确要求通过 TLS 连接代理服务器时，开启“使用 TLS 连接代理服务器”。旧 HTTPS 节点编辑时会自动开启该选项；API 仍使用 http/https/socks5 区分实际连接方式。
- 每行一条；空行忽略；不加 `http://` 等前缀；不自动解码 `%40` 等文本，凭据按原文保存。
- IPv6 必须加方括号，如 `[2001:db8::1]:8080:alice:password`。
- 用户名不能包含 `:`；密码可以包含 `:` 和 `@`。地址在后的格式，从末尾识别 `HOST:PORT`；`USER:PASS@HOST:PORT` 以最后一个 `@` 为地址分隔符。
- 端口范围 1–65535；不支持空账号或空密码；每批最多 50,000 行且 HTTP 请求 JSON 小于 8 MiB。超限时分批导入。
- `(protocol, server, port, username)` 相同即为重复账号。默认跳过；“更新密码与分组”仅更新密码与分组，保留 ID、名称与启停。一个批次重复出现同一账号时，更新模式以最后一条为准。
- 预览只校验输入格式；正式导入后异步探测，不阻塞导入响应。协议选错、代理欠费或白名单限制仍需在供应商侧处理。

## 状态检测

- 默认通过代理请求 `https://api.ipify.org?format=json` 获取出口 IP；支持 HTTP CONNECT、HTTPS 代理 TLS 和 SOCKS5 用户名密码认证，TLS 证书验证始终开启。代理凭据只发送给代理服务器，不发送给 IP 检测服务。
- 默认最多 5 个并发，每次检测最多 10 秒；每次最多读取 8 KiB，不跟随重定向。每个节点消耗一次小型 HTTP 请求的流量。可用 `ISP_PROBE_URL` 指向返回 `{ "ip": "地址" }` 或纯 IP 文本的自有检测服务。
- 状态包括未检测、排队、检测中、可用、认证失败、连接超时、连接失败、检测服务异常。显示出口 IP、完整请求耗时；悬停可查看检测时间和认证状态。“代理接受连接凭据”仅表示使用当前凭据能建立连接，不代表验证了代理强制认证；没有明确认证拒绝响应时不判定为密码错误。
- 检测结果只反映管理服务器的出网路径，无法保证使用者所在网络可达；耗时包含代理连接、TLS 握手和检测服务响应，不是 ICMP ping。
- 手动逐条或勾选本页批量重新检测。队列只在进程内维护，重启后未完成的任务需要手动重试；已完成结果批量原子保存，正常停止会落盘，异常退出可能丢失最后约 1 秒尚未落盘的结果。没有周期性自动检测。
- 检测失败不会自动停用节点，也不会改变分享范围。修改连接地址、协议、用户名或密码会清除旧结果；修改名称、分组、启停不清除。过时任务不能覆盖新连接结果，删除中的节点不会被检测任务重新创建。
- 自动刷新仅更新检测状态，不清除勾选或覆盖编辑框。存储失败时页面提示并保留结果等待重试。

## 配置及部署

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| ISP_HOST | 127.0.0.1 | 监听地址 |
| ISP_PORT | 3100 | 监听端口 |
| ISP_DATA_DIR | 本模块 .data 目录 | 数据与默认管理口令目录 |
| ISP_ADMIN_TOKEN | 自动生成并保存 | 自定义管理口令，至少 24 位且无空白 |
| ISP_PUBLIC_BASE_URL | 当前页面所在地址 | 分享 URL 的公开根地址，可包含路径前缀 |
| ISP_PROBE_URL | https://api.ipify.org?format=json | 出口 IP 检测服务，HTTP(S)，不含 URL 凭据或片段 |
| ISP_PROBE_TIMEOUT_MS | 10000 | 单次检测时限，50–60000 毫秒 |
| ISP_PROBE_CONCURRENCY | 5 | 检测并发数，1–20 |

向其他人分享需要将服务部署到他们能访问的地址，localhost 链接只在本机有效。建议用 HTTPS 反向代理。例：页面位于 `https://isp.example/manager/`，服务器设置 `ISP_PUBLIC_BASE_URL=https://isp.example/manager`，Nginx 配置：

```nginx
location = /manager { return 301 /manager/; }
location /manager/ {
    proxy_pass http://127.0.0.1:3100/;
    client_max_body_size 8m;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    access_log off;
}
```

尾部 `/` 用于去除前缀；页面使用相对资源路径，API 也随页面前缀加载。反向代理不缓存 `/s/`，不将完整分享路径写入访问日志。分享 URL 是访问凭据，仅向使用者发送。代理账号密码会出现在 YAML 内，这是 Clash 连接所需。

管理接口需 `Authorization: Bearer <管理口令>`，分享口令不能管理数据。同源页面将管理口令暂存于 sessionStorage，可点击退出清除。数据文件含代理凭据，写入采用 0600 权限并通过临时文件原子替换。数据目录仅限一个服务进程；不支持多实例同时写同一个文件。备份时保存 `.data/`（包含 store.json 和 admin-token）；不要提交到 Git，模块已提供忽略规则。数据文件损坏时服务拒绝启动，应先恢复备份。

完整 Clash 配置使用 `mixed-port: 7890`、`allow-lan: false`、手动选择组 `ISP`、`MATCH,ISP` 规则，全部流量走所选 ISP。HTTPS 导出为 `type: http` 加 `tls: true`；SOCKS5 不默认打开 UDP。Provider 输出只有 `proxies`。本模块不提供前置代理链配置；ISP 若无法从客户端直接连接，需在客户端已有配置中配置前置代理后使用 Provider。

## API

所有管理 API 以 `/api/isp` 开头，成功返回 `{ "data": ... }`，失败返回 `{ "error": { "message": ... } }`。

| 方法 | 路径 | 参数/作用 |
| --- | --- | --- |
| GET | /nodes | q, group, enabled=true/false, page, pageSize（最大200）；节点含 health/probeState，probes 含队列计数和存储异常状态 |
| POST | /import/preview | content, format, protocol, group, duplicate=skip/update；无写入 |
| POST | /import | 同预览；导入有效行，probesQueued 为自动排队数 |
| POST | /nodes/check | ids（1–50000 个节点 ID）；返回 202，queued 为本次新排队数，重复任务合并 |
| PATCH | /nodes/:id | name, protocol, server, port, username, password, group, enabled |
| POST | /nodes/batch | ids, action=enable/disable/delete/group, group |
| GET | /shares | 列出分享及完整/Provider链接 |
| POST | /shares | name, scope=all/group/selected, group, ids, expiresAt（可选 ISO 时间） |
| DELETE | /shares/:id | 默认撤销分享；mode=permanent 永久删除分享记录（不删除节点） |
| GET | /s/:token/clash.yaml | 公共订阅路由（不含 /api/isp），按分享范围输出完整配置 |
| GET | /s/:token/provider.yaml | 公共订阅路由，输出 Provider |

## 验证

```sh
node --test isp-manager/test/*.test.mjs
```

测试使用临时目录与合成节点，覆盖四格式、IPv6、特殊字符、错误行、万级导入、去重与密码更新、批量校验、写失败回滚、重启读取、HTTP 鉴权、范围隔离、撤销/到期、Clash YAML 回读，以及本地 HTTP/HTTPS/SOCKS5 探测、证书校验、认证失败、超时、异常检测响应、队列并发、旧结果隔离、保存失败重试。探测测试只使用本地合成服务；test/fixtures 的私钥仅用于测试公开证书。

代码以仓库 AGPL-3.0 许可证提供；参见仓库根目录 LICENSE。
