# Agent Note: 把 i18n 做完，并给它一个入口

Status: implemented

## Problem

语言包本身已经覆盖了 12 个命名空间，`errors` 那 47 条也接上了 i18next 单例。
但整套东西是**死代码**：

1. **没有切换入口**。`SUPPORTED_LOCALES` 里躺着 `en-US`，而界面上找不到任何
   能把它选中的地方——用户唯一的希望是改 `localStorage`。一个永远到不了的
   语言包，等于没有。
2. **组件里还剩大量中文字面量**：管理后台四个页面、导出对话框、样式面板、
   拖拽提示、自动保存提示、错误边界、离线提示条、`site-head` 的标题后缀。
3. **三处静默泄漏**，任何「逐个文件替换中文字符串」的翻译都会漏掉：
   - `lib/format.ts` 在模块顶层 `new Intl.DateTimeFormat('zh-CN')`，日期永远
     是 `2026/10/21`；
   - `formatDateTime(...).slice(5, 11)` 用定宽截取取「月-日」，在 `en-US` 下
     切出来的是 `2026, `；
   - 审计列表用 `join('、')` 拼键名，英文下变成 `avatar、email、password`。
4. **模块级常量表存的是文案而不是 key**：`settings-schema.ts`、`ROLE_LABEL` /
   `STATUS_META`、`WEIGHTS`、`FONT_DEFINITIONS.label`、`ACTION_LABEL`、
   `REASON_TEXT`。这些表在模块加载时求值一次，存中文就永远不会跟着切。

没有守卫测试，所以「漏了一个 key」只会在界面上显示成 `editor.panel.xxx` 这种
标识符——比英文更难查。

## Decision

### 1. 语言偏好与入口

新增 `lib/i18n/preference.ts`（纯逻辑）与 `app/locale-store.ts`（zustand）：

- 三档偏好 `system` / `zh-CN` / `en-US`，存 `localStorage['wmind:locale']`，
  与主题的 `wmind:theme` 同构；
- 入口是「个人设置 → 界面语言」，三个 `role="radio"` 按钮；
- 语言名用**该语言自己的写法**（中文 / English），只有「跟随浏览器」走 `t()`；
- `applyLocale` 同步 `<html lang>`，`i18n.on('languageChanged')` 兜住所有路径。

偏好落在 localStorage 而不是用户表：语言是**这台设备上的阅读习惯**，不是账号
属性。加后端字段要动迁移、接口、设置校验四处，收益却是负的。

### 2. 常量表只存 key

`SettingField.label` → `labelKey`、`WEIGHTS[].label` → `labelKey`、
`FONT_DEFINITIONS.label` → `labelKey`；操作日志的 `audit-presenter.ts` 使用 `AUDIT_ACTIONS` 与显式摘要映射，值指向 `admin.audit.*`。
渲染时才 `t()`。这是本笔记里唯一一条「以后加新表也必须遵守」的约定。

审计动作刻意使用显式映射而不是拼接翻译 key：拼出来的 key 守卫测试看不见，漏一条只会在界面上显示成标识符。分享动作、设置字段、角色变化、未知对象与权限详情共用语义 presenter；设置字段复用表单 labelKey，未知字段只显示本地化兜底。历史 detail 视为 unknown，只读取白名单字段，不 stringify 任意 JSON。未知动作码只允许出现在展开详情，映射查找排除对象原型继承键。

概览日志使用操作者、动作及对象组成摘要，时间与 IP 在同一元数据行；超长摘要折叠为两行，展开恢复全文。条数传原始数字供 i18next 选择英文单复数，中英文键、占位符与真实运行选择均有守卫；七项语义测试覆盖已知动作、设置翻译、角色前后值、凭据不展示、历史/畸形详情及原型同名键。

身份快照和完整查询的契约见[可读操作日志](../feature/2026-10-26-wmind-readable-audit-log.md)。

### 3. 格式化按语言建实例并缓存

`lib/format.ts` 改成按 `i18n.language` 建 `Intl` 实例、用 `Map` 缓存，并补了
`formatDayMonth` 与 `formatList`。没有引 `date-fns`：`Intl` 已经在运行时里，
再引一个库只是为了同一件事。

### 4. 错误边界不能变成新的崩溃路径

`components/error-boundary.tsx` 原先刻意写死中文，理由是「i18n 挂了时这个组件
还得能显示」。这个理由是对的，结论是错的——它把整个组件排除在翻译之外。改成
`tr(key, fallback)`：`i18n.t` 包在 try/catch 里，返回值等于 key 或为空时退回
中文字面量。这样「i18n 没初始化」和「key 漏了」两种故障都不会让兜底页变成
一片空白或一串标识符。

### 5. 守卫测试

`src/lib/i18n/locales.test.ts`（5 条）：

- 递归摊平两份语言包，**路径冲突**直接报错（语言包是混合形状：顶层是命名空间
  对象，内部已经是扁平点号键，`share.badge` 还嵌了一层——一层摊平会在第一层
  就停下）；
- 中英 key 集合相等；值非空且不等于自己的 key；占位符一一对应；
- 源码里出现的每个字面量 `t('a.b')` 都真的有翻译；没有缺命名空间的 `t('...')`。

扫描源码前**先剥注释**：`import-present.ts` 的文档注释里就有一句反例
`t('import.error.WHATEVER')`，不剥就是一条假阳性。剥离用状态机手写，不用正则
——正则会吃掉 `url.replace(/\//g, ...)` 里的正则字面量。

没有 `@types/node`，所以扫描走 `import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', eager: true })`，
不用 `node:fs`。

## Consequences

- 语言包从 592 个键涨到约 860 个。
- 加一个界面文案要改两份语言包，守卫测试会拦住只改一份。
- 加一张**模块级常量表**时必须存 key。这条没有自动化守卫，靠 code review。
- 单测环境里「跟随浏览器」解析成中文，而不是 Node 自带的 `en-US`。判据是
  `window` 而不是 `navigator`：Node 21 起全局也有 `navigator`，只看它会让
  一批断言中文文案的用例集体变红，而报错看起来像产品坏了。`preference.test.ts`
  有一条专门钉住这一点。
- `e2e` 脚本与导入解析器的提示仍是中文。前者不进产品包；后者是格式适配层的
  诊断信息，翻译它得先决定「解析器的警告要不要给终端用户看」，那是产品问题。
- `launchBrowser` 现在显式把 Playwright 上下文钉成 `locale: 'zh-CN'`。断言中文
  文案的脚本不能靠跑脚本的机器碰巧是中文系统；分享页的匿名上下文同样要钉，
  否则整页英文，报错只会说「等不到某个标题」。

## Alternatives considered

- **只做翻译，不做切换入口**：等于交付一份没人能用的语言包。测试里能切，
  用户不能——这是最糟的形态，因为它看起来完成了。
- **语言偏好存用户表**：见上，语言是设备习惯。而且未登录的分享页访客也要
  跟随浏览器，那里根本没有用户。
- **`index.html` 内联脚本定语言（照抄主题的做法）**：主题必须内联是因为首帧
  会白闪；语言没有这个问题——第一帧渲染前 React 还没挂载，DOM 里没有文案。
  多一段内联脚本只是多一处要维护的重复逻辑。
- **用 `date-fns` 做本地化**：见上，`Intl` 够用。
- **把常量表改成函数**（`getRoleLabel()` 每次调 `t`）：调用点全要加括号，
  而 `Record<Role, string>` 的类型约束会退化成 `string`，`switch` 的穷尽性
  检查就没了。
- **守卫测试里 `node:fs` 读源码**：没有 `@types/node`，`tsconfig.types` 也不
  包含它。`import.meta.glob` 是 Vite 提供的，不需要 Node 类型。
