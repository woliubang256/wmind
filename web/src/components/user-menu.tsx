import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from './ui/icon';
import { placeMenu, type MenuPlacement } from './ui/select';
import { UserAvatar } from './user-avatar';
import type { AvatarUser } from '@/lib/avatar';
import { useSiteConfig } from '@/features/site/use-site-config';

export function UserMenu({ user, links, isActive, onOpenAccount, avatarSrc, displayName, siteSettings, onAbout, onDeployGuide }: {
  user: AvatarUser;
  links: readonly { to: string; label: string; icon: IconName }[];
  isActive: (to: string) => boolean;
  /**
   * 桌面端菜单里的第一项「账户」：点击打开账户弹窗（登录 / 退出登录）。
   *
   * 桌面端没有登录页，账户就是「本地用户 ↔ 云端账号」的开关，做成菜单项
   * 而不是独立链接，是为了和下面几项保持一致的操作方式。
   */
  onOpenAccount?: () => void;
  /**
   * 「网站设置」：登录且远程账号是管理员时才给。
   *
   * 它打开的是**远程服务器**的管理后台（和 Web 端一样），桌面端不做代理，
   * 用系统浏览器打开。
   */
  siteSettings?: { label: string; onClick: () => void };
  /** 「关于」：打开关于弹窗（项目介绍、版本、检查更新、项目地址）。 */
  onAbout?: () => void;
  /** 「部署说明」：用系统浏览器打开部署文档。 */
  onDeployGuide?: () => void;
  /** 强制头像（本地用户用品牌 logo）。 */
  avatarSrc?: string;
  /** 强制显示名（本地用户的名字要跟随界面语言）。 */
  displayName?: string;
}) {
  const { t } = useTranslation();
  const { config } = useSiteConfig();
  const version = config.version?.trim() || 'dev';
  const displayVersion = /^\d/.test(version) ? `v${version}` : version;
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
  /**
   * 菜单的实际项数与高度。
   *
   * 之前只按 `links` 估算：桌面端还额外有「账户」「关于」「部署说明」「网站设置」
   * 四个动作项，估算高度小于真实高度，菜单就出现了滚动条，最后两项被藏在
   * 滚动区外面（表现为「装了新版却没看到关于」）。这里按真实项数算。
   */
  const actionCount = (onOpenAccount ? 1 : 0) + (onAbout ? 1 : 0) + (onDeployGuide ? 1 : 0) + (siteSettings ? 1 : 0);
  // 分隔线：账户之后、链接之间（仅当没有账户项时）、关于组之前、网站设置之前。
  const separatorCount =
    (onOpenAccount ? 1 : 0) +
    (!onOpenAccount && links.length > 1 ? 1 : 0) +
    (onAbout || onDeployGuide ? 1 : 0) +
    (siteSettings ? 1 : 0);
  const itemCount = links.length + actionCount;
  const menuHeight = itemCount * 36 + 10 + separatorCount * 9;

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      setPlacement(placeMenu({ top: rect.top, bottom: rect.bottom, left: Math.max(8, rect.right - 208), width: 208 },
        menuHeight,
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
  }, [open, menuHeight, close]);
  const attachMenu = useCallback((node: HTMLDivElement | null) => {
    menu.current = node;
    node?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]')[openAt ?? 0]?.focus();
  }, [openAt]);

  return <>
    <button ref={trigger} type="button" aria-label={t('nav.userMenu')} title={t('nav.userMenu')}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => {
        if (open) close();
        else setOpenAt(0);
      }}
      onKeyDown={(event) => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          setOpenAt(event.key === 'ArrowUp' || event.key === 'End' ? links.length - 1 : 0);
        }
      }}
      className="flex h-10 shrink-0 items-center gap-1 rounded-lg px-1 text-sm text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:gap-2 sm:px-2">
      <UserAvatar user={user} src={avatarSrc} className="size-7 sm:size-8" />
      <span className="hidden max-w-32 truncate lg:inline">{displayName?.trim() || user.nickname?.trim() || user.username}</span>
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
      {onOpenAccount ? (
        <div role="none">
          <button type="button" role="menuitem" tabIndex={-1}
            onClick={() => { close(false); onOpenAccount(); }}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent">
            <Icon name="user" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">{t('desktop.account.title')}</span>
          </button>
          <div role="separator" className="my-1 border-t border-border" />
        </div>
      ) : null}
      {links.map(({ to, label, icon }, index) => <div key={to} role="none">
        {!onOpenAccount && index === 1 ? <div role="separator" className="my-1 border-t border-border" /> : null}
        <Link to={to} role="menuitem" tabIndex={-1} aria-current={isActive(to) ? 'page' : undefined}
          onClick={() => close(false)}
          className={`flex items-center gap-2.5 rounded-md px-3 py-2 outline-none hover:bg-accent focus-visible:bg-accent ${isActive(to) ? 'bg-accent/60 font-medium text-accent-foreground' : ''}`}>
          <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">{label}</span>
          {to === '/account' ? <span data-app-version className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">{displayVersion}</span> : null}
        </Link>
      </div>)}
      {onAbout || onDeployGuide ? (
        <div role="none">
          <div role="separator" className="my-1 border-t border-border" />
          {onAbout ? (
            <button type="button" role="menuitem" tabIndex={-1}
              onClick={() => { close(false); onAbout(); }}
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent">
              <Icon name="flag" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">{t('desktop.menu.about')}</span>
            </button>
          ) : null}
          {onDeployGuide ? (
            <button type="button" role="menuitem" tabIndex={-1}
              onClick={() => { close(false); onDeployGuide(); }}
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent">
              <Icon name="file" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">{t('desktop.menu.deployGuide')}</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {siteSettings ? (
        <div role="none">
          <div role="separator" className="my-1 border-t border-border" />
          <button type="button" role="menuitem" tabIndex={-1}
            onClick={() => { close(false); siteSettings.onClick(); }}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent">
            <Icon name="globe" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">{siteSettings.label}</span>
          </button>
        </div>
      ) : null}
    </div>, document.body) : null}
  </>;
}
