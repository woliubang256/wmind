import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { LoadingState } from '@/components/ui/loading-state';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EmptyState, PageHeader, Panel } from '@/components/ui/panel';
import { Switch } from '@/components/ui/switch';
import { siteKeys } from '@/features/site/use-site-config';
import { adminApi } from '@/lib/api/endpoints';
import type { SettingsMap, SettingsValue } from '@/lib/api/types';
import { ApiError, fieldErrorsFrom } from '@/lib/api/errors';
import { diffSettings, SETTING_GROUPS, type SettingField } from './settings-schema';
import { adminKeys } from './queries';
import { BackupPanel } from './backup-panel';
import { AISettingsPanel } from './ai-panel';
import { mapKeys } from '@/features/maps/queries';
import { cn } from '@/lib/utils';

const SETTINGS_TABS = ['general', 'backup', 'ai'] as const;

export function AdminSettingsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<(typeof SETTINGS_TABS)[number]>('general');
  const settings = useQuery({ queryKey: adminKeys.settings, queryFn: adminApi.getSettings });

  return (
    <div className="space-y-5">
      <PageHeader title={t('admin.settings.title')} />
      <div role="tablist" aria-label={t('backup.sections')} className="flex gap-1 border-b border-border">
        {SETTINGS_TABS.map((key, index) => <button key={key} type="button" role="tab" id={`settings-tab-${key}`} aria-controls={`settings-panel-${key}`} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} onKeyDown={(event) => {
          const next = event.key === 'Home' ? SETTINGS_TABS[0] : event.key === 'End' ? SETTINGS_TABS.at(-1) : event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? SETTINGS_TABS[(index + (event.key === 'ArrowRight' ? 1 : -1) + SETTINGS_TABS.length) % SETTINGS_TABS.length] : undefined;
          if (next) { event.preventDefault(); setTab(next); document.getElementById(`settings-tab-${next}`)?.focus(); }
        }} onClick={() => setTab(key)} className={`border-b-2 px-4 py-2.5 text-sm transition-colors ${tab === key ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{t(key === 'general' ? 'backup.generalTab' : key === 'backup' ? 'backup.tab' : 'ai.settingsTab')}</button>)}
      </div>
      <div role="tabpanel" id="settings-panel-backup" aria-labelledby="settings-tab-backup" hidden={tab !== 'backup'}><BackupPanel /></div>
      <div role="tabpanel" id="settings-panel-ai" aria-labelledby="settings-tab-ai" hidden={tab !== 'ai'}><AISettingsPanel active={tab === 'ai'} /></div>
      <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" hidden={tab !== 'general'}>
      {settings.isError ? (
        <EmptyState
          icon="alert"
          title={t('admin.settings.loadFailed')}
          description={settings.error instanceof Error ? settings.error.message : undefined}
          action={
            <Button variant="outline" size="sm" onClick={() => void settings.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : settings.data ? (
        // 表单自己持有草稿状态，因此只在拿到数据后挂载一次；重新挂载会把
        // 用户还没保存的改动抹掉，所以这里不随 refetch 重建。
        <SettingsForm initial={settings.data} />
      ) : (
        <LoadingState label={t('admin.settings.loading')} className="min-h-64" />
      )}
      </div>
    </div>
  );
}

/** 数值字段在本地先校验一遍，避免为了一个明显越界的数字跑一趟后端。 */
function fieldError(
  field: SettingField,
  value: SettingsValue | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  if (field.kind !== 'int' || typeof value !== 'number') return undefined;
  if (!Number.isInteger(value)) return t('admin.settings.intOnly');
  if (field.min !== undefined && value < field.min) return t('admin.settings.min', { min: field.min });
  if (field.max !== undefined && value > field.max) return t('admin.settings.max', { max: field.max });
  return undefined;
}

function SettingsForm({ initial }: { initial: SettingsMap }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SettingsMap>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const patch = diffSettings(initial, draft);
  const dirtyKeys = Object.keys(patch);

  const save = useMutation({
    mutationFn: () => adminApi.updateSettings(patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(adminKeys.settings, updated);
      // 站点名、注册开关等会出现在登录页与页头，必须让公开配置跟着刷新。
      void queryClient.invalidateQueries({ queryKey: siteKeys.config });
      if ('trash.retention_days' in patch) void queryClient.invalidateQueries({ queryKey: mapKeys.trash() });
      setDraft(updated);
      setErrors({});
      toast.success(t('admin.settings.saved', { count: dirtyKeys.length }));
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const fields = fieldErrorsFrom(error);
        if (Object.keys(fields).length > 0) {
          setErrors(fields);
          return;
        }
      }
      toast.error(error instanceof Error ? error.message : t('admin.settings.saveFailed'));
    },
  });

  const set = (key: string, value: SettingsValue) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    // 改动即清除该字段的旧错误，否则用户改对了红字还挂着。
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    for (const field of SETTING_GROUPS.flatMap((group) => group.fields)) {
      const message = fieldError(field, draft[field.key], t);
      if (message) nextErrors[field.key] = message;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      toast.error(t('admin.settings.invalid'));
      return;
    }
    if (dirtyKeys.length === 0) return;
    save.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {SETTING_GROUPS.map((group) => (
        <Panel key={group.id} title={t(group.titleKey)}>
          <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-6">
            {group.fields.map((field) => (
              <SettingRow
                key={field.key}
                field={field}
                value={draft[field.key]}
                error={errors[field.key]}
                onChange={(value) => set(field.key, value)}
              />
            ))}
          </div>
          <GroupWarning groupId={group.id} draft={draft} />
        </Panel>
      ))}

      {/* 悬浮保存条：20 个字段分成 5 组后，保存按钮离正在编辑的字段可能
          隔着两屏，滚到底部才能保存很容易被漏掉。 */}
      <div className="sticky bottom-4 z-10">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/95 px-4 py-3 shadow-lg backdrop-blur">
          <p className="text-sm text-muted-foreground">
            {dirtyKeys.length > 0
              ? t('admin.settings.dirty', { count: dirtyKeys.length })
              : t('admin.settings.clean')}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={dirtyKeys.length === 0 || save.isPending} onClick={() => { setDraft(initial); setErrors({}); }}>
              {t('admin.settings.discard')}
            </Button>
            <Button loading={save.isPending} type="submit" size="sm" disabled={dirtyKeys.length === 0 || save.isPending}>
              {save.isPending ? t('common.saving') : t('admin.settings.save')}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

function SettingRow({
  field,
  value,
  error,
  onChange,
}: {
  field: SettingField;
  value: SettingsValue | undefined;
  error?: string;
  onChange: (value: SettingsValue) => void;
}) {
  const { t } = useTranslation();
  const label = t(field.labelKey);
  const hintText = field.hintKey === undefined ? undefined : t(field.hintKey);
  const hint = error ? <p role="alert" className="mt-1 text-xs text-destructive">{error}</p> : hintText ? <p className="mt-1 text-xs text-muted-foreground">{hintText}</p> : null;
  const rowClass = cn('min-w-0', field.kind === 'bool' || field.kind === 'text' || field.width === 'full' ? 'sm:col-span-2 xl:col-span-6' : field.width === 'half' ? 'xl:col-span-3' : 'xl:col-span-2');

  if (field.kind === 'bool') {
    return (
      <div className={rowClass}>
        <Switch
          checked={value === true}
          onCheckedChange={onChange}
          label={label}
          description={error ?? hintText}
        />
        {error ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const control =
    field.kind === 'enum' ? (
      <Select
        value={String(value ?? '')}
        onChange={onChange}
        aria-label={label}
        options={(field.options ?? []).map((option) => ({ value: option.value, label: t(option.labelKey) }))}
      />
    ) : field.kind === 'text' ? (
      <Textarea
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        placeholder={field.placeholder}
        aria-invalid={error ? true : undefined}
      />
    ) : field.kind === 'int' ? (
      <div className="flex max-w-56 items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          min={field.min}
          max={field.max}
          value={typeof value === 'number' ? value : ''}
          onChange={(event) => onChange(event.target.value === '' ? 0 : Number(event.target.value))}
          aria-label={label}
          aria-invalid={error ? true : undefined}
        />
        {field.unitKey ? <span className="shrink-0 text-sm text-muted-foreground">{t(field.unitKey)}</span> : null}
      </div>
    ) : (
      <Input
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        placeholder={field.placeholder}
        aria-invalid={error ? true : undefined}
      />
    );

  return (
    <div className={rowClass}>
      <label className="block text-sm font-medium">{label}</label>
      <div className="mt-2">{control}</div>
      {hint}
    </div>
  );
}

/**
 * 分组级风险提示。
 *
 * 这几项都能把站点改到「用户进不来」的状态，单条 hint 说不清后果，
 * 所以在分组底部给一句明确的告警——值是从草稿算出来的，改回安全值提示就消失。
 */
function GroupWarning({ groupId, draft }: { groupId: string; draft: SettingsMap }) {
  const { t } = useTranslation();
  const warningKeys: string[] = [];
  if (groupId === 'auth' && draft['auth.default_role'] === 'admin') warningKeys.push('admin.settings.warnDefaultAdmin');
  if (groupId === 'auth' && draft['auth.registration_enabled'] === false) warningKeys.push('admin.settings.warnRegistrationClosed');
  if (groupId === 'share' && draft['share.public_link_enabled'] === false) warningKeys.push('admin.settings.warnShareDisabled');

  return warningKeys.map((warningKey) => (
    <p key={warningKey} className="mt-4 flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-400">
      <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
      {t(warningKey)}
    </p>
  ));
}
