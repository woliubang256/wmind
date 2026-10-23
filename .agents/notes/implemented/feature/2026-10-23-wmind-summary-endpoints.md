# Agent Note: 概要选区与联系端点

Status: implemented

## Problem

概要已有矩形和标题，却没有选中事件。联系命令与几何只查主题树，概要无法作为联系端点。

## Decision

概要使用自身 id 进入画布选区，支持点击、修饰键多选与框选。它仍是 Summary，不伪造树节点。联系通过统一的存在性与矩形解析支持主题和概要。树结构命令只接受真实主题；概要通过专门的重命名和删除命令处理。删除概要同步删除指向它的联系，撤销整体恢复。

## Related decisions

- [概要布局](../../implemented/bug-fix/2026-10-23-wmind-summary-selection-placement.md)：部分重叠，保留选区范围与避让决策。
- [附属结构](../../implemented/architecture/2026-10-22-wmind-annotations.md)：部分重叠，扩展概要交互，保留双位置存储。
- [联系交互](../../implemented/feature/2026-10-23-wmind-relationship-editing.md)：部分重叠，共用标题、样式与控制柄。

## Alternatives considered

- 把概要转换为完整 Topic 可以直接复用树操作，但会改变父子结构与现有概要格式，并引入概要子树语义。本次保留 Summary 身份，只统一选区和端点解析。

## Consequences

概要与主题、概要与概要均支持联系；联系几何和控制柄共用可见矩形解析。概要通过双击或 F2 编辑标题，删除与树删除同步清理联系，一次撤销恢复。XMind 自有导出往返注册概要 id，保留概要端点；没有转换成带子树的主题。

命令、布局、存储与 XMind 往返共 94 条定向测试通过，9 条概要端点浏览器检查覆盖选择、两类连线、控制柄、级联删除、撤销、改名和刷新；结构面板显示概要端点标题。生产构建通过。外部 XMind 的原生概要主题结构仍需真实文件验证；当前对自有文件往返有测试保证。
