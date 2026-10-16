# Agent Note: wmind 内部存储采用自有 .wmind JSON 格式

Status: proposed

## Problem

需求要求支持 XMind / Markdown / OPML 导入导出，并把「数据存储用 xmind 还是 opml 或者其他更好的、可以支持扩展的格式」列为待定项。

这个决定影响面最广：它同时约束前端文档模型、后端存储结构、导入导出适配器、以及未来客户端 App 的实现方式。选错会在项目中期形成难以回收的技术债——要么被厂商格式绑架，要么因表达力不足而反复打补丁。

## Proposal

**内部唯一真相源是自有的 `.wmind` JSON 文档，结构刻意对齐 XMind 的 `content.json`。**

关键约定：

1. 存储位置：PostgreSQL `maps.document` 字段（`JSONB` 类型）。
2. 字段命名与嵌套结构尽量与 XMind `content.json` 一致（`sheets[].rootTopic.children.attached`、`notes`、`labels`、`markers`、`relationships`、`boundaries`、`summaries`），使导入导出转换是「改名」而非「翻译」。
3. 样式键名与 XMind 的 SVG 风格属性做一对一映射表（`svg:fill` ↔ `fill`、`fo:font-size` ↔ `fontSize`、`shape-class` ↔ `shape`）。
4. 预留 `extensions` 数组与 `formatVersion` 字段：解析器 **must** 保留未知字段并在回写时原样输出，避免第三方格式往返丢数据。
5. 第三方格式（`.xmind` / `.opml` / `.md`）只作为进出口的适配器，内核不感知。

**一条关键规则**：调色板颜色是**计算得出**而非写入文档。只有用户手动改色时才把颜色固化进 `topic.style`。这是「一份导图随时切换配色方案而不丢内容」的实现基础——若把调色板色写进每个节点，切换主题就变成了逐节点覆盖。

完整 schema 见 [docs/03-数据模型与文件格式.md](../../../../docs/03-数据模型与文件格式.md)。

## Alternatives considered

### 为什么不直接用 `.xmind` 格式作为内部存储？

这是与 XMind 100% 互通的唯一方案，导入导出零转换，短期成本最低。放弃它的理由是长期的：格式由厂商私有演进且未公开文档化（`structureClass`、`styles.xml` 均无官方规范），跟随成本极高；无法承载 wmind 自己的扩展（版本、协作、权限元数据）；数据库里只能存 zip 二进制，无法做 JSONB 查询与局部路径更新。等于把产品的数据结构主权交给第三方。

### 为什么不用 OPML 作为内部存储？

OPML 格式极简、通用性好、XML 工具链成熟，作为**交换格式**是优秀的。但它只能表达「层级 + 文本」——无法表达样式、主题、形状、线条、联系、外框、概要、标记。而本项目一半的产品价值恰恰在这些视觉能力上。用它做内部格式，等于要先把它扩成私有方言，那还不如直接设计自有格式。

### 为什么不用 Markdown 作为内部存储？

Markdown 人类可读、Git 友好、可 diff，对纯大纲场景有真实吸引力。但它连稳定的节点 ID 都没有，无法支撑「撤销栈定位到具体节点」「联系引用两个节点」「外框圈住一组节点」这些操作；样式表达力比 OPML 更弱。作为导出格式保留，作为存储格式不可行。

### 为什么不把 `document` 拆成 `topics` 关系表？

关系表看起来更「规范」，能按节点查询与统计。但导图是一棵整体树：拆表会导致「打开导图 = 一次递归 CTE 查询」和「保存 = 全量 diff 写回」，复杂度与性能都更差。JSONB 已支持局部路径更新与 GIN 索引，满足将来的服务端检索需求。列表页需要的 `node_count` / `size_bytes` 用冗余列解决，保存时顺带写入。

## Acceptance criteria

1. 一份 `.wmind` 文档可以通过 `docmodel.Validate` 全部校验规则（唯一 ID、引用完整性、枚举合法性、规模上限）。
2. XMind 2020+ / XMind 8 / OPML / Markdown 四种格式导入后，节点数与层级通过断言。
3. 导入再导出同一份 XMind 文件，未被识别的 `extensions` 字段不丢失。
4. 手动改过颜色的节点在切换配色方案后保持手动颜色；未手动改色的节点跟随新配色。
5. `formatVersion` major 更高的文件被拒绝打开并给出明确提示；minor 更高的文件正常打开。
6. 大文档（5000 节点）保存 P95 < 300ms。

## Risks

- **映射表未经真实样本验证**：XMind 的 `structureClass` 字符串与 `styles.xml` 内部结构均为推测，**must** 在实现前准备 5+ 真实 `.xmind` 样本（含自定义主题、图片、联系、外框、概要）作为测试夹具，以样本为准编码，不凭推测。
- **自有格式意味着自维护 schema**：字段变更需同步升级 `formatVersion` 并提供迁移函数。缓解：major 变更需在文档与决策记录中留痕。
- **JSONB 的更新粒度**：整字段替换会产生较大的 WAL 写入。若未来单文档超过 5MB，需评估 `jsonb_set` 局部更新或拆分为 `document` + `document_meta`。
