import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { LoadingMark } from './loading-mark';

/** 同一个加载状态只提供一份可访问文字；图形本身不重复朗读。 */
export function LoadingState({ label, small = false, inline = false, tone = 'default', className }: {
  label?: string;
  small?: boolean;
  inline?: boolean;
  tone?: 'default' | 'soft';
  className?: string;
}) {
  const { t } = useTranslation();
  const text = label ?? t('common.loading');
  if (inline) return <span role="status" className={cn('inline-flex items-center gap-2 text-sm text-muted-foreground', className)}>
    <LoadingMark size="inline" tone={tone} /><span>{text}</span>
  </span>;
  return <div role="status" className={cn('flex flex-col items-center justify-center text-sm text-muted-foreground', small ? 'gap-3' : 'gap-4', className)}>
    <LoadingMark size={small ? 'small' : 'default'} tone={tone} /><p>{text}</p>
  </div>;
}
