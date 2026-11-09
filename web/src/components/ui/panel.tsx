import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './icon';

interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  /** 标题右侧的操作区（按钮、筛选器）。 */
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/**
 * 内容面板：圆角卡片 + 可选标题栏。
 *
 * 个人设置与管理后台的每个区块都用它，免得「有的卡片有边框、有的没有」
 * 这种靠肉眼维护的一致性。
 */
export function Panel({ title, description, actions, footer, children, className, bodyClassName }: PanelProps) {
  const hasHeader = Boolean(title || actions);
  return (
    <section className={cn('overflow-hidden rounded-2xl border border-border/70 bg-card', className)}>
      {hasHeader ? (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-5 py-4">
          <div className="min-w-0">
            {title ? <h2 className="text-base font-semibold">{title}</h2> : null}
            {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn('p-5', bodyClassName)}>{children}</div>
      {footer ? <div className="border-t border-border/70 px-5 py-3">{footer}</div> : null}
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  primary: 'bg-primary/10 text-primary',
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  danger: 'bg-destructive/10 text-destructive',
};

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', BADGE_TONES[tone])}>
      {children}
    </span>
  );
}

export function EmptyState({
  icon = 'files',
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-card/40 px-6 py-12 text-center">
      <div className="max-w-sm">
        <span className="mx-auto grid size-11 place-items-center rounded-2xl bg-secondary text-secondary-foreground">
          <Icon name={icon} className="size-5" />
        </span>
        <p className="mt-4 font-medium">{title}</p>
        {description ? <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p> : null}
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}
