import { describe, expect, it } from 'vitest';
import {
  applyLocale,
  browserLanguages,
  FALLBACK_LOCALE,
  isLocalePreference,
  isSupportedLocale,
  LOCALE_ORDER,
  LOCALE_STORAGE_KEY,
  pickBrowserLocale,
  readLocalePreference,
  resolveLocale,
  SUPPORTED_LOCALES,
} from './preference';

/** 假 storage：只实现 getItem，够 `readLocalePreference` 用。 */
function storageWith(value: string | null) {
  return { getItem: (key: string) => (key === LOCALE_STORAGE_KEY ? value : null) };
}

describe('语言偏好', () => {
  it('没有存值时回退到 system', () => {
    expect(readLocalePreference(storageWith(null))).toBe('system');
    expect(readLocalePreference(undefined)).toBe('system');
  });

  it('存了具体语言就原样返回', () => {
    expect(readLocalePreference(storageWith('en-US'))).toBe('en-US');
    expect(readLocalePreference(storageWith('zh-CN'))).toBe('zh-CN');
    expect(readLocalePreference(storageWith('system'))).toBe('system');
  });

  it('存了非法值也回退到 system，不抛', () => {
    // 老版本存的 'en'、手改的 localStorage、别的实例留下的键名都可能出现。
    expect(readLocalePreference(storageWith('en'))).toBe('system');
    expect(readLocalePreference(storageWith('fr-FR'))).toBe('system');
    expect(readLocalePreference(storageWith(''))).toBe('system');
  });

  it('storage 本身抛异常时也能读', () => {
    const hostile = {
      getItem() {
        throw new Error('隐私模式');
      },
    };
    expect(readLocalePreference(hostile)).toBe('system');
  });

  it('isLocalePreference 认三种合法值', () => {
    expect(isLocalePreference('system')).toBe(true);
    expect(isLocalePreference('zh-CN')).toBe(true);
    expect(isLocalePreference('en-US')).toBe(true);
    expect(isLocalePreference('en')).toBe(false);
    expect(isLocalePreference(null)).toBe(false);
    expect(isLocalePreference(1)).toBe(false);
  });

  it('isSupportedLocale 只认语言包里的那两个', () => {
    expect(SUPPORTED_LOCALES).toEqual(['zh-CN', 'en-US']);
    expect(isSupportedLocale('zh-CN')).toBe(true);
    expect(isSupportedLocale('ja-JP')).toBe(false);
  });

  it('LOCALE_ORDER 覆盖全部偏好且不重复', () => {
    expect([...LOCALE_ORDER].sort()).toEqual(['en-US', 'system', 'zh-CN']);
  });
});

describe('pickBrowserLocale', () => {
  it('按主标签匹配，认 zh-Hans-CN / en-GB 这类变体', () => {
    expect(pickBrowserLocale(['zh-Hans-CN'])).toBe('zh-CN');
    expect(pickBrowserLocale(['en-GB'])).toBe('en-US');
    expect(pickBrowserLocale(['zh-TW'])).toBe('zh-CN');
  });

  it('取列表里第一个命中的，而不是优先级重排', () => {
    // 浏览器已经把用户偏好排好序了：先 en 就先给英文。
    expect(pickBrowserLocale(['en-US', 'zh-CN'])).toBe('en-US');
    expect(pickBrowserLocale(['zh-CN', 'en-US'])).toBe('zh-CN');
    expect(pickBrowserLocale(['fr-FR', 'en-US'])).toBe('en-US');
  });

  it('大小写不敏感', () => {
    expect(pickBrowserLocale(['EN-us'])).toBe('en-US');
  });

  it('一个都不认识时用兜底语言', () => {
    expect(pickBrowserLocale(['fr-FR', 'de-DE'])).toBe(FALLBACK_LOCALE);
    expect(pickBrowserLocale([])).toBe(FALLBACK_LOCALE);
  });
});

describe('resolveLocale', () => {
  it('显式选择优先于浏览器', () => {
    expect(resolveLocale('en-US', ['zh-CN'])).toBe('en-US');
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN');
  });

  it('system 档才看浏览器', () => {
    expect(resolveLocale('system', ['en-US'])).toBe('en-US');
    expect(resolveLocale('system', ['ja-JP'])).toBe(FALLBACK_LOCALE);
  });
});

describe('applyLocale', () => {
  it('把语言写到 html 的 lang 属性', () => {
    const calls: [string, string][] = [];
    applyLocale('en-US', { setAttribute: (name, value) => calls.push([name, value]) });
    expect(calls).toEqual([['lang', 'en-US']]);
  });

  it('没有 document 时静默跳过（node 环境）', () => {
    expect(() => applyLocale('zh-CN')).not.toThrow();
  });
});

describe('browserLanguages', () => {
  // 参数可注入：Node 22 自带 `navigator`（`language` 是 en-US），
  // 拿真实全局去断言「node 下没有 navigator」会随运行时版本变化而红。
  it('优先用 languages 列表', () => {
    expect(browserLanguages({ languages: ['fr-FR', 'en-GB'], language: 'fr-FR' })).toEqual([
      'fr-FR',
      'en-GB',
    ]);
  });

  it('languages 为空时退回 language', () => {
    expect(browserLanguages({ languages: [], language: 'en-US' })).toEqual(['en-US']);
  });

  it('两个都没有时用兜底语言', () => {
    expect(browserLanguages({ languages: [], language: '' })).toEqual([FALLBACK_LOCALE]);
  });

  it('不传参数时读运行时的 navigator，且结果非空', () => {
    // 显式传 `undefined` 会走默认值（= 真实 navigator），所以这里没法断言
    // 「node 下没有 navigator」——Node 22 自带一个。只断言形状：调用方拿到
    // 的永远是一个非空的语言列表，`system` 档才不会解析出空值。
    const languages = browserLanguages();
    expect(languages.length).toBeGreaterThan(0);
    expect(typeof languages[0]).toBe('string');
  });

  it('没有 window 时不采信 Node 自带的 navigator，退回中文', () => {
    // Node 21 起全局有 `navigator`，`language` 是 `en-US`。只看 `navigator`
    // 会让单测进程被当成英文浏览器，「跟随浏览器」解析成 en-US，一批断言
    // 中文文案的用例集体变红。判据必须是 `window`。
    expect(typeof window).toBe('undefined');
    expect(browserLanguages()).toEqual([FALLBACK_LOCALE]);
  });
});
