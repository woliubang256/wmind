import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/ui/icon';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, setAccessToken, type AuthSession } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { authKeys, useCurrentUser } from '@/app/auth';

export function LoginPage() {
  const { t } = useTranslation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: currentUser, isLoading } = useCurrentUser();
  const login = useMutation({
    mutationFn: () => api.post<AuthSession>('/auth/login', { identifier, password }, { auth: false }),
    onSuccess: (session) => {
      setAccessToken(session.accessToken);
      queryClient.setQueryData(authKeys.currentUser, session.user);
      const state = location.state as { from?: string } | null;
      navigate(state?.from ?? '/', { replace: true });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : '登录失败，请稍后重试。');
    },
  });

  if (isLoading) return <div className="py-12 text-center text-sm text-muted-foreground">{t('common.loading')}</div>;
  if (currentUser) return <Navigate to="/" replace />;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    login.mutate();
  };

  return (
    <section className="rounded-3xl border border-border/80 bg-card/95 p-7 shadow-xl shadow-primary/5 backdrop-blur sm:p-9">
      <div className="mb-8 flex flex-col items-center gap-4 text-center">
        <img src="/wmind-logo.jpg" alt="wmind 标志" className="size-24 rounded-3xl object-cover shadow-lg shadow-orange-500/15" />
        <div><h1 className="text-xl font-semibold tracking-tight">{t('auth.loginTitle')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('auth.loginDescription')}</p></div>
      </div>
      <form onSubmit={submit} className="space-y-5">
        <label className="block space-y-2 text-sm font-medium" htmlFor="identifier">
          {t('common.username')}
          <input
            id="identifier"
            name="identifier"
            autoComplete="username"
            required
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            className="h-11 w-full rounded-xl border border-input bg-background px-3 font-normal outline-none transition focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="block space-y-2 text-sm font-medium" htmlFor="password">
          {t('common.password')}
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="h-11 w-full rounded-xl border border-input bg-background px-3 font-normal outline-none transition focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <Button type="submit" disabled={login.isPending} className="w-full">
          {login.isPending ? <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" /> : <>{t('common.login')}<Icon name="arrow-right" className="size-4" /></>}
        </Button>
      </form>
      <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">{t('auth.forgotPassword')}</p>
      <div className="mt-4 border-t border-border pt-4 text-center text-sm text-muted-foreground">
        <span>{t('auth.registerClosed')} </span>
        <Link className="font-medium text-primary hover:underline" to="/register">注册状态</Link>
      </div>
    </section>
  );
}
