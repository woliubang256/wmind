import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { Badge, EmptyState, PageHeader, Panel } from '@/components/ui/panel';
import { adminApi } from '@/lib/api/endpoints';
import type { AuditLog } from '@/lib/api/types';
import { formatBytes, formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import { adminKeys } from './queries';

const ACTION_LABEL: Record<string, string> = {
  'user.create': '创建用户',
  'user.update': '修改用户',
  'user.disable': '禁用用户',
  'user.enable': '启用用户',
  'user.delete': '删除用户',
  'user.role': '调整角色',
  'user.reset_password': '重置密码',
  'settings.update': '修改设置',
};

const ACTION_TONE: Record<string, 'primary' | 'warning' | 'danger' | 'neutral'> = {
  'user.create': 'primary',
  'user.disable': 'warning',
  'user.delete': 'danger',
  'user.reset_password': 'warning',
  'settings.update': 'neutral',
};

export function AdminOverviewPage() {
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
        title="管理概览"
        description="站点规模与最近的管理操作。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void stats.refetch()} disabled={stats.isFetching}>
            <Icon name="clock" className="size-4" />
            {stats.isFetching ? '刷新中…' : '刷新'}
          </Button>
        }
      />

      {stats.isError ? (
        <EmptyState
          icon="alert"
          title="统计数据加载失败"
          description={stats.error instanceof Error ? stats.error.message : undefined}
          action={
            <Button variant="outline" size="sm" onClick={() => void stats.refetch()}>
              重试
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon="users" label="用户总数" value={formatNumber(data?.userCount ?? 0)} />
          <StatCard icon="check" label="活跃用户" value={formatNumber(data?.activeUserCount ?? 0)} />
          <StatCard icon="waypoints" label="导图总数" value={formatNumber(data?.mapCount ?? 0)} hint="导图功能在 M2 接入" />
          <StatCard icon="image" label="存储占用" value={formatBytes(data?.storageUsedBytes ?? 0)} />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel
          title="近 14 天新增"
          description={data ? `今日新增 ${formatNumber(data.mapCountToday)} 张导图` : '正在加载…'}
        >
          <TrendChart points={data?.trend ?? []} />
        </Panel>

        <Panel
          title="最近操作"
          description="审计日志只增不改，记录谁在什么时候改了什么。"
          actions={
            <Badge tone="neutral">{formatNumber(audit.data?.pagination.total ?? 0)} 条</Badge>
          }
          bodyClassName="p-0"
        >
          {audit.isError ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">审计日志加载失败。</p>
          ) : (audit.data?.items.length ?? 0) === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">还没有管理操作记录。</p>
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
  if (points.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">暂无数据。</p>;
  }
  const max = Math.max(1, ...points.map((point) => Math.max(point.newUsers, point.newMaps)));

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-1.5" style={{ height: 132 }}>
        {points.map((point) => (
          <div key={point.date} className="group flex h-full flex-1 flex-col justify-end gap-1" title={`${point.date}：新增用户 ${point.newUsers}，新增导图 ${point.newMaps}`}>
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
            <i className="size-2 rounded-full bg-primary/80" aria-hidden="true" />用户
          </span>
          <span className="flex items-center gap-1">
            <i className="size-2 rounded-full bg-emerald-500/70" aria-hidden="true" />导图
          </span>
        </span>
        <span>{points.at(-1)?.date}</span>
      </div>
    </div>
  );
}

function AuditRow({ log }: { log: AuditLog }) {
  const label = ACTION_LABEL[log.action] ?? log.action;
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
          {log.ip || '未知来源'} · {formatRelative(log.createdAt)}
        </p>
      </div>
      <time className="shrink-0 text-xs text-muted-foreground" dateTime={log.createdAt} title={formatDateTime(log.createdAt)}>
        {formatDateTime(log.createdAt).slice(5, 11)}
      </time>
    </li>
  );
}

/** 从 detail 里挑一句人话。detail 的形状由后端决定，所以逐字段兜底。 */
function summarizeDetail(log: AuditLog): string {
  const detail = log.detail ?? {};
  const keys = (detail as { keys?: unknown }).keys;
  if (Array.isArray(keys) && keys.length > 0) {
    return keys.map(String).join('、');
  }
  const username = (detail as { username?: unknown }).username;
  if (typeof username === 'string' && username) return username;
  const changes = (detail as { changes?: unknown }).changes;
  if (changes && typeof changes === 'object') {
    return Object.keys(changes as Record<string, unknown>).join('、');
  }
  if (log.targetId) return log.targetId;
  return '';
}
