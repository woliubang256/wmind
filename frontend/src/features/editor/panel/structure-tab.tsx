/**
 * 面板的「结构」页签：概要 / 边界 / 联系。
 *
 * 三者在文档里是三种不同的东西，但在界面上是同一种交互：**选中几个主题，
 * 生成一条附属结构，然后给它起个名字**。所以这一页不是三段独立表单，而是
 * 三个同构的小节——用户学会一节就会用另外两节。
 *
 * 为什么放在面板里而不是只放工具栏按钮：新建是一次性的，改名与删除是**反复**
 * 发生的。只给新建按钮的话，用户建完就再也找不到「把它改掉」的入口了。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { collectBoundaries, collectSummaries, walkSheet } from '@/editor/model/traverse';
import type { Sheet, Style, Theme } from '@/editor/model/types';
import type { AnnotationKind } from '@/editor/commands/annotation';
import { cn } from '@/lib/utils';
import { RelationshipStyleFields } from './relationship-style-fields';

export interface AnnotationRow {
  id: string;
  title: string;
  /** 覆盖/连接的主题名，用于让用户认出「这是哪一条」。 */
  detail: string;
}

export interface StructureTabProps {
  sheet: Sheet;
  theme: Theme;
  /** 当前选中的主题 id。按钮的可用性由它决定。 */
  selection: readonly string[];
  /** 面板里正在编辑的那一条，画布上会高亮。 */
  activeId: string | null;
  onActivate: (kind: AnnotationKind, id: string | null) => void;
  onAddSummary: () => void;
  onAddBoundary: () => void;
  onAddRelationship: () => void;
  onRename: (kind: AnnotationKind, id: string, title: string) => void;
  onRemove: (kind: AnnotationKind, id: string) => void;
  onPatchRelationship: (id: string, patch: Partial<Style>) => void;
  onResetRelationshipRouting: (id: string) => void;
}

/** 标题 → 显示用的一行摘要（最多三个名字）。 */
function describe(names: readonly string[]): string {
  const shown = names.filter((name) => name !== '').slice(0, 3);
  if (shown.length === 0) return '';
  const more = names.length > shown.length ? ` +${names.length - shown.length}` : '';
  return `${shown.join('、')}${more}`;
}

export function StructureTab({
  sheet,
  theme,
  selection,
  activeId,
  onActivate,
  onAddSummary,
  onAddBoundary,
  onAddRelationship,
  onRename,
  onRemove,
  onPatchRelationship,
  onResetRelationshipRouting,
}: StructureTabProps) {
  const { t } = useTranslation();

  const titles = new Map<string, string>();
  walkSheet(sheet, (topic) => {
    titles.set(topic.id, topic.title);
  });
  const topicIds = new Set(titles.keys());
  for (const summary of collectSummaries(sheet)) titles.set(summary.id, summary.title);
  const nameOf = (id: string) => titles.get(id) ?? t('editor.annotation.untitledTopic');

  const summaries: AnnotationRow[] = collectSummaries(sheet).map((item) => ({
    id: item.id,
    title: item.title,
    detail: describe(item.range.map(nameOf)),
  }));

  const boundaries: AnnotationRow[] = collectBoundaries(sheet).map((item) => ({
    id: item.id,
    title: item.title,
    detail: describe(item.range.map(nameOf)),
  }));

  const relationships: AnnotationRow[] = sheet.relationships.map((item) => ({
    id: item.id,
    title: item.title,
    detail: `${nameOf(item.end1Id)} → ${nameOf(item.end2Id)}`,
  }));

  const hasSelection = selection.length > 0 && selection.every((id) => topicIds.has(id));
  const pairSelection = selection.length === 2 && selection.every((id) => titles.has(id));

  return (
    <div className="flex flex-col gap-4">
      <Section
        icon="summary"
        title={t('editor.annotation.summary')}
        hint={t('editor.annotation.summaryHint')}
        action={
          <Button size="sm" variant="outline" disabled={!hasSelection} onClick={onAddSummary}>
            <Icon name="plus" className="mr-1 size-3.5" />
            {t('editor.annotation.add')}
          </Button>
        }
        rows={summaries}
        kind="summary"
        activeId={activeId}
        onActivate={onActivate}
        onRename={onRename}
        onRemove={onRemove}
        empty={t('editor.annotation.summaryEmpty')}
      />

      <Section
        icon="boundary"
        title={t('editor.annotation.boundary')}
        hint={t('editor.annotation.boundaryHint')}
        action={
          <Button size="sm" variant="outline" disabled={!hasSelection} onClick={onAddBoundary}>
            <Icon name="plus" className="mr-1 size-3.5" />
            {t('editor.annotation.add')}
          </Button>
        }
        rows={boundaries}
        kind="boundary"
        activeId={activeId}
        onActivate={onActivate}
        onRename={onRename}
        onRemove={onRemove}
        empty={t('editor.annotation.boundaryEmpty')}
      />

      <Section
        icon="relationship"
        title={t('editor.annotation.relationship')}
        hint={t('editor.annotation.relationshipHint')}
        action={
          <Button size="sm" variant="outline" disabled={!pairSelection} onClick={onAddRelationship}>
            <Icon name="plus" className="mr-1 size-3.5" />
            {t('editor.annotation.add')}
          </Button>
        }
        rows={relationships}
        kind="relationship"
        activeId={activeId}
        onActivate={onActivate}
        onRename={onRename}
        onRemove={onRemove}
        empty={t('editor.annotation.relationshipEmpty')}
        renderDetails={(row) => {
          const relationship = sheet.relationships.find((item) => item.id === row.id);
          return relationship ? <RelationshipStyleFields onResetRouting={() => onResetRelationshipRouting(row.id)} relationship={relationship} theme={theme} onPatch={(patch) => onPatchRelationship(row.id, patch)} /> : null;
        }}
      />
    </div>
  );
}

function Section({
  icon,
  title,
  hint,
  action,
  rows,
  kind,
  activeId,
  onActivate,
  onRename,
  onRemove,
  empty,
  renderDetails,
}: {
  icon: IconName;
  title: string;
  hint: string;
  action: ReactNode;
  rows: AnnotationRow[];
  kind: AnnotationKind;
  activeId: string | null;
  onActivate: (kind: AnnotationKind, id: string | null) => void;
  onRename: (kind: AnnotationKind, id: string, title: string) => void;
  onRemove: (kind: AnnotationKind, id: string) => void;
  empty: string;
  renderDetails?: (row: AnnotationRow) => ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Icon name={icon} className="size-3.5 text-muted-foreground" />
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        <span className="ml-auto">{action}</span>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/70 px-2.5 py-2 text-[11px] text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <li key={row.id}>
              <div
                className={cn(
                  'rounded-lg border px-2 py-1.5 transition-colors',
                  activeId === row.id ? 'border-primary bg-primary/5' : 'border-border/70',
                )}
                onClick={() => onActivate(kind, row.id)}
                onFocusCapture={() => onActivate(kind, row.id)}
              >
                <div className="flex items-center gap-1">
                  <RenameField
                    value={row.title}
                    allowEmpty={kind !== 'boundary'}
                    placeholder={row.detail}
                    onCommit={(next) => onRename(kind, row.id, next)}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t('editor.annotation.remove')}
                    onClick={(event) => { event.stopPropagation(); onRemove(kind, row.id); }}
                  >
                    <Icon name="trash" className="size-3.5" />
                  </Button>
                </div>
                <p className="truncate text-[10px] text-muted-foreground">{row.detail}</p>
                {activeId === row.id ? renderDetails?.(row) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 行内改名。
 *
 * 本地 draft 保留输入过程；边界拒绝空标题，失焦时恢复原值。
 * 概要和联系允许清空，分别通过矩形和宽线条命中区重新编辑。
 */
function RenameField({
  value,
  placeholder,
  onCommit,
  allowEmpty = false,
}: {
  value: string;
  placeholder: string;
  onCommit: (next: string) => void;
  allowEmpty?: boolean;
}) {
  const [draft, setDraft] = useState(value);

  // 外部改了标题（撤销、切画布、另一处编辑）时同步回来。
  useEffect(() => setDraft(value), [value]);

  return (
    <Input
      data-annotation-title=""
      value={draft}
      placeholder={placeholder}
      aria-label={placeholder}
      className="h-6 min-w-0 flex-1 border-transparent bg-transparent px-1 text-xs"
      onChange={(event) => {
        setDraft(event.target.value);
        if (allowEmpty || event.target.value.trim() !== '') onCommit(event.target.value);
      }}
      onBlur={() => {
        if (!allowEmpty && draft.trim() === '') setDraft(value);
      }}
    />
  );
}
