import { useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './icon';

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  /** 卡片样式下的一行说明。 */
  description?: string;
  /** 卡片样式下的左侧图标。 */
  icon?: IconName;
  /** 语言名这类「按该语言自己的写法」的文本要标上 `lang`，读屏才会用对语音包。 */
  lang?: string;
  disabled?: boolean;
}

export interface RadioGroupProps<T extends string> {
  /** 组的可访问名。 */
  label: string;
  value: T;
  options: readonly RadioOption<T>[];
  onChange: (value: T) => void;
  /**
   * `plain` 是紧凑的一列/一行小圆点（导出对话框那种），
   * `card` 是带边框的卡片网格（设置页的外观与语言）。
   */
  variant?: 'plain' | 'card';
  orientation?: 'vertical' | 'horizontal';
  /** 卡片样式下每行几列。 */
  columns?: 1 | 2 | 3;
  disabled?: boolean;
  className?: string;
}

/**
 * 单选框组。
 *
 * 不用 `<input type="radio">`：原生圆点的尺寸与配色同样改不动，而设置页那种
 * 「一整块卡片」的选项根本没法用原生控件表达（圆点只能贴在文字左边）。
 *
 * 这里实现的是 WAI-ARIA 的 radiogroup 模式，三件事必须齐：
 *
 * 1. **漫游焦点**：整组只有一个 Tab 停靠点（选中项，没有选中时是第一项），
 *    进组之后用方向键换人。原生 radio 就是这个行为，自己写时最容易漏掉——
 *    漏了就是「按 Tab 要按三次才能走过三个选项」。
 * 2. **方向键即选中**：与原生一致，移动焦点同时改变选中值，不需要再按空格。
 * 3. **首尾相接**：末项按向下回到首项。
 *
 * 左右与上下都接受（`ArrowLeft`/`ArrowRight` 与 `ArrowUp`/`ArrowDown`），
 * 因为「横向排列的组」用户自然会按左右，而纵向排列时按左右也不该没反应。
 */
export function RadioGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  variant = 'plain',
  orientation = 'vertical',
  columns = 3,
  disabled = false,
  className,
}: RadioGroupProps<T>) {
  const groupId = useId();
  const items = useRef(new Map<string, HTMLButtonElement>());

  const selectedIndex = options.findIndex((option) => option.value === value);
  // 没有选中项时把 Tab 停靠点给第一个可选项，否则整组键盘进不去。
  const tabbableIndex =
    selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled);

  const move = (from: number, delta: 1 | -1) => {
    if (options.length === 0) return;
    let cursor = from;
    for (let step = 0; step < options.length; step += 1) {
      cursor = (cursor + delta + options.length) % options.length;
      const next = options[cursor];
      if (!next.disabled) {
        onChange(next.value);
        items.current.get(next.value)?.focus();
        return;
      }
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault();
        move(index, 1);
        return;
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault();
        move(index, -1);
        return;
      case 'Home':
        event.preventDefault();
        move(-1, 1);
        return;
      case 'End':
        event.preventDefault();
        move(0, -1);
        return;
      default:
    }
  };

  const card = variant === 'card';

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-orientation={orientation}
      className={cn(
        card
          ? cn('grid gap-2', columns === 3 && 'sm:grid-cols-3', columns === 2 && 'sm:grid-cols-2')
          : cn('flex gap-3', orientation === 'vertical' ? 'flex-col' : 'flex-row flex-wrap'),
        className,
      )}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        const isDisabled = disabled || option.disabled === true;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node === null) items.current.delete(option.value);
              else items.current.set(option.value, node);
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-describedby={card && option.description ? `${groupId}-${index}-description` : undefined}
            lang={option.lang}
            disabled={isDisabled}
            // 漫游焦点：只有停靠点能 Tab 到，其余用方向键。
            tabIndex={index === tabbableIndex ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'transition-colors focus-visible:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-50',
              card
                ? cn(
                    'flex items-center gap-3 rounded-xl border px-3 py-3 text-left text-sm',
                    'focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'border-border hover:bg-accent hover:text-accent-foreground',
                  )
                : cn(
                    'inline-flex items-center gap-2 rounded-md text-xs text-foreground',
                    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                    active ? 'font-medium text-primary' : 'hover:text-foreground/80',
                  ),
            )}
          >
            {card ? (
              option.icon ? (
                <Icon name={option.icon} className="size-4 shrink-0" />
              ) : null
            ) : (
              <span
                aria-hidden="true"
                className={cn(
                  'grid size-4 shrink-0 place-items-center rounded-full border transition-colors',
                  active ? 'border-primary' : 'border-input',
                )}
              >
                {active ? <span className="size-2 rounded-full bg-primary" /> : null}
              </span>
            )}

            {card ? (
              <span className="min-w-0 flex-1">
                <span className="block truncate">{option.label}</span>
                {option.description ? (
                  <span
                    id={`${groupId}-${index}-description`}
                    className="mt-0.5 block text-[11px] font-normal leading-snug text-muted-foreground"
                  >
                    {option.description}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="truncate">{option.label}</span>
            )}

            {card && active ? <Icon name="check" className="size-4 shrink-0" /> : null}
          </button>
        );
      })}
    </div>
  );
}
