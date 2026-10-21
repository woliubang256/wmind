/**
 * 界面语言偏好：中文 / English / 跟随浏览器。
 *
 * 与外观（`app/theme.ts`）同一套结构：存一个偏好而不是直接存语言，因为
 * 「跟随浏览器」是真实需求——自托管实例的访客可能来自任何语言环境，
 * 让管理员替他们猜是错的。
 *
 * **为什么偏好要落在 localStorage 而不是用户表**：语言是这台设备上的阅读
 * 习惯，不是账号属性。同一个人在办公室的大屏和家里的笔记本上可能想要不同
 * 语言，而为一件事加一个后端字段要动迁移、接口、设置校验四处。
 *
 * 放在 `lib/i18n/` 而不是 `app/`：`lib/i18n/index.ts` 要在 init 时读这份偏好，
 * 而 lib 不该反过来依赖 app。React 侧的 store 在 `app/locale-store.ts`。
 *
 * 与主题不同的是：主题有「首帧防闪烁」的要求，必须在 index.html 的内联脚本
 * 里就定下来；语言没有这个问题——第一帧渲染出来之前 React 还没挂载，任何
 * 文案都还不在 DOM 里。所以这里可以放心地在 `i18n.init` 时同步读。
 */

/** 支持的界面语言。加语言时同时改这里、语言包与 `SUPPORTED_LOCALES`。 */
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** 用户偏好：两种具体语言 + 跟随浏览器。 */
export type LocalePreference = SupportedLocale | 'system';

export const LOCALE_STORAGE_KEY = 'wmind:locale';

/** 展示顺序，也是分段控件的顺序。 */
export const LOCALE_ORDER: LocalePreference[] = ['system', 'zh-CN', 'en-US'];

/** 兜底语言：既不是中文也不是英文的浏览器，看到中文。 */
export const FALLBACK_LOCALE: SupportedLocale = 'zh-CN';

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system' || isSupportedLocale(value);
}

/** 读取已保存的偏好；无值或值非法时回退到 system。 */
export function readLocalePreference(
  storage: Pick<Storage, 'getItem'> | undefined = safeStorage(),
): LocalePreference {
  // `getItem` 本身也可能抛：隐私插件、被策略禁用的 storage、某些嵌入式 WebView。
  // 读不到偏好不是错误，退回 system 就行——让它在模块加载期抛出去，整个应用
  // 都起不来。
  let raw: string | null = null;
  try {
    raw = storage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  return isLocalePreference(raw) ? raw : 'system';
}

/**
 * 从浏览器的语言列表里挑一个支持的语言。
 *
 * 只比主标签（`zh` / `en`）而不是全串：`zh-Hans-CN`、`zh-TW`、`en-GB` 都该
 * 命中，而 `SUPPORTED_LOCALES` 里写的是 `zh-CN` / `en-US`。按列表**顺序**取
 * 第一个命中的——浏览器已经按用户偏好排好序了，重新排序只会猜错。
 */
export function pickBrowserLocale(languages: readonly string[]): SupportedLocale {
  for (const tag of languages) {
    const primary = tag.toLowerCase().split('-')[0];
    const hit = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === primary);
    if (hit !== undefined) return hit;
  }
  return FALLBACK_LOCALE;
}

/** 把偏好解析成实际生效的语言。 */
export function resolveLocale(
  preference: LocalePreference,
  browserLanguages: readonly string[],
): SupportedLocale {
  if (preference !== 'system') return preference;
  return pickBrowserLocale(browserLanguages);
}

export function persistLocalePreference(preference: LocalePreference) {
  try {
    safeStorage()?.setItem(LOCALE_STORAGE_KEY, preference);
  } catch {
    // 隐私模式下 localStorage 可能抛：语言仍在本会话生效，只是不持久。
  }
}

/**
 * 浏览器语言列表。
 *
 * `navigator.languages` 在个别环境下是空数组（隐私插件、某些 WebView），
 * 这时退回 `navigator.language`，再退回中文——三层兜底，否则 `system` 档
 * 会解析出 `undefined`。
 */
export function browserLanguages(
  nav: Pick<Navigator, 'languages' | 'language'> | undefined = defaultNavigator(),
): string[] {
  if (nav === undefined) return [FALLBACK_LOCALE];
  if (Array.isArray(nav.languages) && nav.languages.length > 0) return [...nav.languages];
  if (typeof nav.language === 'string' && nav.language !== '') return [nav.language];
  return [FALLBACK_LOCALE];
}

/**
 * 拿浏览器的语言对象，没有浏览器时返回 undefined。
 *
 * 判据是 `window`，不是 `navigator`：Node 21 起全局也有 `navigator`，且
 * `language` 是 `en-US`。只看 `navigator` 的话，跑单测时「跟随浏览器」这一档
 * 会解析成英文——一批断言中文文案的用例集体变红，而报错看起来像是产品坏了，
 * 实际上是测试进程被当成了英文浏览器。没有 `window` 就没有「浏览器偏好」
 * 可言，退回中文才是对的。
 */
function defaultNavigator(): Pick<Navigator, 'languages' | 'language'> | undefined {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return undefined;
  return navigator;
}

/** `<html lang>` 需要的最小 DOM 表面，便于测试。 */
export interface LangTarget {
  setAttribute(name: string, value: string): void;
}

/**
 * 同步 `<html lang>`。
 *
 * 不只是为了「语义正确」：读屏器按 `lang` 选发音引擎，中文内容标成 `en` 会被
 * 用英文音库念出来；`Intl` 的默认 locale 在某些实现里也跟着它走。
 */
export function applyLocale(locale: SupportedLocale, root?: LangTarget): void {
  // 默认值写成 `root?: LangTarget` 而不是 `= document.documentElement`：
  // 后者在 node（单测）里求值就会抛 ReferenceError，而这个模块被
  // `lib/i18n/index.ts` 在模块顶层调用——一抛就是整个测试文件挂掉。
  const target = root ?? (typeof document === 'undefined' ? undefined : document.documentElement);
  target?.setAttribute('lang', locale);
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
