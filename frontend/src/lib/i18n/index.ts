import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enUS from './locales/en-US.json';
import zhCN from './locales/zh-CN.json';
import { applyLocale, browserLanguages, readLocalePreference, resolveLocale } from './preference';

/**
 * 初始语言：读设备上的偏好，`system` 档再问浏览器。
 *
 * 在这里同步决定而不是等某个组件挂载后再 `changeLanguage`：后者会让首屏先
 * 按默认语言渲染一遍，然后当着用户的面整页换字。语言没有主题那种「必须内联
 * 脚本防闪烁」的紧迫性，但同样不该闪。
 */
const initialLocale = resolveLocale(readLocalePreference(), browserLanguages());

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  lng: initialLocale,
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
  returnNull: false,
});

// `<html lang>` 与 i18n 语言必须一起变：读屏器按它选发音引擎，`Intl` 的默认
// locale 在部分实现里也跟着它走。init 里没法挂事件，所以在这里同步一次 +
// 订阅后续变化。
applyLocale(initialLocale);
i18n.on('languageChanged', (language) => {
  applyLocale(language === 'en-US' ? 'en-US' : 'zh-CN');
});

export default i18n;
