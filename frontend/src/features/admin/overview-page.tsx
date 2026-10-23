import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { Badge, EmptyState, PageHeader, Panel } from '@/components/ui/panel';
import { adminApi } from '@/lib/api/endpoints';
import type { AuditLog } from '@/lib/api/types';
import { formatBytes, formatDateTime, formatDayMonth, formatList, formatNumber, formatRelative } from '@/lib/format';
import { adminKeys } from './queries';

/**
 * 审计动作 → i18n key。
 *
 * 不写成 `t('admin.audit.' + action)`：动作名本身带点（`user.create`），拼出来
 * 的键要先按分隔符切开再逐级找，找不到还得回退到扁平查找——中间任何一步的
 * 行为差异都会让某个动作在某种语言下露出原始英文动作名。显式映射查不到时
 * 直接退回动作名，行为可预期。
 */
const ACTION_LABEL: Record<string, string> = {
  'user.create': 'admin.audit.createUser',
  'user.update': 'admin.audit.updateUser',
  'user.disable': 'admin.audit.disableUser',
  'user.enable': 'admin.audit.enableUser',
  'user.delete': 'admin.audit.deleteUser',
  'user.role': 'admin.audit.changeRole',
  'user.reset_password': 'admin.audit.resetPassword',
  'settings.update': 'admin.audit.updateSettings',
};

const ACTION_TONE: Record<string, 'primary' | 'warning' | 'danger' | 'neutral'> = {
  'user.create': 'primary',
  'user.disable': 'warning',
  'user.delete': 'danger',
  'user.reset_password': 'warning',
  'settings.update': 'neutral',
};

export function AdminOverviewPage() {
  const { t } = useTranslation();
  const stats = useQuery({ queryKey: adminKeys.stats, queryFn: adminApi.stats });
  const auditQuery = { page: 1, pageSize: 8 };
  const audit = useQuery({
    queryKey: adminKeys.audit(auditQuery),
    queryFn: () => adminApi.auditLogs(auditQuery),
  });

  const data = stats.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('admin.overview.title')}
        actions={
          <Button variant="outline" size="sm" onClick={() => void stats.refetch()} disabled={stats.isFetching}>
            <Icon name="clock" className="size-4" />
            {stats.isFetching ? t('admin.overview.refreshing') : t('admin.overview.refresh')}
          </Button>
        }
      />

      {stats.isError ? (
        <EmptyState
          icon="alert"
          title={t('admin.overview.statsFailed')}
          description={stats.error instanceof Error ? stats.error.message : undefined}
          action={
            <Button variant="outline" size="sm" onClick={() => void stats.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon="users" label={t('admin.overview.userCount')} value={formatNumber(data?.userCount ?? 0)} />
          <StatCard
            icon="check"
            label={t('admin.overview.activeUserCount')}
            value={formatNumber(data?.activeUserCount ?? 0)}
          />
          <StatCard icon="waypoints" label={t('admin.overview.mapCount')} value={formatNumber(data?.mapCount ?? 0)} />
          <StatCard
            icon="image"
            label={t('admin.overview.storageUsed')}
            value={formatBytes(data?.storageUsedBytes ?? 0)}
          />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel
          title={t('admin.overview.trendTitle')}
          description={
            data
              ? t('admin.overview.trendToday', { count: formatNumber(data.mapCountToday) })
              : t('common.loading')
          }
        >
          <TrendChart points={data?.trend ?? []} />
        </Panel>

        <Panel
          title={t('admin.overview.auditTitle')}
          actions={
            <Badge tone="neutral">
              {t('admin.overview.auditCount', { count: formatNumber(audit.data?.pagination.total ?? 0) })}
            </Badge>
          }
          bodyClassName="p-0"
        >
          {audit.isError ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">{t('admin.overview.auditFailed')}</p>
          ) : (audit.data?.items.length ?? 0) === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">{t('admin.overview.auditEmpty')}</p>
          ) : (
            <ul className="divide-y divide-border/70">
              {audit.data?.items.map((log) => (
                <AuditRow key={log.id} log={log} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, hint }: { icon: IconName; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{label}</span>
        <Icon name={icon} className="size-4" />
      </div>
      <p className="mt-3 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * 极简柱状图。
 *
 * 不引入图表库：这里只需要「两周内哪天有新增」的形状，为它加一个
 * 100KB+ 的依赖不值。柱高按全局最大值归一，两组数据共用同一刻度，
 * 否则用户会误以为两条柱一样高就等于数值一样。
 */
function TrendChart({ points }: { points: { date: string; newUsers: number; newMaps: number }[] }) {
  const { t } = useTranslation();
  if (points.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">{t('admin.overview.trendEmpty')}</p>;
  }
  const max = Math.max(1, ...points.map((point) => Math.max(point.newUsers, point.newMaps)));

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-1.5" style={{ height: 132 }}>
        {points.map((point) => (
          <div
            key={point.date}
            className="group flex h-full flex-1 flex-col justify-end gap-1"
            title={t('admin.overview.trendTooltip', {
              date: point.date,
              users: formatNumber(point.newUsers),
              maps: formatNumber(point.newMaps),
            })}
          >
            <div className="flex h-full items-end justify-center gap-0.5">
              <span
                className="w-1/2 max-w-2 rounded-t bg-primary/80 transition-colors group-hover:bg-primary"
                style={{ height: `${Math.max(2, (point.newUsers / max) * 100)}%` }}
              />
              <span
                className="w-1/2 max-w-2 rounded-t bg-emerald-500/70 transition-colors group-hover:bg-emerald-500"
                style={{ height: `${Math.max(2, (point.newMaps / max) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{points[0]?.date}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <i className="size-2 rounded-full bg-primary/80" aria-hidden="true" />
            {t('admin.overview.legendUsers')}
          </span>
          <span className="flex items-center gap-1">
            <i className="size-2 rounded-full bg-emerald-500/70" aria-hidden="true" />
            {t('admin.overview.legendMaps')}
          </span>
        </span>
        <span>{points.at(-1)?.date}</span>
      </div>
    </div>
  );
}

function AuditRow({ log }: { log: AuditLog }) {
  const { t } = useTranslation();
  const labelKey = ACTION_LABEL[log.action];
  const label = labelKey === undefined ? log.action : t(labelKey);
  const tone = ACTION_TONE[log.action] ?? 'neutral';
  const detail = summarizeDetail(log);

  return (
    <li className="flex items-start justify-between gap-3 px-5 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={tone}>{label}</Badge>
          {detail ? <span className="truncate text-sm">{detail}</span> : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {log.ip || t('admin.overview.unknownSource')} · {formatRelative(log.createdAt)}
        </p>
      </div>
      <time className="shrink-0 text-xs text-muted-foreground" dateTime={log.createdAt} title={formatDateTime(log.createdAt)}>
        {formatDayMonth(log.createdAt)}
      </time>
    </li>
  );
}

/** 从 detail 里挑一句人话。detail 的形状由后端决定，所以逐字段兜底。 */
function summarizeDetail(log: AuditLog): string {
  const detail = log.detail ?? {};
  const keys = (detail as { keys?: unknown }).keys;
  if (Array.isArray(keys) && keys.length > 0) {
    return formatList(keys.map(String));
  }
  const username = (detail as { username?: unknown }).username;
  if (typeof username === 'string' && username) return username;
  const changes = (detail as { changes?: unknown }).changes;
  if (changes && typeof changes === 'object') {
    return formatList(Object.keys(changes as Record<string, unknown>));
  }
  if (log.targetId) return log.targetId;
  return '';
}
