import { useEffect } from 'react';
import { create } from 'zustand';
import {
  applyLocale,
  browserLanguages,
  persistLocalePreference,
  readLocalePreference,
  resolveLocale,
  type LocalePreference,
  type SupportedLocale,
} from '@/lib/i18n/preference';
import i18n from '@/lib/i18n';

interface LocaleState {
  preference: LocalePreference;
  /** 当前实际生效的语言。 */
  locale: SupportedLocale;
  setPreference: (preference: LocalePreference) => void;
  /** 浏览器语言变化（极少见，但用户装了语言切换插件时会发生）。 */
  syncWithBrowser: () => void;
}

/**
 * 语言状态放在模块级 store 里，登录页与全站顶栏共用偏好，
 * 页面切换和浏览器语言变化都同步到同一个 i18n 实例。
 *
 * 初始值取自 i18n 实例而不是重新读一遍 localStorage：`lib/i18n/index.ts` 在
 * 模块加载时已经解析过一次，再算一次等于给「两处判定不一致」留了口子。
 */
export const useLocaleStore = create<LocaleState>((set, get) => ({
  preference: readLocalePreference(),
  locale: i18n.language === 'en-US' ? 'en-US' : 'zh-CN',

  setPreference: (preference) => {
    const locale = resolveLocale(preference, browserLanguages());
    persistLocalePreference(preference);
    applyLocale(locale);
    void i18n.changeLanguage(locale);
    set({ preference, locale });
  },

  syncWithBrowser: () => {
    if (get().preference !== 'system') return;
    const locale = resolveLocale('system', browserLanguages());
    if (locale === get().locale) return;
    applyLocale(locale);
    void i18n.changeLanguage(locale);
    set({ locale });
  },
}));

/**
 * 跟随系统档下，浏览器语言变了要跟着切。
 *
 * 只在 `system` 档生效；显式选了语言的人不该被浏览器的变化打断。
 */
export function useBrowserLocaleSync() {
  const syncWithBrowser = useLocaleStore((state) => state.syncWithBrowser);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('languagechange', syncWithBrowser);
    return () => window.removeEventListener('languagechange', syncWithBrowser);
  }, [syncWithBrowser]);
}
