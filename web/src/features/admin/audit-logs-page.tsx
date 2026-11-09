import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { SelectField, TextField } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/loading-state';
import { EmptyState, PageHeader, Panel } from '@/components/ui/panel';
import { adminApi, type AuditLogQuery } from '@/lib/api/endpoints';
import { formatNumber } from '@/lib/format';
import { adminKeys } from './queries';
import { AuditRow } from './audit-row';
import { AUDIT_ACTIONS } from './audit-presenter';
import { AUDIT_PAGE_SIZE, buildAuditLogQuery, type AuditFilterError, type AuditFilters } from './audit-filters';

const EMPTY_FILTERS: AuditFilters = { action: '', from: '', to: '' };

export function AdminAuditLogsPage() {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<AuditLogQuery>({ page: 1, pageSize: AUDIT_PAGE_SIZE });
  const [error, setError] = useState<AuditFilterError | null>(null);
  const logs = useQuery({
    queryKey: adminKeys.audit(filters),
    queryFn: () => adminApi.auditLogs(filters),
  });
  const items = logs.data?.items ?? [];
  const pagination = logs.data?.pagination;
  const actionOptions = [
    { value: '', label: t('admin.audit.allActions') },
    ...AUDIT_ACTIONS.map(({ value, labelKey }) => ({ value, label: t(labelKey) })),
  ];

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // A partially typed native date reports an empty value with badInput=true.
    if ([...event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="date"]')].some((input) => !input.validity.valid)) {
      setError('invalidDate');
      return;
    }
    const result = buildAuditLogQuery(draft);
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setFilters(result.query);
  };

  const reset = () => {
    setDraft(EMPTY_FILTERS);
    setError(null);
    setFilters({ page: 1, pageSize: AUDIT_PAGE_SIZE });
  };

  return (
    <div className="space-y-5">
      <PageHeader title={t('admin.audit.title')} actions={
        <Button size="sm" variant="outline" loading={logs.isFetching} onClick={() => void logs.refetch()}>
          <Icon name="clock" className="size-4" />
          {logs.isFetching ? t('common.refreshing') : t('common.refresh')}
        </Button>
      } />
      <Panel bodyClassName="p-0" footer={
        !logs.isPending && !logs.isError && pagination && pagination.total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>
              {t('admin.audit.total', { count: pagination.total })}
              {pagination.totalPages > 1 ? ` · ${t('admin.audit.page', { page: formatNumber(pagination.page), total: formatNumber(pagination.totalPages) })}` : ''}
            </span>
            {pagination.totalPages > 1 ? <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={logs.isFetching || pagination.page <= 1}
                onClick={() => setFilters((current) => ({ ...current, page: Math.max(1, (current.page ?? 1) - 1) }))}>
                <Icon name="chevron-left" className="size-4" />
                {t('admin.audit.prev')}
              </Button>
              <Button variant="outline" size="sm" disabled={logs.isFetching || pagination.page >= pagination.totalPages}
                onClick={() => setFilters((current) => ({ ...current, page: (current.page ?? 1) + 1 }))}>
                {t('admin.audit.next')}
                <Icon name="chevron-right" className="size-4" />
              </Button>
            </div> : null}
          </div>
        ) : undefined
      }>
        <form onSubmit={apply} onReset={reset} noValidate className="grid gap-3 border-b border-border/70 px-5 py-4 sm:grid-cols-2 lg:grid-cols-[minmax(10rem,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <SelectField label={t('admin.audit.action')} value={draft.action} options={actionOptions}
            onChange={(action) => setDraft((current) => ({ ...current, action }))} />
          <TextField label={t('admin.audit.from')} type="date" value={draft.from}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} />
          <TextField label={t('admin.audit.to')} type="date" value={draft.to}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} />
          <div className="flex items-end gap-2">
            <Button type="submit" className="h-11 flex-1 lg:flex-none">{t('admin.audit.apply')}</Button>
            <Button type="reset" variant="ghost" className="h-11 flex-1 lg:flex-none">{t('admin.audit.reset')}</Button>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive sm:col-span-2 lg:col-span-4">{t(`admin.audit.${error}`)}</p> : null}
        </form>
        {logs.isError ? (
          <div className="p-5"><EmptyState icon="alert" title={t('admin.audit.loadFailed')}
            action={<Button variant="outline" onClick={() => void logs.refetch()}>{t('common.retry')}</Button>} /></div>
        ) : logs.isPending ? (
          <LoadingState small className="min-h-48" />
        ) : items.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">{t('admin.audit.empty')}</p>
        ) : (
          <ul className="divide-y divide-border/70" aria-busy={logs.isFetching}>
            {items.map((log) => <AuditRow key={log.id} log={log} />)}
          </ul>
        )}
      </Panel>
    </div>
  );
}
