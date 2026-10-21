import { useId } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** 复选框右侧的文字。传空则只渲染方框（此时必须给 `aria-label`）。 */
  label?: string;
  /** 标签下方的小字说明。 */
  hint?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
}

/**
 * 复选框。
 *
 * 用 `role="checkbox"` 的 button 自绘，不用 `<input type="checkbox">`：原生
 * 方框的颜色由 `accent-color` 决定，尺寸、圆角、勾线粗细、深色主题下的对比度
 * 都改不动——同一个页面上，它会和旁边自绘的开关、按钮明显不是一套东西。
 *
 * 无障碍上要对齐原生控件的三件事：
 *
 * - `role="checkbox"` + `aria-checked`：读屏念「复选框，已勾选」；
 * - 空格切换：button 原生的空格点击已经覆盖，不需要额外键盘处理；
 * - 整行可点：文字放在 button **里面**，而不是外面套一个 `<label>`——
 *   `<label for>` 指向 button 的转发行为在各浏览器不一致，点了没反应最恼人。
 *
 * 焦点环画在方框上（`group-focus-visible`）而不是整行：整行描边会看起来像
 * 一个输入框，反而不像复选框被选中了。
 */
export function Checkbox({
  checked,
  onCheckedChange,
  label,
  hint,
  disabled = false,
  id,
  className,
  'aria-label': ariaLabel,
}: CheckboxProps) {
  const generatedId = useId();
  const checkboxId = id ?? generatedId;
  const hintId = hint ? `${checkboxId}-hint` : undefined;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <button
        id={checkboxId}
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={ariaLabel}
        aria-describedby={hintId}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          'group inline-flex items-start gap-2 text-left text-xs text-foreground',
          'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'mt-px grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors',
            'group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-1 group-focus-visible:ring-offset-background',
            checked
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-input bg-background group-hover:border-ring/60',
          )}
        >
          {checked ? <Icon name="check" className="size-3" strokeWidth="3" /> : null}
        </span>
        {label === undefined ? null : <span className="leading-5">{label}</span>}
      </button>
      {hint ? (
        <p id={hintId} className="pl-6 text-[11px] leading-snug text-muted-foreground/80">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
