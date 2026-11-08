/**
 * 导图来源徽标（本地 / 已同步 / 有本地修改 / 有冲突 / 离线）。
 *
 * 只在桌面端渲染：Web 形态没有「本地导图」这回事。
 *
 * 颜色不是装饰，而是分级：冲突与离线需要用户注意（琥珀/红），本地与已同步
 * 只是陈述事实（灰/绿）。同时用文字而不只是颜色区分——色觉障碍用户与灰度
 * 截图里都要能读出来。
 */

import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { SourceLabel } from '@/lib/desktop';

const TONES: Record<SourceLabel, string> = {
  local: 'border-border/70 bg-card/95 text-muted-foreground',
  synced: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  dirty: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  conflict: 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300',
  offline: 'border-destructive/30 bg-destructive/10 text-destructive',
};

export function SourceBadge({ kind }: { kind: SourceLabel }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 shadow-sm backdrop-blur',
        TONES[kind],
      )}
    >
      {t(`desktop.source.${kind}`)}
    </span>
  );
}
