/**
 * 回收站（`/trash`）。
 *
 * 与最近列表共用卡片，但操作只有「恢复」和「彻底删除」——重命名一个已经删掉
 * 的东西没有意义，而复制它等于绕过回收站。
 *
 * 「彻底删除」和「清空」都要二次确认，且确认按钮是危险色：这两个动作没有
 * 撤销路径，误触的代价是数据没了。
 */

import { useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { EmptyState, PageHeader } from '@/components/ui/panel';
import { mapApi, type MapSummary } from '@/lib/api/maps';
import { formatNumber, formatRelative } from '@/lib/format';
import { mapKeys } from './queries';
import { MapCard, MapCardSkeleton } from './map-card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

const PAGE_SIZE = 24;

export function TrashPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [purging, setPurging] = useState<MapSummary | null>(null);
  const [emptying, setEmptying] = useState(false);

  const trash = useInfiniteQuery({
    queryKey: mapKeys.trash(),
    queryFn: ({ pageParam }) => mapApi.listTrash({ page: pageParam, pageSize: PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const { page, totalPages } = lastPage.pagination;
      return page < totalPages ? page + 1 : undefined;
    },
  });

  const items = useMemo(() => trash.data?.pages.flatMap((page) => page.items) ?? [], [trash.data]);
  const total = trash.data?.pages[0]?.pagination.total ?? 0;

  const refresh = () => {
    // 恢复会同时改变回收站与主列表。
    void queryClient.invalidateQueries({ queryKey: mapKeys.trash() });
    void queryClient.invalidateQueries({ queryKey: mapKeys.lists() });
  };

  const restore = useMutation({
    mutationFn: (uid: string) => mapApi.restore(uid),
    onSuccess: () => {
      toast.success(t('trash.restored'));
      refresh();
    },
    onError: () => toast.error(t('maps.error')),
  });

  const purge = useMutation({
    mutationFn: (uid: string) => mapApi.purge(uid),
    onSuccess: () => {
      toast.success(t('trash.purged'));
      setPurging(null);
      refresh();
    },
    onError: () => toast.error(t('maps.error')),
  });

  const emptyTrash = useMutation({
    mutationFn: () => mapApi.emptyTrash(),
    onSuccess: () => {
      toast.success(t('trash.emptied'));
      setEmptying(false);
      refresh();
    },
    onError: () => toast.error(t('maps.error')),
  });

  const busy = restore.isPending || purge.isPending || emptyTrash.isPending;
  const isEmpty = !trash.isPending && items.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('trash.title')}
        description={t('trash.subtitle')}
        actions={
          total > 0 ? (
            <Button variant="outline" onClick={() => setEmptying(true)} disabled={busy}>
              <Icon name="trash" className="size-4" />
              {t('trash.empty')}
            </Button>
          ) : null
        }
      />

      {trash.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <MapCardSkeleton key={index} />
          ))}
        </div>
      ) : isEmpty ? (
        <EmptyState icon="trash" title={t('trash.empty.title')} description={t('trash.empty.body')} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t('trash.count', { count: formatNumber(total) })}</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((map) => (
              <MapCard
                key={map.uid}
                map={map}
                busy={busy}
                meta={t('trash.deletedAt', { time: formatRelative(map.updatedAt) })}
                // 已删除的图读不到，点进去只会是「导图不存在」。
                href={null}
                actions={[
                  {
                    label: t('trash.restore'),
                    icon: 'undo',
                    onClick: () => restore.mutate(map.uid),
                  },
                  {
                    label: t('trash.purge'),
                    icon: 'trash',
                    tone: 'danger',
                    onClick: () => setPurging(map),
                  },
                ]}
              />
            ))}
          </div>
          {trash.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void trash.fetchNextPage()}
                disabled={trash.isFetchingNextPage}
              >
                {trash.isFetchingNextPage ? t('maps.loadingMore') : t('maps.loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={purging !== null}
        title={t('trash.purge.title')}
        description={purging === null ? undefined : t('trash.purge.body', { title: purging.title })}
        confirmLabel={t('trash.purge.confirm')}
        cancelLabel={t('common.cancel')}
        destructive
        pending={purge.isPending}
        onClose={() => setPurging(null)}
        onConfirm={() => {
          if (purging !== null) purge.mutate(purging.uid);
        }}
      />

      <ConfirmDialog
        open={emptying}
        title={t('trash.emptyConfirm.title')}
        description={t('trash.emptyConfirm.body', { count: formatNumber(total) })}
        confirmLabel={t('trash.emptyConfirm.confirm')}
        cancelLabel={t('common.cancel')}
        destructive
        pending={emptyTrash.isPending}
        onClose={() => setEmptying(false)}
        onConfirm={() => emptyTrash.mutate()}
      />
    </div>
  );
}
