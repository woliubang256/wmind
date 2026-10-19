/**
 * 画布面板的共享控件。
 *
 * 全部用原生元素：`<input type="color">`、`<select>`、`<button aria-pressed>`。
 * 没有自绘的弹层与拖拽把手——自绘控件要自己补焦点陷阱、方向键导航、Esc 关闭，
 * 而这些恰恰是键盘用户最先撞上的地方。原生控件在键盘与读屏上本来就是对的。
 *
 * `input[type=color]` 是这里唯一「不得不依赖系统」的控件：浏览器的取色器各平台
 * 长相不同，但都能用键盘打开、用方向键调值。旁边永远并排放着预设色块，用户
 * 不想进系统取色器时可以直接点。
 */

import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

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

/** 原生下拉。选项少、纯文字时比自绘下拉更省心。 */
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
    <select
      aria-label={label}
      value={String(value)}
      disabled={disabled}
      onChange={(event) => {
        const next = options.find((option) => String(option.value) === event.target.value);
        if (next) onChange(next.value);
      }}
      className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
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
  const fallback = typeof value === 'string' ? value : '#FFFFFF';
  return (
    <Field label={label} hint={hint}>
      <SwatchGrid label={label} colors={presets} value={value} onPick={onChange} />
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          aria-label={`${label}（自定义）`}
          value={/^#[0-9a-f]{6}$/i.test(fallback) ? fallback : '#FFFFFF'}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="h-7 w-9 cursor-pointer rounded-md border border-input bg-background p-0.5"
        />
        <span className="font-mono text-[11px] text-muted-foreground">
          {value === undefined ? '继承' : (value ?? '无填充')}
        </span>
        <div className="ml-auto flex gap-1">
          {onNone ? (
            <button
              type="button"
              onClick={onNone}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              无填充
            </button>
          ) : null}
          {onInherit ? (
            <button
              type="button"
              onClick={onInherit}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              继承主题
            </button>
          ) : null}
        </div>
      </div>
    </Field>
  );
}

/** 复选开关。用原生 checkbox，读屏与键盘都不用额外适配。 */
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
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="size-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <label htmlFor={id} className="text-xs text-foreground">
          {label}
        </label>
      </div>
      {hint ? <p className="pl-6 text-[11px] leading-snug text-muted-foreground/80">{hint}</p> : null}
    </div>
  );
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
