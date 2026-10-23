import { TwoFactorCard } from './two-factor-card';
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { UserAvatar } from '@/components/user-avatar';
import { TextField } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { authKeys, useCurrentUser } from '@/app/auth';
import { useSiteConfig } from '@/features/site/use-site-config';
import { userApi } from '@/lib/api/endpoints';
import type { User } from '@/lib/api/types';
import { ApiError, codeToField, fieldErrorsFrom } from '@/lib/api/errors';
import { hasErrors, validatePasswordChange, validateProfile, type FieldErrors } from '@/lib/validation';

export function AccountPage() {
  const { t } = useTranslation();
  const { data: user } = useCurrentUser();
  if (!user) return null;
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('account.title')}</h1>
      </header>
      <AvatarCard user={user} />
      <ProfileCard user={user} />
      <PasswordCard />
      <TwoFactorCard userUID={user.uid} />
    </div>
  );
}

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return <Panel title={title} description={description} bodyClassName="p-5 sm:p-6">{children}</Panel>;
}

function AvatarCard({ user }: { user: NonNullable<ReturnType<typeof useCurrentUser>['data']> }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const upload = useMutation({
    mutationFn: (file: File) => userApi.uploadAvatar(file),
    onSuccess: (updated: User) => {
      queryClient.setQueryData(authKeys.currentUser, updated);
      toast.success(t('account.avatarUpdated'));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : t('account.avatarFailed'));
    },
    onSettled: () => {
      setUploading(false);
      // 允许重复选同一个文件：不清空 input，第二次选同一张图不会触发 change。
      if (inputRef.current) inputRef.current.value = '';
    },
  });

  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    upload.mutate(file);
  };

  return (
    <Card title={t('account.avatar')}>
      <div className="flex flex-wrap items-center gap-4">
        <UserAvatar user={user} className="size-16 rounded-2xl text-2xl" />
        <div className="space-y-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={pick}
            aria-label={t('account.avatar')}
          />
          <Button variant="outline" size="sm" disabled={uploading} onClick={() => inputRef.current?.click()}>
            <Icon name="image" className="size-4" />
            {uploading ? t('account.uploading') : t('account.changeAvatar')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('account.avatarFormats')}</p>
        </div>
      </div>
    </Card>
  );
}

function ProfileCard({ user }: { user: NonNullable<ReturnType<typeof useCurrentUser>['data']> }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ nickname: user.nickname ?? '', email: user.email });
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: () => userApi.updateProfile(form),
    onSuccess: (updated: User) => {
      queryClient.setQueryData(authKeys.currentUser, updated);
      setErrors({});
      toast.success(t('account.profileSaved'));
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const fields = fieldErrorsFrom(error);
        if (Object.keys(fields).length > 0) {
          setErrors(fields);
          return;
        }
        const field = codeToField(error.code);
        if (field) {
          setErrors({ [field]: error.message });
          return;
        }
      }
      toast.error(error instanceof Error ? error.message : t('account.profileFailed'));
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateProfile(form);
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) return;
    save.mutate();
  };

  return (
    <Card title={t('account.profile')} description={t('account.profileHint')}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <TextField
          label={t('account.username')}
          value={user.username}
          readOnly
          disabled
          hint={t('account.usernameReadonly')}
        />
        <TextField
          label={t('account.nickname')}
          value={form.nickname}
          onChange={(event) => setForm((prev) => ({ ...prev, nickname: event.target.value }))}
          error={errors.nickname}
        />
        <TextField
          label={t('common.email')}
          type="email"
          value={form.email}
          onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
          error={errors.email}
          hint={t('account.emailHint')}
        />
        <div className="flex justify-end">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const { t } = useTranslation();
  const { config } = useSiteConfig();
  const [form, setForm] = useState({ oldPassword: '', newPassword: '', confirmPassword: '' });
  const [errors, setErrors] = useState<FieldErrors>({});

  const change = useMutation({
    mutationFn: () => userApi.changePassword({ oldPassword: form.oldPassword, newPassword: form.newPassword }),
    onSuccess: () => {
      setForm({ oldPassword: '', newPassword: '', confirmPassword: '' });
      setErrors({});
      toast.success(t('account.passwordChanged'));
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const fields = fieldErrorsFrom(error);
        if (Object.keys(fields).length > 0) {
          setErrors(fields);
          return;
        }
        if (error.code === 'AUTH_INVALID_CREDENTIALS') {
          setErrors({ oldPassword: error.message });
          return;
        }
      }
      toast.error(error instanceof Error ? error.message : t('account.passwordFailed'));
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validatePasswordChange(form, config.passwordMinLength);
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) return;
    change.mutate();
  };

  return (
    <Card title={t('account.password')} description={t('account.passwordHint')}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <TextField
          label={t('account.oldPassword')}
          type="password"
          autoComplete="current-password"
          value={form.oldPassword}
          onChange={(event) => setForm((prev) => ({ ...prev, oldPassword: event.target.value }))}
          error={errors.oldPassword}
        />
        <TextField
          label={t('account.newPassword')}
          type="password"
          autoComplete="new-password"
          value={form.newPassword}
          onChange={(event) => setForm((prev) => ({ ...prev, newPassword: event.target.value }))}
          error={errors.newPassword}
          hint={t('register.passwordHint', { min: config.passwordMinLength })}
        />
        <TextField
          label={t('account.confirmPassword')}
          type="password"
          autoComplete="new-password"
          value={form.confirmPassword}
          onChange={(event) => setForm((prev) => ({ ...prev, confirmPassword: event.target.value }))}
          error={errors.confirmPassword}
        />
        <div className="flex justify-end">
          <Button type="submit" disabled={change.isPending}>
            {change.isPending ? t('common.saving') : t('account.changePassword')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
