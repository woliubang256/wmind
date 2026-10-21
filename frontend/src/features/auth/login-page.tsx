import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { TextField } from '@/components/ui/input';
import { api, setAccessToken, type AuthSession } from '@/lib/api/client';
import { ApiError, fieldErrorsFrom } from '@/lib/api/errors';
import { authKeys, useCurrentUser } from '@/app/auth';
import { useSiteConfig } from '@/features/site/use-site-config';
import type { FieldErrors } from '@/lib/validation';

export function LoginPage() {
  const { t } = useTranslation();
  const { config, isLoading: siteLoading } = useSiteConfig({ fresh: true });
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
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
      if (error instanceof ApiError) {
        const backendFields = fieldErrorsFrom(error);
        if (Object.keys(backendFields).length > 0) {
          setErrors(backendFields);
          return;
        }
        // 凭据错误不指向具体字段：指向哪一个都等于告诉攻击者「另一半是对的」。
        if (error.code === 'AUTH_INVALID_CREDENTIALS') {
          setErrors({ identifier: error.message });
          return;
        }
      }
      toast.error(error instanceof Error ? error.message : t('auth.loginFailed'));
    },
  });

  if (isLoading) return <div className="py-12 text-center text-sm text-muted-foreground">{t('common.loading')}</div>;
  if (currentUser) return <Navigate to="/" replace />;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: FieldErrors = {};
    if (!identifier.trim()) nextErrors.identifier = t('auth.identifierRequired');
    if (!password) nextErrors.password = t('auth.passwordRequired');
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    login.mutate();
  };

  return (
    <section className="rounded-3xl border border-border/80 bg-card/95 p-7 shadow-xl shadow-primary/5 backdrop-blur sm:p-9">
      <div className="mb-8 flex flex-col items-center gap-4 text-center">
        <img
          src={config.logoUrl || '/wmind-logo.jpg'}
          alt={t('auth.logoAlt')}
          className="size-24 rounded-3xl object-cover shadow-lg shadow-orange-500/15"
        />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('auth.loginTitle', { site: config.siteName })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('auth.loginDescription')}</p>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-5" noValidate>
        <TextField
          label={t('common.username')}
          name="identifier"
          autoComplete="username"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          error={errors.identifier}
        />
        <TextField
          label={t('common.password')}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={errors.password}
        />
        <Button type="submit" disabled={login.isPending} className="w-full">
          {login.isPending ? (
            <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
          ) : (
            <>
              {t('common.login')}
              <Icon name="arrow-right" className="size-4" />
            </>
          )}
        </Button>
      </form>

      {/* 一期没有自助找回：必须把人工路径说清楚，不能留到以后。 */}
      <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">{t('auth.forgotPassword')}</p>

      {/*
        配置还没回来时不渲染这一块。`useSiteConfig` 的兜底值是
        `registrationEnabled: false`，直接渲染会让开放注册的站点先闪一句
        「本站暂未开放注册」再变成「立即注册」——正好把最关键的信息说反一次。
      */}
      {siteLoading ? null : config.registrationEnabled ? (
        <div className="mt-4 border-t border-border pt-4 text-center text-sm text-muted-foreground">
          {t('auth.noAccount')}{' '}
          <Link className="font-medium text-primary hover:underline" to="/register">
            {t('auth.registerNow')}
          </Link>
        </div>
      ) : (
        <div className="mt-4 border-t border-border pt-4 text-center text-xs text-muted-foreground">
          {t('auth.registerClosed')}
        </div>
      )}
    </section>
  );
}
