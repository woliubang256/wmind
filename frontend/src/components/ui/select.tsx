/**
 * 下拉选择。外观与交互照 shadcn 的 `Select`，但**不引 Radix**——项目没有
 * Radix 依赖（见 docs/09 的「不引组件库」决策），所以这里自己实现弹层。
 *
 * 为什么不用原生 `<select>`：
 *
 * - 原生下拉的弹层由**操作系统**绘制，圆角、阴影、字号、深色配色一律管不了。
 *   深色主题下 Chromium 会画一块系统色的方角面板，和卡片不是一套语言——
 *   这正是它看起来「不像这个网站的东西」的原因。
 * - 原生 `<option>` 里塞不进右侧的补充说明、图标、分组标题。
 * - macOS 的原生下拉弹出时，滚动整个面板会把它留在原地（它挂在窗口层）。
 *
 * 代价是要自己补齐原生免费给的那几样，这里逐条对应：
 *
 * | 原生免费给的 | 这里怎么补 |
 * | --- | --- |
 * | 打开/关闭 | `open` 状态 + 外部 pointerdown 关闭 |
 * | 方向键 / Home / End | `nextEnabledIndex` / `edgeEnabledIndex` |
 * | 首字母跳转 | `typeaheadIndex`，500ms 内的连续按键拼成前缀 |
 * | 读屏念「第几项，共几项」 | `role=listbox` + `role=option` + `aria-activedescendant` |
 * | 弹层不被祖先裁剪 | portal 到最近的 `<dialog>`（没有就 body）+ `position: fixed` |
 * | 空间不够时向上弹 | `placeMenu` 比较上下可用空间 |
 * | 焦点回到触发器 | `close()` 里显式 focus |
 *
 * 弹层挂在最近的 `<dialog>` 而不是 `document.body`：`<dialog>` 被 `showModal()`
 * 提升到 top layer，**盖在所有普通层之上**——portal 到 body 的弹层会被对话框
 * 整个盖住，看起来像「点了没反应」。
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

export interface SelectOption<T extends string | number = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

// ------------------------------------------------------------------ 纯逻辑
// 下面四个函数刻意不碰 DOM：下拉最容易错的就是「跳着跳着跳到 disabled 上」
// 与「敲了首字母没反应」，而这两件事用单测盯比用界面盯便宜得多。

/**
 * 从 `from` 起按 `delta` 走一步，跳过 `disabled`，首尾相接。
 *
 * `from < 0` 表示「还没有活动项」：向下走取第一个，向上走取最后一个。
 * 全部禁用时返回 -1（调用方据此保持不动）。
 */
export function nextEnabledIndex<T extends string | number>(
  options: readonly SelectOption<T>[],
  from: number,
  delta: 1 | -1,
): number {
  const count = options.length;
  if (count === 0) return -1;
  let cursor = from < 0 ? (delta === 1 ? -1 : 0) : from;
  for (let step = 0; step < count; step += 1) {
    cursor = (cursor + delta + count) % count;
    if (!options[cursor].disabled) return cursor;
  }
  return -1;
}

/** 第一个 / 最后一个可选项。全部禁用时返回 -1。 */
export function edgeEnabledIndex<T extends string | number>(
  options: readonly SelectOption<T>[],
  edge: 'first' | 'last',
): number {
  if (options.length === 0) return -1;
  if (edge === 'first') {
    for (let index = 0; index < options.length; index += 1) {
      if (!options[index].disabled) return index;
    }
    return -1;
  }
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index].disabled) return index;
  }
  return -1;
}

/**
 * 首字母跳转。
 *
 * 从 `from` 的**下一项**开始找，找不到再绕回头找一遍：连续敲同一个字母时要在
 * 同首字母的选项之间轮转，而不是永远停在第一个（原生 `<select>` 就是这个行为）。
 */
export function typeaheadIndex<T extends string | number>(
  options: readonly SelectOption<T>[],
  buffer: string,
  from: number,
): number {
  if (buffer === '' || options.length === 0) return -1;
  const needle = buffer.toLowerCase();
  const start = Math.max(from, -1);
  for (let step = 1; step <= options.length; step += 1) {
    const index = (start + step) % options.length;
    const option = options[index];
    if (!option.disabled && option.label.toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

export interface MenuPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  /** 弹层是否在触发器上方。 */
  above: boolean;
}

/**
 * 弹层落点。
 *
 * 高度由调用方**估算**（选项数 × 行高 + 内边距）而不是量真实 DOM：量真实高度
 * 要「先渲染再测量再挪位置」，中间那一帧会闪一下。选项文字一律 `nowrap` +
 * `truncate`，所以估算与真实高度只差不到一个像素。
 */
export function placeMenu(
  trigger: { top: number; bottom: number; left: number; width: number },
  estimatedHeight: number,
  viewport: { width: number; height: number },
  { gap = 4, margin = 8, minWidth = 0, maxHeight = 320 }: {
    gap?: number;
    margin?: number;
    minWidth?: number;
    maxHeight?: number;
  } = {},
): MenuPlacement {
  const spaceBelow = viewport.height - trigger.bottom - gap - margin;
  const spaceAbove = trigger.top - gap - margin;
  // 下方放不下、且上方更宽敞时才翻上去；否则仍然向下，只是变矮。
  const above = estimatedHeight > spaceBelow && spaceAbove > spaceBelow;
  const available = Math.max(above ? spaceAbove : spaceBelow, 96);
  // 宽度先按「至少和触发器一样宽」定，再压到视口以内：触发器贴着右边界时
  // 不压的话，弹层会有一截永远在屏幕外。
  const width = Math.min(
    Math.max(trigger.width, minWidth),
    Math.max(viewport.width - margin * 2, 0),
  );
  const height = Math.min(estimatedHeight, maxHeight, available);
  // 右边超出视口时向左挪，但不越过左边界。
  const left = Math.min(trigger.left, Math.max(viewport.width - width - margin, margin));
  const top = above ? trigger.top - gap - height : trigger.bottom + gap;
  return { top, left, width, maxHeight: height, above };
}

// ------------------------------------------------------------------ 组件

const ITEM_HEIGHT = { sm: 28, md: 34 } as const;

export interface SelectProps<T extends string | number = string> {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** 触发器的可访问名。外层有 `<label htmlFor>` 时可以省略。 */
  'aria-label'?: string;
  'aria-labelledby'?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  /** `sm` 是面板里的紧凑型，`md` 与输入框等高。 */
  size?: keyof typeof ITEM_HEIGHT;
  /** 弹层最小宽度：触发器很窄时（面板里两栏并排）用。 */
  menuMinWidth?: number;
  invalid?: boolean;
  placeholder?: string;
}

export function Select<T extends string | number = string>({
  value,
  options,
  onChange,
  id,
  disabled = false,
  className,
  size = 'md',
  menuMinWidth = 0,
  invalid = false,
  placeholder = '',
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: SelectProps<T>) {
  const reactId = useId();
  const listId = `${reactId}-listbox`;
  const optionId = (index: number) => `${reactId}-option-${index}`;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);

  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    setPlacement(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback((startAt: number) => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    // 挂在最近的 dialog 上，见文件头「为什么不是 body」。
    setPortalTarget(trigger.closest('dialog') ?? document.body);
    setActive(startAt);
    setOpen(true);
  }, []);

  // 落点：打开时算一次，滚动与窗口变化时重算。
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      if (trigger === null) return;
      const rect = trigger.getBoundingClientRect();
      setPlacement(
        placeMenu(
          rect,
          options.length * ITEM_HEIGHT[size] + 8,
          { width: window.innerWidth, height: window.innerHeight },
          { minWidth: Math.max(menuMinWidth, rect.width), maxHeight: 320 },
        ),
      );
    };
    update();
    // `capture` 是必需的：面板与对话框内部的滚动不会冒泡到 window。
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, options.length, size, menuMinWidth]);

  // 打开后把焦点交给 listbox：方向键、首字母、Esc 都在它上面处理。
  //
  // 用 ref 回调而不是 `useEffect([open])`：弹层要等 `placement` 算出来才挂载，
  // 而 `open` 变 true 的那一帧 `listRef.current` 还是 null——effect 先跑、节点
  // 后到，焦点就永远留在触发器上，方向键于是被当成「再打开一次」，活动项
  // 原地不动。回调 ref 只在节点真正挂载时调一次，正好是我们要的时机。
  const attachList = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    if (node !== null) node.focus();
  }, []);

  // 点外面关闭。用 `pointerdown` 而不是 `click`：后者在 mousedown 之后才触发，
  // 中间的 focus 变化会先把弹层关掉一次。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, close]);

  // 首字母缓冲。500ms 没有新按键就清空——与原生 `<select>` 的节奏一致。
  const typed = useRef({ buffer: '', timer: 0 });
  const typeKey = useCallback(
    (key: string) => {
      const state = typed.current;
      state.buffer += key;
      window.clearTimeout(state.timer);
      state.timer = window.setTimeout(() => {
        state.buffer = '';
      }, 500);
      const index = typeaheadIndex(options, state.buffer, active);
      if (index >= 0) setActive(index);
    },
    [options, active],
  );
  useEffect(() => () => window.clearTimeout(typed.current.timer), []);

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (option === undefined || option.disabled) return;
      if (option.value !== value) onChange(option.value);
      close();
    },
    [options, value, onChange, close],
  );

  const moveActive = useCallback(
    (delta: 1 | -1) => setActive((current) => nextEnabledIndex(options, current, delta)),
    [options],
  );

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        return;
      case 'Home':
        event.preventDefault();
        setActive(edgeEnabledIndex(options, 'first'));
        return;
      case 'End':
        event.preventDefault();
        setActive(edgeEnabledIndex(options, 'last'));
        return;
      case 'Enter':
        event.preventDefault();
        commit(active);
        return;
      case ' ':
        event.preventDefault();
        commit(active);
        return;
      case 'Escape':
        event.preventDefault();
        // 弹层先关，别把 Esc 冒到外面的对话框上去——那会连对话框一起关掉。
        event.stopPropagation();
        close();
        return;
      case 'Tab':
        // Tab 是「离开」，焦点交给浏览器自己走，不再抢回触发器。
        close(false);
        return;
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          typeKey(event.key);
        }
    }
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    // Enter / 空格交给 button 自己的 click，不在这里重复处理。
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(
        selectedIndex >= 0
          ? selectedIndex
          : edgeEnabledIndex(options, event.key === 'ArrowDown' ? 'first' : 'last'),
      );
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      openMenu(edgeEnabledIndex(options, event.key === 'Home' ? 'first' : 'last'));
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      openMenu(typeaheadIndex(options, event.key, selectedIndex >= 0 ? selectedIndex - 1 : -1));
    }
  };

  const compact = size === 'sm';

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        // 值挂一份到 DOM 上：自绘下拉没有 `inputValue()`，界面验收要断言
        // 「现在选的是哪个」只能读属性。读可见文字不行——文字是给人看的，
        // 会被翻译、会被截断。
        data-value={String(value)}
        onClick={() => (open ? close() : openMenu(selectedIndex))}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-md border border-input bg-background font-normal outline-none transition',
          'hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring',
          'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/30',
          'disabled:cursor-not-allowed disabled:opacity-60',
          compact ? 'h-8 px-2 text-xs' : 'h-11 rounded-xl px-3 text-sm',
          open && 'ring-2 ring-ring',
          className,
        )}
      >
        <span className={cn('truncate text-left', selected === undefined && 'text-muted-foreground/70')}>
          {selected?.label ?? placeholder}
        </span>
        <Icon
          name="chevron-down"
          className={cn('shrink-0 opacity-60 transition-transform', compact ? 'size-3.5' : 'size-4', open && 'rotate-180')}
        />
      </button>

      {open && placement !== null && portalTarget !== null
        ? createPortal(
            <div
              ref={attachList}
              id={listId}
              role="listbox"
              tabIndex={-1}
              aria-label={ariaLabel}
              aria-labelledby={ariaLabelledBy}
              aria-activedescendant={active >= 0 ? optionId(active) : undefined}
              onKeyDown={onListKeyDown}
              style={{
                position: 'fixed',
                top: placement.top,
                left: placement.left,
                width: placement.width,
                maxHeight: placement.maxHeight,
              }}
              className={cn(
                'z-50 overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg',
                'outline-none',
              )}
            >
              {options.map((option, index) => {
                const isSelected = option.value === value;
                const isActive = index === active;
                return (
                  <div
                    key={String(option.value)}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    data-active={isActive || undefined}
                    // 阻止默认：否则 pointerdown 会把焦点从 listbox 挪走，
                    // 之后的按键就没人接了。click 仍然会正常触发。
                    onPointerDown={(event) => event.preventDefault()}
                    onPointerMove={() => {
                      if (!option.disabled && !isActive) setActive(index);
                    }}
                    onClick={() => commit(index)}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded-md px-2',
                      compact ? 'h-7 text-xs' : 'h-[34px] text-sm',
                      'truncate whitespace-nowrap',
                      option.disabled && 'cursor-not-allowed opacity-45',
                      isActive && !option.disabled && 'bg-accent text-accent-foreground',
                      isSelected && 'font-medium text-primary',
                    )}
                  >
                    {/* 勾选位固定占位，否则选中项的文字会比别的项右移一格。 */}
                    <Icon
                      name="check"
                      className={cn('size-3.5 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')}
                      strokeWidth="2.6"
                    />
                    <span className="truncate">{option.label}</span>
                  </div>
                );
              })}
            </div>,
            portalTarget,
          )
        : null}
    </>
  );
}
