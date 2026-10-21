import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { TextField } from '@/components/ui/input';
import { authKeys, useCurrentUser } from '@/app/auth';
import { useSiteConfig } from '@/features/site/use-site-config';
import { api, setAccessToken, type AuthSession } from '@/lib/api/client';
import { ApiError, codeToField, fieldErrorsFrom } from '@/lib/api/errors';
import { hasErrors, validateRegistration, type FieldErrors } from '@/lib/validation';

export function RegisterPage() {
  const { t } = useTranslation();
  const { config, isLoading: siteLoading } = useSiteConfig({ fresh: true });
  const { data: currentUser, isLoading: userLoading } = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({ username: '', email: '', password: '', nickname: '' });
  const [errors, setErrors] = useState<FieldErrors>({});

  const register = useMutation({
    mutationFn: () =>
      api.post<AuthSession>('/auth/register', form, { auth: false }),
    onSuccess: (session) => {
      // 注册即生效：后端直接下发令牌，前端不必再走一次登录。
      setAccessToken(session.accessToken);
      queryClient.setQueryData(authKeys.currentUser, session.user);
      toast.success(t('register.welcome'));
      navigate('/', { replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const backendFields = fieldErrorsFrom(error);
        if (Object.keys(backendFields).length > 0) {
          setErrors(backendFields);
          return;
        }
        const field = codeToField(error.code);
        if (field) {
          setErrors({ [field]: error.message });
          return;
        }
        if (error.code === 'REGISTRATION_CLOSED') {
          // 期间管理员关掉了注册：刷新站点配置，页面会自动切到「未开放」。
          void queryClient.invalidateQueries({ queryKey: ['site', 'config'] });
        }
      }
      toast.error(error instanceof Error ? error.message : t('register.failed'));
    },
  });

  const update = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateRegistration(form, config.passwordMinLength);
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) return;
    register.mutate();
  };

  if (userLoading || siteLoading) {
    return <div className="py-12 text-center text-sm text-muted-foreground">{t('common.loading')}</div>;
  }
  if (currentUser) return <Navigate to="/" replace />;

  if (!config.registrationEnabled) {
    return (
      <section className="relative rounded-3xl border border-border/80 bg-card/95 p-8 text-center shadow-xl shadow-primary/5">
        {/* 关站页也要有切换：读不懂「本站暂未开放注册」的人，正是最需要它的。 */}
        <LocaleSwitcher className="absolute right-4 top-4" />
        <span className="mx-auto mt-4 grid size-12 place-items-center rounded-2xl bg-secondary text-secondary-foreground">
          <Icon name="lock" className="size-5" />
        </span>
        <h1 className="mt-5 text-xl font-semibold tracking-tight">{t('register.closedTitle')}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('auth.registerClosed')}</p>
        <Button className="mt-6 w-full" onClick={() => navigate('/login')}>
          {t('register.backToLogin')}
        </Button>
      </section>
    );
  }

  return (
    <section className="relative rounded-3xl border border-border/80 bg-card/95 p-7 shadow-xl shadow-primary/5 backdrop-blur sm:p-9">
      <LocaleSwitcher className="absolute right-4 top-4" />

      <div className="mb-7 mt-5 text-center sm:mt-6">
        <h1 className="text-xl font-semibold tracking-tight">{t('register.title', { site: config.siteName })}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('register.description')}</p>
      </div>

      <form onSubmit={submit} className="space-y-4" noValidate>
        <TextField
          label={t('common.username')}
          name="username"
          autoComplete="username"
          value={form.username}
          onChange={update('username')}
          error={errors.username}
          hint={t('register.usernameHint')}
        />
        <TextField
          label={t('common.email')}
          name="email"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={update('email')}
          error={errors.email}
        />
        <TextField
          label={t('common.password')}
          name="password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={update('password')}
          error={errors.password}
          hint={t('register.passwordHint', { min: config.passwordMinLength })}
        />
        <TextField
          label={t('register.nickname')}
          name="nickname"
          autoComplete="nickname"
          value={form.nickname}
          onChange={update('nickname')}
          error={errors.nickname}
          hint={t('register.nicknameHint')}
        />
        <Button type="submit" disabled={register.isPending} className="w-full">
          {register.isPending ? (
            <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
          ) : (
            <>
              {t('register.submit')}
              <Icon name="arrow-right" className="size-4" />
            </>
          )}
        </Button>
      </form>

      <p className="mt-5 text-center text-sm text-muted-foreground">
        {t('register.haveAccount')}{' '}
        <Link className="font-medium text-primary hover:underline" to="/login">
          {t('common.login')}
        </Link>
      </p>
    </section>
  );
}
