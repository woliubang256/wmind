/**
 * 底部画布标签栏（多画布）。
 *
 * 一个导图可以有多张画布，全部存在同一份文档的 `sheets` 数组里——保存、
 * 版本、缩略图、分享都还是「一张导图」，多画布只是文档内部多了一层。
 * 所以这里没有任何网络请求，全部是 store 上的命令。
 *
 * 交互（尽量每一件都能用键盘做）：
 *
 * - 单击切换；←/→ 在标签间移动（焦点跟着走，符合 tablist 的惯例）；
 * - 双击或 Enter / F2 就地改名；Esc 放弃；
 * - Delete 删除；有内容的画布会先要一次确认（空画布直接删，⌘Z 可救）；
 * - 拖动排序；键盘用 Alt+←/→ 移动当前标签。
 *
 * 为什么改名是「就地输入框」而不是弹窗：画布名很短，弹窗要处理焦点陷阱、
 * 遮罩、Esc 三层语义，为一行文字不值当。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Icon } from '@/components/ui/icon';
import type { Sheet } from '@/editor/model/types';
import { sheetHasContent } from '@/editor/commands/sheet';

export interface SheetTabsProps {
  sheets: readonly Sheet[];
  activeId: string;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, toIndex: number) => void;
}

export function SheetTabs({
  sheets,
  activeId,
  onSwitch,
  onAdd,
  onRename,
  onDelete,
  onMove,
}: SheetTabsProps) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Sheet | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 改名结束后要把焦点还给标签，否则焦点掉到 body 上，键盘操作就断了。 */
  const restoreFocusId = useRef<string | null>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  useEffect(() => {
    const id = restoreFocusId.current;
    if (renaming !== null || id === null) return;
    restoreFocusId.current = null;
    const button = document.querySelector<HTMLElement>(`[data-sheet-tab="${CSS.escape(id)}"]`);
    button?.focus();
  }, [renaming]);

  const startRename = (sheet: Sheet) => {
    setRenaming(sheet.id);
    setDraft(sheet.title);
  };

  const commitRename = () => {
    if (renaming === null) return;
    restoreFocusId.current = renaming;
    onRename(renaming, draft);
    setRenaming(null);
  };

  const requestDelete = (sheet: Sheet) => {
    // 空画布直接删：它上面一个字都没有，⌘Z 一秒就能救回来，再弹一次确认
    // 只是把「连点两下」变成「连点三下」。
    if (sheetHasContent(sheet)) {
      setPendingDelete(sheet);
      return;
    }
    onDelete(sheet.id);
  };

  const step = (sheet: Sheet, delta: number) => {
    const from = sheets.findIndex((s) => s.id === sheet.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= sheets.length) return;
    onMove(sheet.id, to);
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, sheet: Sheet, index: number) => {
    // Alt+←/→：调整顺序。键位表（keymap.ts）对带 Alt 的组合一律不拦，
    // 这里显式拦下并 preventDefault，避免 Windows/Linux 上触发「后退」。
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      step(sheet, event.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        event.preventDefault();
        const next = index + (event.key === 'ArrowLeft' ? -1 : 1);
        const target = sheets[next];
        if (!target) return;
        onSwitch(target.id);
        document.querySelector<HTMLElement>(`[data-sheet-tab="${CSS.escape(target.id)}"]`)?.focus();
        return;
      }
      case 'Home':
      case 'End': {
        event.preventDefault();
        const target = event.key === 'Home' ? sheets[0] : sheets[sheets.length - 1];
        if (!target) return;
        onSwitch(target.id);
        document.querySelector<HTMLElement>(`[data-sheet-tab="${CSS.escape(target.id)}"]`)?.focus();
        return;
      }
      case 'F2':
      case 'Enter':
        event.preventDefault();
        startRename(sheet);
        return;
      case 'Delete':
      case 'Backspace':
        // 只剩一张时不给删：按钮也藏起来了，键盘路径同样要挡住。
        if (sheets.length <= 1) return;
        event.preventDefault();
        requestDelete(sheet);
        return;
      default:
    }
  };

  return (
    <div className="flex items-center gap-1 border-t border-border/70 bg-muted/30 px-2 py-1">
      <div
        role="tablist"
        aria-label={t('editor.sheets.label')}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {sheets.map((sheet, index) => {
          const active = sheet.id === activeId;
          const isRenaming = renaming === sheet.id;
          return (
            <div
              key={sheet.id}
              role="presentation"
              draggable={!isRenaming && sheets.length > 1}
              onDragStart={(event) => {
                setDragId(sheet.id);
                event.dataTransfer.effectAllowed = 'move';
                // Firefox 不设 data 就不开始拖。
                event.dataTransfer.setData('text/plain', sheet.id);
              }}
              onDragOver={(event) => {
                if (dragId === null || dragId === sheet.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropIndex(index);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragId !== null && dragId !== sheet.id) onMove(dragId, index);
                setDragId(null);
                setDropIndex(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropIndex(null);
              }}
              className={[
                'flex shrink-0 items-center rounded-md',
                active ? 'bg-background shadow-sm ring-1 ring-border' : 'hover:bg-accent/60',
                dropIndex === index && dragId !== null ? 'ring-2 ring-primary' : '',
                dragId === sheet.id ? 'opacity-50' : '',
              ].join(' ')}
            >
              {isRenaming ? (
                <input
                  ref={inputRef}
                  value={draft}
                  aria-label={t('editor.sheets.rename')}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitRename();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      // Esc 放弃：把焦点还回去再退出改名，不然焦点会跟着
                      // 卸载的输入框一起消失。
                      restoreFocusId.current = sheet.id;
                      setRenaming(null);
                    }
                  }}
                  className="h-7 w-28 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  data-sheet-tab={sheet.id}
                  aria-selected={active}
                  // roving tabindex：tablist 只有一个 tab 在 Tab 键序列里，
                  // 否则按 Tab 穿过五个画布才能到画布外的东西。
                  tabIndex={active ? 0 : -1}
                  onDoubleClick={() => startRename(sheet)}
                  onKeyDown={(event) => onTabKeyDown(event, sheet, index)}
                  onClick={() => onSwitch(sheet.id)}
                  className={[
                    'max-w-[12rem] truncate rounded-md px-2.5 py-1 text-xs',
                    active ? 'font-medium text-foreground' : 'text-muted-foreground',
                  ].join(' ')}
                  title={t('editor.sheets.hint')}
                >
                  {sheet.title}
                </button>
              )}

              {/* 删除按钮与标签是兄弟而不是父子：button 里套 button 是非法标记。 */}
              {active && sheets.length > 1 && !isRenaming ? (
                <button
                  type="button"
                  aria-label={t('editor.sheets.delete')}
                  onClick={() => requestDelete(sheet)}
                  className="mr-1 grid size-5 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Icon name="x" className="size-3" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      <Button
        variant="ghost"
        size="icon"
        aria-label={t('editor.sheets.add')}
        title={t('editor.sheets.add')}
        onClick={onAdd}
        className="size-7 shrink-0"
      >
        <Icon name="plus" className="size-3.5" />
      </Button>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('editor.sheets.deleteTitle', { title: pendingDelete?.title ?? '' })}
        description={t('editor.sheets.deleteBody')}
        confirmLabel={t('editor.sheets.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={() => {
          if (pendingDelete) onDelete(pendingDelete.id);
          setPendingDelete(null);
        }}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}
