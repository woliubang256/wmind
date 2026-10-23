import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from './ui/icon';
import { placeMenu, type MenuPlacement } from './ui/select';
import { UserAvatar } from './user-avatar';
import type { AvatarUser } from '@/lib/avatar';

export function UserMenu({ user, links, isActive }: {
  user: AvatarUser;
  links: readonly { to: string; label: string; icon: IconName }[];
  isActive: (to: string) => boolean;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const open = openAt !== null;
  const close = useCallback((restoreFocus = true) => {
    setOpenAt(null);
    setPlacement(null);
    if (restoreFocus) trigger.current?.focus();
  }, []);
  useEffect(() => close(false), [location.pathname, close]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      setPlacement(placeMenu({ top: rect.top, bottom: rect.bottom, left: Math.max(8, rect.right - 208), width: 208 },
        links.length * 36 + 10 + (links.length > 1 ? 9 : 0),
        { width: window.innerWidth, height: window.innerHeight }, { minWidth: 208 }));
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) close(false);
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
  }, [open, links.length, close]);
  const attachMenu = useCallback((node: HTMLDivElement | null) => {
    menu.current = node;
    node?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]')[openAt ?? 0]?.focus();
  }, [openAt]);

  return <>
    <button ref={trigger} type="button" aria-label={t('nav.userMenu')} title={t('nav.userMenu')}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : setOpenAt(0)}
      onKeyDown={(event) => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          setOpenAt(event.key === 'ArrowUp' || event.key === 'End' ? links.length - 1 : 0);
        }
      }}
      className="flex h-10 shrink-0 items-center gap-1 rounded-lg px-1 text-sm text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:gap-2 sm:px-2">
      <UserAvatar user={user} className="size-7 sm:size-8" />
      <span className="hidden max-w-32 truncate lg:inline">{user.nickname?.trim() || user.username}</span>
      <Icon name="chevron-down" className={`size-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && placement ? createPortal(<div id={id} ref={attachMenu} role="menu" aria-label={t('nav.userMenu')}
      className="z-50 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
      style={{ position: 'fixed', top: placement.top, left: placement.left, width: placement.width, maxHeight: placement.maxHeight }}
      onKeyDown={(event) => {
        const items = [...(menu.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]') ?? [])];
        const index = items.indexOf(document.activeElement as HTMLAnchorElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        else if (event.key === 'Tab') close(false);
      }}>
      {links.map(({ to, label, icon }, index) => <div key={to} role="none">
        {index === 1 ? <div role="separator" className="my-1 border-t border-border" /> : null}
        <Link to={to} role="menuitem" tabIndex={-1} aria-current={isActive(to) ? 'page' : undefined}
          onClick={() => close(false)}
          className={`flex items-center gap-2.5 rounded-md px-3 py-2 outline-none hover:bg-accent focus-visible:bg-accent ${isActive(to) ? 'bg-accent/60 font-medium text-accent-foreground' : ''}`}>
          <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />{label}
        </Link>
      </div>)}
    </div>, document.body) : null}
  </>;
}
