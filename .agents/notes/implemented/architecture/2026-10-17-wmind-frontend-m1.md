# Agent Note: 前端接通 M1：单飞刷新、三档外观、管理后台分包

Status: implemented

## Problem

M1-6 要把已经做完的后端接口接到界面上：登录/注册、个人资料与改密、头像上传、管理后台（用户表、设置表单、概览）、暗色模式。接口都在，但界面层有几个绕不开的问题：

- **刷新令牌是「用一次就轮换」的**，一个页面加载会并发发出五六个请求。全部拿到 401 时如果各自去刷新，第二个开始的刷新必然失败，而且会被服务端判成令牌重放，直接把整条会话撤销。
- **分页信息在信封的 `pagination` 字段里**，而 `apiRequest` 只返回 `data`。让 `apiRequest` 同时返回分页会把返回类型变成联合类型，每个调用点都要判断。
- **暗色模式做两档还是三档？** 用户说「跟随系统」时，他期待的是系统切换时页面跟着变，而不是首次打开时取一次值然后固定。
- **首帧闪烁**：主题写在 `localStorage` 里，而 `localStorage` 在 JS bundle 之后才读得到，中间那一帧会用错主题。
- **管理后台的代码普通用户永远用不到**，塞进主 bundle 等于让所有人替管理员付下载成本。
- **表单校验用不用 zod？** 只有四条规则（必填、长度、格式、两次一致）。
- **20 个设置项分 5 组**，保存按钮可能离正在编辑的字段隔着两屏。

## Decision

### 并发 401 合并成一次刷新（单飞）

`refreshSession` 用一个模块级的 `refreshInFlight: Promise<AuthSession|null> | null`：首个恢复或刷新建立 Promise，其余的直接 await 同一个。`finally` 里清空。[启动会话恢复](../bug-fix/2026-10-25-wmind-session-bootstrap.md)把无内存令牌时的用户探测改成主动恢复，并复用刷新响应的用户数据；运行中 401 仍用同一操作，迟到的旧 401 优先复用已更新的令牌。

没有这一层，一次页面加载里的并发请求会触发多次刷新；而刷新令牌是轮换式的，后到的请求拿着已经被换掉的令牌去刷新，服务端会按「重放」处理并撤销整条会话——症状是「打开页面莫名被登出」，且只在慢网络下偶发。

单测里用一个可控的 `fetch` 假实现断言 `refreshCalls === 1`：五个并发请求全部 401，只发出一次刷新。

### `apiRequest` 与 `apiList` 分开

`apiRequest<T>` 返回 `data`；`apiList<T>` 返回 `{items, pagination}`，内部调 `requestEnvelope` 拿整个信封。分页只在列表接口上有意义，把类型联合压给所有调用点不划算。

### 三档外观 + 首帧内联脚本 + 模块级 store

- `ThemePreference = 'light' | 'dark' | 'system'`，`resolveTheme(preference, systemPrefersDark)` 是纯函数，`systemPrefersDark` 由调用方注入——测试因此不需要 jsdom。
- `index.html` 里一段内联脚本在 CSS 与 bundle 之前读 `localStorage` 并给 `<html>` 加 `dark`。键名与判定逻辑必须和 `app/theme.ts` 一致，否则会出现「刷新后闪一下再变回来」。
- 状态放在 zustand 的 `useThemeStore`，顶栏操作、系统监听与路由切换共享同一偏好。个人设置的重复入口由[设置精简](../simplification/2026-10-24-wmind-account-controls.md)移除，共享状态和持久化继续有效。
- `system` 档订阅 `matchMedia('(prefers-color-scheme: dark)')` 的 `change`，订阅挂在 `Providers`（只装一次）。订阅放在 store 创建时会泄漏监听，HMR 下还会叠加。
- 同时更新 `meta[name="theme-color"]`：深色页面配浅色地址栏很割裂。

### 管理后台路由级懒加载 + 依赖分包

全站顶栏保留最近、模板、我的分享、回收站四个主导航。个人设置和管理入口归入右侧 `UserMenu`（[统一头像](2026-10-17-wmind-user-profile.md)、用户名、向下箭头）；个人设置始终可见，管理概览、用户管理、网站设置只按当前用户 `role === 'admin'` 加入菜单。桌面与移动共用同一用户菜单，移动导航抽屉也只保留主导航，避免重复入口。路由权限继续由 RequireAdmin 和后端保障，菜单隐藏不承担鉴权。

菜单用原生链接保留 URL、当前页高亮和新标签打开能力，支持方向键、Home/End、Enter、Esc 还焦点、Tab 离开、外部点击与导航后关闭。浮层复用共享 `placeMenu` 并 portal 到 body，避免被粘性顶栏裁切；右对齐且限制在视口内。320px 下收起顶栏语言选择器的当前值文字，语言图标和可访问名仍保留，图标按钮缩为 32px。退出、语言和外观保留各自操作。

「个人设置」链接右侧显示当前服务的实际版本，复用公开站点配置 `version` 和 `useSiteConfig` 的共享缓存；数字版本补 `v` 前缀，已带前缀的版本原样展示，开发环境与配置失败回退显示 `dev`。版本是链接内的次级文字，不增设菜单项或键盘焦点，管理员、普通用户和移动端均使用同一组件。前端不从 package.json 推断后端版本，避免独立部署或缓存前端时误报正在运行的服务版本。

三个 admin 页面用路由的 `lazy: async () => ({ Component })`，产物是三个独立 chunk（5.7 / 9.1 / 15.0 KB）。`vite.config.ts` 里用**函数式** `manualChunks` 而不是对象映射：对象映射只覆盖列出的包本身，它们的传递依赖（scheduler、use-sync-external-store）仍留在主 chunk，等于白拆。拆完主 chunk 从 523 KB 降到 50 KB，react 依赖单独一个 317 KB 的长期缓存文件。

### 表单校验手写，不引 zod

`src/lib/validation.ts` 返回 `Record<string, string>`——与后端 `error.details.fields` 同形。于是「前端先校验」与「后端再校验」两条路径共用同一套渲染：`fieldErrorsFrom(error)` 取出字段错误铺到表单上，取不到再按错误码映射（`AUTH_EMAIL_TAKEN` → `email`）。

规则与 `backend/internal/service/auth.go` 的 `validateRegistration` 对齐。两边漂移的症状是「前端放过、后端 422」，用户看到一个没标红的错误。

### 组件用原生能力，不自造

- `Modal` 用原生 `<dialog>` + `showModal()`：焦点陷阱、Esc 关闭、`::backdrop` 都交给浏览器。`dismissible=false` 时挂 `cancel` 监听拦掉 Esc——一次性密码对话框被 Esc 顺手关掉，用户就再也看不到密码了。
- `Switch` 用 `role="switch"` 的 button 而不是 checkbox：设置项表达的是「开/关」，不是「勾选」。
- `Field`/`TextField` 的标签与控件 id 由同一个 `useId()` 生成；分开写时只要漏一个，点标签就不会聚焦到输入框——这种缺陷不报错，只是「不好用」。

### 设置页：只提交改动，脏值可见

`diffSettings(initial, draft)` 只把变了的键放进 patch。后端是部分更新语义，只传改动可以避免覆盖别人刚改的项。保存条 `sticky bottom-4`：20 个字段分 5 组后，保存按钮离正在编辑的字段可能隔着两屏。

数值字段先在本地按 schema 的 `min`/`max` 校验，越界不跑网络；后端返回的字段错误按设置键铺回对应行。

### i18n 边界：外壳与认证走 i18n，管理后台中文单语

`t()` 覆盖导航、认证、个人设置、外观；管理后台（用户表、设置表单、概览）用中文常量，与 `settings-schema.ts` 的字段描述同源。原因：这一期的英文文案没有验收标准，逐条硬造译文只会制造维护负担；而错误消息本身来自后端（`errorMessages` 是中文表），单靠前端 i18n 也无法给出完整英文体验。

代价是切到 `en-US` 后管理后台仍是中文。这条限制记在 Consequences 里，等有真实英文需求时再补。

## Alternatives considered

- **把个人设置和管理入口也留在移动抽屉** — 改动更少且沿用现有导航，但会出现两个不同用户入口；所有屏宽统一进用户菜单。
- **用 Select 承载路由动作** — 现有控件自带键盘和定位，但选择值不等于导航动作，且不能原生在新标签打开链接；菜单保留真实 Link 与 menu/menuitem 语义，复用定位函数。
- **把发布版本写死进前端构建** — 无需等待站点配置且静态资源自带版本；但前后端可独立更新，旧缓存会显示错误服务版本，因此使用现有公开配置中的服务版本，并在开发时保留 `dev`。

- **用 react-hook-form + zod** — 声明式、生态成熟。被否：本期只有 4 个表单、每张 2–5 个字段，收益不足以抵消两个依赖（zod 约 13 KB min）。校验结果手写成 `Record<string, string>` 后，与后端字段错误天然同构，反而更省。
- **把 access token 也存进 `localStorage`** — 刷新页面不用重新换取令牌。被否：XSS 能直接读走长效令牌；现在只存内存，刷新时靠 httpOnly 的 refresh cookie 换一次，代价是一次额外的请求。
- **`apiRequest` 统一返回 `{data, pagination}`** — 少一个函数。被否：非列表接口的调用点全部要解构或忽略第二个字段，类型也变成联合。
- **暗色模式只做两档** — 实现简单。被否：用户选「跟随系统」后系统切换页面不变，等于这个选项是假的。
- **主题状态放 Context 而不是 zustand** — 少一个依赖。被否：`zustand` 已在依赖里（M0 定的技术栈），Context 会让 `Providers` 下所有消费者在主题变化时重渲染。
- **管理后台不做懒加载** — 少一处 `lazy`。被否：普通用户占绝大多数，却要为三个管理页面付下载与解析成本。
- **自造遮罩层实现对话框** — 样式完全可控。被否：焦点陷阱、Esc、滚动锁定、`inert` 背景都是手写对话框最容易漏的地方，而 `<dialog>` 已经把这些做对了。
- **头像在前端先校验类型与尺寸** — 早失败。被否：文件类型只能靠扩展名/MIME 猜，尺寸要解码。后端用 `image.Decode` 真解码并居中裁切，前端预校验只会多一条可能与后端不一致的规则。
- **管理后台也逐条走 i18n** — 一致性更好。被否：见上，本期没有英文验收标准，译文无人校对等于把错误固化。

## Consequences

- **收益**：并发 401 不再触发令牌重放导致的「莫名登出」；单测锁住了「只刷新一次」。
- **收益**：深色模式三档、刷新不闪、跨标签页持久（同源 `localStorage`）；`theme-color` 跟随主题。
- **收益**：主 chunk 从 523 KB 降到 50 KB，依赖单独缓存；管理后台三个 chunk 按需加载。
- **收益**：设置页只提交改动、脏值计数可见、越界值本地拦截；关闭注册后匿名登录页与注册页同步反映（实测）。
- **代价**：`en-US` 下管理后台仍是中文；表单级校验文案（`validation.ts`）也是中文常量。
- **代价**：没有组件级测试。Vitest 跑在 `node` 环境（无 jsdom），交互行为靠 Playwright 冒烟覆盖；后续要写组件测试需要引入 jsdom 或 happy-dom，并调整 `test.environment`。
- **代价**：`AdminOverviewPage` 只列最近 8 条审计，没有独立的审计查询页；筛选接口（action / actor_uid / 时间）已就绪，界面留到有真实排障需求时再做。
- **已知限制**：`GET /admin/stats` 的导图相关字段仍为 0 / 空数组，概览里的「近 14 天新增」在 M2 之前显示「暂无数据」。
- **已知限制**：需要恢复会话的匿名页面仍可能收到 `/auth/refresh` 401，因为脚本读不到 HttpOnly Cookie；有效会话启动不再先发送无令牌的 `/auth/me`。临时网络或服务错误显示原地重试，不当作会话失效。

## Verification

- `e2e/user-menu-version.mjs` 42 项通过，使用完整路由夹具，不创建账号或访问开发数据库；覆盖正式版本与 `dev`、空版本与配置失败回退、管理员与普通用户、中英文、320/375/768/1440px 布局、键盘焦点与个人设置导航；TypeScript 构建检查通过。

- `e2e/user-menu.mjs` 22 项通过：管理与普通用户可见项、真实路由与单项高亮、键盘和焦点、外部点击、320/375/768px 几何、中英文与深色。`zoom-presets.mjs` 16 项和既有 `toolbar.mjs` 12 项回归通过；语言包检查与前端生产构建通过。

- `node node_modules/typescript/bin/tsc --noEmit`：0 错误（`noUnusedLocals` + `verbatimModuleSyntax` 全开）。
- `node node_modules/vitest/vitest.mjs run`：4 个文件 35 个用例通过——`theme.test.ts`（7，含循环切换与纯函数解析）、`validation.test.ts`（13）、`format.test.ts`（8，含字节单位与相对时间边界）、`client.test.ts`（7，含并发 401 只刷新一次、`apiList` 保留分页）。
- `node node_modules/vite/bin/vite.js build`：通过，无 chunk 体积告警；产物 `index 50.3 KB / react 317 KB / vendor 63.6 KB / i18n 49.5 KB / data 41.3 KB` + 三个 admin chunk。
- Playwright（`playwright-core` + 缓存的 chromium，脚本在 `/tmp/wmind-ui-smoke/smoke.mjs`）对着「真实后端 + Vite dev」跑通 16 步并截图：匿名登录/注册 → 登录 → 个人设置 → 管理概览 → 用户管理 → 新建用户（`smokeuser`）→ 重置密码（服务端生成 16 位密码）→ 网站设置 → 深色模式 → 关闭注册 → 匿名登录页/注册页 → 恢复注册 → 删除用户。
  - 断言：`dark class applied: true`、`theme-color: #111521`、刷新后仍为深色；注册关闭后登录页「立即注册」链接数 0、注册页显示「暂未开放注册」；删除后该用户行数 0。
  - 后端日志核对：`POST /admin/users/{uid}/reset-password` 200、`DELETE /admin/users/{uid}?map_strategy=delete` 204。
- 冒烟过程中发现并修掉两个真实缺陷（都不是类型检查能发现的）：
  1. **对话框贴在视口左上角**：原生 `<dialog>` 靠 UA 样式里的 `margin: auto` 居中，而 Tailwind 的 preflight 把所有元素 `margin` 清零。加 `m-auto` 后恢复居中。
  2. **侧栏同时点亮两项**：`/admin/users` 也以 `/admin` 开头，纯前缀匹配会同时高亮「管理概览」与「用户管理」。改成「更长的链接优先」后只剩一项。
