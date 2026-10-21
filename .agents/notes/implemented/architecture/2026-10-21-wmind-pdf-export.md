# Agent Note: PDF 导出走栅格，而不是矢量

Status: implemented

## Problem

README 的格式行里写着「PDF 待做」，M4 的验收标准 5「导出的 PDF 中文正常显示」
挂着阻塞。原因是计划里的技术路线走不通：

`jsPDF` + `svg2pdf.js` + `opentype.js`，文字转路径需要 **TTF 字体程序**。仓库里
只有思源黑体/宋体/等宽的 **WOFF2 分片**（`unicode-range` 切片，每族 101 个），
而 PDF 的字体嵌入不接受 WOFF2。要补的是一整套 WOFF2→TTF 的子集化工具，那不是
一次导出功能的附带工作。

同时三个依赖也装不进 `package.json`（本机 pnpm store 坏，`pnpm add` 会在
`node_modules/.ignored` 那步失败），所以连「先装上再说」都不行。

## Decision

**单页图片 PDF**：复用 PNG/JPEG 那条栅格化链路，产出 JPEG，再用
`editor/export/pdf.ts` 手写一个 6 个对象的 PDF 容器包起来。

```
SVG 字符串 ──rasterizeSvg(jpeg)──▶ JPEG 字节 ──buildImagePdf──▶ .pdf
```

### 为什么是 6 个对象

Catalog / Pages / Page / Contents / Image XObject / Info，加一张 20 字节一行的
xref 表和 `startxref`。就这些。jsPDF 做出同样的产出要 ~150 KB 压缩代码。

更重要的是**可测**：`buildImagePdf` 是纯函数，单测可以逐字节断言——头部、
每个对象的偏移、xref 的步长、`/Length` 与 JPEG 字节数一致、`startxref` 指回
`xref`。用 jsPDF 只能断言「文件不是空的」。

### 三个必须钉住的细节

1. **单位**：PDF 用户单位是 1/72 英寸，CSS px 是 1/96 英寸，所以 `px × 0.75 = pt`。
   搞错这一条，PDF 会大 33% 并在打印时被裁掉。页面尺寸取导图的**逻辑尺寸**
   （不是倍率后的像素）：倍率只决定清晰度，不该改变纸张大小。
2. **图像尺寸从字节里读**（`jpegSize`），不从调用方传的值。两者应当相等，但
   浏览器对大图降采样、或 `toBlob` 换了编码参数时，声明错的 `/Width` 会让阅读器
   拉伸或裁切，而且**完全不报错**——用户只看到一张「有点糊」的图。
3. **文本字符串编码**：ASCII 走 `(…)` 并转义 `\` `(` `)`；其余走 UTF-16BE
   十六进制带 BOM。`PDFDocEncoding` 不是 UTF-8，直接塞 UTF-8 字节会让中文标题
   在阅读器的文件信息里变成乱码。

### JPEG 原样嵌入

`/DCTDecode` 交给阅读器解码：不解码、不重编码、没有 alpha 通道要处理。PNG 就不
行——要么 `FlateDecode` 后自己拼 raw RGB，要么走 `SMask` 处理透明，两条都比
JPEG 多一段代码。

### 界面要如实说

导出对话框在 PDF 下的说明写着「文字是位图，不可选中——需要可编辑的文字请导出
SVG」。这是这个方案唯一的实质代价，不能让用户拿到文件才发现。

## Consequences

- 中文在任何设备上都正常显示（不依赖阅读器里装没装思源黑体）——这正好也是
  M4 验收标准 8 的要求。
- **文字不可选中、不可搜索**。M4 的 IE-15 从「阻塞」变成「部分通过」。
- 文件比矢量 PDF 大（一张 2× 导图的 JPEG 通常几百 KB 到几 MB），但比 PNG 小。
- PDF 同样受浏览器画布尺寸闸门约束（单边 16384、总像素 268M），走的是和
  PNG/JPEG 同一条 `checkRasterSize`。
- 拆分导出时每个分支各出一份 PDF，页面尺寸与标题用该分支自己的——用整份文档
  的会让 zip 里出现 N 个同名文件。
- 单测 25 条：文本转义 / UTF-16BE / 代理对、日期格式、`px→pt` 与下限、`jpegSize`
  的正常路径与三种异常（非 JPEG、跳过 DHT、没有帧头）、PDF 结构逐项断言。

## Alternatives considered

- **矢量 PDF（字体子集嵌入）**：需要 `Type0` + `CIDFontType2` + `CIDToGIDMap` +
  `W` + `ToUnicode`，输入还得是 TTF。前提在本仓库不成立，见上。这是上一版明确
  否掉「整张位图塞进 PDF」的理由——改判的原因不是难度，而是前提不成立。
- **`jsPDF` + `svg2pdf.js`**：依赖装不进来；而且它照样要 TTF，文字转路径这条
  同样卡在字体格式上。装得进来也只解决容器，不解决字体。
- **服务端 `chromedp` → `Page.printToPDF`**：保真度最高，矢量文字也有。但要在
  容器里多装一个 Chromium（镜像 +400MB），而且「前端导出」的零网络往返优势没了。
  留给服务端导出（IE-30）。
- **PNG 塞进 PDF**：`/FlateDecode` 要自己拼 raw RGB 行，或者走 `SMask` 处理
  透明。同样的产出多一段易错代码，没有收益。
- **A4/A3 固定纸张 + 分页**：一期导出的是「一张图」，分页会把一棵树切成几块，
  用户还得自己拼。默认「适应内容」的单页更符合导图的使用场景。
