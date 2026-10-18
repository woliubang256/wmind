# Agent Note: 编辑器内核的文档模型、命令与撤销栈

Status: implemented

## Problem

M2.1 要给出「可编辑导图」的底座：文档模型、遍历工具、校验、store、命令与撤销栈。docs/05 §4.2/§4.7 给了类型与命令清单，但有几处必须自己定：

- 撤销怎么实现：为每种操作写反向操作，还是存快照？
- 1000 节点的文档，每次编辑都存一份快照会不会把内存吃光？
- 命令怎么把「新建出来的节点 id」告诉 store，好让 UI 选中它？
- 连续打字时每个字符都入栈，撤销就退化成退格键——合并规则放在哪一层？
- 用户上传的 `.wmind` 里有一个不认识的形状枚举，应该打不开还是尽量显示？
- 调色板颜色要不要写进 `topic.style`？
- store 做成全局单例还是每张导图一个实例？

## Decision

### 撤销用「快照 + immer 结构共享」，不写反向操作

```ts
const applied = produce(state.doc, (draft) => { outcome.result = command.apply(draft, ctx) });
const nextDoc = produce(applied, (draft) => { draft.meta.updatedAt = new Date(at).toISOString() });
```

反向操作要求每个命令配一个 `undo()`，且必须与 `apply()` 严格对称。删子树要记住「插回哪个父节点的第几个位置」，改样式要记住「改之前的每个字段值」——二十多个命令就是二十多份容易写错的对称逻辑，而漏一个的表现是「撤销后文档损坏」，属于最难查的一类 bug。

快照方案下命令只需实现 `apply`，撤销就是把旧引用换回来。代价是内存，靠 immer 的结构共享抵消：改一个节点的标题只复制从根到该节点的路径，1000 节点文档的单次增量是几百字节量级，不是整份文档。

栈深上限 200（docs/05 §4.7）。超限丢最旧的。

### `meta.updatedAt` 用第二次 `produce`，换取空操作检测

immer 在 recipe 未做任何修改时返回**原引用**。这正好可以用来判断「这条命令什么都没改」——按了 Delete 但选中的是根节点、折叠一个没有子节点的主题、把标题改成原来的值，都不该进撤销栈。

但如果把 `draft.meta.updatedAt` 写进同一个 recipe，每次命令都会改动 `meta`，空操作检测就永远失效了。所以分成两次 `produce`：第一次跑命令并比较引用，第二次只碰 `meta`。

### 命令返回 `CommandResult`，而不是直接改 store

```ts
export interface CommandResult { select?: string[]; edit?: boolean }
```

新建节点后要选中它并进入编辑态，这需要知道新节点的 id。三种做法里：

- 命令持有 store 引用 → 内核层反向依赖视图层，测试要造 store；
- 命令在外部预生成 id 再传入 → 调用方得先知道要建几个节点（粘贴就不是固定数量）；
- 命令返回结果，store 统一应用 → 命令保持纯函数，视图概念（选中、编辑）不污染内核。

选第三种。

### 合并键而不是 `coalesceWith(prev)` 回调

docs/05 §4.7 写的是 `coalesceWith?: (prev: EditorCommand) => boolean`。实现时改成 `coalesceKey?: string`：回调要取 `prev` 的具体字段必须把它断言成具体命令类型（`prev as RenameCommand`），这是类型不安全的口子，且每个命令都要重复写一遍判断。键比较（`rename:${id}`）表达力等价，store 侧一行比较即可。

合并窗口 800ms，同类型 + 同键才合并。撤销时清空 `lastCommand`，否则「撤销后立刻打字」会与撤销前那次输入合并成一条历史。

### `parseDocument` 对字段级错误宽容，对结构级错误硬失败

| 情况 | 处理 |
| --- | --- |
| 不是 JSON 对象 / `format` 不对 / major 版本更高 / 完全没有画布 | 抛 `DocumentParseError` |
| 枚举值不认识、颜色不合法、数字越界、id 重复 | 回退默认值 + `warnings` 里留一条带路径的说明 |

理由不对称：`.wmind` 是长期存档格式，将来新增形状或字体时，老客户端打开新文件应该「少显示一点」而不是「打不开」；反过来，major 变更意味着结构不兼容，静默降级会把用户文档截断后再保存回去，那才是真的丢数据。

id 重复**必须**重新生成而不是报警后继续：两个节点同 id 时 `findTopic` 会静默返回先遇到的那个，之后所有编辑都改错地方，而 UI 上完全看不出来。

### 调色板颜色不写回 `topic.style`

`resolveStyle` 逐层合并时用 `assigned: Set<keyof Style>` 跟踪「哪些字段已经被显式指定过」，只有没被指定的 `fill` / `lineColor` 才取调色板。

如果从默认值开始一路 `Object.assign`，默认值会把「未指定」和「指定为默认值」混为一谈，调色板就永远生效不了——而调色板不生效的直接后果是「换配色方案后一半节点还是旧颜色」。

`null` 是有效值（表示无填充），`undefined` 才是未指定。这两者在 `apply()` 里必须区分，是最容易写错的一处。

### `branchIndex` 在遍历时逐层传递

分支序号决定取哪个颜色。若让 `resolveStyle` 自己反查父链，每次解析是 O(depth)；在 `WalkContext` 里传递是 O(1)，且「同一分支同一色系」的语义直接由「后代继承祖先的 branchIndex」表达出来。

### store 是工厂，不是单例

`createEditorStore({ doc, ... })` 返回 vanilla zustand store，每张打开的导图一个实例。全局单例在测试里会互相污染（一个测试改了文档，下一个测试看到的是脏状态），在应用里也挡住了「预览」这类并存场景。React 绑定单独放在 `use-editor.tsx`，内核测试因此不需要 DOM。

## Consequences

- 新增命令只需实现 `apply`，撤销 / 重做自动可用；命令是纯数据，可序列化、可重放。
- 撤销栈内存随「编辑次数 × 路径长度」增长，与文档规模基本无关；200 步上限兜底。
- 空操作不产生历史，撤销栈里不会出现「按了但什么都没发生」的记录。
- 导入畸形文件不会白屏：能显示多少显示多少，`warnings` 由上层决定是否提示。
- 内核 103 个单元测试（含遍历 16、校验 16、样式 14、store 22）在 node 环境跑，不需要 jsdom。
- 已知代价：`findTopic` 是 O(n) 全树扫描。命中测试、拖拽落点这类高频路径在 M2.4/M2.5 里由调用方自建 id → box 的 Map，不在模型层维护索引——文档是 immer 不可变结构，索引一改就得整体重建，比按需扫描更容易出错。

## Alternatives considered

**反向操作命令（inverse command）**：内存最省，且天然可做协同编辑的 OT。放弃原因是实现成本与出错面：每个命令都要写一份严格对称的撤销逻辑，漏一个就是「撤销后文档损坏」。协同编辑不在本期范围，等真要做时再换。

**Redux Toolkit**：`createSlice` + `undoable` 中间件能省掉手写历史栈。放弃原因是多引入一个依赖和一层抽象，而这里的历史语义（合并窗口、选中态一起回滚、`meta.updatedAt` 不参与空操作判断）需要定制，中间件反而更难改。

**类模型 + 方法调用**（`class Topic { addChild() }`）：读写更顺手，但序列化要写 `toJSON`/`fromJSON`，且 immer 对类实例的处理需要额外配置。文档模型直接是普通对象，与磁盘格式一一对应，少一层映射。

**全局单例 store**：实现最短。放弃原因是测试互相污染，且无法同时打开多张导图做预览。
