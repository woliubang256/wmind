import { afterEach, describe, expect, it, vi } from 'vitest';
import { avatarFallback, gravatarUrl } from './avatar';

const user = { uid: 'person-1', username: 'alice', nickname: '', email: 'test@example.com' };
afterEach(() => vi.unstubAllGlobals());

describe('默认头像', () => {
  it('昵称优先，空白昵称回退用户名，保留完整 Unicode 字符', () => {
    expect(avatarFallback({ ...user, nickname: '  张三  ' }).initial).toBe('张');
    expect(avatarFallback({ ...user, nickname: '   ' }).initial).toBe('A');
    expect(avatarFallback({ ...user, nickname: '🌲tree' }).initial).toBe('🌲');
    expect(avatarFallback({ ...user, username: '' }).initial).toBe('?');
  });
  it('同一用户的颜色不随昵称、邮箱或重复渲染变化', () => {
    expect(avatarFallback(user).background).toBe(avatarFallback({ ...user, nickname: '李四', email: 'new@example.com' }).background);
  });
  it('不同用户分配多种背景，白色首字符的对比度至少 4.5:1', () => {
    const colors = new Set(Array.from({ length: 500 }, (_, i) => avatarFallback({ ...user, uid: `person-${i}` }).background));
    expect(colors.size).toBeGreaterThanOrEqual(6);
    for (const color of colors) {
      const rgb = color.slice(1).match(/../g)!.map((part) => parseInt(part, 16) / 255)
        .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('Gravatar 按规范化邮箱的 SHA-256 寻址，并要求不存在时返回 404', async () => {
    expect(await gravatarUrl(' Test@Example.COM ')).toBe('https://www.gravatar.com/avatar/973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b?s=128&d=404&r=g');
  });
  it('缺少邮箱不请求 Gravatar', async () => { expect(await gravatarUrl('   ')).toBeNull(); });
  it('Web Crypto 不可用时仍可使用本地首字符', async () => {
    vi.stubGlobal('crypto', undefined);
    expect(await gravatarUrl(user.email)).toBeNull();
    expect(avatarFallback(user).initial).toBe('A');
  });
});
