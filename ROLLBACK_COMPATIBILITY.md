# PR #4 回滚兼容性补充审查（2026-10-22）

## 先部署读取器，再启用新写入

PR #3 现在增加一个只读兼容层：AuthService 能读取 `$s2$`、`$s$` 和历史客户端证明。
其登录流程不会自动迁移，注册和修改密码仍使用原 `$s$` 写入器。这是迁移前必须先发布的
兼容基线，不是直接使用原来的 main 或 `3427858` 回滚。

PR #4 才开始随机盐 `$s2$` 写入及成功登录后的迁移。回滚时保留同一份当前 D1、附件存储和
DO 数据，只切换到上述兼容代码版本；不执行 D1 Time Travel/备份还原，不重置密码或批量改回验证值。
上线 PR #4 前，应记录已发布兼容版本的真实 Cloudflare Version ID；Git SHA 不能代替 Version ID。
本次只准备代码和本地验证，不上传、激活或指定任何生产版本。

## 旧版本的实际影响

原 AuthService 只识别 `$s$`，其他字符串走客户端证明直接比较，因此正常客户端无法通过 `$s2$` 行
的密码校验。影响密码登录以及修改主密码、删除账户、API key/设备/2FA/passkey 管理、备份及
管理员敏感操作中需要再次校验密码的路径。新注册、修改密码写入的新行也会受影响，不只登录迁移的旧用户。

验证值不是保险库加密密钥。单纯迁移不改变 key/private_key、公钥、保险库密文或 security stamp。
尚有效的访问令牌、刷新令牌及已缓存的本地保险库不一定立即失效，但不能作为可靠的密码登录回滚方案。
修改主密码会正常轮换 security stamp、撤销刷新令牌并重新包装用户密钥，回滚必须保留这些最新数据。

## 发布和 Git 合并

三个 PR 的关系必须保持 #3 → #4 → #5。仓库目前同时允许 merge、squash 和 rebase，主分支无
ruleset 强制约束。当前堆叠应统一选择 **Create a merge commit**，保留原提交身份和祖先关系。
每次合并后才把下一个 PR 的 base 改为 main，检查待合并提交与差异只包含该阶段。
不要在此堆叠上混用 squash/rebase；若必须使用，应先重建后续分支、剔除已合并阶段并重新测试。

PR #3 发布兼容读取器并验证后，再考虑 PR #4，最后 PR #5。main 合并仍会触发已有 Cloudflare
生产部署，本次没有更改构建/部署规则。回滚代码前必须确认该代码可读取最新 schema 和存储格式；
这个方案只涵盖本轮没有 schema 迁移的三个 PR，不为未来数据库变更提供自动回滚承诺。

## 隔离 D1 验证结果

`npm run test:rollback-compatibility` 固定兼容基线 `2df60ea49d8c7399b8e2b261386f2476b732695e`，
将它和负面对照旧版 `3427858` 的受控 backend Git 源码分别 dry-run 打包。按以下顺序切换真实
Miniflare Worker，始终挂载同一个本机临时 D1，所有外部请求在 outboundService 阻断：

1. 兼容基线：旧用户正常登录，验证值保持 `$s$`；2FA 用户仍收到挑战。
2. 候选 PR #4：错误密码不迁移，成功登录迁移 `$s2$` 且密钥/stamp 不变；创建真实加密项目。
3. 在新版本修改主密码：使用客户端 PBKDF2 和 AES-CBC/HMAC 实现重新包装同一随机用户密钥，
   原密码失败、新密码成功，旧 access/refresh token 撤销。
4. 运行未修复旧版作为对照：新密码登录返回 400，复现原回滚风险。
5. 回滚兼容基线：用新密码正常登录，保留完整最新用户行及保险库行；用新密码解包用户密钥，
   逐项解密升级后新增项目及其中密码，与原始虚构明文一致。
6. 回滚后仍能创建项目、修改主密码（旧写入器生成 `$s$`）；再次登录并解密两个阶段的项目成功。
7. TOTP：缺失/错误第二因子不迁移；有效 TOTP 才迁移。回滚后仍要求 TOTP，已使用的 TOTP
   被拒绝，下一有效时间窗的 TOTP 成功；不清空重放保护表、不移除 2FA 或重置密码。
8. 再升级候选代码：回滚期间改过密码的账户仍能登录、重新迁移，两个阶段的最新密文均能解密。

以上本地 D1 生命周期已通过。测试会销毁自己创建的临时目录，不接触远程 D1、真实账号或附件。
YubiKey、硬件 WebAuthn 和真实官方安装包未实测，不能从 TOTP 结果推定这些场景全部通过。

## WebSocket：仍有正式发布阻断项

已读取官方 [SignalRConnectionService 固定源码](https://github.com/bitwarden/clients/blob/be779078cf1a763bc31e6f547423f205117190e8/libs/common/src/platform/server-notifications/internal/signalr-connection.service.ts)：
共享 JS 实现设置 `skipNegotiation: true`、`HttpTransportType.WebSockets`、
`accessTokenFactory`，使用 MessagePack；它不会先调用我们新增的 negotiate 获取一次性 id。
官方依赖为 SignalR 10.0.0。浏览器 WebSocket 无法发送自定义 Authorization header，SignalR
会把访问 JWT 放进 `access_token` URL 参数；见 [Microsoft 官方认证说明](https://learn.microsoft.com/aspnet/core/signalr/authn-and-authz#bearer-token-authentication)。

另已核实正式发布的 `browser-v2026.10.0`、`desktop-v2026.10.0`、`web-v2026.10.0`：
这三个 tag 的同一文件均为 blob `033e2b61d156942e621fc35540945220109656b9`，配置完全相同，
不是只根据尚未发布的 main 作出判断。

隔离 Worker 已用真实用户令牌、标准 WebSocket 升级头，复现官方浏览器直连请求形态得到 401。
这是确定的协议冲突，不是因为没有安装客户端就猜测不兼容。测试中的 401 断言是安全负向回归，
不代表官方客户端通知成功；完整的官方客户端通知端到端测试尚未通过。

**因此现在不要发布 PR #4/#5。** 原生客户端若实际携带 Authorization header，代码路径可以接收，
但本轮未运行真实桌面/iOS/Android 安装包；移动系统推送也不属于此 WebSocket 证明范围。
尚未完整验证 101/MessagePack 收发/断线重连。没有恢复 URL 访问 JWT、跳过认证或删除安全测试
来消除这个问题。需要先确定兼容官方客户端的认证方案或拆分此通知改动，并单独完成协议回归。

## 当前结论

密码格式回滚阻断已通过先部署兼容读取器、保留最新存储数据的方案解决。PR #3 可单独审查发布，
但 PR #4/#5 仍被上述通知协议冲突阻断。待该问题解决并复验后，正式顺序为兼容基线 → PR #4
→ PR #5；紧急回滚使用事先记录的兼容基线 Version ID，保持当前 D1/R2/KV/DO 内容，不回滚数据库。
GitHub 没有 required checks 强制门禁，技术上“能点合并”不等于已满足本报告的发布条件。
