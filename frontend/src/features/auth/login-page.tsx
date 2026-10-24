import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { LoadingState } from '@/components/ui/loading-state';
import { LoadingImage } from '@/components/ui/loading-image';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { TextField } from '@/components/ui/input';
import { api, setAccessToken, type AuthSession } from '@/lib/api/client';
import type { TwoFactorChallenge } from '@/lib/api/two-factor';
import { loginWithPassword } from '@/lib/api/login';
import { ApiError, fieldErrorsFrom } from '@/lib/api/errors';
import { authKeys, useCurrentUser } from '@/app/auth';
import { useSiteConfig } from '@/features/site/use-site-config';
import type { FieldErrors } from '@/lib/validation';

export function LoginPage() {
  const { t } = useTranslation();
  const { config, isLoading: siteLoading } = useSiteConfig({ fresh: true });
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: currentUser, isLoading } = useCurrentUser();

  const login = useMutation({
    mutationFn: () => challenge
      ? api.post<AuthSession>('/auth/2fa/verify', { challengeToken: challenge.challengeToken, code }, { auth: false })
      : loginWithPassword(identifier, password),
    onSuccess: (session) => {
      if ('twoFactorRequired' in session) {
        setChallenge(session); setPassword(''); setCode(''); setRecovery(false); setErrors({}); return;
      }
      setAccessToken(session.accessToken);
      queryClient.setQueryData(authKeys.currentUser, session.user);
      const state = location.state as { from?: string } | null;
      navigate(state?.from ?? '/', { replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        if (challenge) {
          if (error.code === 'AUTH_2FA_EXPIRED') { setChallenge(null); setCode(''); setErrors({ identifier: error.message }); }
          else setErrors({ code: error.message });
          return;
        }
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

  if (isLoading) return <LoadingState className="py-12" />;
  if (currentUser) return <Navigate to="/" replace />;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: FieldErrors = {};
    if (challenge) {
      if (!code.trim()) { setErrors({ code: t('twoFactor.codeRequired') }); return; }
      setErrors({}); login.mutate(); return;
    }
    if (!identifier.trim()) nextErrors.identifier = t('auth.identifierRequired');
    if (!password) nextErrors.password = t('auth.passwordRequired');
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    login.mutate();
  };

  return (
    <section className="relative rounded-3xl border border-border/80 bg-card/95 p-7 shadow-xl shadow-primary/5 backdrop-blur sm:p-9">
      {/*
        语言切换放在卡片右上角，并且是**第一个**可聚焦元素：看不懂当前界面语言
        的人，第一个 Tab 就该落在它上面。`mt-5` 给 logo 让出一行高度，否则窄屏上
        这块会和居中的 logo 在角上蹭到一起。
      */}
      <LocaleSwitcher className="absolute right-4 top-4" />

      <div className="mb-8 mt-5 flex flex-col items-center gap-4 text-center sm:mt-7">
        <LoadingImage
          src={config.logoUrl || '/wmind-logo.jpg'}
          alt={t('auth.logoAlt')}
          containerClassName="size-24 overflow-hidden rounded-3xl shadow-lg shadow-orange-500/15"
          className="size-full object-cover"
        />
        <h1 className="text-xl font-semibold tracking-tight">{t('auth.loginTitle', { site: config.siteName })}</h1>
      </div>

      <form onSubmit={submit} className="space-y-5" noValidate>
        {challenge ? <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('twoFactor.loginHint')}</p>
          <TextField key={recovery ? 'recovery' : 'totp'} autoFocus label={t(recovery ? 'twoFactor.recoveryCode' : 'twoFactor.code')}
            autoComplete="one-time-code" inputMode={recovery ? 'text' : 'numeric'} maxLength={recovery ? 30 : 6}
            value={code} onChange={(event) => setCode(event.target.value)} error={errors.code} />
          <Button type="button" variant="ghost" disabled={login.isPending} onClick={() => { setRecovery(!recovery); setCode(''); setErrors({}); }}>
            {t(recovery ? 'twoFactor.useAuthenticator' : 'twoFactor.useRecovery')}
          </Button>
        </div> : <>
          <TextField label={t('common.username')} name="identifier" autoComplete="username" value={identifier}
            onChange={(event) => setIdentifier(event.target.value)} error={errors.identifier} />
          <TextField label={t('common.password')} name="password" type="password" autoComplete="current-password" value={password}
            onChange={(event) => setPassword(event.target.value)} error={errors.password} />
        </>}
        <Button type="submit" loading={login.isPending} className="w-full">
          {t(challenge ? 'twoFactor.verify' : 'common.login')}
          <Icon name="arrow-right" className="size-4" />
        </Button>
        {challenge ? <Button type="button" variant="outline" className="w-full" disabled={login.isPending}
          onClick={() => { setChallenge(null); setCode(''); setPassword(''); setErrors({}); login.reset(); }}>{t('twoFactor.backToPassword')}</Button> : null}
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
