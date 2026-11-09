/**
 * 保存状态指示器。
 *
 * 放在页脚而不是标题栏（docs/01 FR-MAP-11 说标题栏）：标题栏已经被
 * 返回、标题、撤销重做、缩放、预览挤满，再塞一个会随状态变宽的文字块，
 * 窄屏下标题输入框会被压到只剩几十像素。页脚本来就有一行统计信息，
 * 而且离「刚编辑完」的视线更近。
 *
 * 五种状态都必须有明确文案：只显示一个小圆点的话，「保存中」和「保存失败」
 * 在用户眼里是一样的。
 */

import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/icon';
import { LoadingMark } from '@/components/ui/loading-mark';
import type { SaveState } from '@/editor/store/editor-store';

export interface SaveIndicatorProps {
  save: SaveState;
  onRetry: () => void;
  onResolveConflict: () => void;
}

export function SaveIndicator({ save, onRetry, onResolveConflict }: SaveIndicatorProps) {
  const { t } = useTranslation();

  if (save.status === 'saving') {
    return (
      <span className="inline-flex items-center gap-1.5" aria-live="polite">
        <LoadingMark size="inline" />
        {t('editor.save.saving')}
      </span>
    );
  }

  if (save.status === 'dirty') {
    return (
      <span className="inline-flex items-center gap-1.5" aria-live="polite">
        <span className="size-2 rounded-full bg-muted-foreground/50" />
        {t('editor.save.unsaved')}
      </span>
    );
  }

  if (save.status === 'error') {
    return (
      <button
        type="button"
        onClick={onRetry}
        title={save.error ?? undefined}
        className="inline-flex items-center gap-1.5 rounded text-destructive hover:underline"
      >
        <Icon name="alert" className="size-3.5" />
        {t('editor.save.failed')}
        <span className="underline underline-offset-2">{t('editor.save.retry')}</span>
      </button>
    );
  }

  if (save.status === 'conflict') {
    return (
      <button
        type="button"
        onClick={onResolveConflict}
        className="inline-flex items-center gap-1.5 rounded text-amber-600 hover:underline dark:text-amber-400"
      >
        <Icon name="alert" className="size-3.5" />
        {t('editor.save.conflict')}
      </button>
    );
  }

  if (save.status === 'saved') {
    return (
      <span className="inline-flex items-center gap-1.5" aria-live="polite">
        <Icon name="check" className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        {save.at ? t('editor.save.savedAt', { time: new Date(save.at).toLocaleTimeString() }) : t('editor.save.saved')}
      </span>
    );
  }

  // idle：本地文档（演示 / 压测）没有保存这回事，显示占位保持页脚三栏对齐。
  return <span aria-hidden="true">—</span>;
}
