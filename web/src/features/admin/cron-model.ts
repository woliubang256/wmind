export const CRON_FIELDS = [
  { key: 'minute', min: 0, max: 59 },
  { key: 'hour', min: 0, max: 23 },
  { key: 'day', min: 1, max: 31 },
  { key: 'month', min: 1, max: 12 },
  { key: 'weekday', min: 0, max: 6 },
] as const;

export const CRON_PRESETS: Record<string, string> = {
  daily: '0 3 * * *', weekly: '0 3 * * 1', monthly: '0 3 1 * *',
  hourly: '0 * * * *', quarterHour: '*/15 * * * *',
};
export type CronMode = 'every' | 'interval' | 'values' | 'range' | 'custom';
export interface CronFieldValue {
  mode: CronMode;
  start: number;
  end: number;
  step: number;
  values: number[];
  raw: string;
}

export function parseCronField(raw: string, min: number, max: number): CronFieldValue {
  const base: CronFieldValue = { mode: 'custom', start: min, end: Math.min(min + 1, max), step: 1, values: [min], raw };
  const inRange = (value: number) => Number.isInteger(value) && value >= min && value <= max;
  if (raw === '*') return { ...base, mode: 'every' };
  const interval = /^\*\/(\d+)$/.exec(raw);
  if (interval && Number(interval[1]) >= 1 && Number(interval[1]) <= max - min + 1) {
    return { ...base, mode: 'interval', step: Number(interval[1]) };
  }
  const range = /^(\d+)-(\d+)$/.exec(raw);
  if (range && inRange(Number(range[1])) && inRange(Number(range[2])) && Number(range[1]) <= Number(range[2])) {
    return { ...base, mode: 'range', start: Number(range[1]), end: Number(range[2]) };
  }
  if (/^\d+(,\d+)*$/.test(raw)) {
    const values = [...new Set(raw.split(',').map(Number))].sort((a, b) => a - b);
    if (values.every(inRange)) return { ...base, mode: 'values', values };
  }
  return base;
}

export function formatCronField(value: CronFieldValue): string {
  switch (value.mode) {
    case 'every': return '*';
    case 'interval': return `*/${value.step}`;
    case 'range': return `${value.start}-${value.end}`;
    case 'values': return [...new Set(value.values)].sort((a, b) => a - b).join(',');
    case 'custom': return value.raw;
  }
}

export function replaceCronField(expression: string, index: number, value: CronFieldValue): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || index < 0 || index > 4) return expression;
  fields[index] = formatCronField(value);
  return fields.join(' ');
}
