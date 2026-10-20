# Agent Note: 打开导图时先过归一化闸门：少一个 `theme` 就是整页白屏

Status: implemented

## Problem

验收 IE-27（首帧无跳动）时用 REST 直接建了一份文档，`sheets` / `rootTopic` 齐全、
`theme` 缺失。打开 `/maps/:uid` 得到的是一整页：

```
Unexpected Application Error!
TypeError: Cannot read properties of undefined (reading 'global')
    at scanDocument (use-fonts-ready.ts:32)
```

`scanDocument` 读的是 `doc.theme.global.fontFamily`，而这份文档没有 `theme`。

这不是「测试数据造得不规范」，而是两道闸门不一致：

- **服务端**只校验 `format`、`sheets`、`rootTopic` 三个字段（`internal/service/map.go`），
  其余一律放行。
- **前端导入路径**产出文档后要过 `parseDocument`，它会把缺的字段补齐并记一条
  `document-normalized` 警告。
- **前端加载路径**（`RemoteEditor` 的 `queryFn`）把 `mapApi.get()` 的返回值直接交给
  `createEditorStore`，中间没有任何校验。

于是同一份「不完整但合法」的文档，走导入能开，存下来再打开就白屏。本地草稿
（`local-draft.ts`）是同一类问题的第二个入口：`isValidDraft` 只确认「format 对、
有画布」，注释里写着「localStorage 是用户能手改的，也是上一个版本的前端写的」，
但过完形状检查就原样交给了 `loadDocument`。

## Decision

两处都接上**同一个** `parseDocument`：

1. `RemoteEditor` 的 `queryFn`：`{ ...detail, document: parseDocument(detail.document).document }`。
   归一化失败（`format` 不对、`formatVersion` 的 major 高于本版本）时抛出去，
   由已有的 `query.isError` 分支显示「加载失败 + 重试」，而不是让 React 错误边界
   接住一个 `TypeError`。
2. `readDraft`：形状过关后再归一化一次；归一化失败就当作无效草稿清掉。用户手里
   还有服务端那一份，丢掉一份读不懂的草稿比让编辑器崩掉好。

归一化是**修补**而不是丢弃：它只补默认值、修正非法枚举、给缺 id 的节点发 id。
修补结果会随下一次自动保存写回服务端，等于顺手把文件修好了。

## Consequences

- 缺 `theme` / 缺 `children` / 非法枚举的文档不再白屏，而是正常打开（并可能被
  静默修补）。
- 加载路径与导入路径现在共用同一个校验函数，「导入能开、重开崩」这一类分叉
  在结构上消失了。
- `local-draft.test.ts` 加了两条：缺字段的旧草稿被补全、归一化救不回来的草稿被
  丢弃。前者在改动前会拿到 `theme === undefined`。
- 顺带确认了 IE-27 的判定口径：`getBoundingClientRect` 量到的是**乘过缩放**的
  尺寸（打开时 100%，随后「缩放到适应」变成 78%），拿它比首帧与稳定帧会把
  「缩放变化」误判成「布局跳动」。正确口径是节点自己的 `rect[width]`。

## Alternatives considered

**在 `scanDocument` 里给 `doc.theme` 加 `?.` 兜底**：一行就能不崩。放弃原因：
白屏只是症状，缺字段会在布局、导出、字体加载里各炸一次，逐个加可选链等于把
「文档一定完整」这个前提从代码里删掉。

**让服务端严格校验全部字段**：更彻底。放弃原因：服务端不该重复实现一遍前端
的文档归一化规则（两套规则迟早分叉），而且历史数据里已经有「不完整但能开」的
文档，收紧校验会把它们变成 400。

**归一化时把 warnings 也弹给用户**（像导入那样）：信息更全。放弃原因：打开一张
自己昨天存过的导图时弹「你的文件被修补了 3 处」，用户既无法处理也不知道该做什么；
导入是「引入外部文件」，才需要那份交代。
