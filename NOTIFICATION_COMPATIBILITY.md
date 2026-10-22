# 官方 Bitwarden 通知兼容修复（2026-10-22）

## 协议基线与实现边界

核实官方 browser/desktop/web-v2026.10.0 的
[SignalRConnectionService](https://github.com/bitwarden/clients/blob/browser-v2026.10.0/libs/common/src/platform/server-notifications/internal/signalr-connection.service.ts)：
三者同一文件均为 blob `033e2b61d156942e621fc35540945220109656b9`，使用 SignalR/MessagePack
10.0.0、`skipNegotiation: true`、WebSockets、`accessTokenFactory`。浏览器不能自定义 WebSocket
Authorization header，因此 SignalR 使用 `access_token` 查询参数。上游固定 main `cb871095`
的通知处理器只接受 Header 或一次性票据，确实也有相同的浏览器直连 401 问题。

本轮仅恢复精确 `/notifications/hub`、GET、`Upgrade: websocket` 的 URL JWT 入口；HTTP 网络
握手仍由 Workers/WebSocket 运行时处理。其他 API、negotiate、匿名 Hub 均不因此获得 JWT 查询认证。
优先级为显式 Authorization → 显式 id 票据 → 唯一 access_token；前者无效即拒绝，不降级回退。
没有 User-Agent 允许名单，也不要求修改或自行编译官方客户端。

Header 与 URL JWT 共用 HS256/typ/签名/issuer/iat/exp 校验；拒绝缺失或非整数过期值。
账号必须在最新 D1 记录中为 active，security stamp 必须一致；含设备绑定的令牌必须同时具有
did/dstamp，设备必须存在、未封禁且会话 stamp 相符。未设备绑定的历史访问令牌仍按账号 stamp
校验，不额外扩大它的权限。通知校验不使用 AuthService 的 15 秒进程缓存。

Web Vault 的签名、60 秒一次性票据保留，期限同时不超过其原访问 JWT 的 exp。
DO 保存的是非 bearer 的会话上下文，不保存原 JWT；消费票据后重新检查 D1 状态，防止协商后
账号/设备已撤销仍建立连接。没有 D1 schema、Wrangler DO 类迁移或生产配置变更。

## URL 与日志

认证后的用户 Hub 内部 URL 从固定值重建，查询中只包含受信任的 user/device 路由值。
access_token、id 及所有客户端附加查询均丢弃；Authorization、Cookie、Referer 也不转发。
匿名 Hub 同样重建 URL，只传已核实的 auth-request 路由 ID。DO 获取受控 session 元数据，
不获取原 JWT。对通知路径，路由异常只写固定错误文本，不序列化任意异常消息或堆栈。
现有应用审计元数据只记录 pathname，不记录查询字符串。

这些措施只限制应用自己写出的日志和内部转发，**不能阻止 Cloudflare 边缘、Workers 自动请求
日志/追踪、Logpush、WAF、上游代理或外部监控记录最初请求 URL**。本次没有修改线上日志配置。
应限制这些日志的访问与保留，并按实际日志产品核实查询脱敏。不要将访问 JWT 粘贴到工单/截图。

访问令牌当前有效期仍为 7200 秒（2 小时），未为消除告警改短或改长。URL 中的令牌仍是完整
API bearer：若泄露，攻击者可在过期或账号/设备会话撤销前把它用于其他需要 Authorization 的 API。
“仅 Hub 接受 URL”不把该 JWT 变成通知专用令牌。HTTPS/WSS 保护传输，不能解决日志读取风险。
这是兼容现有官方协议的明确剩余风险；参见
[Microsoft SignalR 安全说明](https://learn.microsoft.com/aspnet/core/signalr/security#access-token-logging)。

## 已建立连接的生命周期

每个用户连接保存 exp 和账号/设备会话上下文。DO 的现有 alarm 同时处理票据回收和最早连接
到期，过期后主动关闭。每次收到消息及发送通知前重新查询 D1；撤销/禁用后不继续发送通知，
并关闭连接。没有后台轮询：无消息的已撤销空闲连接可能保持到下一次活动或 exp，但下一次
应用通知必须先重新验证。alarm 延迟不跳过收发前的 exp 校验。

旧兼容日期 2024-01-01 需要在 webSocketClose 显式回复关闭帧，现已补齐，避免异常 1006 和
Miniflare 清理错误。旧已连接 session 或未包含新上下文的旧票据可能需要重连一次；无需客户端
设置变更。官方服务采用 2–5 分钟随机重试，可能有短暂无通知窗口；其
[getActiveBearerToken](https://github.com/bitwarden/clients/blob/browser-v2026.10.0/libs/common/src/services/api.service.ts)
会在需要时刷新访问令牌后供重连使用。

## 验证与限制

- `test:notifications-security`：正向 URL/Header/票据，以及路径/方法/非升级限制、重复参数、
  凭证冲突、过期/篡改、账号/设备撤销、票据复用、内部 URL/headers 与异常日志脱敏。
- `test:notifications-protocol`：在浏览器式 VM 加载未修改的官方 10.0.0 browser 分发库，
  使 SignalR 实际走 URL JWT 路径，连接真实 Miniflare Worker/DO。R2/KV 两配置均验证 101、
  MessagePack 握手/ReceiveMessage、干净关闭/重连、Header 与票据 101、过期和撤销后的拒绝/关闭。
  VM 只补齐浏览器传输所需的全局对象，不运行官方客户端 UI、认证 SDK 或扩展沙箱。
- 原跨版本 D1 回滚测试保留；末尾由“JWT URL 返回 401”改为真实 101 并正常关闭。
- SignalR/MessagePack 仅为开发测试依赖，固定官方基线版本；打包输入检查增加这两个包，
  不允许进入 Worker 产物。既有 npm/OSV/Semgrep 及其他安全检查保留。

没有使用真实账号、远程 D1、线上 Worker URL、真实用户保险库或移动系统推送。尚未运行正式
browser 扩展/desktop/web 安装包的完整登录与 UI 流程，也未模拟两小时实际等待、全网代理或
Cloudflare 真实跨地域 hibernation；短 TTL 测试验证相同 exp 关闭路径。
通过协议库回归不能表述为所有客户端完整端到端认证。本轮没有合并 PR 或主动部署。
