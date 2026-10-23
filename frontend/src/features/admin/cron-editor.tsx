import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { CRON_FIELDS, CRON_PRESETS, parseCronField, replaceCronField, type CronFieldValue, type CronMode } from './cron-model';

interface Props { value: string; onChange: (value: string) => void; disabled?: boolean }
export function CronEditor({ value, onChange, disabled }: Props) {
  const { t } = useTranslation();
  const fields = value.trim().split(/\s+/);
  const preset = Object.entries(CRON_PRESETS).find(([, expression]) => expression === value)?.[0] ?? 'custom';
  return (
    <div className="space-y-3">
      <label className="block space-y-1.5 text-xs font-medium">
        <span>{t('backup.frequency')}</span>
        <Select aria-label={t('backup.frequency')} value={preset} disabled={disabled} onChange={(key) => { if (CRON_PRESETS[key]) onChange(CRON_PRESETS[key]); }}
          options={[...Object.keys(CRON_PRESETS), 'custom'].map((key) => ({ value: key, label: t(`backup.presets.${key}`) }))} />
      </label>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {fields.length === 5 && CRON_FIELDS.map((field, index) => {
          const model = parseCronField(fields[index], field.min, field.max);
          const label = t(`backup.fields.${field.key}`);
          const update = (patch: Partial<CronFieldValue>) => onChange(replaceCronField(value, index, { ...model, ...patch }));
          return (
            <fieldset key={field.key} disabled={disabled} className="min-w-0 rounded-lg border border-border/80 p-3">
              <legend className="px-1 text-xs font-medium">{label}</legend>
              <Select aria-label={t('backup.ruleFor', { field: label })} value={model.mode} disabled={disabled}
                options={(['every', 'interval', 'values', 'range', 'custom'] as CronMode[]).map((mode) => ({ value: mode, label: t(`backup.modes.${mode}`) }))}
                onChange={(mode) => update({ mode: mode as CronMode })} />
              {model.mode === 'interval' && <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span>{t('backup.every')}</span><Input type="number" aria-label={t('backup.intervalFor', { field: label })} min={1} max={field.max - field.min + 1} value={model.step} onChange={(e) => update({ step: Number(e.target.value) })} className="h-8 w-20 text-xs" /><span>{label}</span>
              </label>}
              {model.mode === 'range' && <div className="mt-2 flex items-center gap-2">
                <Input type="number" aria-label={t('backup.rangeStart', { field: label })} min={field.min} max={field.max} value={model.start} onChange={(e) => update({ start: Number(e.target.value) })} className="h-8 text-xs" />
                <span className="text-xs text-muted-foreground">–</span>
                <Input type="number" aria-label={t('backup.rangeEnd', { field: label })} min={field.min} max={field.max} value={model.end} onChange={(e) => update({ end: Number(e.target.value) })} className="h-8 text-xs" />
              </div>}
              {model.mode === 'values' && <div className={cn('mt-2 grid gap-1', field.key === 'weekday' ? 'grid-cols-4' : 'grid-cols-6')}>
                {Array.from({ length: field.max - field.min + 1 }, (_, i) => i + field.min).map((n) => {
                  const selected = model.values.includes(n);
                  return <button key={n} type="button" aria-label={`${label} ${field.key === 'weekday' ? t(`backup.weekdays.${n}`) : n}`} aria-pressed={selected} disabled={disabled}
                    className={cn('rounded border px-1 py-1.5 text-[11px] transition-colors disabled:opacity-50', selected ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted')}
                    onClick={() => { if (selected && model.values.length === 1) return; update({ values: selected ? model.values.filter((v) => v !== n) : [...model.values, n] }); }}>
                    {field.key === 'weekday' ? t(`backup.weekdays.${n}`) : n}
                  </button>;
                })}
              </div>}
              {model.mode === 'custom' && <Input className="mt-2 h-8 font-mono text-xs" aria-label={t('backup.customFor', { field: label })} value={model.raw} onChange={(e) => update({ raw: e.target.value })} />}
            </fieldset>
          );
        })}
      </div>
      <label className="block space-y-1.5 text-xs font-medium">
        <span>{t('backup.expression')}</span>
        <Input value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={t('backup.expression')} className="font-mono text-xs" spellCheck={false} />
      </label>
      <p className="text-xs leading-5 text-muted-foreground">{t('backup.cronHint')}</p>
    </div>
  );
}
