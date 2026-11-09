import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SelectField, TextField, Textarea } from '@/components/ui/input';
import { EmptyState, Panel } from '@/components/ui/panel';
import { LoadingState } from '@/components/ui/loading-state';
import { Switch } from '@/components/ui/switch';
import { siteKeys } from '@/features/site/use-site-config';
import { AI_REASONING_EFFORTS, aiApi, aiKeys, type AIConfiguration, type AIConfigurationInput } from '@/features/ai/api';

export function AISettingsPanel({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: aiKeys.configuration, queryFn: aiApi.configuration, enabled: active });
  if (query.isError) return <EmptyState icon="alert" title={t('ai.loadFailed')}
    description={query.error.message} action={<Button size="sm" variant="outline" onClick={() => void query.refetch()}>{t('common.retry')}</Button>} />;
  if (!query.data) return <LoadingState className="min-h-64" />;
  return <AISettingsForm initial={query.data} />;
}

function AISettingsForm({ initial }: { initial: AIConfiguration }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AIConfigurationInput>({ enabled: initial.enabled, baseUrl: initial.baseUrl, apiKey: '', model: initial.model, reasoningEffort: initial.reasoningEffort ?? '' });
  const dirty = draft.enabled !== initial.enabled || draft.baseUrl !== initial.baseUrl || draft.model !== initial.model || draft.reasoningEffort !== (initial.reasoningEffort ?? '') || Boolean(draft.apiKey) || Boolean(draft.clearApiKey);
  const set = <K extends keyof AIConfigurationInput>(key: K, value: AIConfigurationInput[K]) => setDraft((previous) => ({ ...previous, [key]: value }));
  const save = useMutation({ mutationFn: () => aiApi.save(draft), onSuccess: (updated) => {
    queryClient.setQueryData(aiKeys.configuration, updated);
    void queryClient.invalidateQueries({ queryKey: siteKeys.config });
    setDraft({ enabled: updated.enabled, baseUrl: updated.baseUrl, apiKey: '', model: updated.model, reasoningEffort: updated.reasoningEffort ?? '' });
    toast.success(t('ai.saved'));
  } });
  const submit = (event: FormEvent) => { event.preventDefault(); if (dirty && !save.isPending) save.mutate(); };

  return <Panel title="AI Provider">
    <form className="space-y-5" onSubmit={submit}>
      <Switch checked={draft.enabled} onCheckedChange={(value) => setDraft((previous) => ({ ...previous, enabled: value, clearApiKey: value ? false : previous.clearApiKey }))} label={t('ai.enabled')} disabled={save.isPending} />
      <fieldset disabled={save.isPending} className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">AI Provider</legend>
        <TextField label="Base URL" aria-label="Base URL" value={draft.baseUrl} onChange={(event) => set('baseUrl', event.target.value)} placeholder="https://api.openai.com/v1" type="url" required={draft.enabled} spellCheck={false} />
        <TextField label="API Key" aria-label="API Key" type="password" value={draft.apiKey ?? ''} onChange={(event) => set('apiKey', event.target.value)}
          autoComplete="new-password" placeholder={initial.apiKeySet ? '••••••••' : 'sk-…'} required={draft.enabled && (!initial.apiKeySet || draft.clearApiKey)} />
        <TextField label="Model" aria-label="Model" value={draft.model} onChange={(event) => set('model', event.target.value)} placeholder="gpt-4.1-mini" required={draft.enabled} spellCheck={false} />
        <SelectField label={t('ai.reasoningEffort')} hint={t('ai.reasoningHint')} value={draft.reasoningEffort}
          onChange={(value) => set('reasoningEffort', value)} disabled={save.isPending}
          options={AI_REASONING_EFFORTS.map((value) => ({ value, label: value || t('ai.reasoningOmitted') }))} />
      </fieldset>
      {initial.apiKeySet && <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
        <span>{t('ai.keyRetained')}</span>
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.clearApiKey ?? false} disabled={save.isPending || draft.enabled} onChange={(event) => set('clearApiKey', event.target.checked)} />{t('ai.clearKey')}</label>
      </div>}
      <details className="rounded-xl border border-border px-3 py-2.5">
        <summary className="cursor-pointer text-sm font-medium">{t('ai.systemPrompt')}</summary>
        <Textarea aria-label={t('ai.systemPrompt')} readOnly value={initial.systemPrompt} rows={9} className="mt-3 resize-none bg-muted/35 text-xs leading-6" />
      </details>
      {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
      <div className="flex justify-end"><Button type="submit" loading={save.isPending} disabled={!dirty || save.isPending}>{t('common.save')}</Button></div>
    </form>
  </Panel>;
}
