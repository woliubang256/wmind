import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '@/components/ui/icon';
import { placeMenu, type MenuPlacement } from '@/components/ui/select';

export type SheetAction = 'rename' | 'copy' | 'paste' | 'duplicate' | 'delete' | 'add' | 'saveAs';
const ACTIONS: [SheetAction, IconName][] = [['rename', 'pencil'], ['copy', 'copy'], ['paste', 'clipboard-list'], ['duplicate', 'files'], ['delete', 'trash'], ['add', 'plus'], ['saveAs', 'download']];

export function SheetMenu({ anchor, canPaste, canDelete, onAction, onClose }: {
  anchor: HTMLElement; canPaste: boolean; canDelete: boolean;
  onAction(action: SheetAction): void; onClose(restoreFocus: boolean): void;
}) {
  const { t } = useTranslation();
  const menu = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  useLayoutEffect(() => {
    const update = () => setPlacement(placeMenu(anchor.getBoundingClientRect(), 270,
      { width: window.innerWidth, height: window.innerHeight }, { minWidth: 180 }));
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose(false);
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
  }, [anchor, onClose]);
  useLayoutEffect(() => { if (placement) menu.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [!!placement]);
  if (!placement) return null;
  return createPortal(<div ref={menu} role="menu" aria-label={t('editor.sheets.menu')}
    style={{ position: 'fixed', top: placement.top, left: placement.left, width: placement.width, maxHeight: placement.maxHeight }}
    className="z-50 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-lg"
    onKeyDown={(event) => {
      const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); }
      else if (event.key === 'Tab') onClose(true);
    }}>
    {ACTIONS.map(([action, icon]) => <button key={action} type="button" role="menuitem"
      disabled={(action === 'paste' && !canPaste) || (action === 'delete' && !canDelete)}
      className="flex h-9 w-full items-center gap-2 rounded px-3 text-left outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-40"
      onClick={() => { onClose(action !== 'rename'); onAction(action); }}>
      <Icon name={icon} className="size-3.5" />{t(`editor.sheets.${action}`)}
    </button>)}
  </div>, document.body);
}
