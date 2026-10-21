# 分阶段上游同步（2026-10-21）

2026-10-22 补充：PR #3 增加 `$s2$` 读取兼容层，作为迁移前先发布的回滚基线；
它仍使用旧写入器且不自动迁移。详见 `ROLLBACK_COMPATIBILITY.md`。

基线为本仓库 main `993d890a1ee2f5ed7e94b2e2c4d9b1345d177edc`，已经包含 PR #1 和 PR #2。
上游固定为 `shuaiplus/nodewarden@cb871095c1e348b8f784492cf0e479d124142f8b`，不在测试期间追逐变化的 main。

三个阶段使用顺序分支和独立 PR。第一阶段以 main 为 base，第二、三阶段分别基于前一阶段；
请按顺序合并，前一个 PR 合并后将下一个 PR 的 base 调整为 main 并复核差异。
没有直接推送 main、自动合并或执行生产部署命令。按已核实的 Cloudflare 配置，分支推送可能自动
执行版本上传；合并 main 将触发 `wrangler deploy`，应按正式生产发布处理。

## 必须保留的本地安全改动

- npm 锁文件和完整 `npm audit`，OSV `fail-on-vuln: true`，Semgrep 如实失败及真实报告摘要。
- Dependency Compatibility 的安装、现有回归、两种配置 dry-run、本地 Miniflare 和打包输入检查。
- Preact 要求的 Babel 7；不恢复上游 `@babel/core >=7.29.6` 无上界覆盖。
- 不恢复有漏洞的旧 sharp 固定值，也不重新把 Miniflare 的 undici 全局强制升级至 8。
- PR #1 更新的域名规则和自定义规则。上游的旧生成时间不作为回退理由。
- 保留原依赖审计及其告警解释作为历史，不用删除报告或禁用检查获得绿色状态。

## 阶段 1：依赖安全迁移与类型检查

来源：上游 `4c241aa`（Tailwind 4 迁移）、`13bb0a0`（三处前端类型声明修复）。
按提交补丁应用相关改动，没有直接使用上游整个 package.json/package-lock.json。

- Tailwind 4.3.3 / `@tailwindcss/vite`，移除 Tailwind 3 的 PostCSS 配置和旧构建依赖路径。
- 上游 CSS 主题、暗色 variant、圆角/行高和旧工具类兼容调整一起引入；否则只升级包会改变页面。
- 保留 Wrangler 4.107.1、Miniflare 的 undici 7 / sharp 0.35 安全覆盖，生产依赖声明未变。
- `npm audit` 和 `npm audit --omit=dev` 均退出 0。锁文件不再包含 braces 或
  postcss-selector-parser；两项原有依赖漏洞通过移除旧工具链解决，没有漏洞忽略。
- 原有 26 项测试、三项安全脚本、10 种语言校验、前后端类型检查、正式/demo 构建、R2/KV
  dry-run、真实 Worker 的 Miniflare 运行和 sharp 图片适配器测试全部通过。
- 前端类型检查现已通过并加入永久 CI；工具链产物检查增加 `@tailwindcss`。
- 本地 Edge 演示版验证了登录页和深色金库，输入/按钮字号、尺寸和圆角的登录页基线一致；
  检查了桌面和 390×844 窄屏，响应式重排后无页面横向溢出。模拟数据不连接生产。

兼容性：Tailwind 4 的浏览器下限是 Safari 16.4、Chrome 111、Firefox 128；不再承诺更老浏览器。
本机未安装这些历史浏览器，未声称跨浏览器完整回归或真实账号全流程通过。
参考：[官方升级指南](https://tailwindcss.com/docs/upgrade-guide)。

## 阶段 2：认证与金库数据兼容性

来源：上游 `e63f966`、`a72592e`、`5f71cb3`、`293f5ce`，不改变第一阶段的依赖版本。

- WebSocket 通过带签名、60 秒有效、DO 单次消费的票据连接；访问 JWT 不再放进 URL。
- 新密码验证格式使用独立随机盐，兼容旧 `$s$` 及历史客户端证明；成功登录并完成二次验证后
  才通过条件更新迁移，保留金库密钥、security stamp 和更新时间。登录失败及 auth-request 不迁移。
- 完整更新正确清空省略的 notes，保留未知/linked 字段；并发写入在 SQL 层校验 revision，
  冲突要求客户端刷新，避免静默覆盖；同步引入上游客户端兼容更新和批量删除/恢复接口。
- 增加 5 项通知安全、20 项金库兼容性、9 项密码验证测试并纳入 CI。原有测试及构建继续验证。
- 本地真实 Worker 的 R2/KV 两种配置验证旧账号迁移、失败/二次验证路径、密钥保持、真实 DO
  票据单次消费；测试阻断外部网络，使用一次性数据库及虚构账号。
- 完整 WebSocket 101 升级曾成功，但旧 Miniflare 的连接清理出现 ECONNRESET，未把该试验算为
  通过的端到端测试。永久回归改为真实 DO 消费加离线路由测试；真实浏览器/官方客户端通知仍待发布验证。

发布风险：成功登录会写入新密码验证格式，旧版服务不能识别。上线后回滚必须保留新格式读取器，
不能简单切回未修复的阶段 1（`3427858`）或旧 Worker。2026-10-22 已先在阶段 1 增加读取兼容层，
其固定提交 `2df60ea` 可作为保留最新数据的回滚基线，见 `ROLLBACK_COMPATIBILITY.md`。
没有新增数据库 schema 迁移或执行远程数据库命令。

## 阶段 3：其余依赖、界面、语言与发布资料

计划更新其余上游依赖、备份列表自适应布局、重复组标识、繁体中文术语和 1.8.1 发布资料。
Wrangler / Miniflare / Workers 类型必须按实际 peer 约束一并验证；不照抄与本地安全修复冲突的覆盖。
