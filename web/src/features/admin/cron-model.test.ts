import { describe, expect, it } from 'vitest';
import { CRON_FIELDS, CRON_PRESETS, formatCronField, parseCronField, replaceCronField } from './cron-model';

describe('visual Cron model', () => {
  it.each(['*', '*/15', '0,15,30,45', '10-20', '59'])('round trips minute field %s', (raw) => {
    expect(formatCronField(parseCronField(raw, 0, 59))).toBe(raw);
  });
  it.each(['MON-FRI', '1-5/2', '1,3-5', 'bad'])('preserves advanced field %s', (raw) => {
    expect(formatCronField(parseCronField(raw, 0, 6))).toBe(raw);
  });
  it('does not silently repair invalid bounds or change other fields', () => {
    expect(parseCronField('60', 0, 59).mode).toBe('custom');
    expect(parseCronField('*/0', 0, 59).mode).toBe('custom');
    expect(parseCronField('20-10', 0, 59).mode).toBe('custom');
    expect(replaceCronField('0 3 * * MON-FRI', 0, parseCronField('*/15', 0, 59))).toBe('*/15 3 * * MON-FRI');
    expect(replaceCronField('0 0 * * * *', 0, parseCronField('*', 0, 59))).toBe('0 0 * * * *');
  });
  it('gives every preset exactly five independently editable fields', () => {
    for (const expression of Object.values(CRON_PRESETS)) {
      expect(expression.split(' ')).toHaveLength(5);
      expression.split(' ').forEach((raw, i) => {
        const field = CRON_FIELDS[i];
        expect(parseCronField(raw, field.min, field.max).mode).not.toBe('custom');
      });
    }
  });
  it('sorts and deduplicates selected values', () => {
    const parsed = parseCronField('5,1,5,3', 0, 6);
    expect(parsed.values).toEqual([1, 3, 5]);
    expect(formatCronField(parsed)).toBe('1,3,5');
  });
});
