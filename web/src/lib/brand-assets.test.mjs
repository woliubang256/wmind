import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const logo = readFileSync(new URL('../../public/wmind-logo.jpg', import.meta.url));
const original = readFileSync(new URL('../../../docs/wmind_logo.png', import.meta.url));

function jpegDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 2; offset + 8 < bytes.length;) {
    if (bytes[offset] !== 0xff) throw new Error('无效的 JPEG 标记');
    const marker = bytes[offset + 1];
    if (marker === 0xc0 || marker === 0xc2) {
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) throw new Error('无效的 JPEG 数据段');
    offset += 2 + length;
  }
  throw new Error('未找到 JPEG 尺寸');
}

describe('网站 Logo 资源', () => {
  it('原始 PNG 保留在 docs，不使用网站压缩图替代', () => {
    expect([...original.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(original.buffer, original.byteOffset, original.byteLength);
    expect(view.getUint32(16)).toBe(1254);
    expect(view.getUint32(20)).toBe(1254);
  });

  it('现有 Logo 地址提供 256 像素小图，满足登录页高清屏显示', () => {
    expect([...logo.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect(jpegDimensions(logo)).toEqual({ width: 256, height: 256 });
  });

  it('网站小图控制在 16 KiB 内，不发布原始大图', () => {
    expect(logo.byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(logo.byteLength).toBeLessThan(original.byteLength / 20);
  });
});
