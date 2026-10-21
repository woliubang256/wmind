# 界面验收脚本

这里放的是**必须进浏览器才能验**的判据：`role` / `aria-*` 有没有被浏览器接受、
点完之后 DOM 到底变成什么样、2000 个节点拖起来卡不卡。单测（`vitest`）管不到这些，
所以单独一套。

数据准备一律走 REST，断言一律读 DOM。

## 前置条件

| 需要什么 | 默认值 | 覆盖方式 |
| --- | --- | --- |
| 后端 | `http://127.0.0.1:8080` | `API=...` |
| 前端（dev 或 preview） | `http://127.0.0.1:5199` | `BASE=...` |
| Chromium 可执行文件 | Playwright 缓存里的 `chromium-1228` | `PLAYWRIGHT_CHROMIUM=...` |
| 管理员账号（注册被限流时建号用） | `admin@example.test` | `ADMIN_EMAIL` / `ADMIN_PASSWORD` |
| SQLite 库文件（只有分享那套要直接改库造过期态） | `/tmp/wmind-share.db` | `WMIND_SQLITE_PATH=...` |

起后端：

```bash
cd backend
WMIND_ADDR=127.0.0.1:8080 \
WMIND_SQLITE_PATH=/tmp/wmind-share.db \
WMIND_JWT_SECRET=dev-secret-dev-secret-dev-secret-32 \
WMIND_ADMIN_EMAIL=admin@example.test \
WMIND_ADMIN_PASSWORD=share-admin-password \
go run ./cmd/server
```

起前端：

```bash
cd frontend
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5199
```

dev 就够——六套脚本断言的是 DOM 结构和渲染**数量**，不是耗时。只有量性能时才
必须换生产构建，见下面「几处不显然的地方」。

### `playwright-core` 没写进 `package.json`

本机的 pnpm store 是坏的（`pnpm add` 会在 `node_modules/.ignored` 那步失败），
所以这个依赖**没能入库**。要跑这套脚本，先装一次：

```bash
cd frontend && pnpm add -D playwright-core@1.63.0
```

或者临时把已有的那份挂进来（不提交，`node_modules/` 在 `.gitignore` 里）：

```bash
ln -s /path/to/playwright-core frontend/node_modules/playwright-core
```

`playwright-core` 不自带浏览器。本机用的是缓存里的
`~/Library/Caches/ms-playwright/chromium-1228/...`，换机器要么 `playwright install chromium`，
要么用 `PLAYWRIGHT_CHROMIUM` 指到自己的 Chrome。

## 怎么跑

```bash
cd frontend

node e2e/run-all.mjs             # 八套全跑
node e2e/run-all.mjs a11y share  # 只跑指定的
node e2e/a11y.mjs                # 单跑一套（输出最完整）
```

`run-all.mjs` 会先探一次后端和前端的健康，连不上就直接报「先把服务起起来」，
不让八套脚本各超时一遍。每套脚本是**独立子进程**——一套崩了不影响其余七套。

## 八套分别验什么

| 脚本 | 条数 | 判据 |
| --- | --- | --- |
| `share.mjs` | 24 | 分享全流程：创建/复制链接、密码与申请授权、撤销、过期、备注不外泄、`allow_download` 控制导出入口、站点开关关闭后历史链接立即失效 |
| `templates.mjs` | 27 | 8 个内置模板各建一次图且结构对得上、模板预览是真渲染、我的模板增删改、站点开关关闭后的三处表现 |
| `canvas.mjs` | 25 | 多画布新建/切换/持久化、大纲与画布双向同步、`Ctrl+]` 降级、折叠隐藏后代、ZEN 模式进出 |
| `a11y.mjs` | 23 | 画布是不是一棵可读的树（`role=tree` / `treeitem` / `aria-level` / `aria-expanded`）、方向键后 `aria-activedescendant` 换人、播报文案、只读预览降级成一个 `img`、两个键盘陷阱 |
| `export.mjs` | 24 | 六种格式都在、PDF 能下且结构合法（`%PDF` / `DCTDecode` / `MediaBox` 与页脚毫米对得上 / `startxref` 指对）、SVG 分支没被带坏、切英文后导航与导出对话框整块无中文、刷新后语言保持、**站点关掉导出后编辑器不再有「导出」按钮** |
| `register.mjs` | 11 | 关闭注册后登录页没有入口、`/register` 拿不到表单、接口返回 403 `REGISTRATION_CLOSED` 而不是 429、关站期间连打 5 次不退化、重开后不再返回 `REGISTRATION_CLOSED` |
| `culling.mjs` | 6 | 2001 个节点时只渲染视口附近、放大后是子集、缩回来不丢、选中节点离开视口仍渲染 |
| `errors.mjs` | 3 | 断网提示条出现与消失、首帧就离线时也带提示条 |

合计 143 条。

## 几处不显然的地方

**`errors.mjs --crash` 要手工注入。** 崩溃兜底页只在渲染期抛错时出现，从外部
触发不了。做法是在 `RecentPage` 第一行加一句 `throw new Error('injected-for-acceptance')`
（**消息必须一字不差**，脚本按这个字符串断言兜底页与控制台都带上了原始消息），
跑 `node e2e/errors.mjs --crash`，跑完 `git checkout -- src/features/maps/recent-page.tsx`。
注入的那一行不在任何提交里。

**`share.mjs` 直接用 `sqlite3` 改库。** 「链接过期」没法从接口造（服务端不给改
`expires_at` 的入口），只能把那一行的年份改到 2000。所以它认 `WMIND_SQLITE_PATH`，
换 PostgreSQL 部署时这一条跑不了。

**性能数字必须来自生产构建。** dev 模式是双渲染 + 不压缩，同一段操作 dev 量到
53ms、生产构建只有 22.6ms——拿 dev 的数字做优化决策会优化错地方。注意
`vite preview` **不套用** `server.proxy`，所以量性能时要自己起一个带 `/api`
反代的静态服务器，否则接口全 404。本仓库的六套脚本不涉及计时，可以跑 dev。

**`register.mjs` 与 `export.mjs` 会改站点设置，跑完自己恢复。** 前者用管理员账号把
`auth.registration_enabled` 关掉、验完再打开；后者把 `feature.export_enabled` 关掉，
验「编辑器里的导出按钮消失」，再打开。两处 `finally` 都无条件恢复：这套脚本被别的
套件跟在后面跑，留一个「已关站」或「已关导出」的实例会让别人的用例全部失败。

`export.mjs` 里那两条还多一个坑：**不能用 `reload()` 验开关效果**。站点配置在
前端有 5 分钟 `staleTime`，刷新后拿到的仍是旧的那份。要开一个**新页面**（同一个
context，Cookie 还在，但 React Query 缓存是新的）。

**`culling.mjs` 自己造压测文档。** 2001 个节点（40 个分支 × 50 个叶子 + 根）走
`POST /maps` 现造，不再依赖手工灌库的固定 uid——那样换台机器就跑不了。
