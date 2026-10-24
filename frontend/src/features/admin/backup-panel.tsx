import { useEffect, useId, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { EmptyState, Panel } from '@/components/ui/panel';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { backupApi, backupKeys, type BackupConfiguration, type BackupJob, type BackupState, type RestorePreview } from './backup-api';
import { CronEditor } from './cron-editor';

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function size(bytes: number): string { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`; }

export function BackupPanel() {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: backupKeys.state, queryFn: backupApi.get, refetchInterval: (state) => state.state.data?.busy ? 2000 : 15000 });
  if (query.isError) return <EmptyState icon="alert" title={t('backup.loadFailed')} description={errorMessage(query.error)} action={<Button size="sm" variant="outline" onClick={() => void query.refetch()}>{t('common.retry')}</Button>} />;
  if (!query.data) return <EmptyState icon="clock" title={t('backup.loading')} />;
  return <div className="space-y-5"><BackupForm state={query.data} /><RestorePanel busy={query.data.busy} maxBytes={query.data.maxUploadBytes} /><JobHistory state={query.data} /></div>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block min-w-0 space-y-1.5"><span className="text-xs font-medium">{label}</span>{children}{hint && <span className="block text-xs leading-5 text-muted-foreground">{hint}</span>}</label>;
}

function BackupForm({ state }: { state: BackupState }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<BackupConfiguration>(state.configuration);
  const [schedule, setSchedule] = useState({ cron: draft.cron, timezone: draft.timezone });
  const timezonesId = useId();
  useEffect(() => { const timer = setTimeout(() => setSchedule({ cron: draft.cron, timezone: draft.timezone }), 350); return () => clearTimeout(timer); }, [draft.cron, draft.timezone]);
  const preview = useQuery({ queryKey: ['admin', 'backup-schedule', schedule], queryFn: () => backupApi.schedule(schedule.cron, schedule.timezone), retry: false, staleTime: 60000 });
  const scheduleCurrent = schedule.cron === draft.cron && schedule.timezone === draft.timezone;
  const scheduleValid = scheduleCurrent && preview.isSuccess;
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.configuration);
  const retentionValid = Number.isInteger(draft.retainCount) && draft.retainCount >= 1 && draft.retainCount <= 1000;
  const save = useMutation({ mutationFn: () => backupApi.save(draft), onSuccess: (updated) => { queryClient.setQueryData(backupKeys.state, updated); setDraft(updated.configuration); toast.success(t('backup.saved')); }, onError: (error) => toast.error(errorMessage(error)) });
  const test = useMutation({ mutationFn: () => backupApi.test(draft), onSuccess: () => toast.success(t('backup.testPassed')), onError: (error) => toast.error(errorMessage(error)) });
  const run = useMutation({ mutationFn: backupApi.run, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: backupKeys.state }); toast.success(t('backup.started')); }, onError: (error) => toast.error(errorMessage(error)) });
  const disabled = state.busy || save.isPending || test.isPending || run.isPending;
  const set = <K extends keyof BackupConfiguration>(key: K, value: BackupConfiguration[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const setDAV = (key: keyof BackupConfiguration['webdav'], value: string) => setDraft((current) => ({ ...current, webdav: { ...current.webdav, [key]: value } }));
  const setS3 = (key: keyof BackupConfiguration['s3'], value: string | boolean) => setDraft((current) => ({ ...current, s3: { ...current.s3, [key]: value } }));
  const credentialsSet = draft.target === 'webdav' ? draft.webdav.passwordSet : draft.s3.accessKeySet || draft.s3.secretKeySet || draft.s3.sessionTokenSet;
  const formatTime = (raw: string) => new Intl.DateTimeFormat(i18n.resolvedLanguage, { timeZone: schedule.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(raw));
  return <Panel title={t('backup.backupTitle')} description={t('backup.backupDescription')}>
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); if (!disabled && scheduleValid && retentionValid) save.mutate(); }}>
      <Switch checked={draft.enabled} disabled={disabled} onCheckedChange={(value) => set('enabled', value)} label={t('backup.enabled')} description={t('backup.enabledHint')} />
      <div className="space-y-4 border-t border-border/70 pt-4">
        <div className="max-w-sm"><Field label={t('backup.retainCount')} hint={t('backup.retainCountHint')}><Input type="number" min={1} max={1000} step={1} required disabled={disabled} value={draft.retainCount || ''} onChange={(event) => set('retainCount', Number(event.target.value))} aria-label={t('backup.retainCount')} aria-invalid={!retentionValid} /></Field>{!retentionValid && <p role="alert" className="mt-1 text-xs text-destructive">{t('backup.invalidRetainCount')}</p>}</div>
        <Switch checked={draft.skipUnchanged} disabled={disabled} onCheckedChange={(value) => set('skipUnchanged', value)} label={t('backup.skipUnchanged')} description={t('backup.skipUnchangedHint')} />
      </div>
      <fieldset disabled={disabled} className="space-y-4 border-t border-border/70 pt-4">
        <legend className="sr-only">{t('backup.scheduleTitle')}</legend>
        <CronEditor value={draft.cron} onChange={(value) => set('cron', value)} disabled={disabled} />
        <Field label={t('backup.timezone')}><Input value={draft.timezone} onChange={(event) => set('timezone', event.target.value)} aria-label={t('backup.timezone')} list={timezonesId} spellCheck={false} /><datalist id={timezonesId}>{['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Singapore', 'UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'].map((zone) => <option key={zone} value={zone} />)}</datalist></Field>
        <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-xs" aria-live="polite">
          <p className="font-medium">{t('backup.upcoming')} <span className="font-normal text-muted-foreground">{draft.timezone}</span></p>
          {preview.isError && scheduleCurrent ? <p role="alert" className="mt-1 text-destructive">{t('backup.invalidSchedule')}</p> : !scheduleCurrent || preview.isFetching ? <p className="mt-1 text-muted-foreground">{t('backup.checkingSchedule')}</p> : <ol className="mt-1.5 grid gap-x-6 gap-y-1 text-muted-foreground sm:grid-cols-2">{preview.data?.nextRuns.map((date) => <li key={date}>{formatTime(date)}</li>)}</ol>}
        </div>
      </fieldset>
      <fieldset disabled={disabled} className="space-y-4 border-t border-border/70 pt-4">
        <legend className="sr-only">{t('backup.target')}</legend>
        <Field label={t('backup.target')}><Select value={draft.target} onChange={(value) => set('target', value)} disabled={disabled} aria-label={t('backup.target')} options={[{ value: 'webdav', label: 'WebDAV' }, { value: 's3', label: t('backup.s3Compatible') }]} /></Field>
        {draft.target === 'webdav' ? <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field label={t('backup.davURL')} hint={t('backup.davURLHint')}><Input value={draft.webdav.url} onChange={(e) => setDAV('url', e.target.value)} aria-label={t('backup.davURL')} placeholder="https://dav.example.com/backups/wmind" type="url" spellCheck={false} /></Field></div>
          <Field label={t('backup.davUsername')}><Input value={draft.webdav.username} onChange={(e) => setDAV('username', e.target.value)} aria-label={t('backup.davUsername')} autoComplete="off" /></Field>
          <Field label={t('backup.davPassword')}><Input type="password" value={draft.webdav.password ?? ''} onChange={(e) => setDAV('password', e.target.value)} aria-label={t('backup.davPassword')} autoComplete="new-password" placeholder={draft.webdav.passwordSet ? '••••••••' : ''} /></Field>
        </div> : <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Endpoint" hint={t('backup.endpointHint')}><Input value={draft.s3.endpoint} onChange={(e) => setS3('endpoint', e.target.value)} aria-label="S3 Endpoint" placeholder="https://s3.example.com" type="url" spellCheck={false} /></Field>
          <Field label={t('backup.region')}><Input value={draft.s3.region} onChange={(e) => setS3('region', e.target.value)} aria-label={t('backup.region')} placeholder="us-east-1" /></Field>
          <Field label={t('backup.bucket')}><Input value={draft.s3.bucket} onChange={(e) => setS3('bucket', e.target.value)} aria-label={t('backup.bucket')} /></Field>
          <Field label={t('backup.prefix')}><Input value={draft.s3.prefix} onChange={(e) => setS3('prefix', e.target.value)} aria-label={t('backup.prefix')} placeholder="wmind" /></Field>
          <Field label="Access Key"><Input type="password" value={draft.s3.accessKey ?? ''} onChange={(e) => setS3('accessKey', e.target.value)} aria-label="S3 Access Key" autoComplete="new-password" placeholder={draft.s3.accessKeySet ? '••••••••' : ''} /></Field>
          <Field label="Secret Key"><Input type="password" value={draft.s3.secretKey ?? ''} onChange={(e) => setS3('secretKey', e.target.value)} aria-label="S3 Secret Key" autoComplete="new-password" placeholder={draft.s3.secretKeySet ? '••••••••' : ''} /></Field>
          <div className="sm:col-span-2"><Field label={t('backup.sessionToken')} hint={t('backup.sessionTokenHint')}><Input type="password" value={draft.s3.sessionToken ?? ''} onChange={(e) => setS3('sessionToken', e.target.value)} aria-label={t('backup.sessionToken')} autoComplete="new-password" placeholder={draft.s3.sessionTokenSet ? '••••••••' : ''} /></Field></div>
          {draft.s3.sessionTokenSet && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.s3.clearSessionToken ?? false} onChange={(e) => setS3('clearSessionToken', e.target.checked)} />{t('backup.clearSessionToken')}</label>}
          <div className="sm:col-span-2"><Switch checked={draft.s3.pathStyle} onCheckedChange={(value) => setS3('pathStyle', value)} disabled={disabled} label={t('backup.pathStyle')} description={t('backup.pathStyleHint')} /></div>
        </div>}
        {credentialsSet && <p className="text-xs text-muted-foreground">{t('backup.secretRetained')}</p>}
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={disabled || !dirty || !scheduleValid || !retentionValid}><Icon name="save" className="size-3.5" />{save.isPending ? t('common.saving') : t('backup.save')}</Button>
          <Button size="sm" variant="outline" disabled={disabled || !retentionValid} onClick={() => test.mutate()}>{test.isPending ? t('backup.testing') : t('backup.test')}</Button>
        </div>
        <Button size="sm" variant="outline" disabled={disabled || dirty} title={dirty ? t('backup.saveFirst') : undefined} onClick={() => run.mutate()}><Icon name="upload" className="size-3.5" />{t('backup.run')}</Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{dirty ? t('backup.saveFirst') : t('backup.testHint')}</p>
    </form>
  </Panel>;
}

function RestorePanel({ busy, maxBytes }: { busy: boolean; maxBytes: number }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<RestorePreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [filename, setFilename] = useState('');
  const [uploadError, setUploadError] = useState('');
  const inspect = useMutation({ mutationFn: backupApi.inspect, onSuccess: (data) => { setPreview(data); setConfirmed(false); }, onError: (error) => { setUploadError(errorMessage(error)); toast.error(errorMessage(error)); } });
  const restore = useMutation({ mutationFn: () => backupApi.restore(preview!.id), onSuccess: () => { setPreview(undefined); setConfirmed(false); void queryClient.invalidateQueries({ queryKey: backupKeys.state }); toast.success(t('backup.restoreStarted')); }, onError: (error) => toast.error(errorMessage(error)) });
  return <Panel title={t('backup.restoreTitle')}>
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 p-4">
        <Icon name="upload" className="size-5 shrink-0 text-muted-foreground" />
        <label className="min-w-0 flex-1 space-y-2"><span className="block text-xs font-medium">{t('backup.chooseZIP')}</span>
          <input type="file" accept=".zip,application/zip" aria-label={t('backup.chooseZIP')} disabled={busy || inspect.isPending || restore.isPending}
            className="block w-full min-w-0 text-xs file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-2 file:text-xs file:font-medium disabled:opacity-50"
            onChange={(event) => {
              const file = event.target.files?.[0]; event.target.value = ''; setUploadError('');
              if (!file) return; setPreview(undefined); setConfirmed(false);
              if (file.size > maxBytes) { setUploadError(t('backup.tooLarge', { size: size(maxBytes) })); return; }
              setFilename(file.name); inspect.mutate(file);
            }} />
        </label>
      </div>
      {inspect.isPending && <p role="status" className="text-xs text-muted-foreground">{t('backup.validating')}</p>}
      {uploadError && <p role="alert" className="text-xs text-destructive">{uploadError}</p>}
      <p className="text-xs leading-5 text-muted-foreground">{t('backup.restoreHint', { size: size(maxBytes) })}</p>
    </div>
    <Modal open={preview !== undefined} title={t('backup.confirmTitle')} description={t('backup.overwriteWarning')} onClose={() => { setPreview(undefined); setConfirmed(false); }} dismissible={!restore.isPending}
      footer={<><Button size="sm" variant="ghost" disabled={restore.isPending} onClick={() => setPreview(undefined)}>{t('common.cancel')}</Button><Button size="sm" variant="destructive" disabled={!confirmed || restore.isPending || busy} onClick={() => restore.mutate()}>{restore.isPending ? t('backup.startingRestore') : t('backup.confirmRestore')}</Button></>}>
      {preview && <div className="space-y-4 text-sm">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
          <dt className="text-muted-foreground">{t('backup.archiveFile')}</dt><dd className="break-all">{filename}</dd>
          <dt className="text-muted-foreground">{t('backup.createdAt')}</dt><dd>{new Date(preview.createdAt).toLocaleString(i18n.resolvedLanguage)}</dd>
          <dt className="text-muted-foreground">{t('backup.database')}</dt><dd>{preview.database.driver} · v{preview.database.schema}</dd>
          <dt className="text-muted-foreground">{t('backup.archiveContents')}</dt><dd>{t('backup.fileCount', { count: preview.files })} · {size(preview.bytes)}</dd>
        </dl>
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-400">{t('backup.safetyHint')}</p>
        <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={restore.isPending} />{t('backup.confirmCheckbox')}</label>
        {restore.isError && <p role="alert" className="text-xs text-destructive">{errorMessage(restore.error)}</p>}
      </div>}
    </Modal>
  </Panel>;
}

function JobHistory({ state }: { state: BackupState }) {
  const { t, i18n } = useTranslation();
  const jobs = state.current?.status === 'running' ? [state.current, ...state.history] : state.history;
  return <Panel title={t('backup.historyTitle')} description={t('backup.historyDescription')}>
    {jobs.length === 0 ? <p className="text-xs text-muted-foreground">{t('backup.noHistory')}</p> : <div className="divide-y divide-border/70">{jobs.map((job: BackupJob) => <div key={job.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0" role={job.status === 'running' ? 'status' : undefined}>
      <Icon name={job.status === 'failed' || job.warningCode ? 'alert' : job.status === 'running' ? 'clock' : 'check'} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1"><div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><p className="text-xs font-medium">{t(`backup.kind.${job.kind}`)} <span className="font-normal text-muted-foreground">· {t(`backup.trigger.${job.trigger}`)}</span></p><span className="text-xs text-muted-foreground">{t(`backup.status.${job.status}`)}{job.status === 'running' ? ` · ${t(`backup.stages.${job.stage}`)}` : ''}</span></div>
        <p className="text-[11px] text-muted-foreground">{new Date(job.startedAt).toLocaleString(i18n.resolvedLanguage)}{job.bytes ? ` · ${size(job.bytes)}` : ''}</p>
        {job.contentVersion && <p className="break-all text-[11px] text-muted-foreground">{t('backup.contentVersion', { version: job.contentVersion })}</p>}
        {job.filename && <p className="break-all text-[11px] text-muted-foreground">{job.status === 'skipped' ? t('backup.reusedFile', { filename: job.filename }) : job.filename}</p>}
        {job.errorCode && <p className="text-xs text-destructive">{t(`backup.jobErrors.${job.errorCode}`, { defaultValue: t('backup.operationFailed') })}</p>}
        {job.warningCode && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{t(`backup.jobWarnings.${job.warningCode}`)}</p>}
        {job.recoveryFile && <p className="break-all text-[11px] text-muted-foreground">{t('backup.recoveryFile', { filename: job.recoveryFile })}</p>}
      </div>
    </div>)}</div>}
  </Panel>;
}
