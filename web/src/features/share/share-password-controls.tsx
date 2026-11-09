import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Icon } from '@/components/ui/icon';
import { Modal } from '@/components/ui/modal';
import { fieldErrorsFrom } from '@/lib/api/errors';
import { shareApi, type ShareLink } from '@/lib/api/shares';
import { shareKeys } from './queries';
import { copyToClipboard, generateSharePassword } from './share-password';

export function SharePasswordField({ value, onChange, error, disabled, autoFocus }: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [generationFailed, setGenerationFailed] = useState(false);
  return (
    <Field label={t('share.create.password')} htmlFor={id} error={generationFailed ? t('share.password.generateFailed') : error} hint={t('share.create.passwordHint')}>
      <div className="flex items-center gap-2">
        <Input id={id} type="text" className="min-w-0 flex-1" value={value} placeholder={t('share.create.passwordPlaceholder')}
          autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={64} disabled={disabled} autoFocus={autoFocus}
          aria-invalid={error || generationFailed ? true : undefined}
          onChange={(event) => { setGenerationFailed(false); onChange(event.target.value); }} />
        <Button variant="outline" size="sm" className="h-11 shrink-0" disabled={disabled}
          onClick={() => {
            try { onChange(generateSharePassword()); setGenerationFailed(false); }
            catch { setGenerationFailed(true); }
          }}>
          {t('share.password.generate')}
        </Button>
      </div>
    </Field>
  );
}

/** One compact password row shared by the map dialog and My shares. */
export function SharePasswordControl({ link, onReset }: { link: ShareLink; onReset: (link: ShareLink) => void }) {
  const { t } = useTranslation();
  if (!link.hasPassword) return null;
  const password = link.password;
  return (
    <span className="inline-flex max-w-full items-center gap-1 text-xs" data-share-password={link.uid}>
      <Icon name="lock" className="size-3.5 shrink-0 text-muted-foreground" />
      {password ? <>
        <code dir="ltr" className="max-w-40 select-all truncate" title={password} aria-label={t('share.create.password')}>{password}</code>
        <Button size="icon" variant="ghost" className="size-7 shrink-0" title={t('share.password.copy')} aria-label={t('share.password.copy')}
          onClick={async () => {
            const ok = await copyToClipboard(password);
            if (ok) toast.success(t('share.copied')); else toast.error(t('share.copyFailed'));
          }}><Icon name="copy" className="size-3.5" /></Button>
      </> : <span className="text-muted-foreground">{t('share.password.unavailable')}</span>}
      {!link.revokedAt ? <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onReset(link)}>
        {t('share.password.reset')}
      </Button> : null}
    </span>
  );
}

export function SharePasswordResetDialog({ link, onClose, onSaved }: { link: ShareLink; onClose: () => void; onSaved?: (link: ShareLink) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const update = useMutation({
    mutationFn: () => shareApi.update(link.uid, { password: password.trim() || null }),
    onSuccess: (saved) => {
      onSaved?.(saved);
      void queryClient.invalidateQueries({ queryKey: shareKeys.root });
      toast.success(t('share.password.saved'));
      onClose();
    },
  });
  const fields = update.error ? fieldErrorsFrom(update.error) : {};
  return <Modal open title={t('share.password.reset')} size="md" dismissible={!update.isPending} onClose={() => { if (!update.isPending) onClose(); }}>
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (!update.isPending) update.mutate(); }}>
      <SharePasswordField value={password} onChange={setPassword} error={fields.password} disabled={update.isPending} autoFocus />
      <p className="text-xs text-muted-foreground">{t('share.password.resetHint')}</p>
      {update.error && Object.keys(fields).length === 0 ? <p role="alert" className="text-xs text-destructive">{update.error.message}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={update.isPending} onClick={onClose}>{t('common.cancel')}</Button>
        <Button type="submit" loading={update.isPending}>{t('common.save')}</Button>
      </div>
    </form>
  </Modal>;
}
