# Agent Note: 主题附加内容格式与测量

Status: implemented

## Problem

Insert 的待办、任务、附件与视觉素材需要持久化，并在节点布局中为真实内容留出空间。

## Decision

Topic 的可选 content 字段存放待办状态、任务属性、便携文件、附件、素材 id 与公式 SVG。旧文档无需迁移。备注、标签、href 与图片仍使用原字段。统一清洗函数同时用于原生解析和 XMind 的 wmindContent 扩展；复制子树深拷贝内容。内容命令整批校验端点、清洗输入、限制最终文档 8 MiB，并通过现有历史支持撤销。

measureDetails 区分主行待办与备注/链接入口、底部标签 badge、任务/附件行和媒体。TopicSize 保存测量产物，主行图标只增加横向占用；标签按节点宽度换行并保留完整文字。TopicDetailsView 与导出共享；标题、标记、原图片及 HTML 编辑框通过共同几何函数定位。

NodeBox.height 表示实际形状高度，outerHeight（有标签时）表示包含形状下方标签的总占用。TopicSize.height 始终是布局占用，bodyHeight 是形状高度。结构布局按总占用排兄弟，连线与编辑框仍按形状定位；topicBounds 统一给视口裁剪、框选、概要/边界、导出及拖拽预览提供完整范围。该区分不写入文档。极窄固定宽度在添加左右入口后至少为标题保留一个字的宽度，允许测量宽度适当超过保存的固定宽度；不反写用户样式。链接只允许明确的外部协议和内部主题引用，内嵌文件仅以下载恢复。

## Related decisions

- [测量布局](2026-10-18-wmind-editor-measure-layout.md)：扩展内容高度而不改变结构布局。
- [XMind 导出](2026-10-23-wmind-xmind-export.md)：新字段通过自有扩展往返，外部 XMind 不保证识别。

## Alternatives considered

- 把图标和内容作为不占空间的装饰层可以少改测量，但会与标题、图片或相邻主题重叠，导出也无法可靠计算范围，因此所有内容都参与测量。

文件和文件夹通过 insert-files.ts 读取，单批限制 2 MiB、100 个文件。文件夹先检查相对路径再生成 ZIP，保留目录层次；下载通过 application/octet-stream Blob 恢复原字节。附件总数最多 100，超限整批拒绝。

- 所有装饰都放在形状内部可以继续复用单一矩形，但底部 badge 会改变形状高度，标题与连线的视觉中心也随标签数量漂移；形状高度和完整占用分开，代价是所有完整范围消费者都必须使用 topicBounds。

## Consequences

原生保存、复制与本项目 XMind 往返保留附加内容。内嵌文件增加文档体积，超过 8 MiB 的修改在提交历史前失败。后续 Insert 编辑器使用该命令与格式，无需新增独立存储。
