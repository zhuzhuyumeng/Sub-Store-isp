# ISP Manager 增量开发设计

## 已确认需求
独立后端模块与简单管理页面；大量 ISP 批量导入；用户选择四种格式：HOST:PORT:USER:PASS、HOST:PORT@USER:PASS、USER:PASS:HOST:PORT、USER:PASS@HOST:PORT；导出可供他人订阅的 Clash 链接。用户授权回退原有两处未提交修改并继续开发。

## 边界
所有新增功能置于 backend/isp-manager/，不修改既有文件。使用独立 Git 工作区 codex/isp-manager。Node 24+ 独立进程提供同源页面和 /api/isp 接口，默认监听 127.0.0.1:3100。独立数据文件，不触碰 Sub-Store 的 sub-store.json。共享已有 express/yaml 依赖；简单 HTTP/HTTPS/SOCKS5 节点直接映射为 Clash 标准字段，避免加载原应用的全局存储副作用。

## 数据与流程
节点字段：id、name、protocol、server、port、username、password、group、enabled、createdAt、updatedAt。导入先预览校验，再提交；空行忽略，错误保留行号但不返回原始凭据。最大 50,000 行/8 MiB 请求。IPv6 必须带方括号。裸格式凭据不做 URL 解码。协议由下拉框选择，默认 HTTP。格式分隔规则写入说明。

以 protocol/server/port/username 标识同一账号。默认跳过重复，可选择更新密码和分组，保留 ID、启停和名称。支持批量启停、删除、移动分组；单条编辑名称、地址、端口、账号密码、协议和分组。列表分页、搜索、分组和状态筛选；密码默认掩码。

分享对象有名称、随机 256 位 token、启停、可选到期日和范围（全部、一个分组、所选节点）。完整配置含 mixed-port、代理选择组、MATCH 规则；Provider 仅含 proxies。生成时读取最新启用节点。撤销 token 后拉取立即失效。范围固定于服务端，查询参数不能扩展范围。无启用节点返回 404，防止空配置误导用户。分享仅能下载 YAML，不能管理节点。

## 管理权限及持久化
管理 API 使用 Bearer token。首次启动生成权限 0600 的管理员 token 文件；可用 ISP_ADMIN_TOKEN 设置。浏览器仅在 sessionStorage 中保留管理 token，可注销。跨域请求不开放 CORS。分享响应 no-store，错误和日志不含凭据。原子写入 JSON，权限 0600，单进程写入串行执行，写失败不修改内存；损坏文件拒绝启动，不覆盖。运行数据目录 .data/ 独立忽略。仅单实例使用同一数据目录。

## 页面
用户补充原站 https://sub-store.vercel.app/subs 作为参考。采用浅灰背景、居中标题、白色圆角表单、蓝色按钮和底部导航；系统中文字体、等宽地址列。主视图包含 ISP 表格、分页、批量工具条、导入弹窗和订阅页签。四种格式用下拉菜单和对应示例呈现。导入预览显示成功/重复/错误统计和行号。手机窄屏表格横向滚动；表单可键盘访问；状态与错误通过 live region 提示。

## 验收
四格式与 IPv6/特殊密码解析；校验错误不含原文；万级导入与重复更新；持久化重启；管理鉴权；分享范围、禁用、撤销、到期；YAML 解析回读；真实 HTTP 集成；桌面与窄屏页面操作。只使用合成测试节点，不验证真实代理连通性。部署公网域名需运营方提供域名和反向代理，交付本地可运行版本与部署说明。
