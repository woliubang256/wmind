# Agent Note: 品牌标识变成站点设置（导出时可覆盖）

Status: implemented

## Problem

导出对话框的「品牌标识」原本只决定**印不印**：勾上就在页脚印死字 `wmind`，
不勾就没有。两个问题：

1. **自建站印着别人的名字**。把站点名改成「Acme 思维」之后，导出图右下角还是
   `wmind`——这是明显的错，而且是那种「导出给客户看才发现」的错。
2. **不能改**。同一台站点上，市场部要印公司名、个人用户想印自己的水印，
   两者只能二选一。

## Decision

### `site.brand` 存空串，回退在读取时做

设置项加在 `site.name` 旁边（`KindString`、`Public`、`MaxRunes: 64`），默认 `""`。
`Snapshot.BrandName()` 在读取时回退到 `SiteName()`：

```go
func (s *Snapshot) BrandName() string {
    if brand := strings.TrimSpace(s.String("site.brand")); brand != "" {
        return brand
    }
    return s.SiteName()
}
```

**回退放在读取而不是写入**，是因为「留空 = 跟站点名一致」要一直成立：管理员把
站点名从「Acme」改成「Acme 思维」，没设过品牌名的站要跟着变。如果默认值写死成
当前站点名，改名之后就脱钩了，而管理员并不会想到「还要再去改一次品牌」。

### `brand: boolean` → `brandText: string`

`ExportOptions` / `ExportContext` 里原来的 `brand: boolean` 换成一个字符串，
勾选框只管「印不印」，旁边的输入框管「印什么」。页脚高度条件同步改成
`options.date || options.brandText !== ''`——否则「勾了但清空文字」会留一条空白页脚，
看起来像排版坏了。

`export-canvas.tsx` 里原来写死的 `wmind` 改成 `ctx.brandText`。

### 预填是单向的，用户改过就不再覆盖

配置是异步来的，登录后第一次打开对话框时它可能还没落地。三条时序要同时成立：

- 配置晚到 → 字段该填上；
- 用户已经敲了字 → 不能被覆盖；
- 关掉再打开 → 又该重新套用设置。

用一个 `brandTouched` 标记 + `open` 依赖盖住：`open` 变 false 时复位标记，
标记为 true 时 effect 直接 return。

```ts
useEffect(() => {
  if (!open) { brandTouched.current = false; return; }
  if (brandTouched.current) return;
  setOptions((current) => (current.brandText === siteBrand ? current : { ...current, brandText: siteBrand }));
}, [open, siteBrand]);
```

`current.brandText === siteBrand` 那一层短路是为了避免同值 `setState` 触发重渲染
（`siteBrand` 是每次 render 重新算的字符串，不是稳定引用）。

## Consequences

- 后台「站点设置」多一个字段（`kind: 'string'` + `hintKey`），提示文案写明
  「留空则使用站点名称」，让「留空即跟随」在表单上自解释。
- `SiteConfig.brand` 是**已解析**的值（后端已经做过回退），前端不需要再判空；
  `useSiteConfig` 的兜底给 `''`，对话框里再 `|| config.siteName` 兜一次。
- 导出页脚从「有/无品牌」变成「有/无 + 任意文字」，`e2e/export.mjs` 的品牌用例
  相应改成断言输入框存在、可编辑、且值等于站点设置。
- 品牌文字限制 64 字符。页脚是单行居中，再长会撞到日期。
- 已知未做：不支持上传品牌 logo（只有文字）。

## Alternatives considered

- **把默认值写成当前站点名（`Default: site.name` 的值）。** 设置项是静态表，
  拿不到另一个键的运行时值；而且改名后会脱钩。
- **前端做回退（后端返回空串）。** 每个消费方都要写一遍 `|| siteName`，
  漏一个就印出空白页脚。回退是「这个字段的语义」，属于后端。
- **品牌文字复用 `site.name`，不新增设置项。** 站点名是「这个站叫什么」，
  品牌是「导出的图上印什么」，两者在自建站上经常不同（站点叫 Acme Docs，
  图上印 Acme）。
- **预填只在挂载时做一次。** 配置晚于挂载时字段永远是空的，而用户不知道
  这里本该有默认值。
