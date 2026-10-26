import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/icon';
import type { AuditLog } from '@/lib/api/types';
import { formatDateTime, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { presentAuditLog } from './audit-presenter';

export function AuditRow({ log }: { log: AuditLog }) {
  const { t } = useTranslation();
  const event = presentAuditLog(log, t);
  return (
    <li data-audit-id={log.id} className="min-w-0">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 [&::-webkit-details-marker]:hidden">
          <span className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground',
            event.tone === 'danger' && 'bg-destructive/10 text-destructive', event.tone === 'warning' && 'bg-amber-500/10 text-amber-700 dark:text-amber-400')}>
            <Icon name={event.icon} className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm leading-6 [overflow-wrap:anywhere] group-open:line-clamp-none">{event.summary}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs leading-5 text-muted-foreground">
              <time dateTime={log.createdAt} title={formatDateTime(log.createdAt)}>{formatRelative(log.createdAt)}</time>
              <span aria-hidden="true">·</span>
              <span className="[overflow-wrap:anywhere]">{log.ip || t('admin.overview.unknownSource')}</span>
            </p>
          </div>
          <Icon name="chevron-down" className="mt-1.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <dl className="grid gap-x-5 gap-y-3 bg-muted/25 px-4 py-4 text-sm sm:grid-cols-2">
          {event.details.map((item) => (
            <div key={item.label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{item.label}</dt>
              <dd className="mt-1 [overflow-wrap:anywhere]">{item.value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </li>
  );
}
