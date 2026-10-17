import { useEffect } from 'react';
import { create } from 'zustand';
import {
  applyResolvedTheme,
  nextThemePreference,
  persistThemePreference,
  readThemePreference,
  resolveTheme,
  systemPrefersDark,
  watchSystemTheme,
  type ResolvedTheme,
  type ThemePreference,
} from './theme';

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  /** 当前系统是否深色。system 档下它变化会带动 resolved 变化。 */
  systemDark: boolean;
  setPreference: (preference: ThemePreference) => void;
  /** 循环 light → dark → system，供顶栏按钮使用。 */
  cycle: () => void;
  setSystemDark: (dark: boolean) => void;
}

/**
 * 外观状态放在模块级 store 里，而不是每个组件各自 useState。
 *
 * 顶栏的切换按钮与「个人设置 → 外观」是两处入口，各自持有一份状态时
 * 会出现「在设置页切了，顶栏图标没变」——直到刷新才对上。
 */
export const useThemeStore = create<ThemeState>((set, get) => ({
  // 初始值来自 localStorage；首帧的 class 已由 index.html 的内联脚本写好，
  // 这里只是把同一份判定结果读进 React 状态。
  preference: readThemePreference(),
  systemDark: systemPrefersDark(),
  resolved: resolveTheme(readThemePreference(), systemPrefersDark()),

  setPreference: (preference) => {
    const resolved = resolveTheme(preference, get().systemDark);
    persistThemePreference(preference);
    applyResolvedTheme(resolved);
    set({ preference, resolved });
  },

  cycle: () => {
    get().setPreference(nextThemePreference(get().preference));
  },

  setSystemDark: (dark) => {
    const { preference, systemDark } = get();
    if (dark === systemDark) return;
    // 只有 system 档需要跟着系统变；显式档位忽略系统变化。
    const resolved = resolveTheme(preference, dark);
    if (preference === 'system') applyResolvedTheme(resolved);
    set({ systemDark: dark, resolved });
  },
}));

/**
 * 订阅系统主题变化。在应用根部调用一次即可。
 *
 * 用 effect 而不是在 store 创建时订阅：模块加载发生在任何渲染之前，
 * 那时订阅会泄漏一个永远不会被清理的监听（HMR 时会叠加多个）。
 */
export function useSystemThemeSync() {
  const setSystemDark = useThemeStore((state) => state.setSystemDark);
  useEffect(() => watchSystemTheme(setSystemDark), [setSystemDark]);
}
