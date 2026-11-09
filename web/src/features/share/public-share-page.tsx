/**
 * 公开分享页（`/s/:token`）。
 *
 * 这一页是**匿名**的：访客通常没有账号，所以它不走 `RequireAuth`，也不
 * 携带登录令牌。安全边界全部由令牌（128 bit 随机）与可选的访问密码承担。
 *
 * 四个状态必须各自有明确的界面，而不是笼统一句「出错了」：
 *
 * - 需要密码 → 输密码表单（拿到凭证后存 sessionStorage，刷新不用再输）；
 * - 分享失效（不存在 / 已撤销 / 已过期 / 导图已删除）→ 同一个失效页。
 *   服务端刻意不区分原因，前端也不猜；
 * - 站点关闭分享 → 单独一句「站点已关闭分享」，因为这是管理员的操作，
 *   用户需要知道去找谁；
 * - 正常 → 只读查看器。
 *
 * 只读是真的只读：挂的是 `READ_ONLY_PLUGINS`（平移缩放 + 折叠），编辑、
 * 选中、拖拽的插件根本没有被挂载。
 */

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { produce } from 'immer';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { LoadingState } from '@/components/ui/loading-state';
import { TextField } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ApiError } from '@/lib/api/errors';
import {
  clearShareAccess,
  readShareAccess,
  readSharePasswordQuery,
  shareApi,
  writeShareAccess,
  type PublicShare,
} from '@/lib/api/shares';
import { parseDocument } from '@/editor/model/validate';
import { MindMapViewer } from '@/editor/viewer/mind-map-viewer';
import { READ_ONLY_PLUGINS } from '@/editor/viewer/plugins';
import { MAX_ZOOM, MIN_ZOOM, zoomedViewport } from '@/editor/viewer/plugins/pan-zoom';
import { findTopicInSheet } from '@/editor/model/traverse';
import { layoutMindmap } from '@/editor/layout/mindmap';
import type { LayoutResult } from '@/editor/layout/types';
import { layoutAnnotations, unionRect } from '@/editor/layout/annotations';
import { CanvasScrollbars } from '@/features/editor/canvas-scrollbars';
import { centeredViewport } from '@/features/editor/canvas-navigation';
import { useCanvasViewport } from '@/features/editor/use-canvas-viewport';
import { ToolbarButton } from '@/features/editor/toolbar-button';
import { useFontsReady } from '@/features/editor/use-fonts-ready';
import { useSiteConfig } from '@/features/site/use-site-config';
import { shareKeys } from './queries';

/**
 * 导出对话框按需加载。
 *
 * 它把字体分片、图片内嵌、SVG 栅格化、多图拆分全带进来（几百 KB），而
 * 大多数访客只是来看一眼。只有点了「导出」才值得付这个代价。
 */
const ExportDialog = lazy(() =>
  import('@/features/editor/export-dialog').then((module) => ({ default: module.ExportDialog })),
);

function ShareShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-border/70 bg-card p-8 text-center sm:p-12">
      {children}
    </section>
  );
}

function InvalidShare({ code }: { code: 'SHARE_NOT_FOUND' | 'SHARE_DISABLED' }) {
  const { t } = useTranslation();
  const disabled = code === 'SHARE_DISABLED';
  return (
    <ShareShell>
      <Icon name={disabled ? 'lock' : 'eye-off'} className="mx-auto size-10 text-muted-foreground" />
      <h1 className="mt-5 text-2xl font-semibold">{t(disabled ? 'share.public.disabledTitle' : 'share.public.invalidTitle')}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        {t(disabled ? 'share.public.disabledBody' : 'share.public.invalidBody')}
      </p>
    </ShareShell>
  );
}

/**
 * 密码表单。
 *
 * 输错不刷新页面、不跳转：错误就显示在输入框下面，焦点留在原地。
 * 后端对这个接口按 IP 限流 10 次/分钟，被限流时把 429 的提示原样显示出来
 * ——「等一会儿再试」比「密码错误」准确。
 */
function PasswordGate({ token, initialPassword, onGranted }: { token: string; initialPassword: string; onGranted: (accessToken: string) => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState(initialPassword);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const access = await shareApi.publicVerify(token, password);
      writeShareAccess(token, access.accessToken);
      onGranted(access.accessToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('share.public.invalidBody'));
    } finally {
      setPending(false);
    }
  };

  return (
    <ShareShell>
      <Icon name="lock" className="mx-auto size-10 text-primary" />
      <h1 className="mt-5 text-2xl font-semibold">{t('share.public.passwordTitle')}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{t('share.public.passwordBody')}</p>
      <form onSubmit={submit} className="mx-auto mt-6 flex max-w-sm flex-col gap-3 text-left">
        <TextField
          label={t('share.public.passwordLabel')}
          type="password"
          value={password}
          autoFocus
          autoComplete="off"
          error={error || undefined}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button type="submit" loading={pending} disabled={password === ''}>
          {pending ? t('share.public.submitting') : t('share.public.submit')}
        </Button>
      </form>
    </ShareShell>
  );
}

/** 与编辑端一致：等待字体期间不测字，避免回退字体的几何进入布局缓存。 */
const PENDING_LAYOUT: LayoutResult = {
  boxes: new Map(), edges: [], sizes: new Map(), styles: new Map(),
  bounds: { x: 0, y: 0, width: 1, height: 1 },
};

/** 只读画布。文档已经过归一化，字体就绪后才进布局（否则宽度会被永久缓存错）。 */
function ShareCanvas({ share }: { share: PublicShare }) {
  const { t } = useTranslation();
  const { config } = useSiteConfig();
  // 访客折叠只改独立归一化副本，不回写源文档或浏览器持久存储。
  const [document, setDocument] = useState(() => parseDocument(share.document).document);
  const fonts = useFontsReady(document);
  const [sheetId, setSheetId] = useState(() => document.viewState?.activeSheetId ?? document.sheets[0]!.id);
  const sheet = document.sheets.find((item) => item.id === sheetId) ?? document.sheets[0]!;
  const [exportOpen, setExportOpen] = useState(false);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const layout = useMemo(
    () => fonts.ready ? layoutMindmap({ sheet, theme: document.theme }) : PENDING_LAYOUT,
    [sheet, document.theme, fonts.ready, fonts.generation],
  );
  const bounds = useMemo(() => {
    const annotations = layoutAnnotations(sheet, layout, sheet.themeOverride ?? document.theme);
    return unionRect([layout.bounds, ...(annotations.bounds ? [annotations.bounds] : [])], 16)!;
  }, [sheet, layout, document.theme]);
  const { viewport, setViewport, fit } = useCanvasViewport({ canvasRef, sheetId: sheet.id, bounds,
    savedView: document.viewState?.sheets[sheet.id], ready: fonts.ready });
  const zoom = (factor: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) setViewport((current) => zoomedViewport(current, factor, { x: rect.width / 2, y: rect.height / 2 }));
  };
  const toggleCollapse = (id: string) => setDocument((current) => produce(current, (draft) => {
    const target = draft.sheets.find((item) => item.id === sheet.id);
    const found = target && findTopicInSheet(target, id);
    if (found && (found.topic.children.attached.length || found.topic.children.detached.length)) found.topic.collapsed = !found.topic.collapsed;
  }));

  // 两个开关都要开：分享者允许下载，且站点没关导出。站点级开关是管理员
  // 的意志，不该被单条分享链接的 `allowDownload` 覆盖。
  const canExport = share.allowDownload && config.exportEnabled;

  if (!sheet) return <InvalidShare code="SHARE_NOT_FOUND" />;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{share.title}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('share.public.byline', {
              owner: share.ownerNickname || t('share.public.anonymous'),
              time: new Date(share.createdAt).toLocaleDateString(),
            })}
            {share.expiresAt ? ` · ${t('share.public.expiresAt', { time: new Date(share.expiresAt).toLocaleDateString() })}` : ''}
          </p>
        </div>
        {canExport ? (
          <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
            <Icon name="download" className="mr-1.5 size-4" />
            {t('editor.exportEntry')}
          </Button>
        ) : null}
      </header>

      <div className="flex h-[calc(100svh-15rem)] min-h-[420px] flex-col overflow-hidden rounded-2xl border border-border/70 bg-background">
        <div ref={canvasRef} className="relative min-h-0 flex-1">
        {fonts.ready ? (
          <div id="share-canvas-surface" className="size-full">
          <MindMapViewer
            sheet={sheet}
            theme={document.theme}
            plugins={READ_ONLY_PLUGINS}
            layout={layout}
            viewport={viewport}
            onViewportChange={setViewport}
            onToggleCollapse={toggleCollapse}
            readOnly
            ariaLabel={share.title}
            className="size-full"
          />
          <CanvasScrollbars canvasRef={canvasRef} bounds={bounds} viewport={viewport} onChange={setViewport} surfaceId="share-canvas-surface" />
          </div>
        ) : (
          <LoadingState className="size-full" />
        )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1 border-t border-border/70 bg-card px-3 py-1.5">
          {document.sheets.length > 1 ? <Select aria-label={t('editor.sheets.label')} value={sheet.id} onChange={setSheetId}
            className="mr-auto w-40 max-w-full" size="sm" options={document.sheets.map((item) => ({ value: item.id, label: item.title }))} /> : null}
          <ToolbarButton variant="ghost" size="icon" className="size-8" aria-label={t('editor.zoomOut')} disabled={!fonts.ready || viewport.zoom <= MIN_ZOOM} onClick={() => zoom(1 / 1.2)}><Icon name="zoom-out" className="size-4" /></ToolbarButton>
          <Select aria-label={t('editor.zoomPresets')} size="sm" menuMinWidth={112} value={Number((viewport.zoom * 100).toFixed(6))}
            options={[50, 75, 100, 125, 150, 200].map((percent) => ({ value: percent, label: `${percent}%` }))}
            disabled={!fonts.ready} onChange={(percent) => zoom(percent / 100 / viewport.zoom)}
            renderTrigger={(props) => <button {...props} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"><span>{t('editor.zoomLevel', { percent: Math.round(viewport.zoom * 100) })}</span><Icon name="chevron-down" className="size-3 rotate-180" /></button>} />
          <ToolbarButton variant="ghost" size="icon" className="size-8" aria-label={t('editor.zoomIn')} disabled={!fonts.ready || viewport.zoom >= MAX_ZOOM} onClick={() => zoom(1.2)}><Icon name="zoom-in" className="size-4" /></ToolbarButton>
          <ToolbarButton variant="ghost" size="icon" className="size-8" aria-label={t('editor.fit')} disabled={!fonts.ready} onClick={fit}><Icon name="maximize" className="size-4" /></ToolbarButton>
          <ToolbarButton variant="ghost" size="icon" className="size-8" aria-label={t('editor.centerTopic')} disabled={!fonts.ready} onClick={() => {
            const rect = canvasRef.current?.getBoundingClientRect();
            const root = layout.boxes.get(sheet.rootTopic.id);
            if (rect && root) setViewport((current) => centeredViewport(current, root, rect));
          }}><Icon name="locate" className="size-4" /></ToolbarButton>
        </div>
      </div>

      {canExport && exportOpen ? (
        <Suspense fallback={<LoadingState className="fixed inset-0 z-40 bg-background/90" />}>
          <ExportDialog open={exportOpen} document={document} sheetId={sheet.id} brandLocked onClose={() => setExportOpen(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}

export function PublicSharePage() {
  const { token = '' } = useParams();
  // Scope all transient state, including pending password verification, to its share.
  return <PublicShareContent key={token} token={token} />;
}

function PublicShareContent({ token }: { token: string }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { config } = useSiteConfig();
  const [access, setAccess] = useState(() => readShareAccess(token));
  const prefill = useMemo(() => readSharePasswordQuery(location.search), [location.search]);
  const [passwordSeed, setPasswordSeed] = useState(() => ({ value: prefill.password, key: location.key }));

  // Keep the hint only in memory. Replace rather than push so Back cannot restore it.
  useLayoutEffect(() => {
    if (!prefill.present) return;
    setPasswordSeed((current) => current.key === location.key ? current : { value: prefill.password, key: location.key });
    void navigate({ pathname: location.pathname, search: prefill.search, hash: location.hash }, { replace: true, state: location.state });
  }, [prefill, location, navigate]);

  const query = useQuery({
    queryKey: [...shareKeys.public(token), access],
    queryFn: () => shareApi.publicGet(token, access || undefined),
    enabled: token !== '',
    // 分享可以随时被撤销：不缓存、不重试、切回标签页就重取。
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });

  const onGranted = useCallback((accessToken: string) => {
    setPasswordSeed((current) => ({ ...current, value: '' }));
    setAccess(accessToken);
  }, []);

  // 凭证过期（30 分钟）后接口回到 401：清掉本地凭证，回到密码框，
  // 而不是让用户对着一个永远转圈的页面。
  useEffect(() => {
    const error = query.error;
    if (error instanceof ApiError && error.code === 'SHARE_PASSWORD_REQUIRED' && access) {
      clearShareAccess(token);
      setAccess('');
      toast.info(t('share.public.passwordExpired'));
    }
  }, [query.error, access, token, t]);

  if (!token) return <InvalidShare code="SHARE_NOT_FOUND" />;

  if (query.isPending) {
    return (
      <LoadingState className="h-[60svh]" />
    );
  }

  if (query.error) {
    const code = query.error instanceof ApiError ? query.error.code : '';
    if (code === 'SHARE_PASSWORD_REQUIRED') {
      return <PasswordGate key={passwordSeed.key} token={token} initialPassword={passwordSeed.value} onGranted={onGranted} />;
    }
    if (code === 'SHARE_DISABLED') {
      return <InvalidShare code="SHARE_DISABLED" />;
    }
    return <InvalidShare code="SHARE_NOT_FOUND" />;
  }

  if (query.data) return <ShareCanvas key={token} share={query.data} />;

  // 站点关了分享但接口还没回来：直接给关闭页，不闪一下「不存在」。
  if (!config.shareEnabled) return <InvalidShare code="SHARE_DISABLED" />;

  return <InvalidShare code="SHARE_NOT_FOUND" />;
}
