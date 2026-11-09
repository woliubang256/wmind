/**
 * 画布面板的共享控件。
 *
 * 下拉与复选框走 `components/ui` 里的自绘组件（`Select` / `Checkbox`），
 * 不用原生控件：面板是深色的，而原生下拉的弹层由操作系统绘制，配色、圆角、
 * 阴影一概不跟主题走，弹出来像另一个程序的东西。
 *
 * `input[type=color]` 是这里唯一还依赖系统的控件：浏览器取色器各平台长相不同，
 * 但都能用键盘打开、用方向键调值；自己造一个 HSV 取色盘要处理色域、无障碍、
 * 触屏拖拽，代价远大于收益。旁边永远并排放着预设色块，不想进系统取色器时
 * 可以直接点。
 */

import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5">
      <span id={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground/80">{hint}</p> : null}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** 悬停提示；纯符号按钮必须给，否则读屏只会念出一个字母。 */
  title?: string;
}

/** 一排互斥按钮。选中态用 `aria-pressed`，不靠颜色单独表达。 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T | null;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            title={option.title ?? option.label}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-xs transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:pointer-events-none disabled:opacity-50',
              active
                ? 'border-primary bg-primary/10 font-semibold text-foreground'
                : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** 紧凑型下拉。选项少、纯文字，用面板尺寸（28px 高）而不是表单尺寸。 */
export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      aria-label={label}
      size="sm"
      value={value}
      options={options}
      disabled={disabled}
      onChange={onChange}
      // 面板最窄时触发器只有 ~110px，「Open Sans」这类字体名会被截到看不出
      // 区别，所以弹层至少 160px 宽。
      menuMinWidth={160}
    />
  );
}

/**
 * 色板。
 *
 * 每个色块是一个 `aria-pressed` 按钮，`aria-label` 写色值本身——「浅蓝」「深红」
 * 这类名字在 60 个色值里根本区分不开。选中态除了描边还加了内圈，色盲用户
 * 光看颜色深浅分不出哪个被选中。
 */
export function SwatchGrid({
  label,
  colors,
  value,
  onPick,
}: {
  label: string;
  colors: readonly string[];
  value: string | null | undefined;
  onPick: (color: string) => void;
}) {
  const current = value?.toUpperCase();
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {colors.map((color) => {
        const active = current === color.toUpperCase();
        return (
          <button
            key={color}
            type="button"
            aria-label={color}
            aria-pressed={active}
            title={color}
            onClick={() => onPick(color)}
            style={{ backgroundColor: color }}
            className={cn(
              'size-6 rounded-md border transition-shadow',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              active ? 'border-foreground ring-2 ring-primary ring-offset-1' : 'border-black/10',
            )}
          />
        );
      })}
    </div>
  );
}

/**
 * 一个颜色字段：色板 + 系统取色器 + 「继承 / 无填充」。
 *
 * `value === undefined` 表示继承（字段没写进 `topic.style`），`null` 表示显式
 * 的「无填充」。两者在界面上是两件事：继承会跟着主题走，无填充永远是透明。
 */
export function ColorField({
  label,
  value,
  presets,
  onChange,
  onInherit,
  onNone,
  hint,
}: {
  label: string;
  value: string | null | undefined;
  presets: readonly string[];
  onChange: (color: string) => void;
  onInherit?: () => void;
  onNone?: () => void;
  hint?: string;
}) {
  const { t } = useTranslation();
  const fallback = typeof value === 'string' ? value : '#FFFFFF';
  return (
    <Field label={label} hint={hint}>
      <SwatchGrid label={label} colors={presets} value={value} onPick={onChange} />
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          aria-label={t('editor.panel.customColor', { label })}
          value={/^#[0-9a-f]{6}$/i.test(fallback) ? fallback : '#FFFFFF'}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="h-7 w-9 cursor-pointer rounded-md border border-input bg-background p-0.5"
        />
        <span className="font-mono text-[11px] text-muted-foreground">
          {value === undefined ? t('editor.panel.inherit') : (value ?? t('editor.panel.noFill'))}
        </span>
        <div className="ml-auto flex gap-1">
          {onNone ? (
            <button
              type="button"
              onClick={onNone}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              {t('editor.panel.noFill')}
            </button>
          ) : null}
          {onInherit ? (
            <button
              type="button"
              onClick={onInherit}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              {t('editor.panel.inheritTheme')}
            </button>
          ) : null}
        </div>
      </div>
    </Field>
  );
}

/** 复选开关。自绘方框，键盘与读屏由 `role="checkbox"` 承担。 */
export function ToggleField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  return <Checkbox label={label} checked={checked} onCheckedChange={onChange} hint={hint} />;
}

/** 分节标题，给长面板分组用。 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-border/60 pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}
