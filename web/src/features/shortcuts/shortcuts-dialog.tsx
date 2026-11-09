/**
 * 快捷键速查（仅桌面端）。
 *
 * 内容与 docs/10-用户使用手册.md §13 同源，改动两边要同步。
 *
 * 平台差异只在一处：`⌘`（macOS）与 `Ctrl`（Windows / Linux）。平台来源：
 * 桌面壳用 mygo 上报的真实平台（darwin → mac，windows/linux → pc）；
 * Web 端读不到系统就按 Windows 展示（用户共识）。
 */

import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/modal';
import { shortcutPlatform, type ShortcutPlatform } from '@/lib/desktop';

interface Entry {
  keys: string;
  label: string;
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const platform: ShortcutPlatform = shortcutPlatform();
  const mod = platform === 'mac' ? '⌘' : 'Ctrl';
  const redo = platform === 'mac' ? '⌘ + Shift + Z' : 'Ctrl + Y';

  const groups: { title: string; entries: Entry[] }[] = [
    {
      title: t('desktop.shortcuts.group.edit'),
      entries: [
        { keys: 'Tab', label: t('desktop.shortcuts.items.newChild') },
        { keys: 'Enter', label: t('desktop.shortcuts.items.newSibling') },
        { keys: 'F2', label: t('desktop.shortcuts.items.editTitle') },
        { keys: 'Shift + Enter', label: t('desktop.shortcuts.items.lineBreak') },
        { keys: 'Esc', label: t('desktop.shortcuts.items.deselect') },
        { keys: 'Delete / Backspace', label: t('desktop.shortcuts.items.delete') },
        { keys: `${mod} + .`, label: t('desktop.shortcuts.items.collapse') },
        { keys: `${mod} + A`, label: t('desktop.shortcuts.items.selectAllSiblings') },
        { keys: `${mod} + C / X / V`, label: t('desktop.shortcuts.items.clipboard') },
        { keys: `${mod} + B`, label: t('desktop.shortcuts.items.bold') },
        { keys: `${mod} + Shift + H`, label: t('desktop.shortcuts.items.cycleFill') },
        { keys: `${mod} + Z`, label: t('desktop.shortcuts.items.undo') },
        { keys: redo, label: t('desktop.shortcuts.items.redo') },
        { keys: `${mod} + S`, label: t('desktop.shortcuts.items.save') },
      ],
    },
    {
      title: t('desktop.shortcuts.group.navigate'),
      entries: [
        { keys: '↑ ↓ ← →', label: t('desktop.shortcuts.items.nearestTopic') },
        { keys: `${mod} + ←`, label: t('desktop.shortcuts.items.parent') },
        { keys: `${mod} + →`, label: t('desktop.shortcuts.items.firstChild') },
        { keys: `${mod} + ↑ / ↓`, label: t('desktop.shortcuts.items.siblings') },
        { keys: `${mod} + 0`, label: t('desktop.shortcuts.items.zoomReset') },
        { keys: `${mod} + 1`, label: t('desktop.shortcuts.items.zoomFit') },
        { keys: t('desktop.shortcuts.keys.wheel'), label: t('desktop.shortcuts.items.zoom') },
        { keys: t('desktop.shortcuts.keys.spaceDrag'), label: t('desktop.shortcuts.items.pan') },
        { keys: 'Shift + Tab', label: t('desktop.shortcuts.items.blurCanvas') },
      ],
    },
  ];

  return (
    <Modal open={open} title={t('desktop.shortcuts.title')} onClose={onClose}>
      <div className="space-y-5">
        <p className="text-xs text-muted-foreground">{t('desktop.shortcuts.hint')}</p>
        {groups.map((group) => (
          <section key={group.title}>
            <h3 className="mb-2 text-sm font-semibold">{group.title}</h3>
            <dl className="grid gap-1.5">
              {group.entries.map((entry) => (
                <div key={entry.keys} className="grid grid-cols-[auto_1fr] items-baseline gap-3 text-sm">
                  <dt>
                    <kbd className="rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-xs">
                      {entry.keys}
                    </kbd>
                  </dt>
                  <dd className="min-w-0 text-muted-foreground">{entry.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
