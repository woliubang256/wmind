import { useEffect } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
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
  // 状态在 store 里，和「个人设置 → 外观」共用：两处各存一份会导致
  // 在设置页切了之后顶栏图标不动。
  const preference = useThemeStore((state) => state.preference);
  const cycle = useThemeStore((state) => state.cycle);
  const icon = preference === 'light' ? 'sun' : preference === 'dark' ? 'moon' : 'monitor';
  return (
    <Button variant="ghost" size="icon" aria-label={t('common.theme')} title={t(`theme.${preference}`)} onClick={cycle}>
      <Icon name={icon} className="size-4" />
    </Button>
  );
}

export function AppLayout() {
  const { t } = useTranslation();
  const { data: user } = useCurrentUser();
  const { config } = useSiteConfig();
  const location = useLocation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAccessToken(null);
      void queryClient.setQueryData(authKeys.currentUser, null);
      navigate('/login', { replace: true });
    });
    return () => setUnauthorizedHandler(undefined);
  }, [navigate, queryClient]);

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
    { to: '/account', label: t('nav.account'), icon: 'settings' as const },
  ];
  const adminLinks = user?.role === 'admin'
    ? [
        { to: '/admin', label: t('nav.adminOverview'), icon: 'layout-dashboard' as const },
        { to: '/admin/users', label: t('nav.adminUsers'), icon: 'shield' as const },
        { to: '/admin/settings', label: t('nav.adminSettings'), icon: 'settings' as const }
      ]
    : [];

  const allLinks = [...links, ...adminLinks];

  /**
   * 侧栏高亮。
   *
   * 前缀匹配必须让「更具体的链接」优先：`/admin/users` 同时以 `/admin`
   * 开头，只按前缀判断会点亮两项，用户看不出自己在哪一页。
   */
  const isActive = (to: string) => {
    if (location.pathname === to) return true;
    if (to === '/' || !location.pathname.startsWith(`${to}/`)) return false;
    return !allLinks.some((other) => other.to !== to && other.to.length > to.length && location.pathname.startsWith(other.to));
  };

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <img src={config.logoUrl || '/wmind-logo.jpg'} alt="" className="size-9 rounded-xl object-cover shadow-sm" />
            <span>{config.siteName}</span>
          </Link>
          <div className="flex items-center gap-1">
            <span className="hidden pr-2 text-sm text-muted-foreground sm:inline">{user?.nickname || user?.username}</span>
            <ThemeToggle />
            <Button variant="ghost" size="icon" aria-label={t('common.logout')} onClick={() => void signOut()}>
              <Icon name="logout" className="size-4" />
            </Button>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-7 sm:px-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="flex gap-1 overflow-x-auto md:flex-col">
          {allLinks.map(({ to, label, icon }) => {
            const active = isActive(to);
            return (
              <Link
                key={to}
                to={to}
                className={`flex shrink-0 items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}`}
              >
                <Icon name={icon} className="size-4" />{label}
              </Link>
            );
          })}
        </aside>
        <main className="min-w-0"><Outlet /></main>
      </div>
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
