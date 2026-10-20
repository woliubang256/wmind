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

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { TextField } from '@/components/ui/input';
import { ApiError } from '@/lib/api/errors';
import {
  clearShareAccess,
  readShareAccess,
  shareApi,
  writeShareAccess,
  type PublicShare,
} from '@/lib/api/shares';
import { parseDocument } from '@/editor/model/validate';
import { MindMapViewer } from '@/editor/viewer/mind-map-viewer';
import { READ_ONLY_PLUGINS } from '@/editor/viewer/plugins';
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
function PasswordGate({ token, onGranted }: { token: string; onGranted: (accessToken: string) => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
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
        <Button type="submit" disabled={pending || password === ''}>
          {pending ? t('share.public.submitting') : t('share.public.submit')}
        </Button>
      </form>
    </ShareShell>
  );
}

/** 只读画布。文档已经过归一化，字体就绪后才进布局（否则宽度会被永久缓存错）。 */
function ShareCanvas({ share }: { share: PublicShare }) {
  const { t } = useTranslation();
  const document = useMemo(() => parseDocument(share.document).document, [share.document]);
  const fonts = useFontsReady(document);
  const sheet = document.sheets[0];
  const [exportOpen, setExportOpen] = useState(false);

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
        {share.allowDownload ? (
          <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
            <Icon name="download" className="mr-1.5 size-4" />
            {t('editor.exportEntry')}
          </Button>
        ) : null}
      </header>

      <div className="h-[calc(100svh-15rem)] min-h-[420px] overflow-hidden rounded-2xl border border-border/70 bg-background">
        {fonts.ready ? (
          <MindMapViewer
            sheet={sheet}
            theme={document.theme}
            plugins={READ_ONLY_PLUGINS}
            readOnly
            ariaLabel={share.title}
            className="size-full"
          />
        ) : (
          <div className="grid size-full place-items-center text-sm text-muted-foreground">{t('common.loading')}</div>
        )}
      </div>

      {share.allowDownload && exportOpen ? (
        <Suspense fallback={null}>
          <ExportDialog open={exportOpen} document={document} sheetId={sheet.id} onClose={() => setExportOpen(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}

export function PublicSharePage() {
  const { token = '' } = useParams();
  const { t } = useTranslation();
  const { config } = useSiteConfig();
  const [access, setAccess] = useState(() => readShareAccess(token));

  // 换令牌（比如从一个分享跳到另一个）时，凭证也要跟着换。
  useEffect(() => {
    setAccess(readShareAccess(token));
  }, [token]);

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
      <div className="grid h-[60svh] place-items-center text-sm text-muted-foreground">{t('common.loading')}</div>
    );
  }

  if (query.error) {
    const code = query.error instanceof ApiError ? query.error.code : '';
    if (code === 'SHARE_PASSWORD_REQUIRED') {
      return <PasswordGate token={token} onGranted={onGranted} />;
    }
    if (code === 'SHARE_DISABLED') {
      return <InvalidShare code="SHARE_DISABLED" />;
    }
    return <InvalidShare code="SHARE_NOT_FOUND" />;
  }

  if (query.data) return <ShareCanvas share={query.data} />;

  // 站点关了分享但接口还没回来：直接给关闭页，不闪一下「不存在」。
  if (!config.shareEnabled) return <InvalidShare code="SHARE_DISABLED" />;

  return <InvalidShare code="SHARE_NOT_FOUND" />;
}
