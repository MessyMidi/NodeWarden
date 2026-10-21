# 依赖安全审计（2026-10-21）

## 范围与结论

基线为 `8ca838a66997c97e90e9cfb059bbea5e12d2f3b6`（PR #1 合并结果），参考
[原始安全扫描](https://github.com/MessyMidi/NodeWarden/actions/runs/39541546936)。
检查了源码引用、npm 锁文件、上游 npm 元数据、OSV 公告、构建产物和本地模拟运行。
没有重复域名规则兼容性分析，没有调用生产 Cloudflare API、部署 Worker 或访问线上数据。

原 OSV 报告的 10 个受影响包实例、25 项发现全部来自开发依赖：Browserslist 有两个版本，
同一公告因此被重复计数；这不是 25 个独立生产漏洞。当前未发现这些公告涉及的库进入 Worker
生产运行路径。`npm audit --omit=dev` 无已知告警，但这不代表完成了整个密码管理器的安全审计。

开发依赖仍需修复：本地开发服务会处理 HTTP 请求，CLI 会连接上游，构建器会解析源文件，
恶意图片解码甚至可能影响 Linux 构建机。不能仅凭 `dev: true` 判定没有风险。

## 风险与修复

所有版本均以本 PR 的 `package-lock.json` 为准；没有使用 `npm audit fix --force`。

| 依赖与路径 | 锁文件变化 | 触发条件与实际影响 |
| --- | --- | --- |
| Babel / Autoprefixer → Browserslist → baseline-browser-mapping | `2.10.40` → `2.11.30` | 非法参数会直接终止 Node 进程。本仓库通过构建配置调用，未向线上用户提供参数入口。修复开发/构建 DoS。 |
| Babel / Autoprefixer → Browserslist | `4.28.1`、`4.28.4` → `4.29.4` | 大量外部查询可无限扩充缓存；恶意 `browserslist-stats.json` 可使构建崩溃或修改结果对象原型。后者可由提交到仓库的文件触发，属于真实 CI 输入风险。 |
| PostCSS → nanoid | `3.3.17` → `3.3.20` | `customAlphabet` / `customRandom` 接收大小 0 时可能死循环。当前 PostCSS 调用未发现来自用户的大小参数；不是 NodeWarden 密钥/令牌生成器。 |
| PostCSS → source-map-js | `1.2.1` → `1.2.2` | 恶意 indexed source map 的 section offset 可阻塞事件循环；涉及构建过程中的源映射，不是金库数据读取。 |
| Tailwind / postcss-nested → postcss-selector-parser | `6.1.2` → `6.1.5` | 修复 AST 序列化递归问题；平坦超长选择器的二次复杂度问题仍保留，见下文。 |
| Wrangler → Miniflare → sharp | `0.35.0` → `0.35.5` | libheif / librsvg 的恶意图像在特定 glibc Linux / Node 条件下可能导致代码执行。NodeWarden 没有 Images binding，也没有导入 sharp；网站图标代理使用 Worker 原生 fetch，并非本地 sharp。风险在使用该图像适配器的开发/CI 工具进程，不是已部署 Worker。 |
| Wrangler → Miniflare → undici | 强制的 `8.9.0` → `7.30.1` | WebSocket 服务器、异常响应，以及启用缓存/重试/解压/dump/BalancedPool 等特定 API 时，可触发崩溃、Cookie 重放/泄露、响应截断或 TLS 自定义校验丢失。Miniflare 用它进行本地 HTTP 桥接；未发现其使用公告涉及的 interceptor、BalancedPool、WebSocketStream。Worker 原生 fetch 不会使用此 npm undici。 |
| Vite | `8.1.3` → `8.1.6` | 内嵌 launch-editor 在 Windows / WSL 特定文件名、环境变量及编辑器组合下存在命令执行风险，其中一项可绕过文件存在性检查。影响开发服务的打开编辑器入口；普通静态构建不会把该服务器入口发布给用户。 |

### override 与兼容性选择

- 删除阻止补丁的 nanoid、undici、sharp 全局旧版本固定。nanoid、Browserslist、source-map-js、
  selector parser 按调用方现有 semver 范围正常更新锁文件。
- 删除无上界的 `@babel/core >=7.29.6` override：它把要求 `7.x` 的 Preact 插件解析到了 Babel 8。
  恢复上游 peer 约束后安装 Babel `7.29.7`，`npm ls --all` 没有无效 peer。
- 删除全局 esbuild/ws override，交还调用方的正常约束；最终 esbuild `0.28.1`、ws `8.21.0`。
- Wrangler 更新并固定到 `4.107.1`，匹配 Miniflare `4.20260702.0` 和 Workers 类型
  `4.20260702.1`。当前最新 Wrangler `4.151.3` 引入 Miniflare `5.20261019.1-beta`；
  `4.108.0` 起还要求 Workers 类型主版本 5。为避免扩大本次迁移范围，没有直接更新到 latest。
  `4.116.0` 的候选安装因类型 peer 不兼容被拒绝后放弃，未使用 force/legacy-peer-deps。
- Miniflare 4 上游仍精确要求 undici `7.28.0`、sharp `0.34.5`，无法仅靠锁文件更新修复。
  仅在 `miniflare` 下覆盖为 undici `^7.29.1`、sharp `^0.35.5`。
  undici 回到调用方支持的 7 主版本；sharp 保留原仓库已经采用的 0.35 分支并升补丁。
  sharp 相对于 Miniflare 原始要求仍跨 0.x 次版本，所以额外实测其 Images 适配器。
- Vite 限制为 `~8.1.6`，没有顺带迁移到 8.3；Tailwind 保留 3.4.19。
- 正式 dependencies 声明未变，锁文件中已有生产依赖的版本没有变化。没有改动密码、加密、数据库
  schema、存储配置、Worker compatibility date 或业务逻辑。

## 公告清单

以下是基线的 23 个独立 GHSA（Browserslist 的两个重复实例使 OSV 计数变成 25）。
每个编号均链接原始公告，便于核对具体前提；**保留**的两项没有被忽略或压低严重等级。

| 依赖 | 公告 | 状态 |
| --- | --- | --- |
| baseline-browser-mapping | [GHSA-w5vr-8v7q-w6rv](https://osv.dev/GHSA-w5vr-8v7q-w6rv) | 已修复 |
| browserslist | [GHSA-73wf-gq98-2v4g](https://osv.dev/GHSA-73wf-gq98-2v4g)、[GHSA-c83g-rgw3-j3cx](https://osv.dev/GHSA-c83g-rgw3-j3cx) | 已修复 |
| nanoid | [GHSA-2v37-7h3g-55p8](https://osv.dev/GHSA-2v37-7h3g-55p8) | 已修复 |
| postcss-selector-parser | [GHSA-w9m9-85wc-3x92](https://osv.dev/GHSA-w9m9-85wc-3x92) | 已修复 |
| sharp | [GHSA-rgj7-g3m4-5g8c](https://osv.dev/GHSA-rgj7-g3m4-5g8c)、[GHSA-wq5f-xc86-pv6w](https://osv.dev/GHSA-wq5f-xc86-pv6w) | 已修复 |
| source-map-js | [GHSA-68fv-2mgg-jv7q](https://osv.dev/GHSA-68fv-2mgg-jv7q) | 已修复 |
| undici：压缩 WebSocket 错误 | [GHSA-3wwx-pv8p-q78v](https://osv.dev/GHSA-3wwx-pv8p-q78v) | 已修复 |
| undici：重试响应未释放 | [GHSA-pmjh-fq2x-6v4x](https://osv.dev/GHSA-pmjh-fq2x-6v4x) | 已修复 |
| undici：重试后响应拆分 | [GHSA-r53p-7pc4-xj5r](https://osv.dev/GHSA-r53p-7pc4-xj5r) | 已修复 |
| undici：未请求的 WebSocket 子协议 | [GHSA-rfgv-xxqx-mfg5](https://osv.dev/GHSA-rfgv-xxqx-mfg5) | 已修复 |
| undici：解压后体积无界 | [GHSA-3xpg-4rpp-hhhm](https://osv.dev/GHSA-3xpg-4rpp-hhhm) | 已修复 |
| undici：共享缓存重放 Set-Cookie | [GHSA-2jfj-6hjv-fm6j](https://osv.dev/GHSA-2jfj-6hjv-fm6j) | 已修复 |
| undici：dump 截断响应 | [GHSA-2gqq-gqf2-x968](https://osv.dev/GHSA-2gqq-gqf2-x968) | 已修复 |
| undici：BalancedPool 丢弃 TLS 函数 | [GHSA-w293-vg96-wgc3](https://osv.dev/GHSA-w293-vg96-wgc3) | 已修复 |
| undici：缓存不安全 HTTP 方法 | [GHSA-8436-99hf-9mmv](https://osv.dev/GHSA-8436-99hf-9mmv) | 已修复 |
| undici：WebSocketStream 异常关闭 | [GHSA-rx4f-c7p8-82vq](https://osv.dev/GHSA-rx4f-c7p8-82vq) | 已修复 |
| vite / launch-editor | [GHSA-698v-4r3x-3vcv](https://osv.dev/GHSA-698v-4r3x-3vcv)、[GHSA-r825-w8mm-5pxw](https://osv.dev/GHSA-r825-w8mm-5pxw)、[GHSA-587h-7wmj-h5pm](https://osv.dev/GHSA-587h-7wmj-h5pm) | 已修复 |
| braces | [GHSA-vfj7-8cjw-p6xm](https://osv.dev/GHSA-vfj7-8cjw-p6xm) / CVE-2026-93687 | **保留** |
| postcss-selector-parser | [GHSA-rj75-hqrm-r3gf](https://osv.dev/GHSA-rj75-hqrm-r3gf) / CVE-2026-104844 | **保留** |

### 剩余风险与后续建议

1. **braces 3.0.3，GHSA-vfj7-8cjw-p6xm**：深层嵌套的花括号模式导致递归栈耗尽。
   当前没有已发布的修复版本。来自 Tailwind → chokidar，以及 Tailwind / fast-glob → micromatch。
   本项目的 glob 模式由仓库 `tailwind.config.js` 控制，线上请求、密码和金库内容不会传给它。
   恶意改动构建配置仍可使开发/CI 构建崩溃，因此剩余影响是开发与 CI 可用性。
   跟踪 braces 补丁及 Tailwind 后续依赖更新，不要把用户提供的 glob 接入构建服务。
2. **postcss-selector-parser 6.1.5，GHSA-rj75-hqrm-r3gf**：反复 `.a` / `#a` 的平坦超长选择器
   会触发 O(n²) 解析。修复版本是 7.1.6，但 Tailwind 3 要求 `^6.1.2`，postcss-nested 6
   要求 `^6.1.1`，不能当作兼容补丁强塞 7.x。项目只在构建时解析仓库样式，不提供用户 CSS
   解析服务；恶意源码可拖慢 CI，未发现生产运行路径。跟踪 6.x 回补，或在单独 PR 中迁移
   Tailwind 4 并做页面、主题和样式回归。此次没有冒险跨主版本消除数字。

完整 `npm audit` 退出码为 **1**，报告 7 个受影响依赖节点（5 high、2 moderate）。
这些是上述两个根本问题及 chokidar、micromatch、fast-glob、postcss-nested、Tailwind 的传递归因，
不是又增加了 7 个独立漏洞。不能把该结果描述成“审计全绿”。

## GitHub Actions

- 将 `pnpm audit` 替换成 npm 锁文件校验与 `npm audit`，包含开发依赖、全部严重等级。
  不存在/不同步的锁文件、registry 故障、安装失败或漏洞都会使任务失败。
  安全审计 job 使用 `npm ci --ignore-scripts`，避免只为审计执行依赖安装脚本。
- 保留 OSV 的原有可复用工作流、扫描范围、SARIF 上传和 `fail-on-vuln: true`。
- 原 Semgrep 步骤还存在 `|| true` 和伪造空 SARIF 的成功路径；移除这两个路径，添加 `--error`。
  有发现或扫描器错误时如实失败，有实际 SARIF 时失败后仍打印发现摘要并上传。没有删除扫描或加入全局忽略。
- 新增 Dependency Compatibility，在 Node 24 / Linux 上运行安装、现有回归、Worker 类型检查、
  demo 构建、R2/KV dry-run、Miniflare 实测及产物隔离检查；不使用 Cloudflare 凭证。
  默认前端构建由两次 dry-run 的原有 build hook 执行。

## 已执行验证

本地环境：Windows，Node `24.15.0`，npm `11.12.1`。安装首次因连接重置失败，重试成功；
最终候选 `npm ci` 成功。下列失败项没有伪装成通过。

| 检查 | 结果 |
| --- | --- |
| `npm ci` | 成功，包含原生可选依赖安装脚本 |
| `npm ls --all` | 成功，没有 peer / invalid 依赖 |
| `npm audit` | 退出 1，保留上述两个根本漏洞、7 个传递影响节点 |
| `npm audit --omit=dev` | 退出 0，0 告警 |
| `npm run build`、`npm run build:demo` | 均通过 |
| `test:config-compatibility` / `test:web-crypto` / `test:webauthn-connectors` | 全部通过，共 26 项测试；基线同样通过 |
| `npm run i18n:validate` | 10 种语言通过 |
| 三个已有 `scripts/security-audit-*.mjs`，通过 `node --import tsx` 执行 | 均通过：备份地址、恢复时排除认证状态、API key 查看/轮换 |
| `tsc --noEmit`（Worker） | 通过，基线同样通过 |
| `tsc --noEmit -p webapp/tsconfig.json` | **失败**；修改前和修改后同样是下面 3 处原有错误 |
| Wrangler R2 和 KV 配置 `deploy --dry-run` | 均通过；没有部署 |
| 真实打包 Worker 在隔离 Miniflare 中运行 | 两种配置均通过：配置/版本接口、401 拦截、预登录、本地 D1 初始化、R2/KV 读写、两个 DO 启动 |
| Miniflare Images → sharp | SVG 转 2×2 PNG，通过；只是工具兼容性测试，不是给生产 Worker 添加 Images |
| Worker metafile | 每种配置检查 357 个输入，未包含所审计的开发工具 |
| 前端输出模块列表 | 通过临时 Vite 插件检查 289 个模块，未包含所审计的开发工具 |
| CSS 内容对比 | 修改前后 SHA-256 相同：`ea087c9ccc705b5822a4768528fceafc7b3625e6e9a041652be4a638ebfa0664` |

原有前端类型错误：

- `webapp/src/lib/api/backup.ts:252`：`Uint8Array<ArrayBufferLike>` 与 `Uint8Array<ArrayBuffer>` 不匹配。
- `webapp/src/lib/backup-center.ts:190`：缺少 `PersistedRemoteBrowserState.refreshedAt`。
- `webapp/src/lib/password-security-cache.ts:45`：`PasswordSecurityState` 上不存在 `controller`。

本次未修改这些无关业务实现。没有用真实账号进行浏览器端完整登录/解锁/同步/附件/备份恢复端到端测试，
也没有做生产冒烟；本地测试不能替代这些检查。

### 工具链测试复现（无需 Cloudflare 凭证）

```sh
npm ci
npx --no-install wrangler deploy --dry-run -c wrangler.toml --outdir build/dependency-audit/bundle-r2 --metafile build/dependency-audit/bundle-r2.json
npx --no-install wrangler deploy --dry-run -c wrangler.kv.toml --outdir build/dependency-audit/bundle-kv --metafile build/dependency-audit/bundle-kv.json
npm run test:dependency-toolchain
npm audit
npm audit --omit=dev
```

## 合并前

### GitHub 实测记录

- [OSV / npm 等安全扫描](https://github.com/MessyMidi/NodeWarden/actions/runs/39581562823)：
  OSV 从基线 25 项降为 **2 项**（braces 和 selector parser），即消除 23 项原始发现
  （21 个独立公告，含重复版本计数）。npm 锁文件安装成功，audit 如预期因剩余项失败。
- [Linux Dependency Compatibility](https://github.com/MessyMidi/NodeWarden/actions/runs/39581570533)：
  **全部通过**，包括 npm ci、26 项回归、Worker 类型检查、demo、两种 dry-run、Miniflare
  本地运行、glibc Linux 上的 sharp 图片转换和两份 357 输入的产物检查。
- actionlint、zizmor、Gitleaks 通过。Semgrep 成功执行扫描并发现 **12 项**源码提示，因移除
  吞错逻辑而如实失败；这不是本次依赖升级新产生的 12 个依赖漏洞。补充日志摘要以便逐项核对。

- 查看本 PR 最新提交的 GitHub 扫描日志，确认只有已解释的依赖剩余项；新的 Semgrep 失败也需要
  看实际日志，不能通过恢复吞错来变绿。若分支保护要求所有安全检查绿色，本 PR 不会绕过它。
- 优先等待 Dependency Compatibility 的 Linux 结果，以覆盖 sharp 公告涉及的 glibc 平台。
- 如有隔离测试账号/测试部署，建议人工确认登录、金库解锁、同步、附件及备份流程。
  此 PR 没有部署或安排自动合并，也没有修改任何线上数据。
