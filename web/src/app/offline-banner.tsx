/**
 * 断网提示条。
 *
 * 只有一条规则：`navigator.onLine === false` 时显示，恢复后自动消失。
 *
 * 为什么值得单独做一个全局组件：断网时页面上的表现是**一组互不相干的失败**——
 * 列表加载失败、保存失败、缩略图没了、头像裂了。用户看到的是「这网站坏了」，
 * 而真实原因只有一个。把原因写在最显眼的位置，其余的失败就都解释得通了。
 *
 * 位置选在底部居中而不是顶部通栏：顶部通栏会把页头挤下去，而页头里有「保存
 * 状态」和「返回」，恰是断网时用户最需要看的地方。
 *
 * 用 `useSyncExternalStore` 而不是 `useEffect + useState`：`online` / `offline`
 * 是外部事件源，用 effect 订阅会在首次渲染时先给出一个错的 `true`（或者为了
 * 避免它而多写一个 state），而 `useSyncExternalStore` 在首帧读的就是真值。
 */

import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/icon';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** 是否在线。SSR / 非浏览器环境下恒为 true（没有 navigator 就当没断网）。 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (typeof navigator === 'undefined' ? true : navigator.onLine),
    () => true,
  );
}

export function OfflineBanner() {
  const { t } = useTranslation();
  const online = useOnline();
  if (online) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex max-w-md items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 shadow-sm backdrop-blur dark:text-amber-300">
        <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
        <span>{t('offline.message')}</span>
      </div>
    </div>
  );
}
