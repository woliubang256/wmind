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
import { readSharePasswordQuery, resolveShareUrl, shareAccessStorageKey, shareUrlForCopy } from './shares';

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

describe('share password URL', () => {
  it('相对或绝对链接加入编码密码，保留其他查询与hash', () => {
    const secret = 'Ab+ &?中文';
    const result = shareUrlForCopy({ url: '/s/abc?x=1&psw=old#sheet', hasPassword: true, password: secret });
    const url = new URL(result);
    expect(url.origin).toBe(ORIGIN);
    expect(url.searchParams.getAll('psw')).toEqual([secret]);
    expect(url.searchParams.get('x')).toBe('1');
    expect(url.hash).toBe('#sheet');
    expect(shareUrlForCopy({ url: 'https://other.example/s/x', hasPassword: true, password: 'Ab9x' })).toBe('https://other.example/s/x?psw=Ab9x');
  });
  it('无密码与旧哈希不附带密码，也不保留旧的psw', () => {
    for (const [hasPassword, password] of [[false, null], [true, null], [false, 'stale']] as const) {
      expect(shareUrlForCopy({ url: '/s/x?psw=stale&x=1', hasPassword, password })).toBe(`${ORIGIN}/s/x?x=1`);
    }
  });
  it('伪协议或带凭据的地址不附加秘密', () => {
    for (const url of ['javascript:alert(1)', 'mailto:a@b.c', 'https://user:pass@example.com/s/x']) {
      expect(shareUrlForCopy({ url, hasPassword: true, password: 'Ab9x' })).toBe(url);
    }
  });
  it('预填仅解码值，清除全部psw并保留其他查询', () => {
    expect(readSharePasswordQuery('?x=1&psw=Ab%2B9&psw=second&empty=')).toEqual({ password: 'Ab+9', search: '?x=1&empty=', present: true });
    expect(readSharePasswordQuery('?psw=')).toEqual({ password: '', search: '', present: true });
    expect(readSharePasswordQuery('')).toEqual({ password: '', search: '', present: false });
  });
  it('无效超长密码不预填但仍清除参数', () => {
    for (const password of ['a'.repeat(65), '中'.repeat(25)]) {
      expect(readSharePasswordQuery(`?psw=${encodeURIComponent(password)}`)).toEqual({ password: '', search: '', present: true });
    }
  });
});
