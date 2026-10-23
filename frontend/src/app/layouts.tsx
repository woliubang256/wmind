import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { UserMenu } from '@/components/user-menu';
import { api, setAccessToken, setUnauthorizedHandler } from '@/lib/api/client';
import { useSiteConfig } from '@/features/site/use-site-config';
import { useThemeStore } from './theme-store';
import { authKeys, useCurrentUser } from './auth';

function LoadingPage() {
  const { t } = useTranslation();
  return <main className="grid min-h-svh place-items-center text-sm text-muted-foreground">{t('common.loading')}</main>;
}

export function RequireAuth() {
  const { data: user, isLoading, isError } = useCurrentUser();
  const location = useLocation();
  if (isLoading) return <LoadingPage />;
  if (isError || !user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

export function RequireAdmin() {
  const { data: user, isLoading } = useCurrentUser();
  if (isLoading) return <LoadingPage />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') return <Navigate to="/" replace />;
  return <Outlet />;
}

function ThemeToggle() {
  const { t } = useTranslation();
  // 使用全站共享偏好，页面跳转和刷新保持相同外观。
  const preference = useThemeStore((state) => state.preference);
  const cycle = useThemeStore((state) => state.cycle);
  const icon = preference === 'light' ? 'sun' : preference === 'dark' ? 'moon' : 'monitor';
  return (
    <Button variant="ghost" size="icon" className="size-8 sm:size-10" aria-label={t('common.theme')} title={t(`theme.${preference}`)} onClick={cycle}>
      <Icon name={icon} className="size-4" />
    </Button>
  );
}

/**
 * 移动端导航抽屉。
 *
 * 用原生 `<dialog>` 而不是自己造遮罩：焦点陷阱、Esc 关闭、`::backdrop` 都由
 * 浏览器负责。这里只把它从「居中对话框」改成「贴左边的抽屉」——原生 dialog
 * 默认靠 `margin: auto` 居中，preflight 又把 margin 清零，所以 `m-0` 就落到了
 * 左上角，配 `h-svh` 就是一条侧栏。
 *
   * 为什么窄屏要收起来而不是横向滚动：多条链接在 375px 上横向滚动条根本看不出
 * 还有内容，用户会以为「我的分享」之后就没有了。
 */
function MobileNav({
  open,
  links,
  isActive,
  onClose,
}: {
  open: boolean;
  links: { to: string; label: string; icon: IconName }[];
  isActive: (to: string) => boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        // 点遮罩时 target 是 dialog 自己。
        if (event.target === ref.current) onClose();
      }}
      aria-label={t('nav.menu')}
      className="m-0 h-svh max-h-svh w-72 max-w-[82vw] rounded-none border-0 border-r border-border bg-card p-0 text-card-foreground backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-semibold">{t('nav.menu')}</span>
          <Button variant="ghost" size="icon" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" className="size-4" />
          </Button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
          {links.map(({ to, label, icon }) => {
            const active = isActive(to);
            return (
              <Link
                key={to}
                to={to}
                onClick={onClose}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}`}
              >
                <Icon name={icon} className="size-4" />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </dialog>
  );
}

export function AppLayout() {
  const { t } = useTranslation();
  const { data: user } = useCurrentUser();
  const { config } = useSiteConfig();
  const location = useLocation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAccessToken(null);
      void queryClient.setQueryData(authKeys.currentUser, null);
      navigate('/login', { replace: true });
    });
    return () => setUnauthorizedHandler(undefined);
  }, [navigate, queryClient]);

  // 换页时收抽屉：手机上点完链接还盖着半屏菜单是常态 bug。
  useEffect(() => setNavOpen(false), [location.pathname]);

  const signOut = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      toast.error(t('app.logoutUnconfirmed'));
    } finally {
      setAccessToken(null);
      queryClient.clear();
      navigate('/login', { replace: true });
    }
  };

  const links = [
    { to: '/', label: t('nav.recent'), icon: 'files' as const },
    { to: '/templates', label: t('nav.templates'), icon: 'waypoints' as const },
    { to: '/shares', label: t('nav.shares'), icon: 'link' as const },
    { to: '/trash', label: t('nav.trash'), icon: 'trash' as const },
  ];
  const adminLinks = user?.role === 'admin'
    ? [
        { to: '/admin', label: t('nav.adminOverview'), icon: 'layout-dashboard' as const },
        { to: '/admin/users', label: t('nav.adminUsers'), icon: 'shield' as const },
        { to: '/admin/settings', label: t('nav.adminSettings'), icon: 'settings' as const }
      ]
    : [];

  const userLinks = [{ to: '/account', label: t('nav.account'), icon: 'settings' as const }, ...adminLinks];
  const allLinks = [...links, ...userLinks];

  /**
   * 导航高亮。
   *
   * 前缀匹配必须让「更具体的链接」优先：`/admin/users` 同时以 `/admin`
   * 开头，只按前缀判断会点亮两项，用户看不出自己在哪一页。
   */
  const isActive = (to: string) => {
    if (location.pathname === to) return true;
    if (to === '/' || !location.pathname.startsWith(`${to}/`)) return false;
    return !allLinks.some((other) => other.to !== to && other.to.length > to.length && location.pathname.startsWith(other.to));
  };

  /**
   * 编辑器要**满宽**。
   *
   * 侧栏换成顶栏就是为了把横向空间还给画布，如果内容区还套着 `max-w-7xl`
   * 与 `px-4 py-7`，等于只还了一半。编辑器自己管高度（`100svh - 顶栏`），
   * 其余页面仍然是居中的内容列。
   */
  const fullBleed = location.pathname.startsWith('/maps/');

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/90 backdrop-blur">
        <div className="flex h-14 items-center gap-2 px-3 sm:px-4">
          <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
            <img src={config.logoUrl || '/wmind-logo.jpg'} alt="" className="size-8 rounded-lg object-cover shadow-sm" />
            <span className="hidden max-w-40 truncate sm:inline">{config.siteName}</span>
          </Link>

          {/*
            桌面端导航。
            `md` 到 `xl` 之间只留图标，给右侧用户、语言与外观操作保留空间；
            折行后顶栏会突然变高、画布跟着跳一下。图标有 `title` 与
            `aria-label`，悬停和读屏都拿得到名字。
          */}
          <nav aria-label={t('nav.primary')} className="ml-1 hidden items-center gap-0.5 md:flex">
            {links.map(({ to, label, icon }) => {
              const active = isActive(to);
              return (
                <Link
                  key={to}
                  to={to}
                  title={label}
                  aria-label={label}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}`}
                >
                  <Icon name={icon} className="size-4 shrink-0" />
                  <span className="hidden xl:inline">{label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            {user ? <UserMenu user={user} links={userLinks} isActive={isActive} /> : null}
            <Button
              variant="ghost"
              size="icon"
              className="size-8 sm:size-10 md:hidden"
              aria-label={t('nav.menu')}
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            >
              <Icon name="menu" className="size-5" />
            </Button>
            <LocaleSwitcher className="max-sm:[&_[role=combobox]>span]:hidden" />
            <ThemeToggle />
            <Button variant="ghost" size="icon" className="size-8 sm:size-10" aria-label={t('common.logout')} onClick={() => void signOut()}>
              <Icon name="logout" className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <MobileNav open={navOpen} links={links} isActive={isActive} onClose={() => setNavOpen(false)} />

      {fullBleed ? (
        <main className="min-w-0"><Outlet /></main>
      ) : (
        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6"><Outlet /></main>
      )}
    </div>
  );
}

export function AuthLayout() {
  return (
    <main className="grid min-h-svh place-items-center bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/10 via-background to-background px-4 py-12">
      <div className="w-full max-w-md"><Outlet /></div>
    </main>
  );
}

export function PublicLayout() {
  const { config } = useSiteConfig();
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b border-border/70 px-5 py-3"><Link to="/" className="inline-flex items-center gap-2 font-semibold"><img src={config.logoUrl || '/wmind-logo.jpg'} alt="" className="size-9 rounded-xl object-cover" /><span>{config.siteName}</span></Link></header>
      <main className="mx-auto max-w-6xl px-4 py-8"><Outlet /></main>
    </div>
  );
}
