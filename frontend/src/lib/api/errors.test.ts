import { describe, expect, it } from 'vitest';

import i18n from '@/lib/i18n';
import { ApiError, errorMessageKeys, resolveErrorMessage } from './errors';

describe('错误文案解析', () => {
  it('认识的错误码用本地文案，不看后端给的 message', () => {
    const message = resolveErrorMessage('AUTH_INVALID_CREDENTIALS', 'invalid credentials');
    expect(message).toBe(i18n.t('errors.AUTH_INVALID_CREDENTIALS'));
    expect(message).not.toBe('invalid credentials');
  });

  it('不认识的错误码退回后端给的 message', () => {
    expect(resolveErrorMessage('SOMETHING_NEW_FROM_SERVER', '后端新加的码')).toBe('后端新加的码');
  });

  it('两者都没有时给通用兜底，而不是空字符串', () => {
    expect(resolveErrorMessage('SOMETHING_NEW_FROM_SERVER', undefined)).toBe(i18n.t('errors.unknown'));
    expect(resolveErrorMessage('SOMETHING_NEW_FROM_SERVER', '')).toBe(i18n.t('errors.unknown'));
  });

  /*
    这条钉的是 i18next 的坑：找不到 key 时它**把 key 原样返回**（配置里
    `returnNull: false`），所以「t() 返回了非空字符串」不等于「翻译存在」。
    漏写一个 key 时界面会直接显示 `errors.XXX`，比英文更难查。
  */
  it('映射表里的每个 key 都真的存在于语言包', () => {
    for (const [code, key] of Object.entries(errorMessageKeys)) {
      expect(i18n.exists(key), `${code} → ${key} 在语言包里不存在`).toBe(true);
    }
  });

  it('两种语言都有同一套错误文案', () => {
    const zh = Object.keys(i18n.getResourceBundle('zh-CN', 'translation').errors).sort();
    const en = Object.keys(i18n.getResourceBundle('en-US', 'translation').errors).sort();
    expect(en).toEqual(zh);
  });

  it('ApiError 的 message 走本地文案，code 保留后端原值', () => {
    const error = new ApiError(
      { error: { code: 'MAP_NOT_FOUND', message: 'map not found' }, requestId: 'req-1' },
      404,
    );
    expect(error.message).toBe(i18n.t('errors.MAP_NOT_FOUND'));
    expect(error.code).toBe('MAP_NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.requestId).toBe('req-1');
  });
});
