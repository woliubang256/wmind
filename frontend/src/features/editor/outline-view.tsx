/**
 * 大纲视图：把当前画布摊成一棵缩进列表。
 *
 * 「与画布双向同步」在这套架构里是免费的：大纲不持有任何副本，它每次都从
 * store 的文档里 `flatten` 出来。所以画布上改一个字，大纲立刻变；大纲里改
 * 一个字，画布立刻变——中间没有同步逻辑，也就没有「同步漏了一次」这种 bug。
 * 唯一需要手动对齐的是**选中**：两边共用 store 的 `selection`。
 *
 * 折叠状态跟着画布走（折叠节点的后代在大纲里也不显示），否则同一个文档在
 * 两个视图里长得不一样，用户会以为大纲漏了内容。
 *
 * 键盘（与画布不完全一样，理由见下）：
 *
 * | 按键 | 动作 |
 * | --- | --- |
 * | ↑ / ↓ | 上下移动 |
 * | Home / End | 首行 / 末行 |
 * | Enter / F2 | 改文字 |
 * | Delete | 删除所选 |
 * | Ctrl/⌘ + ] | 降一级（变成上一个兄弟的子节点） |
 * | Ctrl/⌘ + [ | 升一级（提到父节点的下一行） |
 *
 * 缩进不用 Tab：Tab 是浏览器里唯一的「离开这个控件」的键，被列表吃掉之后
 * 键盘用户就出不去了。XMind 的大纲用 Tab 缩进，代价正是这个。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/icon';
import { flatten, findTopicInSheet, type FlatTopic } from '@/editor/model/traverse';
import type { Sheet, WmindDocument } from '@/editor/model/types';

export interface OutlineViewProps {
  doc: WmindDocument;
  sheet: Sheet;
  selection: readonly string[];
  onSelect: (ids: string[]) => void;
  onCommitTitle: (id: string, title: string) => void;
  onAddChild: (id: string) => void;
  onDelete: (ids: string[]) => void;
  onToggleCollapse: (id: string) => void;
  onIndent: (id: string) => void;
  onOutdent: (id: string) => void;
}

/** 折叠节点之下的行要藏起来——用扁平表里的 depth 做一次栈式过滤。 */
function visibleRows(rows: FlatTopic[]): FlatTopic[] {
  const out: FlatTopic[] = [];
  /** 栈顶是「被折叠的节点的 depth」，depth 大于它的都不可见。 */
  const collapsedDepths: number[] = [];
  for (const row of rows) {
    while (collapsedDepths.length > 0 && row.depth <= collapsedDepths[collapsedDepths.length - 1]!) {
      collapsedDepths.pop();
    }
    if (collapsedDepths.length > 0) continue;
    out.push(row);
    if (row.collapsed && row.childCount > 0) collapsedDepths.push(row.depth);
  }
  return out;
}

export function OutlineView({
  doc,
  sheet,
  selection,
  onSelect,
  onCommitTitle,
  onAddChild,
  onDelete,
  onToggleCollapse,
  onIndent,
  onOutdent,
}: OutlineViewProps) {
  const { t } = useTranslation();
  const rows = useMemo(() => visibleRows(flatten(doc, sheet.id)), [doc, sheet.id]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  // 画布上选中了别的节点时，把键盘焦点带过去——否则按 ↓ 会从上次停留的行
  // 继续走，而用户刚在画布上点了另一个节点。
  useEffect(() => {
    const id = selection[0];
    if (id && rows.some((row) => row.id === id)) setFocusId(id);
  }, [selection, rows]);

  /** 当前该聚焦哪一行：优先选中，其次上次停留，最后第一行。 */
  const activeId = focusId ?? selection[0] ?? rows[0]?.id ?? null;

  const focusRow = useCallback((id: string) => {
    setFocusId(id);
    listRef.current?.querySelector<HTMLElement>(`[data-outline-row="${CSS.escape(id)}"]`)?.focus();
  }, []);

  const startEdit = (row: FlatTopic) => {
    setEditingId(row.id);
    setDraft(row.title);
  };

  const commitEdit = () => {
    if (editingId === null) return;
    onCommitTitle(editingId, draft);
    const id = editingId;
    setEditingId(null);
    focusRow(id);
  };

  const moveFocus = (row: FlatTopic, delta: number) => {
    const index = rows.findIndex((item) => item.id === row.id);
    const target = rows[index + delta];
    if (!target) return;
    onSelect([target.id]);
    focusRow(target.id);
  };

  const onRowKeyDown = (event: React.KeyboardEvent<HTMLElement>, row: FlatTopic) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && (event.key === ']' || event.key === '}')) {
      event.preventDefault();
      onIndent(row.id);
      return;
    }
    if (mod && (event.key === '[' || event.key === '{')) {
      event.preventDefault();
      onOutdent(row.id);
      return;
    }
    // 折叠 / 展开：与画布同一个键位。行内的折叠按钮是 `tabIndex={-1}`（整棵树
    // 只留一个 Tab 停靠点），所以键盘必须另有一条路能用上它。
    if (mod && event.key === '.') {
      event.preventDefault();
      onToggleCollapse(row.id);
      return;
    }
    // ⌘/Ctrl + Enter = 新建子主题。裸 Enter 是「改名」，而裸 Tab 必须留给
    // 浏览器（离开控件），所以加子主题只能挂在组合键上。
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      onAddChild(row.id);
      return;
    }
    if (mod) return;

    // Tab 交给浏览器，只阻止冒泡到编辑器的全局快捷键。
    //
    // 不 stopPropagation 的话，裸 Tab 会被 keymap 解析成「新建子主题」——而
    // `Tab` 是键盘用户离开这个列表的唯一出路（缩进是 Ctrl/Cmd + ]）。焦点在
    // 树里出不去是标准的键盘陷阱（WCAG 2.1.2），docs/05 §4.6.2 也是这么定的。
    // 不 preventDefault，所以浏览器的焦点移动照常发生。
    if (event.key === 'Tab') {
      event.stopPropagation();
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(row, 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(row, -1);
        return;
      case 'Home':
        event.preventDefault();
        if (rows[0]) {
          onSelect([rows[0].id]);
          focusRow(rows[0].id);
        }
        return;
      case 'End': {
        event.preventDefault();
        const last = rows[rows.length - 1];
        if (last) {
          onSelect([last.id]);
          focusRow(last.id);
        }
        return;
      }
      case 'Enter':
      case 'F2':
        event.preventDefault();
        startEdit(row);
        return;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        // 根节点删不掉：删了就没有中心主题了，文档直接不合法。
        if (row.parentId !== null) onDelete([row.id]);
        return;
      default:
    }
  };

  if (rows.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
        {t('editor.outline.empty')}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
        <span>{t('editor.outline.hint')}</span>
        <span>{t('editor.outline.count', { count: rows.length })}</span>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-2">
        <ul role="tree" aria-label={t('editor.outline.label')} className="flex flex-col">
          {rows.map((row) => {
            const selected = selection.includes(row.id);
            const isEditing = editingId === row.id;
            const hasChildren = row.childCount > 0;
            return (
              <li
                key={row.id}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-selected={selected}
                aria-expanded={hasChildren ? !row.collapsed : undefined}
                className="group flex items-stretch"
              >
                <div
                  className={[
                    'flex min-w-0 flex-1 items-center gap-1 rounded-md pr-2',
                    selected ? 'bg-accent' : 'hover:bg-accent/50',
                  ].join(' ')}
                  style={{ paddingLeft: `${8 + row.depth * 20}px` }}
                >
                  {hasChildren ? (
                    <button
                      type="button"
                      aria-label={t('editor.collapse')}
                      aria-expanded={!row.collapsed}
                      /*
                        `tabIndex={-1}`：整棵树只留「活动行」一个 Tab 停靠点。
                        每行都挂一个可 Tab 的按钮，意味着 50 行的导图要按 50 次
                        Tab 才能离开——那和键盘陷阱只差一步。折叠由 ⌘+. 承担，
                        读屏的浏览模式照样能找到这个按钮。
                      */
                      tabIndex={-1}
                      onClick={() => onToggleCollapse(row.id)}
                      className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted"
                    >
                      <Icon
                        name={row.collapsed ? 'chevron-right' : 'chevron-down'}
                        className="size-3.5"
                      />
                    </button>
                  ) : (
                    <span className="size-5 shrink-0" aria-hidden="true" />
                  )}

                  {isEditing ? (
                    <input
                      ref={inputRef}
                      value={draft}
                      aria-label={t('editor.outline.edit')}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitEdit();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          const id = row.id;
                          setEditingId(null);
                          focusRow(id);
                        }
                      }}
                      className="my-0.5 min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
                    />
                  ) : (
                    <button
                      type="button"
                      data-outline-row={row.id}
                      tabIndex={activeId === row.id ? 0 : -1}
                      onClick={() => {
                        onSelect([row.id]);
                        setFocusId(row.id);
                      }}
                      onDoubleClick={() => startEdit(row)}
                      onKeyDown={(event) => onRowKeyDown(event, row)}
                      className={[
                        'min-w-0 flex-1 truncate rounded-md px-1 py-1 text-left text-sm',
                        row.isFloating ? 'text-muted-foreground' : 'text-foreground',
                        selected ? 'font-medium' : '',
                      ].join(' ')}
                    >
                      {row.title === '' ? t('editor.outline.untitled') : row.title}
                    </button>
                  )}

                  {row.hiddenChildren > 0 ? (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                      +{row.hiddenChildren}
                    </span>
                  ) : null}

                  <button
                    type="button"
                    aria-label={t('editor.addChild')}
                    // 同折叠按钮：不参与 Tab 序列，键盘用 ⌘/Ctrl + Enter。
                    tabIndex={-1}
                    onClick={() => onAddChild(row.id)}
                    className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Icon name="plus" className="size-3" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** 供编辑器页面复用：缩进 / 升一级要算的父级与下标。 */
export function indentTarget(sheet: Sheet, id: string): { parentId: string; index: number } | null {
  const found = findTopicInSheet(sheet, id);
  if (!found || !found.parent) return null;
  const siblings = found.parent.children.attached;
  const prev = siblings[found.index - 1];
  if (!prev) return null;
  return { parentId: prev.id, index: prev.children.attached.length };
}

export function outdentTarget(sheet: Sheet, id: string): { parentId: string; index: number } | null {
  const found = findTopicInSheet(sheet, id);
  if (!found || !found.parent) return null;
  const grand = findTopicInSheet(sheet, found.parent.id);
  // 一级主题的父节点就是中心主题，它没有上级——再提就出文档了。
  if (!grand || !grand.parent) return null;
  return { parentId: grand.parent.id, index: grand.index + 1 };
}
