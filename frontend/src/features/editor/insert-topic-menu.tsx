import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/icon';
import { placeMenu, type MenuPlacement } from '@/components/ui/select';
import { ToolbarButton } from './toolbar-button';

export function InsertTopicMenu({ rootSelected, onInsert }: {
  rootSelected: boolean;
  onInsert: (kind: 'sibling' | 'child') => void;
}) {
  const { t } = useTranslation();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const initialIndex = useRef(0);
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (trigger.current) setPlacement(placeMenu(trigger.current.getBoundingClientRect(), 112,
        { width: window.innerWidth, height: window.innerHeight }, { minWidth: 248 }));
    };
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    update();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);
  const focusItem = (index: number) => menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]')[index]?.focus();
  const show = (index: number) => { initialIndex.current = index; setOpen(true); };
  return <>
    <ToolbarButton ref={trigger} variant="ghost" size="sm" className="px-2" aria-label={t('editor.insert')}
      hint={t('editor.hint.insert')} aria-haspopup="menu" aria-expanded={open}
      onClick={() => open ? close() : show(rootSelected ? 1 : 0)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); show(event.key === 'ArrowUp' || rootSelected ? 1 : 0);
        }
      }}>
      <Icon name="plus" className="size-4" /><Icon name="chevron-down" className="size-3" />
    </ToolbarButton>
    {open && placement && createPortal(
      <div role="menu" aria-label={t('editor.insert')} ref={(node) => {
        menu.current = node;
        if (node) node.querySelectorAll<HTMLButtonElement>('[role=menuitem]')[initialIndex.current]?.focus();
      }} style={{ position: 'fixed', top: placement.top, left: placement.left, width: placement.width }}
        className="z-50 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const current = document.activeElement?.getAttribute('data-index') === '1' ? 1 : 0;
            focusItem(rootSelected ? 1 : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - current);
          } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          else if (event.key === 'Tab') close(false);
        }}>
        {(['sibling', 'child'] as const).map((kind, index) => <button key={kind} type="button" role="menuitem"
          data-index={index} tabIndex={-1} aria-disabled={kind === 'sibling' && rootSelected || undefined}
          className="flex w-full flex-col rounded-md px-3 py-2 text-left outline-none hover:bg-accent focus:bg-accent aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onClick={() => {
            if (kind === 'sibling' && rootSelected) return;
            close(false); onInsert(kind);
          }}>
          <span className="flex w-full items-center justify-between gap-4"><span>{t(kind === 'sibling' ? 'editor.addSibling' : 'editor.addChild')}</span>
            <kbd className="text-xs text-muted-foreground">{kind === 'sibling' ? 'Enter' : 'Tab'}</kbd></span>
          {kind === 'sibling' && rootSelected ? <span className="mt-0.5 text-xs">{t('editor.hint.rootSibling')}</span> : null}
        </button>)}
      </div>, document.body,
    )}
  </>;
}
