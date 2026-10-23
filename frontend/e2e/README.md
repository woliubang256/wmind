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

dev 就够——二十套脚本断言的是 DOM 结构和渲染**数量**，不是耗时。只有量性能时才
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

node e2e/run-all.mjs             # 二十套全跑
node e2e/run-all.mjs a11y share  # 只跑指定的
node e2e/a11y.mjs                # 单跑一套（输出最完整）
```

`run-all.mjs` 会先探一次后端和前端的健康，连不上就直接报「先把服务起起来」，
不让二十套脚本各超时一遍。每套脚本是**独立子进程**——一套崩了不影响其余套件。

## 二十三套分别验什么

| 脚本 | 条数 | 判据 |
| --- | --- | --- |
| `share.mjs` | 24 | 分享全流程：创建/复制链接、密码与申请授权、撤销、过期、备注不外泄、`allow_download` 控制导出入口、站点开关关闭后历史链接立即失效 |
| `editor-appearance.mjs` | 24 | 实际字号与字重、深浅主题、全画布形状、局部样式保留、撤销、新增与折叠后代、画布隔离、20 主分支分散端点、圆角分叉、预览/SVG 一致、保存刷新 |
| `zoom-presets.mjs` | 16 | 六档快捷比例、向上弹出、画布中心不漂移、当前勾选、任意比例、键盘和关闭、只读预览、大纲禁用、窄屏 |
| `avatars.mjs` | 13 | 首字符与稳定配色、中文昵称、Gravatar、无 Referer、手动上传优先和刷新保留、失败逐级回退、设置页与管理列表一致 |
| `user-menu.mjs` | 22 | 四项入口分组、管理员/普通用户权限、当前页高亮、键盘和关闭、320/375/768px 顶栏与菜单、移动抽屉、中英文和深色 |
| `palettes.mjs` | 35 | 黎明默认主题、缤纷/经典分类与键盘、19 套逐一应用及指纹、浅色连线、七色主题、保存刷新、撤销重做、旧图保留、中英文及窄屏 |
| `two-factor.mjs` | 8 | 验证器绑定、两步登录、恢复码登录、重新生成恢复码、关闭验证、中英文与手机布局 |
| `login-encryption.mjs` | 9 | 真实浏览器密文请求、既有账号会话、重放拒绝、明文拒绝、错密重试新挑战、Web Crypto 缺失与无效公钥无明文回退 |
| `annotation-delete.mjs` | 11 | 联系与边界的画布选中、Delete/Backspace、控制柄焦点、Esc、工具栏删除、撤销重做及切换清理 |
| `templates.mjs` | 27 | 8 个内置模板各建一次图且结构对得上、模板预览是真渲染、我的模板增删改、站点开关关闭后的三处表现 |
| `canvas.mjs` | 25 | 多画布新建/切换/持久化、大纲与画布双向同步、`Ctrl+]` 降级、折叠隐藏后代、ZEN 模式进出 |
| `a11y.mjs` | 23 | 画布是不是一棵可读的树（`role=tree` / `treeitem` / `aria-level` / `aria-expanded`）、方向键后 `aria-activedescendant` 换人、播报文案、只读预览降级成一个 `img`、两个键盘陷阱 |
| `annotations.mjs` | 30 | 概要跨父级完整选区、左右方向、避让和重复创建；联系双击线条/文字、F2、输入法、提交取消、颜色线宽线型、四种箭头、撤销重做、刷新持久化和只读预览；边界新增改名删除 |
| `toolbar.mjs` | 12 | 纯图标入口与分组、菜单图标、结构键盘切换与提示、侧栏开关、375/1440px 布局、悬停/聚焦提示、禁用原因、独立同级/子级与撤销 |
| `drag-return.mjs` | 10 | 拖远后回到原主题及附近、反复离开/回归、缩放与多选锚点、父级顺序子树和选区保持、既有移动/非法后代/脱离、撤销不占位 |
| `relationship-routing.mjs` | 9 | 控制柄拖动、Esc 取消、一次撤销重做、键盘微调、保存重开、恢复自动、折线路由、预览 |
| `insert-content.mjs` | 30 | 无选区/单选/多选、主行与标签几何、HTML 备注查看编辑、内容浮层与键盘返回、待办撤销重做、标题编辑框、预览只读、链接跳转与文件下载、图片素材公式、刷新与 SVG/PNG 导出 |
| `summary-endpoints.mjs` | 12 | 完整子树与嵌套圆弧括号、概要直接选中、概要到主题/概要连线、控制柄、概要和范围主题删除清理、一次撤销、双击改名、刷新 |
| `markers.mjs` | 9 | 已有标记渲染、42 图标分组替换、多选统一应用/取消、窄主题排版和编辑框、持久化、清空撤销重做、预览 |
| `export.mjs` | 31 | 七种格式都在、PDF 能下且结构合法（`%PDF` / `DCTDecode` / `MediaBox` 与页脚毫米对得上 / `startxref` 指对）、SVG 分支没被带坏、**品牌落款预填站点设置且改过的值真的进了文件**、**XMind 下下来是 zip 且 `content.json` 里真有节点标题**、切英文后导航与导出对话框整块无中文、刷新后语言保持、**站点关掉导出后编辑器不再有「导出」按钮** |
| `register.mjs` | 11 | 关闭注册后登录页没有入口、`/register` 拿不到表单、接口返回 403 `REGISTRATION_CLOSED` 而不是 429、关站期间连打 5 次不退化、重开后不再返回 `REGISTRATION_CLOSED` |
| `locale.mjs` | 24 | 登录/注册/关站页语言入口、右上角位置、首个 Tab、文案翻译、存储及键盘；登录后顶栏和编辑器即时切换、刷新保持、320/375/768/1280px 控件可见、导图内容保持和跟随浏览器 |
| `culling.mjs` | 6 | 2001 个节点时只渲染视口附近、放大后是子集、缩回来不丢、选中节点离开视口仍渲染 |
| `errors.mjs` | 3 | 断网提示条出现与消失、首帧就离线时也带提示条 |

合计 415 条。

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
反代的静态服务器，否则接口全 404。本仓库的二十套脚本不涉及计时，可以跑 dev。

**`register.mjs`、`locale.mjs` 与 `export.mjs` 会改站点设置，跑完自己恢复。**
前者用管理员账号把 `auth.registration_enabled` 关掉、验完再打开；`locale.mjs`
为了验「关站提示页也得有语言切换」也会关一次；`export.mjs` 把
`feature.export_enabled` 关掉，验「编辑器里的导出按钮消失」，再打开。三处
`finally` 都无条件恢复：这套脚本被别的套件跟在后面跑，留一个「已关站」或
「已关导出」的实例会让别人的用例全部失败。

`export.mjs` 里那两条还多一个坑：**不能用 `reload()` 验开关效果**。站点配置在
前端有 5 分钟 `staleTime`，刷新后拿到的仍是旧的那份。要开一个**新页面**（同一个
context，Cookie 还在，但 React Query 缓存是新的）。

**登录会被限流，`login()` 自己会等。** 登录限流按「IP + 账号」分桶，5 次/分钟
（`NewRateLimiter(5, time.Minute, 5)`）。二十套脚本一轮下来管理员账号要登七八次，
正好压在边界上——所以 `lib/harness.mjs` 的 `login()` 撞到 429 时会按服务端给的
`retryAfter` 等一等再试（最多两次）。**限流不是被测对象**，不该让脚本因为跑得勤
而红；不加这一步的话，连跑两轮必然有一套挂在 429 上，报错还长得像「登录坏了」。

**注册是 3 次/小时，所以管理员建号是必经之路，不是兜底。** 二十套脚本各建一个
独立账号，第四套开始必然撞 429，全部改走 `POST /admin/users`。这条路的凭据由
`lib/harness.mjs` 从 `backend/.env` 读（`WMIND_ADMIN_EMAIL` / `WMIND_ADMIN_PASSWORD`），
也可以用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 环境变量覆盖。写死的默认值只是最后的
兜底——**它和本机 `.env` 对不上时的表现是 401**，从 `ensureUser` 里抛出来长得像
「账号密码错了」，完全看不出其实是管理员种子换过了。所以那里特意包了一层，
把「注册被限流 → 管理员登录失败」和真实的账号错误区分开。

**点画布不能用 `page.locator('svg').first()`。** 导航搬到顶栏之后，页面上第一个
`<svg>` 是顶栏 logo，点它等于点了「回首页」的链接，后面等节点必然 30s 超时。
画布要点名 `svg[data-read-only="false"]`。

**`culling.mjs` 自己造压测文档。** 2001 个节点（40 个分支 × 50 个叶子 + 根）走
`POST /maps` 现造，不再依赖手工灌库的固定 uid——那样换台机器就跑不了。

**下拉 / 复选 / 单选不是原生元素，Playwright 那三个便利 API 全用不了。** 自绘之后：

| 原来怎么写 | 现在怎么写 |
| --- | --- |
| `select.selectOption('2')` | 点 `role=combobox` 触发器 → 等 `role=listbox` 出现 → 点 `role=option` → 等弹层卸载 |
| `radio.check()` / `uncheck()` | `.click()`（没有 `input`，`check()` 会直接抛错） |
| `select.inputValue()` | `getAttribute('data-value')`（触发器上挂着当前值） |

读可见文字来判断选中态在导出对话框里会翻车：选项文字会被翻译、会被 `truncate`
截断，所以一律读 `data-value`。

**`getByLabel` 是子串匹配。** `getByLabel('边框')` 在导出对话框里能匹配到 8 个
（编辑器面板的「边框宽度」「边框颜色」也算），改成 `getByRole('combobox', { name: '边框', exact: true })`。
`<label>` 包着自绘下拉时，可访问名会变成「标签文字 + 当前值」拼在一起，
所以这几个控件的可访问名都显式写在 `aria-label` 上。

## 后台备份与恢复

`backup.mjs` 会恢复整个数据库与上传目录，只能指向新建的隔离后端。它启动本地 WebDAV，验证 Cron 双向编辑、凭据脱敏、S3 条件表单、窄屏、中英文、真实 ZIP 上传、手动覆盖恢复与会话失效。该脚本不加入默认全量套件；显式运行：

```sh
WMIND_BACKUP_E2E_ISOLATED=1 BASE=http://127.0.0.1:5299 API=http://127.0.0.1:8099 \
ADMIN_EMAIL=backup-admin@example.test ADMIN_PASSWORD=backup-e2e-admin-password \
node e2e/backup.mjs
```

截图保存到 `/tmp/wmind-backup-desktop.png` 与 `/tmp/wmind-backup-mobile.png`。后端必须使用独立 SQLite 路径、上传目录及测试加密密钥，不能使用日常开发数据。
