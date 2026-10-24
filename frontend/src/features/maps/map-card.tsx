/**
 * 列表里的一张导图卡片。
 *
 * 结构上刻意把「打开」和「操作」分开：
 *
 * - 缩略图 + 标题 + 元信息包在一个 `<Link>` 里，整块可点；
 * - 悬浮操作按钮是 `<Link>` 的**兄弟**，绝对定位盖在右上角。
 *
 * 不能把按钮塞进 `<Link>` 里——`<a>` 里嵌 `<button>` 是非法结构，浏览器会
 * 把它拆开，而「点删除却打开了导图」正是这种结构最典型的后果。
 *
 * 操作由调用方以列表传入，而不是在这里写死四个回调：回收站要的是「恢复 /
 * 彻底删除」，与最近列表的「重命名 / 复制 / 分享 / 删除」完全不同。写死回调
 * 的话，回收站只能拿「重命名」的位置去干「恢复」的活——图标和 tooltip 就在
 * 撒谎。
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '@/components/ui/icon';
import { LoadingImage } from '@/components/ui/loading-image';
import { cn } from '@/lib/utils';
import { formatBytes, formatRelative } from '@/lib/format';
import type { MapSummary } from '@/lib/api/maps';

export interface MapCardAction {
  label: string;
  icon: IconName;
  onClick: () => void;
  tone?: 'default' | 'danger';
}

interface CardActionProps extends MapCardAction {
  disabled: boolean;
}

function CardAction({ label, icon, onClick, tone = 'default', disabled }: CardActionProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        // 按钮盖在链接上方，但保险起见还是拦掉冒泡——将来若有人把按钮挪进
        // 链接内部，这一行能让行为保持不变。
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        'grid size-8 place-items-center rounded-lg border border-border/60 bg-card/95 text-muted-foreground shadow-sm transition',
        'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:pointer-events-none disabled:opacity-50',
        tone === 'danger' && 'hover:border-destructive/40 hover:text-destructive',
      )}
    >
      <Icon name={icon} className="size-4" />
    </button>
  );
}
export interface MapCardProps {
  map: MapSummary;
  actions: MapCardAction[];
  /** 任一操作进行中时禁用全部操作，避免并发点两下建出两张副本。 */
  busy?: boolean;
  /** 覆盖默认的「更新于 …」，回收站用剩余删除期限。 */
  meta?: ReactNode;
  /**
   * 点击卡片打开的地址。`null` 表示这张图现在打不开。
   *
   * 回收站里的图就是这种情况：它的 uid 已经读不到了，点进去只会得到一页
   * 「导图不存在」。渲染成不可点的容器比渲染成死链接诚实。
   */
  href?: string | null;
}

export function MapCard({ map, actions, busy = false, meta, href }: MapCardProps) {
  const { t } = useTranslation();
  const target = href === undefined ? `/maps/${map.uid}` : href;

  const body = (
    <>
      <div className="relative grid aspect-[16/10] place-items-center overflow-hidden border-b border-border/60 bg-secondary/30">
        {map.thumbnailUrl === '' ? (
          // 还没有缩略图：给一个淡图标而不是空白。空白会让人以为加载失败。
          <Icon name="waypoints" className="size-10 text-muted-foreground/40" strokeWidth={1.2} />
        ) : (
          <LoadingImage
            src={map.thumbnailUrl}
            alt={t('maps.thumbnailAlt', { title: map.title })}
            loading="lazy"
            decoding="async"
            containerClassName="size-full"
            className="size-full object-contain"
          />
        )}
      </div>
      <div className="px-3 py-3">
        <h3 className="truncate text-sm font-medium" title={map.title}>
          {map.title}
        </h3>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {meta ?? t('maps.updatedAt', { time: formatRelative(map.updatedAt) })}
          <span aria-hidden="true"> · </span>
          {t('maps.nodeCount', { count: map.nodeCount })}
          <span aria-hidden="true"> · </span>
          {formatBytes(map.sizeBytes)}
        </p>
      </div>
    </>
  );

  return (
    <article className="group relative overflow-hidden rounded-2xl border border-border/70 bg-card transition hover:border-border hover:shadow-sm focus-within:border-ring">
      {target === null ? (
        <div>{body}</div>
      ) : (
        <Link to={target} className="block focus-visible:outline-none">
          {body}
        </Link>
      )}

      {/*
        悬浮才显形，但 focus-within 时也要显形——只写 group-hover 的话，键盘
        用户 Tab 到按钮上时按钮仍然 opacity-0，等于对着空气按回车。
      */}
      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {actions.map((action) => (
          <CardAction key={action.label} {...action} disabled={busy} />
        ))}
      </div>
    </article>
  );
}
