import { describe, expect, it } from 'vitest';
import { buildImagePdf, jpegSize, pageSizePoints, pdfDate, pdfTextString, PX_TO_PT } from './pdf';

/** 造一个只有 SOI + SOF0 + EOI 的「JPEG」，够 `jpegSize` 解析就行。 */
function fakeJpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0, // SOF0
    0x00,
    0x11, // 段长 17
    0x08, // 精度
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03, // 分量数
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9, // EOI
  ]);
}

/** 把字节流按 latin1 解成字符串，便于断言结构。 */
function text(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
}

/** 从 `startxref` 后面读偏移，再核对那张表。 */
function readXref(bytes: Uint8Array): { offset: number; entries: number[] } {
  const source = text(bytes);
  const marker = source.lastIndexOf('startxref');
  expect(marker).toBeGreaterThan(0);
  const offset = Number(/startxref\s+(\d+)/.exec(source.slice(marker))?.[1]);
  expect(source.slice(offset, offset + 4)).toBe('xref');
  const header = /xref\s+0\s+(\d+)\s/.exec(source.slice(offset));
  const count = Number(header?.[1]);
  const entries: number[] = [];
  let cursor = offset + header![0].length;
  for (let index = 0; index < count; index += 1) {
    entries.push(Number(source.slice(cursor, cursor + 10)));
    cursor += 20;
  }
  return { offset, entries };
}

const BASE = {
  jpeg: fakeJpeg(200, 100),
  imageWidth: 200,
  imageHeight: 100,
  pageWidth: 300,
  pageHeight: 150,
  title: 'Quarterly plan',
  creator: 'wmind',
  createdAt: new Date('2026-10-21T06:30:00Z'),
};

describe('pdfTextString', () => {
  it('纯 ASCII 走字面量', () => {
    expect(pdfTextString('Quarterly plan')).toBe('(Quarterly plan)');
  });

  it('转义反斜杠与括号', () => {
    expect(pdfTextString('a(b)c\\d')).toBe('(a\\(b\\)c\\\\d)');
  });

  it('非 ASCII 走 UTF-16BE 十六进制并带 BOM', () => {
    // 「季」= U+5B63
    expect(pdfTextString('季')).toBe('<feff5b63>');
  });

  it('补充平面字符编成代理对', () => {
    // U+1F600 → D83D DE00
    expect(pdfTextString('😀')).toBe('<feffd83dde00>');
  });

  it('空串给一对空括号', () => {
    expect(pdfTextString('')).toBe('()');
  });
});

describe('pdfDate', () => {
  it('输出 PDF 的 D: 格式，用 UTC', () => {
    expect(pdfDate(new Date('2026-10-21T06:30:05Z'))).toBe('D:20261021063005Z');
  });
});

describe('pageSizePoints', () => {
  it('CSS 像素按 96→72 DPI 折算', () => {
    expect(pageSizePoints(1200, 800)).toEqual({ width: 900, height: 600 });
    expect(PX_TO_PT).toBe(0.75);
  });

  it('保留两位小数', () => {
    expect(pageSizePoints(101, 101)).toEqual({ width: 75.75, height: 75.75 });
  });

  it('0 或非法值夹到下限，避免 MediaBox 全零', () => {
    expect(pageSizePoints(0, 0)).toEqual({ width: 1, height: 1 });
    expect(pageSizePoints(Number.NaN, -5)).toEqual({ width: 1, height: 1 });
  });
});

describe('jpegSize', () => {
  it('从 SOF0 读出宽高', () => {
    expect(jpegSize(fakeJpeg(1234, 567))).toEqual({ width: 1234, height: 567 });
  });

  it('不是 JPEG 时返回 null', () => {
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(jpegSize(new Uint8Array())).toBeNull();
  });

  it('跳过 DHT（0xC4）这类非帧头段', () => {
    const bytes = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xc4, // DHT
      0x00,
      0x04,
      0x00,
      0x00, // 段长 4，内容 2 字节
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      0x00,
      0x40, // 高 64
      0x00,
      0x50, // 宽 80
    ]);
    expect(jpegSize(bytes)).toEqual({ width: 80, height: 64 });
  });

  it('没有帧头时返回 null', () => {
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});

describe('buildImagePdf', () => {
  it('生成合法的头尾与交叉引用表', () => {
    const bytes = buildImagePdf(BASE);
    const source = text(bytes);

    expect(source.startsWith('%PDF-1.4\n')).toBe(true);
    expect(source.endsWith('%%EOF\n')).toBe(true);

    const { entries } = readXref(bytes);
    // 1 个 free + 6 个在用对象。
    expect(entries).toHaveLength(7);
    expect(entries[0]).toBe(0);
    for (let id = 1; id <= 6; id += 1) {
      const offset = entries[id]!;
      expect(source.slice(offset, offset + 7)).toBe(`${id} 0 obj`);
    }
  });

  it('trailer 的 Size 与 Root 对得上', () => {
    const source = text(buildImagePdf(BASE));
    expect(source).toContain('trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>');
    expect(source).toContain('<< /Type /Catalog /Pages 2 0 R >>');
    expect(source).toContain('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  });

  it('MediaBox 用传入的 point 尺寸', () => {
    expect(text(buildImagePdf(BASE))).toContain('/MediaBox [0 0 300 150]');
  });

  it('图像字典声明真实像素与 DCTDecode', () => {
    const source = text(buildImagePdf(BASE));
    expect(source).toContain('/Width 200 /Height 100');
    expect(source).toContain('/Filter /DCTDecode');
  });

  it('JPEG 字节原样出现在流里，且 Length 等于字节数', () => {
    const bytes = buildImagePdf(BASE);
    const source = text(bytes);
    const start = source.indexOf('stream\n', source.indexOf('/DCTDecode'));
    const payload = source.slice(start + 'stream\n'.length, start + 'stream\n'.length + BASE.jpeg.length);
    expect(Array.from(payload, (char) => char.charCodeAt(0))).toEqual(Array.from(BASE.jpeg));
    expect(source).toContain(`/Length ${BASE.jpeg.length} >>`);
  });

  it('内容流把单位图像铺满整页', () => {
    const source = text(buildImagePdf(BASE));
    expect(source).toContain('300 0 0 150 0 0 cm');
    expect(source).toContain('/Im0 Do');
  });

  it('中文标题写成 UTF-16BE 十六进制', () => {
    const source = text(buildImagePdf({ ...BASE, title: '季度计划' }));
    expect(source).toContain('/Title <feff');
    expect(source).not.toContain('季度计划');
  });

  it('ASCII 标题写成字面量', () => {
    expect(text(buildImagePdf(BASE))).toContain('/Title (Quarterly plan)');
  });

  it('Info 里带创建时间', () => {
    expect(text(buildImagePdf(BASE))).toContain('/CreationDate (D:20261021063000Z)');
  });

  it('Creator 与 Producer 都写，但不写空串', () => {
    const withCreator = text(buildImagePdf(BASE));
    expect(withCreator).toContain('/Creator (wmind)');
    expect(withCreator).toContain('/Producer (wmind)');

    const without = text(buildImagePdf({ ...BASE, creator: '' }));
    expect(without).not.toContain('/Creator');
  });

  it('空 JPEG 与非法尺寸直接报错，不产出坏文件', () => {
    expect(() => buildImagePdf({ ...BASE, jpeg: new Uint8Array() })).toThrow();
    expect(() => buildImagePdf({ ...BASE, imageWidth: 0 })).toThrow();
    expect(() => buildImagePdf({ ...BASE, pageHeight: -1 })).toThrow();
  });

  it('每个交叉引用条目恰好 20 字节', () => {
    const bytes = buildImagePdf(BASE);
    const { offset } = readXref(bytes);
    const source = text(bytes);
    const header = /xref\s+0\s+\d+\s/.exec(source.slice(offset))!;
    const tableStart = offset + header[0].length;
    // 7 条 × 20 字节之后紧接着 trailer。
    expect(source.slice(tableStart + 7 * 20, tableStart + 7 * 20 + 8)).toBe('trailer\n');
  });
});
