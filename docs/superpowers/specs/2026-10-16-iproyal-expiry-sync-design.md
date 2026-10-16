# IPRoyal 订单有效期同步设计

## 目标

在现有 ISP Manager 页面中增量接入 IPRoyal API，按代理 IP 和端口自动关联订单，展示订单状态与到期时间。订单过期时只标记节点状态，保留节点和现有 Clash 分享内容。

## 范围

- 修改现有 `backend/isp-manager` 后端和页面，不新建第二个前端。
- IPRoyal API Token 只从服务端环境变量 `IPROYAL_API_TOKEN` 读取，不写入浏览器、数据文件、日志或分享链接。
- `ISP_ADMIN_TOKEN` 采用可选鉴权：未配置时管理 API 不要求 Bearer 口令；配置后保留现有鉴权行为。
- 同步 IPRoyal ISP 订单分页数据，读取订单 ID、状态、`expire_date` 和订单代理信息。
- 按节点的 `server` 与 HTTP/HTTPS 端口自动匹配订单；匹配不到的节点保留原有连通性探测结果，并显示未匹配。
- 订单到期只更新供应商状态，不自动停用节点、不改变分享范围。
- 现有代理连通性、出口 IP、国家定位和订阅生成逻辑保持不变。

## 数据流

1. 服务启动时读取 `IPROYAL_API_TOKEN`；没有 Token 时不执行供应商同步，页面显示未配置。
2. 管理员点击现有页面中的“同步 IPRoyal”，或服务按配置间隔执行同步。
3. 客户端调用 `GET https://apid.iproyal.com/v1/reseller/orders`，带 `X-Access-Token`，按页读取订单。
4. 将订单代理 IP/端口建立索引，匹配本地节点；对匹配节点原子保存供应商元数据。
5. 页面在现有节点状态区域展示供应商状态、到期时间、剩余时间和最近同步时间。
6. API 请求失败时保留上一次成功同步结果，记录非敏感错误状态，不覆盖节点连接状态。

## 数据模型

节点增加可选 `iproyal` 对象：

```json
{
  "orderId": 420,
  "status": "confirmed",
  "expiresAt": "2026-10-20T10:25:12.000Z",
  "syncedAt": "2026-10-16T12:00:00.000Z",
  "syncStatus": "matched"
}
```

`syncStatus` 取 `matched`、`unmatched`、`expired`、`error` 或 `not_configured`。供应商状态不改变节点的 `enabled` 字段；Clash 输出仍只按现有启用规则生成。

## API 与配置

- 新增服务端 IPRoyal 客户端模块，限制响应大小、请求超时和错误信息，禁止记录 Token。
- 新增管理接口用于读取同步状态和触发同步；接口沿用 `/api/isp` 前缀。
- 新增配置：
  - `IPROYAL_API_TOKEN`：可选，服务端 Token。
  - `IPROYAL_API_URL`：默认 `https://apid.iproyal.com/v1/reseller`。
  - `IPROYAL_SYNC_INTERVAL_MS`：默认 6 小时，允许关闭定时同步。
- `ISP_ADMIN_TOKEN` 未配置时跳过管理 API 鉴权；配置后使用现有 Bearer 校验。

## 页面增量

- 在当前节点列表的状态单元格中增加 IPRoyal 状态和到期时间。
- 在现有顶部操作区域增加“同步 IPRoyal”按钮和最近同步状态。
- 不新增路由、不替换页面结构、不要求用户在浏览器填写供应商 Token。

## 错误处理

- Token 缺失：状态为未配置，不阻塞 ISP Manager 其他功能。
- API 超时、401、限流、无效 JSON 或分页异常：保留旧供应商元数据，显示同步失败时间和可重试提示。
- 订单过期：标记为过期，但保留节点、分享链接和 Clash 配置。
- 同一节点匹配多个订单：选择到期时间更晚且状态优先级更高的订单，并记录匹配结果；不得把凭据写入错误信息。

## 验证

- 使用本地 HTTP 测试服务器模拟 IPRoyal API，覆盖分页、Token 请求头、IP/端口匹配、过期状态、未匹配节点、失败保留旧状态和 Token 不泄露。
- 保留并运行现有 ISP Manager 全部测试。
- 使用真实代理探测测试不调用 IPRoyal 真实写接口；真实 API 只在部署环境通过配置 Token 后验证读取权限。
