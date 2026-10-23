import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '@/components/ui/icon';
import { placeMenu, type MenuPlacement } from '@/components/ui/select';
import { ToolbarButton } from './toolbar-button';
import { insertAvailability, type InsertAction } from './insert-actions';

const MAIN = ['note', 'label', 'todo', 'task', 'link', 'attachment', 'sticker', 'illustration', 'image', 'equation'] as const;
const LINKS = ['web', 'topic', 'file', 'folder'] as const;
const ACTION_ICONS: Record<InsertAction | 'link', IconName> = {
  note: 'note', label: 'tag', todo: 'square-check', task: 'clipboard-list',
  link: 'link', attachment: 'paperclip', sticker: 'sticker', illustration: 'shapes',
  image: 'image', equation: 'sigma', web: 'globe', topic: 'waypoints', file: 'file', folder: 'folder',
};

export function InsertMenu({ topics, selection, onInsert }: { topics: number; selection: number; onInsert(action: InsertAction): void }) {
  const { t } = useTranslation();
  const trigger = useRef<HTMLButtonElement>(null); const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false); const [links, setLinks] = useState(false);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const close = (focus = true) => { setOpen(false); setLinks(false); if (focus) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => { if (trigger.current) setPlacement(placeMenu(trigger.current.getBoundingClientRect(), Math.min(600, window.innerHeight - 24), { width: window.innerWidth, height: window.innerHeight }, { minWidth: 264 })); };
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false); };
    update(); document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', update);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', update); };
  }, [open]);
  useLayoutEffect(() => { if (open && placement) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(); }, [open, links, !!placement]);
  const items = links ? LINKS : MAIN;
  return <>
    <ToolbarButton ref={trigger} variant="ghost" size="icon" className="gap-0.5" aria-label={t('editor.insert')}
      hint={t('editor.hint.insert')} aria-haspopup="menu" aria-expanded={open} onClick={() => open ? close() : setOpen(true)}
      onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}>
      <Icon name="plus" className="size-4" /><Icon name="chevron-down" className="size-3" />
    </ToolbarButton>
    {open && placement ? createPortal(<div ref={menu} role="menu" aria-label={t(links ? 'editor.content.link' : 'editor.insert')}
      style={{ position: 'fixed', top: placement.top, left: placement.left, width: placement.width, maxHeight: 'min(640px, calc(100vh - 24px))' }}
      className="z-50 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
      onKeyDown={(event) => {
        const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        } else if (event.key === 'ArrowRight' && document.activeElement?.getAttribute('data-action') === 'link' && !insertAvailability('web', topics, selection)) { event.preventDefault(); setLinks(true); }
        else if (event.key === 'ArrowLeft' && links) { event.preventDefault(); setLinks(false); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (links) setLinks(false); else close(); }
        else if (event.key === 'Tab') close(false);
      }}>
      {links ? <button type="button" role="menuitem" className="mb-1 flex w-full items-center gap-2 rounded px-3 py-2 text-muted-foreground hover:bg-accent focus:bg-accent" onClick={() => setLinks(false)}><Icon name="chevron-left" className="size-4" />{t('editor.insert')}</button> : null}
      {items.map((action) => {
        const reason = insertAvailability(action === 'link' ? 'web' : action, topics, selection);
        return <button key={action} type="button" role="menuitem" data-action={action} aria-haspopup={action === 'link' ? 'menu' : undefined}
          aria-disabled={reason ? true : undefined} title={reason ? t(`editor.content.reason.${reason}`) : t(`editor.content.hint.${action}`)}
          className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left outline-none hover:bg-accent focus:bg-accent aria-disabled:opacity-45"
          onClick={() => { if (reason) return; if (action === 'link') { setLinks(true); return; } close(false); onInsert(action); }}>
          <span className="flex min-w-0 items-center gap-3"><Icon name={ACTION_ICONS[action]} className="size-4 shrink-0 text-muted-foreground" /><span>{t(`editor.content.${action}`)}</span></span>{action === 'link' ? <Icon name="chevron-right" className="size-4" /> : null}
        </button>;
      })}
      {insertAvailability('label', topics, selection) ? <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{t(`editor.content.reason.${insertAvailability('label', topics, selection)}`)}</p> : null}
    </div>, document.body) : null}
  </>;
}
