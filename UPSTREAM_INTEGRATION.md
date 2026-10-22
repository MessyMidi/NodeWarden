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

计划单独引入 WebSocket 一次性连接票据、账户密码验证兼容性、金库完整更新和并发保护，
并运行上游新增的离线安全回归。该阶段不与样式迁移或依赖批量更新混为一个审查范围。

## 阶段 3：其余依赖、界面、语言与发布资料

计划更新其余上游依赖、备份列表自适应布局、重复组标识、繁体中文术语和 1.8.1 发布资料。
Wrangler / Miniflare / Workers 类型必须按实际 peer 约束一并验证；不照抄与本地安全修复冲突的覆盖。
