import { forwardRef, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ToolbarButtonProps extends ButtonProps {
  hint?: string;
  shortcut?: string;
  disabledReason?: string;
}

/** 禁用动作仍可聚焦以发现原因，但鼠标和键盘点击都不能执行。 */
export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(function ToolbarButton(
  { hint, shortcut, disabledReason, disabled, children, onClick, className, ...props }, forwardedRef,
) {
  const id = useId();
  const anchor = useRef<HTMLButtonElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const label = hint ?? props['aria-label'] ?? (typeof children === 'string' ? children : '');
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect();
      const tip = popup.current?.getBoundingClientRect();
      if (!rect || !tip) return;
      setPosition({
        left: Math.max(8, Math.min(rect.left + rect.width / 2 - tip.width / 2, window.innerWidth - tip.width - 8)),
        top: rect.bottom + tip.height + 8 <= window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - tip.height - 6),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, label, disabled, disabledReason]);
  return <>
    <Button
      {...props}
      ref={(node) => {
        anchor.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
      aria-disabled={disabled || undefined}
      aria-describedby={open ? id : undefined}
      className={cn(disabled && 'cursor-not-allowed opacity-50', className)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { setOpen(false); event.stopPropagation(); }
        props.onKeyDown?.(event);
      }}
      onClick={(event) => {
        setOpen(false);
        if (disabled) { event.preventDefault(); return; }
        onClick?.(event);
      }}
    >{children}</Button>
    {open && label && createPortal(
      <div ref={popup} id={id} role="tooltip" style={{ position: 'fixed', ...position }}
        className="pointer-events-none z-[100] max-w-[min(20rem,calc(100vw-1rem))] rounded-md border border-border bg-popover px-3 py-2 text-xs leading-5 text-popover-foreground shadow-md">
        <div>{label}{shortcut ? <kbd className="ml-3 text-muted-foreground">{shortcut}</kbd> : null}</div>
        {disabled && disabledReason ? <div className="text-muted-foreground">{disabledReason}</div> : null}
      </div>, document.body,
    )}
  </>;
});
