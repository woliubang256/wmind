# Agent Note: 错误文案走 i18n，而不是写死在请求层

Status: implemented

## Problem

`lib/api/errors.ts` 里有一张 47 条的 `errorMessages`：错误码 → 中文一句话。
`ApiError` 在构造时把这句话塞进 `Error.message`，界面上所有 `catch` 分支都直接
显示 `error.message`。

于是整个站点里**最常被用户看到的文案**是唯一没进语言包的一批：把语言切成 en-US，
表单校验、登录失败、导图超限、分享失效——全部照旧显示中文。而语言包本身已经覆盖
了 `editor` / `maps` / `share` / `templates` 等 12 个命名空间，缺的偏偏是这一块。

难点在于**这一层拿不到 React 上下文**：`ApiError` 在 `client.ts` 的响应拦截里
构造，可能发生在任意事件回调、`setTimeout`、甚至 `beforeunload` 里。`useTranslation`
在这里用不了。

## Decision

### 码 → key，文案在语言包里

`errorMessages` 换成 `errorMessageKeys`（码 → `errors.<CODE>`），`ApiError` 构造时
走 i18next 的**单例** `i18n.t()`。码本身是后端契约（docs/04 §3.2），不翻译；只有
给人看的那句话翻译。

新增 `resolveErrorMessage(code, fallback)`，三级兜底：

1. 认识的码 → 本地文案；
2. 不认识的码（后端新加的）→ 后端自己给的 `message`；
3. 两者都没有 → `errors.unknown`。

第 2 级不能省。后端加一个新错误码是**一次发布之内**的事，前端要么跟着发一次版，
要么就显示一句「请求失败」——后者会让新功能上线当天的报错全都变成哑巴。

### 一个必须钉住的坑：i18next 把 key 原样返回

配置里 `returnNull: false`，找不到 key 时 `t()` 返回的是 **key 本身**（非空字符串）。
所以「`t()` 返回了东西」不等于「翻译存在」。少写一个 key 时界面会直接显示
`errors.MAP_NOT_FOUND` 这种字符串——比英文更难查，因为它看起来像是个正常的标识符。

`errors.test.ts` 里有一条专门的守卫：遍历 `errorMessageKeys` 的每一个值，
`i18n.exists(key)` 必须为 true。另一条比对两份语言包的 `errors` 键集合相等。

### 语言切换只影响新错误

已经抛出来的那条 `ApiError` 保持抛出时的语言。为它记住语言、再订阅一次 `languageChanged`
重渲染一遍不值得——错误提示是瞬时的，用户看到它的那几秒里不会去切语言。

## Consequences

- 新增一个后端错误码，要改三处：后端常量、`errorMessageKeys`、两份语言包。
  守卫测试能抓住「语言包漏了」，抓不住「`errorMessageKeys` 漏了」——后者会静默
  退化成第 2 级（显示后端的中文 message）。这是可接受的降级，不是错误。
- `errorMessages` 这个名字不再导出。它此前只在 `errors.ts` 内部用，外部零引用
  （改之前 grep 过），所以没有兼容层。
- 单测 6 条：认识的码用本地文案、不认识的退回后端 message、两者都没有用兜底、
  每个 key 都存在于语言包、两种语言键集合相等、`ApiError` 保留 code/status/requestId。

## Alternatives considered

- **在组件里 `t()`**：所有展示错误的地方改成 `t('errors.' + error.code)`。要在
  十几个组件里各改一次，且 `error.message` 仍会是中文——两套文案并存比现在更糟。
- **后端返回本地化文案**：需要 `Accept-Language` 协商、后端维护一份语言包，且
  错误文案会进 HTTP 缓存键。服务端本地化对「API 优先」的产品是另一套设计，不是
  这个 bug 的修法。
- **保留中文表，只补英文表**（按语言选表）：等价于自己实现一遍 i18next，还要处理
  切换时机。
- **用 `i18next.t` 的 `defaultValue` 参数兜底**：`t(key, { defaultValue: fallback })`
  能省掉一次比对，但当 `fallback` 也是中文时，两种语言下都会显示中文，掩盖漏翻译。
  现在这样「比对 key」能立刻暴露漏写。
