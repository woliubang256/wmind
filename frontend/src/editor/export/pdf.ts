/**
 * PDF 导出：把一张位图包成单页 PDF。
 *
 * ## 为什么是位图，不是矢量
 *
 * 矢量 PDF 的难点从来不是画矩形和贝塞尔曲线，而是**字体**：PDF 里的文字必须
 * 引用一份嵌入的字体程序（`Type0` + `CIDFontType2`），还要给每个用到的字符
 * 建 `CIDToGIDMap`、`W` 宽度数组和 `ToUnicode` CMap，否则要么显示成方块，
 * 要么复制出来是乱码。而 `font-embed.ts` 现在拿到的是 WOFF2 分片——PDF 不认
 * WOFF2，得先解成 TTF 再按码位切子集。那是一个独立工程，做完之前「PDF 里
 * 能选中文字」这件事拿不到。
 *
 * 位图路线把这件事绕开了：渲染仍然交给浏览器（也就是用户眼前看到的那一份），
 * 我们只负责把 canvas 吐出的 JPEG 塞进一个合法的 PDF 容器。代价是文字不可选、
 * 放大到极限会糊——但导出的倍率是可选的，2 倍（即 192 DPI）已经够印刷。
 *
 * ## 为什么自己写容器，不引 jsPDF
 *
 * 单页单图 PDF 的结构是固定的六个对象，一共一百多行；而 jsPDF 的压缩后体积
 * 在 150 KB 上下，还要为它配一套字体子集参数。这里需要的功能它一样都不多给。
 * 自己写的另一个好处是**可测**：`buildImagePdf` 是纯函数，测试可以直接读回
 * 字节流检查交叉引用表是否指向正确的偏移——引了库就只能断言「没抛异常」。
 *
 * ## 单位
 *
 * PDF 的用户单位是 1/72 英寸（point），CSS 像素是 1/96 英寸。所以
 * `px × 0.75 = pt`，页面尺寸与画布上看到的物理大小一致（A4 宽的导图导出来
 * 就是 A4 宽）。这一点必须写死在代码里而不是让调用方猜：直接拿像素当 point
 * 用，导出的 PDF 会大出 33%，打印时被裁掉一圈。
 */

/** JPEG 字节流 + 页面几何。 */
export interface PdfPageInput {
  /** 已编码的 JPEG 字节。PDF 用 `DCTDecode` 直接透传，不解码也不重编码。 */
  jpeg: Uint8Array;
  /** 位图像素宽（用于 `/Width`，必须是真实像素数）。 */
  imageWidth: number;
  /** 位图像素高。 */
  imageHeight: number;
  /** 页面宽（point）。见文件头的单位说明。 */
  pageWidth: number;
  /** 页面高（point）。 */
  pageHeight: number;
  /** 文档标题，写进 Info 字典。 */
  title?: string;
  /** 生成者，写进 Info 字典。 */
  creator?: string;
  /** 创建时间，默认取当前时刻。测试注入固定值。 */
  createdAt?: Date;
}

/** 页面尺寸的下限（point）：0 宽的 MediaBox 在部分阅读器里会被当成坏文件。 */
export const MIN_PAGE_POINTS = 1;

/** CSS 像素 → PDF point。 */
export const PX_TO_PT = 0.75;

/**
 * 逻辑像素换算成页面 point。
 *
 * 夹一个下限而不是直接透传：空文档导出的包围盒可能是 0×0，`MediaBox [0 0 0 0]`
 * 在 Acrobat 里会报「文件已损坏」。
 */
export function pageSizePoints(widthPx: number, heightPx: number): { width: number; height: number } {
  const width = Number.isFinite(widthPx) ? widthPx * PX_TO_PT : 0;
  const height = Number.isFinite(heightPx) ? heightPx * PX_TO_PT : 0;
  return {
    width: Math.max(MIN_PAGE_POINTS, Math.round(width * 100) / 100),
    height: Math.max(MIN_PAGE_POINTS, Math.round(height * 100) / 100),
  };
}

const encoder = new TextEncoder();

function ascii(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * PDF 文本串。
 *
 * 纯 ASCII 走 `(…)` 字面量（`\` `(` `)` 要转义）；其余一律走 UTF-16BE 十六进制
 * 并带 BOM。PDF 的 `PDFDocEncoding` 不是 UTF-8，直接把 UTF-8 字节塞进字面量
 * 会让中文标题变成乱码——而标题是用户唯一能在阅读器「文档属性」里看到的东西。
 */
export function pdfTextString(value: string): string {
  // 允许的 ASCII 是 0x20–0x7E：控制字符在字面量里同样需要转义，不值得为它们
  // 单独写分支，直接走十六进制。
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) {
    return `(${value.replace(/[\\()]/g, (char) => `\\${char}`)})`;
  }
  const bytes: number[] = [0xfe, 0xff];
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0xffff) {
      const value16 = code - 0x10000;
      const high = 0xd800 + (value16 >> 10);
      const low = 0xdc00 + (value16 & 0x3ff);
      bytes.push(high >> 8, high & 0xff, low >> 8, low & 0xff);
    } else {
      bytes.push(code >> 8, code & 0xff);
    }
  }
  return `<${bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}>`;
}

/** PDF 日期串：`D:YYYYMMDDHHmmSSZ`（UTC）。 */
export function pdfDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * 拼一个单页 PDF。
 *
 * 对象编号固定，改结构时下面的 `XREF_SIZE` 也要跟着改：
 *
 * 1. Catalog
 * 2. Pages
 * 3. Page
 * 4. Contents（`q … cm /Im0 Do Q`）
 * 5. Image XObject（DCTDecode 透传 JPEG）
 * 6. Info
 */
export function buildImagePdf(input: PdfPageInput): Uint8Array {
  if (input.jpeg.length === 0) throw new Error('PDF 需要一张非空的 JPEG');
  if (input.imageWidth <= 0 || input.imageHeight <= 0) throw new Error('PDF 图像尺寸必须为正');
  if (input.pageWidth <= 0 || input.pageHeight <= 0) throw new Error('PDF 页面尺寸必须为正');

  const chunks: Uint8Array[] = [];
  let cursor = 0;
  const offsets: number[] = [];

  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    cursor += bytes.length;
  };
  const pushText = (text: string) => push(ascii(text));

  /** 开始一个间接对象，返回写入位置（供交叉引用表使用）。 */
  const beginObject = (id: number) => {
    offsets[id] = cursor;
    pushText(`${id} 0 obj\n`);
  };
  const endObject = () => pushText('endobj\n');

  // 头部。第二行那四个 >0x7F 的字节是「本文件是二进制」的标记：某些传输工具
  // 会按文本处理 PDF，没有这个标记就可能把字节流里的换行改掉。
  pushText('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // 1 — Catalog
  beginObject(1);
  pushText('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObject();

  // 2 — Pages
  beginObject(2);
  pushText('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n');
  endObject();

  // 3 — Page
  beginObject(3);
  pushText(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${input.pageWidth} ${input.pageHeight}]` +
      ' /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\n',
  );
  endObject();

  // 4 — Contents。`cm` 把 1×1 的单位图像铺满整页：PDF 的图像坐标系原点在左下，
  // 缩放矩阵写成 `w 0 0 h 0 0`，`Do` 之后就正好占满 MediaBox。
  const content = `q\n${input.pageWidth} 0 0 ${input.pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;
  const contentBytes = ascii(content);
  beginObject(4);
  pushText(`<< /Length ${contentBytes.length} >>\nstream\n`);
  push(contentBytes);
  pushText('endstream\n');
  endObject();

  // 5 — Image。JPEG 用 `/DCTDecode` 原样塞进去，PDF 阅读器自己解码。
  beginObject(5);
  pushText(
    `<< /Type /XObject /Subtype /Image /Width ${input.imageWidth} /Height ${input.imageHeight}` +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode' +
      ` /Length ${input.jpeg.length} >>\nstream\n`,
  );
  push(input.jpeg);
  pushText('\nendstream\n');
  endObject();

  // 6 — Info
  const info: string[] = [];
  if (input.title !== undefined && input.title !== '') info.push(`/Title ${pdfTextString(input.title)}`);
  if (input.creator !== undefined && input.creator !== '') {
    info.push(`/Creator ${pdfTextString(input.creator)}`);
    info.push(`/Producer ${pdfTextString(input.creator)}`);
  }
  info.push(`/CreationDate ${pdfTextString(pdfDate(input.createdAt ?? new Date()))}`);
  beginObject(6);
  pushText(`<< ${info.join(' ')} >>\n`);
  endObject();

  // 交叉引用表。每条恰好 20 字节（10 位偏移 + 空格 + 5 位代次 + 空格 + n + 空格 + 换行），
  // 少一个字节整个文件就废了——阅读器按固定步长读这张表，不按行读。
  const xrefOffset = cursor;
  const xrefSize = 7;
  pushText(`xref\n0 ${xrefSize}\n`);
  pushText('0000000000 65535 f \n');
  for (let id = 1; id < xrefSize; id += 1) {
    pushText(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  pushText(`trailer\n<< /Size ${xrefSize} /Root 1 0 R /Info 6 0 R >>\n`);
  pushText(`startxref\n${xrefOffset}\n%%EOF\n`);

  // 合并。预分配总长度而不是反复 concat：一张 4 倍倍率的图有几十兆，
  // 逐次拼接会把同一份数据复制几十遍。
  const out = new Uint8Array(cursor);
  let written = 0;
  for (const chunk of chunks) {
    out.set(chunk, written);
    written += chunk.length;
  }
  return out;
}

/**
 * 从 JPEG 字节里读出像素尺寸。
 *
 * 不用 `rasterizeSvg` 传进来的尺寸，而是从文件本身读：两者应当一致，不一致时
 * 说明编码环节有问题，让 PDF 里的 `/Width` 跟着文件走比跟着调用方走更安全——
 * 声明错了尺寸，阅读器要么拉伸要么裁切，而且完全不报错。
 *
 * 只认 SOF0–SOF15（排除 DHT=C4、JPG=C8、DAC=CC 这几个不是帧头的段）。
 * 不是 JPEG 时返回 `null`，调用方自己决定怎么报错。
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  // 循环条件只要求「够读一个段头」（标记 2 字节 + 长度 2 字节）；SOF 需要读到
  // 第 9 个字节，单独在那里判。原先这里写的是 `offset + 9 < length`，把
  // 「帧头恰好是最后一个段」的文件误判成解析失败——差一位的边界。
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    // 填充字节 0xFF 可以连续出现，跳过。
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // 无长度的段：TEM(01)、RST0–7(D0–D7)、SOI(D8)、EOI(D9)。
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > bytes.length) return null;
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    offset += 2 + length;
  }
  return null;
}
