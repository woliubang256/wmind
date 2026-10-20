# Agent Note: 界面验收脚本入库（六套 108 条）

Status: implemented

## Problem

M5/M6 的验收里有一批判据**只能在浏览器里验**：`role="tree"` 到底有没有被浏览器
接受、方向键之后 `aria-activedescendant` 有没有换人、2000 个节点时是不是只渲染
了视口附近、点完「创建链接」之后剪贴板旁边那串 URL 长得对不对。单测覆盖不到，
`vitest` 里没有 DOM 的语义树，也没有真实的布局与滚动。

这些脚本此前散在 `/tmp/wmind-accept/` 下，是六份各自演化的独立文件。当时的代价
已经具体到可以点名：

- **骨架抄了六份**，`check` 出现了三种签名（有的返回 `pass`，有的不返回），
  `waitForCanvas` 出现两种判据（等 `g.wmind-topic` / 等 `svg text`），换个页面
  就有一半脚本超时。
- **建号逻辑抄了六份**，其中两份没有 429 兜底。注册限流是 3 次/小时/IP，连着跑
  两轮就红——红的原因跟被测功能毫无关系。
- **`culling.mjs` 写死了 `/maps/stress`**，那个 uid 是某次手工灌库灌进去的，换台
  机器直接 404。
- **`/tmp` 会被清掉**。脚本一旦消失，那 108 条判据就只剩文档里的一句「已验收」。

## Decision

### 收进 `frontend/e2e/`，骨架抽成 `lib/harness.mjs`

六个脚本只留自己的断言，公共部分（地址、计数、REST、建号、登录、等画布、点节点、
启动浏览器）收进一份 `lib/harness.mjs`。三处签名统一：

- `check` 一律返回 `pass`（不返回的写法让人误以为能 `if (!check(...))`）；
- `api` 一律支持 `raw` + `headers`（原先只有两份支持，另四份想验「该被拒」时只能
  靠 try/catch 抓异常，抓不到状态码）；
- `waitForCanvas` 两个判据都认（`g.wmind-topic` 或 `svg text`）。

`newPage(browser, { context, errors })` 收掉「开页 + 挂 pageerror」这四行。传
`errors` 就复用同一个数组——分享那套要开五个匿名上下文，异常必须汇总到一处判。

### `run-all.mjs` 用子进程，不用 import

`results` / `check` / `summary` 是模块级单例，同进程 import 六份会串台。子进程还
顺带解决了另一件事：**一套崩了不影响其余五套**。跑之前先探一次后端与前端的健康，
连不上就报「先把服务起起来」——否则六套脚本各超时一遍，要等五分钟才知道环境没
起来。

### `culling.mjs` 自己造压测文档

2001 个节点（40 个分支 × 50 个叶子 + 根）走 `POST /maps` 现造。节点数、包围盒、
`MIN_ZOOM` 下限都和原来那个手工灌库的文档一致，实测渲染数一模一样（197/2001）。
这条改动把一个「只在写它的那台机器上能跑」的脚本变成了可复现的。

### `errors.mjs --crash` 保留手工注入

崩溃兜底页只在渲染期抛错时出现，从外部触发不了。做法仍是把 `RecentPage` 改成一
进函数就 `throw`，跑完 `git checkout` 回来。**没有**为了自动化去给产品加一个
「测试模式」开关——那种开关本身就是一条要维护的代码路径。

### `playwright-core` 没能入库

本机的 pnpm store 是坏的：`pnpm add -D playwright-core` 会在
`node_modules/.ignored` 那一步 `ENOENT`，`--lockfile-only` 也倒在同一个符号链接
上。试了两次，`node_modules` 与 `package.json` 都没有被改坏（`tsc --noEmit`
仍通过，`git status` 干净），但依赖就是加不进去。

所以 `README.md` 里写清了「先 `pnpm add -D playwright-core`」这一步，并给了
「把已有的那份 `ln -s` 进 `node_modules`」的临时办法（`node_modules/` 在
`.gitignore` 里，不会误提交）。**这是一处真实的欠账**：干净环境 checkout 之后
`npm run e2e` 会因为找不到模块而失败，得先补一次安装。

## Consequences

- 六套 108 条（分享 24 / 模板 27 / 多画布 25 / 无障碍 23 / 裁剪 6 / 错误 3），
  全部实跑通过，串行耗时 88 秒。
- **不进 CI**。这套需要后端 + 前端 + 一个真实数据库，还要一个能跑 Chromium 的
  环境；现在的 CI 只跑单测与构建。要不要把它接进 CI 是另一个决定（见下）。
- **`share.mjs` 直连 `sqlite3`**：「链接过期」没有接口可造，只能改 `expires_at`
  的年份。它认 `WMIND_SQLITE_PATH`，PostgreSQL 部署下这一条跑不了。
- **dev 服务器就够跑这六套**（断言的是结构与渲染数量，不是耗时）。要量性能必须
  换生产构建，且 `vite preview` 不套用 `server.proxy`，得自己起带反代的静态服务。
- `run-all.mjs` 的汇总行不 `padEnd`：标签是中英混排，按字符数补空格只会越补越歪。

## Alternatives considered

- **引 `@playwright/test`**：它自带 fixtures、trace、并行、HTML 报告，是这类脚本
  的正规答案。不引的理由是依赖装不进来（同上），而且这六套的价值在**判据本身**
  （每一条都在验一个具体的产品承诺），不在报告好不好看。等依赖能正常安装时可以
  迁移，脚本里的断言几乎能原样搬。
- **把六套塞进 `vitest`**：vitest 也能驱动浏览器，但那要把 `check` 改成 `expect`、
  把「一条失败继续跑」改成「一条失败就中止」，而验收脚本的价值恰恰是**跑完看全貌**
  ——哪几条过了、挂的那条前后是什么状态。
- **同进程 import 六份脚本**：计数串台，且一套抛异常会带塌后面五套。
- **给 `culling` 保留固定 uid，配一个灌库脚本**：多一个「先灌库」的前置步骤，且
  灌库脚本要跟着 schema 改。现造更省事，代价是每次多花约 1 秒建文档。
- **给产品加测试模式开关来触发崩溃页**：为测试在生产代码里留一条分支，比手工注入
  一行 `throw` 贵得多。
- **把 `playwright-core` 写进 `package.json` 但不装**：锁文件会与 `package.json`
  不一致，`--frozen-lockfile` 在 CI 直接失败——比现在的「README 里写清」更糟。
