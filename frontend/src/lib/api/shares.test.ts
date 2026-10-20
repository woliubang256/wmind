/**
 * 分享接口里的纯函数测试。
 *
 * 只有 `resolveShareUrl` 值得单测：它是唯一一处「后端给的值 → 用户看到的值」
 * 的字符串变换，其余都是对 fetch 的直通，测它们只是在测 mock。
 *
 * 测试跑在 node 环境（没有 jsdom），所以这里临时挂一个 `window` 桩：函数
 * 只读 `location.origin` 一个字段，桩得足够小就不会掩盖问题。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveShareUrl, shareAccessStorageKey } from './shares';

const ORIGIN = 'https://wmind.example.com';

beforeAll(() => {
  (globalThis as { window?: unknown }).window = { location: { origin: ORIGIN } };
});

afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('resolveShareUrl', () => {
  it('站点没配 base_url 时把相对路径补成绝对地址', () => {
    expect(resolveShareUrl('/s/kJ8xQ2mNp4Vt7Zs1Rw9YbC')).toBe(`${ORIGIN}/s/kJ8xQ2mNp4Vt7Zs1Rw9YbC`);
  });

  it('缺前导斜杠也能补对', () => {
    expect(resolveShareUrl('s/abc')).toBe(`${ORIGIN}/s/abc`);
  });

  it('站点配了 base_url 时原样返回', () => {
    const absolute = 'https://maps.example.org/s/abc';
    expect(resolveShareUrl(absolute)).toBe(absolute);
  });

  it('不把伪协议拼到 origin 后面', () => {
    // 这个值只会进 <code> 文本与剪贴板，不进 href；但把 `javascript:…`
    // 拼成 `https://site/javascript:…` 会让用户复制到一个假链接，
    // 所以带 scheme 的一律原样返回。
    expect(resolveShareUrl('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(resolveShareUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
  });
});

describe('shareAccessStorageKey', () => {
  it('按令牌分键，两个分享互不覆盖', () => {
    expect(shareAccessStorageKey('aaa')).not.toBe(shareAccessStorageKey('bbb'));
    expect(shareAccessStorageKey('aaa')).toBe('wmind:share-access:aaa');
  });
});
