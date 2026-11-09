/**
 * 外观偏好：light / dark / system 三档。
 *
 * 三档而不是两档：用户说「跟随系统」时，他期待的是**系统变化时页面跟着变**，
 * 而不是「首次打开时取一次系统值然后固定下来」。所以 system 档必须挂
 * matchMedia 的 change 监听。
 *
 * 首帧防闪烁靠 index.html 里的内联脚本（在 CSS 与 JS bundle 之前执行），
 * 这个模块只负责运行期的切换与持久化。两处的键名与判定逻辑必须一致，
 * 否则会出现「刷新后闪一下再变回来」。
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'wmind:theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 三档的展示顺序，也是切换按钮的循环顺序。 */
export const THEME_ORDER: ThemePreference[] = ['light', 'dark', 'system'];

/** 读取已保存的偏好；无值或值非法时回退到 system。 */
export function readThemePreference(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): ThemePreference {
  const raw = storage?.getItem(THEME_STORAGE_KEY) ?? null;
  return isThemePreference(raw) ? raw : 'system';
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * 把偏好解析成实际生效的主题。
 *
 * `systemPrefersDark` 由调用方传入而不是在这里读 matchMedia：
 * 这样这个函数是纯函数，测试不需要 mock 浏览器 API。
 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/** 循环切换：light → dark → system → light。 */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  const index = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? 'system';
}

/** 深色 / 浅色的地址栏颜色，与 styles.css 的 --background 一致。 */
export const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#f8fafc',
  dark: '#111521',
};

/** `applyResolvedTheme` 需要的最小 DOM 表面，便于在 node 环境里测试。 */
export interface ThemeTarget {
  classList: { toggle(token: string, force?: boolean): void };
}

/**
 * 把解析后的主题写到 <html> 的 class 与 meta[theme-color]。
 *
 * root 与 meta 作为参数注入（默认取真实 DOM）：测试因此不需要 jsdom，
 * 也不必为了一个四行的 DOM 写操作把整个测试环境换成浏览器模拟。
 */
export function applyResolvedTheme(
  theme: ResolvedTheme,
  root: ThemeTarget = document.documentElement,
  meta: { setAttribute(name: string, value: string): void } | null = document.querySelector('meta[name="theme-color"]'),
) {
  root.classList.toggle('dark', theme === 'dark');
  // 移动端地址栏颜色跟随主题，否则深色页面配浅色地址栏很割裂。
  meta?.setAttribute('content', THEME_COLORS[theme]);
}

export function persistThemePreference(preference: ThemePreference) {
  try {
    safeStorage()?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // 隐私模式下 localStorage 可能抛异常：主题仍在本会话生效，只是不持久。
  }
}

export function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches;
}

/**
 * 订阅系统主题变化，返回取消订阅函数。
 *
 * 不用 `addEventListener` 的兼容写法（旧 Safari 只有 addListener）：一期
 * 只支持现代浏览器，多一条分支就多一处不会被执行的代码。
 */
export function watchSystemTheme(onChange: (prefersDark: boolean) => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const query = matchMedia(DARK_QUERY);
  const handler = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
