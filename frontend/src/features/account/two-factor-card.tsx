import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LoadingState } from '@/components/ui/loading-state';
import { LoadingImage } from '@/components/ui/loading-image';
import { authKeys } from '@/app/auth';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { api, setAccessToken } from '@/lib/api/client';
import type { TwoFactorChange, TwoFactorSetup, TwoFactorStatus } from '@/lib/api/two-factor';

type Mode = 'idle' | 'start' | 'enable' | 'disable' | 'regenerate';

export function TwoFactorCard({ userUID }: { userUID: string }) {
  const statusKey = ['account', 'two-factor', userUID] as const;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: statusKey, queryFn: () => api.get<TwoFactorStatus>('/auth/2fa/status'), staleTime: 30_000 });
  const [mode, setMode] = useState<Mode>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const reset = () => { setMode('idle'); setPassword(''); setCode(''); setSetup(null); setError(''); };
  const change = useMutation<TwoFactorSetup | TwoFactorChange, Error, void>({
    mutationFn: () => mode === 'start'
      ? api.post<TwoFactorSetup>('/auth/2fa/setup', { password }, { retryAuth: false })
      : api.post<TwoFactorChange>(`/auth/2fa/${mode === 'regenerate' ? 'recovery-codes' : mode}`, { password, code }, { retryAuth: false }),
    onSuccess(result) {
      setError('');
      if ('secret' in result) { setSetup(result); setMode('enable'); setCode(''); return; }
      if (result.session) {
        setAccessToken(result.session.accessToken);
        queryClient.setQueryData(authKeys.currentUser, result.session.user);
      }
      setCodes(result.recoveryCodes ?? []);
      reset();
      void queryClient.invalidateQueries({ queryKey: statusKey });
    },
    onError(err) { setError(err instanceof Error ? err.message : t('errors.unknown')); },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!password || (mode !== 'start' && !code.trim())) { setError(t('twoFactor.required')); return; }
    change.mutate();
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${t('twoFactor.title')}\n${t('twoFactor.codesHint')}\n\n${codes.join('\n')}\n`], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'wmind-recovery-codes.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const busy = change.isPending;
  return <Panel title={t('twoFactor.title')} description={t('twoFactor.description')} bodyClassName="p-5 sm:p-6">
    <div className="space-y-4" data-two-factor-settings>
      {status.isPending ? <LoadingState small className="py-6" /> : status.isError ? <div role="alert" className="space-y-3">
        <p>{status.error.message}</p><Button variant="outline" onClick={() => void status.refetch()}>{t('common.retry')}</Button>
      </div> : <p className="text-sm" role="status">{status.data.enabled ? t('twoFactor.enabled', { count: status.data.recoveryCodesRemaining }) : t('twoFactor.disabled')}</p>}
      {codes.length > 0 ? <div className="space-y-4 rounded-xl border border-border bg-muted/30 p-4">
        <p className="font-medium">{t('twoFactor.saveCodes')}</p>
        <p className="text-sm text-muted-foreground">{t('twoFactor.codesHint')}</p>
        <pre data-recovery-codes className="grid whitespace-pre-wrap rounded-lg bg-background p-3 text-sm leading-7">{codes.join('\n')}</pre>
        <div className="flex flex-wrap gap-2"><Button onClick={download}>{t('twoFactor.downloadCodes')}</Button>
          <Button variant="outline" onClick={() => setCodes([])}>{t('twoFactor.codesSaved')}</Button></div>
      </div> : mode === 'idle' ? <div className="flex flex-wrap gap-2">
        {status.data?.enabled ? <>
          <Button variant="outline" onClick={() => setMode('regenerate')}>{t('twoFactor.regenerate')}</Button>
          <Button variant="outline" onClick={() => setMode('disable')}>{t('twoFactor.disable')}</Button>
        </> : <Button disabled={!status.data} onClick={() => setMode('start')}>{t('twoFactor.enable')}</Button>}
      </div> : <form className="max-w-lg space-y-4" onSubmit={submit}>
        <p className="text-sm font-medium">{t(mode === 'start' || mode === 'enable' ? 'twoFactor.enable' : mode === 'disable' ? 'twoFactor.disable' : 'twoFactor.regenerate')}</p>
        {mode === 'disable' ? <p className="text-sm text-muted-foreground">{t('twoFactor.disableHint')}</p> : null}
        {mode === 'regenerate' ? <p className="text-sm text-muted-foreground">{t('twoFactor.regenerateHint')}</p> : null}
        <TextField label={t('twoFactor.password')} type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} required />
        {setup ? <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('twoFactor.scanHint')}</p>
          <LoadingImage src={setup.qrCode} alt={t('twoFactor.qrAlt')} width={240} height={240} containerClassName="size-60 overflow-hidden rounded-lg border border-border bg-white" className="size-full" />
          <TextField label={t('twoFactor.manualKey')} value={setup.secret} readOnly className="font-mono" onFocus={(e) => e.target.select()} />
        </div> : null}
        {mode !== 'start' ? <TextField label={t(mode === 'enable' ? 'twoFactor.code' : 'twoFactor.codeOrRecovery')} autoComplete="one-time-code" value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} required /> : null}
        <p className="text-xs text-muted-foreground">{t('twoFactor.reuseHint')}</p>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>{busy ? t('common.processing') : t(mode === 'start' ? 'twoFactor.next' : mode === 'enable' ? 'twoFactor.confirmEnable' : 'common.submit')}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={reset}>{t('common.cancel')}</Button>
        </div>
      </form>}
    </div>
  </Panel>;
}
