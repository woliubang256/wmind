/**
 * 「我的分享」页（`/shares`）。
 *
 * 这一页存在的理由是**可撤销**：分享链接一旦发出去就不受控，用户需要一个
 * 地方把它们一次看全、知道自己发过什么、随时收回。所以：
 *
 * - 已撤销的链接仍然列出来（带「已撤销」标记与访问次数），而不是消失；
 * - 访问次数直接显示在行里，它是用户判断「要不要撤销」的唯一依据；
 * - 撤销在这里也是二次确认，与分享对话框里的行为一致。
 *
 * 分页用页码而不是无限滚动：这一页的条目天然有限（每张图 20 条上限），
 * 而「我到底发过多少条」这个问题，页码比滚动更好回答。
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Icon } from '@/components/ui/icon';
import { LoadingState } from '@/components/ui/loading-state';
import { Badge, EmptyState, PageHeader, Panel } from '@/components/ui/panel';
import { resolveShareUrl, shareApi, type ShareLink } from '@/lib/api/shares';
import { shareKeys } from './queries';
import { copyToClipboard } from './share-password';
import { SharePasswordControl, SharePasswordResetDialog } from './share-password-controls';

const PAGE_SIZE = 20;

export function SharesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [revoking, setRevoking] = useState<ShareLink | null>(null);
  const [resetting, setResetting] = useState<ShareLink | null>(null);

  const query = useQuery({
    queryKey: [...shareKeys.mine(), page],
    queryFn: () => shareApi.listMine({ page, pageSize: PAGE_SIZE }),
  });

  const revoke = useMutation({
    mutationFn: (uid: string) => shareApi.revoke(uid),
    onSuccess: () => {
      setRevoking(null);
      toast.success(t('share.revoked'));
      void queryClient.invalidateQueries({ queryKey: shareKeys.root });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const copy = async (link: ShareLink) => {
    if (await copyToClipboard(resolveShareUrl(link.url))) {
      toast.success(t('share.copied'));
    } else {
      toast.error(t('share.copyFailed'));
    }
  };

  const items = query.data?.items ?? [];
  const pagination = query.data?.pagination;

  return (
    <div className="space-y-6">
      <PageHeader title={t('share.mine.title')} />

      {query.isPending ? (
        <LoadingState className="min-h-64" />
      ) : items.length === 0 ? (
        <EmptyState
          icon="link"
          title={t('share.mine.emptyTitle')}
          description={t('share.mine.emptyBody')}
          action={
            <Button size="sm" variant="outline" onClick={() => navigate('/')}>
              {t('share.mine.emptyAction')}
            </Button>
          }
        />
      ) : (
        <Panel bodyClassName="p-0">
          <ul className="divide-y divide-border/70">
            {items.map((link) => (
              <li key={link.uid} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/maps/${link.mapUid}`} className="truncate font-medium hover:underline">
                      {link.mapTitle}
                    </Link>
                    {link.revokedAt ? <Badge>{t('share.badge.revoked')}</Badge> : null}
                    <SharePasswordControl link={link} onReset={setResetting} />
                    <Badge tone={link.revokedAt ? 'neutral' : 'success'}>
                      {link.expiresAt
                        ? t('share.badge.expires', { time: new Date(link.expiresAt).toLocaleDateString() })
                        : t('share.badge.forever')}
                    </Badge>
                    {!link.allowDownload ? <Badge>{t('share.badge.noDownload')}</Badge> : null}
                  </div>
                  <code className="mt-1.5 block truncate text-xs text-muted-foreground">{resolveShareUrl(link.url)}</code>
                </div>

                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Icon name="eye" className="size-3.5" />
                    {t('share.views', { count: link.viewCount })}
                  </span>
                  <span className="hidden sm:inline">{new Date(link.createdAt).toLocaleDateString()}</span>
                  {!link.revokedAt ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => void copy(link)}>
                        <Icon name="copy" className="mr-1.5 size-3.5" />
                        {t('share.copy')}
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRevoking(link)}>
                        <Icon name="trash" className="mr-1.5 size-3.5" />
                        {t('share.revoke')}
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {pagination && pagination.totalPages > 1 ? (
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
            <Icon name="chevron-left" className="mr-1 size-4" />
            {t('share.mine.prev')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t('share.mine.pageOf', { page: pagination.page, total: pagination.totalPages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pagination.totalPages}
            onClick={() => setPage((value) => value + 1)}
          >
            {t('share.mine.next')}
            <Icon name="chevron-right" className="ml-1 size-4" />
          </Button>
        </div>
      ) : null}

      {resetting ? <SharePasswordResetDialog key={resetting.uid} link={resetting} onClose={() => setResetting(null)} /> : null}

      <ConfirmDialog
        open={revoking !== null}
        title={t('share.revokeConfirm.title')}
        description={t('share.revokeConfirm.body')}
        confirmLabel={t('share.revoke')}
        cancelLabel={t('common.cancel')}
        destructive
        pending={revoke.isPending}
        onClose={() => setRevoking(null)}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.uid);
        }}
      />
    </div>
  );
}
