# Agent Note: LaTeX 公式生成自包含 SVG

Status: implemented

## Problem

公式需要在画布和离线导出的图片中显示分式、上下标、根号和矩阵。直接存 LaTeX 文本不能表达数学排版。

## Decision

insert-equation.ts 使用 MathJax TeX 与 SVG 输出，限定 base、ams 包，不加载 HTML、链接或动态 require 扩展。字形以路径写入 SVG，fontCache 为 none；白色衬底和固定文字色使其在不同主题上可见。输入上限 2000 字符，输出限制 350 KB，非法公式拒绝保存。公式源文本和 SVG 同时保存在可选 content.equation 中，后续可以编辑源文本。

公式模块动态导入，MathJax 独立 chunk，普通编辑不加载约 589 KB gzip 的公式引擎。开发服务器显式预构建相关入口，避免首次预览导致编辑器刷新。

## Related decisions

- [内容模型](../../implemented/architecture/2026-10-23-wmind-topic-content-model.md)：公式作为可测量媒体共享渲染和持久化。

## Alternatives considered

- MathML 或 HTML 公式可以直接用浏览器排版，但导出的 SVG 再通过 img 栅格化时无法可靠保留 foreignObject 及字体。因此生成字形路径而不是依赖外部 DOM。

## Consequences

分式、根号和脚本的自包含 SVG 以及非法输入拒绝有定向测试。首次公式预览需要加载较大的独立引擎，之后复用缓存；不支持额外 TeX 包和自定义 HTML 宏。
