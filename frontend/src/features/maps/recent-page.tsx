/**
 * 最近列表页（`/`）。
 *
 * 这一页是整个产品的正门，所以它的三件事必须都成立：**能看见**（缩略图卡片）、
 * **找得到**（搜索 + 排序）、**能动手**（重命名 / 复制 / 删除）。
 *
 * 列表用 `useInfiniteQuery` 而不是自己管 page 状态：后端是 offset 分页，
 * 自己管的话「搜索词变了要把页码重置回 1」这类逻辑会散落在每个 setState 旁边，
 * 漏一个就会出现「搜到第 2 页的关键词在第 1 页显示为空」。
 *
 * 滚动加载用一个哨兵元素 + IntersectionObserver，同时保留一个「加载更多」按钮：
 * 前者是体验，后者是无障碍与降级（`prefers-reduced-motion`、不支持 observer 的
 * 环境、以及键盘用户）。
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input, TextField } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { EmptyState, PageHeader } from '@/components/ui/panel';
import { mapApi, type MapSort, type MapSummary } from '@/lib/api/maps';
import { formatBytes, formatNumber } from '@/lib/format';
import { IMPORT_LIMITS } from '@/editor/import/limits';
import { createStarterDocument } from '@/features/editor/demo-document';
import { useSiteConfig } from '@/features/site/use-site-config';
import { mapKeys } from './queries';
import { MapCard } from './map-card';
import { LoadingState } from '@/components/ui/loading-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ShareDialog } from '@/features/share/share-dialog';
import { TemplatePicker } from '@/features/templates/template-picker';

/**
 * 导入模块按需加载。
 *
 * 里面装着三种格式的解析器和 fflate（解压），加起来比整个首页还大，而绝大多数
 * 会话根本不会导入。静态引入会让每个打开首页的人都先下载它。
 */
const ImportDialog = lazy(() => import('@/features/dashboard/import-dialog').then((module) => ({ default: module.ImportDialog })));
const AIGenerateDialog = lazy(() => import('@/features/ai/generate-dialog').then((module) => ({ default: module.AIGenerateDialog })));

/** 一页 24 张：3 列 / 4 列 / 6 列都能整除，不会在最后一行留下半排。 */
const PAGE_SIZE = 24;

/** 搜索防抖。300ms 是「停手」与「还没打完」之间的常用分界。 */
const SEARCH_DEBOUNCE_MS = 300;

export function RecentPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { config } = useSiteConfig();

  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<MapSort>('updated');
  const [creating, setCreating] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [aiOpen, setAIOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const [dropping, setDropping] = useState(false);
  const [renaming, setRenaming] = useState<MapSummary | null>(null);
  const [sharing, setSharing] = useState<MapSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [deleting, setDeleting] = useState<MapSummary | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(keyword.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [keyword]);

  const maps = useInfiniteQuery({
    queryKey: mapKeys.list({ keyword: search, sort }),
    queryFn: ({ pageParam }) =>
      mapApi.list({ page: pageParam, pageSize: PAGE_SIZE, keyword: search || undefined, sort }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const { page, totalPages } = lastPage.pagination;
      return page < totalPages ? page + 1 : undefined;
    },
  });

  const items = useMemo(() => maps.data?.pages.flatMap((page) => page.items) ?? [], [maps.data]);
  const total = maps.data?.pages[0]?.pagination.total ?? 0;

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: mapKeys.lists() });
  }, [queryClient]);

  const createMap = async () => {
    setCreating(true);
    try {
      const created = await mapApi.create({ title: t('editor.untitledMap'), document: createStarterDocument() });
      navigate(`/maps/${created.uid}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('maps.error'));
    } finally {
      setCreating(false);
    }
  };

  const rename = useMutation({
    mutationFn: (input: { uid: string; title: string }) => mapApi.rename(input.uid, input.title),
    onSuccess: () => {
      toast.success(t('maps.renamed'));
      setRenaming(null);
      refresh();
    },
    onError: () => toast.error(t('maps.error')),
  });

  const duplicate = useMutation({
    mutationFn: (uid: string) => mapApi.duplicate(uid),
    onSuccess: () => {
      toast.success(t('maps.duplicated'));
      refresh();
    },
    onError: () => toast.error(t('maps.error')),
  });

  const remove = useMutation({
    mutationFn: (uid: string) => mapApi.remove(uid),
    onSuccess: () => {
      toast.success(t('maps.deleted'));
      setDeleting(null);
      // 删除会同时改变主列表与回收站，两个都要刷。
      refresh();
      void queryClient.invalidateQueries({ queryKey: mapKeys.trash() });
    },
    onError: () => toast.error(t('maps.error')),
  });

  const busy = duplicate.isPending || remove.isPending || rename.isPending;

  /**
   * 只有真的拖了**文件**才接管事件。
   *
   * 不判断 `types` 的话，在页面里选中文字一拖，整个页面就会变成「投放区」，
   * 松手时把浏览器默认的拖拽行为吃掉——用户会发现选中的文字拖不动了。
   */
  const hasFiles = (event: React.DragEvent) => config.importEnabled && event.dataTransfer.types.includes('Files');

  // ── 滚动加载 ──────────────────────────────────────────────────────────────
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMore = useCallback(() => {
    if (maps.hasNextPage && !maps.isFetchingNextPage) void maps.fetchNextPage();
  }, [maps]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      // 提前 240px 就开始取下一页：等哨兵真的进视口再请求，用户会先看到
      // 一屏空白再看到内容。
      { rootMargin: '240px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // items.length 参与依赖：哨兵在「有下一页」时才渲染，第一页到达后它才出现。
  }, [loadMore, items.length]);

  const isEmpty = !maps.isPending && items.length === 0;
  const searching = search !== '';

  return (
    <div
      className="relative space-y-6"
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        // 子元素之间移动也会触发 dragleave，只有真正离开整块区域才算离开。
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDropping(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length === 0) return;
        setPendingFiles(files);
        setImportOpen(true);
      }}
    >
      {dropping ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-3xl border-2 border-dashed border-primary bg-background/85 backdrop-blur-sm">
          <div className="text-center">
            <Icon name="upload" className="mx-auto size-8 text-primary" />
            <p className="mt-3 text-sm font-medium">{t('import.dialog.dropTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('import.dialog.formats', { limit: formatBytes(IMPORT_LIMITS.maxInputBytes) })}
            </p>
          </div>
        </div>
      ) : null}

      <PageHeader
        title={t('maps.title')}
        actions={
          <>
            {config.importEnabled ? (
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Icon name="upload" className="size-4" />
                {t('import.dialog.title')}
              </Button>
            ) : null}
            {config.aiEnabled && <Button variant="outline" onClick={() => setAIOpen(true)}><Icon name="sparkles" className="size-4" />{t('ai.title')}</Button>}
            <Button onClick={() => setPickerOpen(true)} disabled={creating}>
              <Icon name="file-plus" className="size-4" />
              {t('maps.create')}
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={t('maps.searchPlaceholder')}
            aria-label={t('maps.search')}
            className="h-10 pl-9"
          />
        </div>
        {/*
          `Select` 是 `appearance-none`（原生箭头被去掉，因为它跟自定义边框
          对不齐），所以这里自己补一个 chevron。不补的话，排序控件看起来像
          一个写着「最近修改」的标签，没人会想到去点它。
        */}
        <Select
          value={sort}
          onChange={(next) => setSort(next as MapSort)}
          aria-label={t('maps.sort')}
          className="h-10 w-auto"
          options={[
            { value: 'updated', label: t('maps.sort.updated') },
            { value: 'title', label: t('maps.sort.title') },
            { value: 'created', label: t('maps.sort.created') },
          ]}
        />
        <span className="ml-auto text-sm text-muted-foreground">
          {maps.isPending ? null : t('maps.count', { count: formatNumber(total) })}
        </span>
      </div>

      {maps.isPending ? (
        <LoadingState className="min-h-80" />
      ) : isEmpty && searching ? (
        <EmptyState
          icon="search"
          title={t('maps.emptySearch.title')}
          description={t('maps.emptySearch.body', { keyword: search })}
          action={
            <Button variant="outline" size="sm" onClick={() => setKeyword('')}>
              {t('maps.clearSearch')}
            </Button>
          }
        />
      ) : isEmpty ? (
        <EmptyState
          icon="files"
          title={t('maps.empty.title')}
          description={t('maps.empty.body')}
          action={
            <Button size="sm" onClick={() => setPickerOpen(true)} disabled={creating}>
              <Icon name="file-plus" className="size-4" />
              {t('maps.create')}
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((map) => (
              <MapCard
                key={map.uid}
                map={map}
                busy={busy}
                actions={[
                  {
                    label: t('maps.actions.rename'),
                    icon: 'pencil',
                    onClick: () => {
                      setRenaming(map);
                      setRenameTitle(map.title);
                    },
                  },
                  {
                    label: t('maps.actions.duplicate'),
                    icon: 'copy',
                    onClick: () => duplicate.mutate(map.uid),
                  },
                  {
                    label: t('maps.actions.share'),
                    icon: 'link',
                    onClick: () => setSharing(map),
                  },
                  {
                    label: t('maps.actions.delete'),
                    icon: 'trash',
                    tone: 'danger',
                    onClick: () => setDeleting(map),
                  },
                ]}
              />
            ))}
          </div>

          <div ref={sentinelRef} className="flex justify-center pt-2">
            {maps.hasNextPage ? (
              <Button loading={maps.isFetchingNextPage} variant="outline" size="sm" onClick={loadMore} disabled={maps.isFetchingNextPage}>
                {maps.isFetchingNextPage ? t('maps.loadingMore') : t('maps.loadMore')}
              </Button>
            ) : items.length > PAGE_SIZE ? (
              <span className="text-xs text-muted-foreground">{t('maps.allLoaded')}</span>
            ) : null}
          </div>
        </>
      )}

      <Modal
        open={renaming !== null}
        title={t('maps.rename.title')}
        onClose={() => setRenaming(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setRenaming(null)} disabled={rename.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (renaming === null) return;
                rename.mutate({ uid: renaming.uid, title: renameTitle });
              }}
              loading={rename.isPending}
              disabled={renameTitle.trim() === ''}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <TextField
          label={t('maps.rename.label')}
          value={renameTitle}
          autoFocus
          maxLength={200}
          onChange={(event) => setRenameTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || renaming === null) return;
            event.preventDefault();
            rename.mutate({ uid: renaming.uid, title: renameTitle });
          }}
        />
      </Modal>

      <TemplatePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onCreateBlank={() => {
          setPickerOpen(false);
          void createMap();
        }}
      />

      {sharing ? (
        <ShareDialog
          open
          mapUid={sharing.uid}
          mapTitle={sharing.title}
          onClose={() => setSharing(null)}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={t('maps.delete.title')}
        description={deleting === null ? undefined : t('maps.delete.body', { title: deleting.title })}
        confirmLabel={t('maps.delete.confirm')}
        cancelLabel={t('common.cancel')}
        destructive
        pending={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting !== null) remove.mutate(deleting.uid);
        }}
      />

      {aiOpen && <Suspense fallback={<LoadingState className="fixed inset-0 z-40 bg-background/90" />}><AIGenerateDialog onClose={() => setAIOpen(false)} /></Suspense>}
      {importOpen ? (
        <Suspense fallback={<LoadingState className="fixed inset-0 z-40 bg-background/90" />}>
          <ImportDialog
            open
            onClose={() => setImportOpen(false)}
            initialFiles={pendingFiles}
            onFilesConsumed={() => setPendingFiles(null)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
