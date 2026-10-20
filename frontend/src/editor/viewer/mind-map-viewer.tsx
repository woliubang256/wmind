/**
 * `MindMapViewer`：几何 + 样式 → SVG。
 *
 * 这个组件**不含任何交互逻辑**。平移缩放、选中、编辑、拖拽全部是插件
 * （见 viewer-types.ts）。只读分享页只要不传那些插件，页面上就不存在
 * 编辑能力——不是藏起来，是根本没有。
 *
 * 分层顺序（从下到上）：
 *
 *   边界 → 父子连线 → 关系线 → 主题 → 插件 overlay
 *
 * 边界在最下是因为它是一块底色；关系线在父子连线之上是因为它通常是
 * 跨分支的细线，被密集的分支线盖住就看不见了。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { layoutMindmap } from '../layout/mindmap';
import type { LayoutResult, NodeBox } from '../layout/types';
import type { ComputedStyle, Sheet, Theme } from '../model/types';
import { fontStack } from '../theme/fonts';
import { ViewerContext } from './viewer-context';
import type { CommitTitleOptions, ViewerContextValue, ViewerPlugin, Viewport } from './viewer-types';
import { EdgesLayer, TopicsLayer } from './layers';
import { BoundariesLayer, RelationshipsLayer } from './decorations';

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

export interface MindMapViewerProps {
  sheet: Sheet;
  theme: Theme;
  /** 已经算好的布局；不传则内部按 `mindmap` 结构计算。 */
  layout?: LayoutResult;
  plugins?: ViewerPlugin[];
  readOnly?: boolean;
  selection?: ReadonlySet<string>;
  editingId?: string | null;
  onSelectionChange?(ids: string[]): void;
  onToggleCollapse?(id: string): void;
  onBeginEdit?(id: string): void;
  onCommitTitle?(id: string, title: string, options?: CommitTitleOptions): void;
  onCancelEdit?(): void;
  onMoveTopics?(ids: string[], parentId: string, index?: number): void;
  onDetachTopics?(ids: string[]): void;
  /** 受控视口。传了它就由外部持有，内部不再维护状态。 */
  viewport?: Viewport;
  initialViewport?: Viewport;
  onViewportChange?(viewport: Viewport): void;
  className?: string;
  ariaLabel?: string;
}

export function MindMapViewer({
  sheet,
  theme,
  layout: providedLayout,
  plugins,
  readOnly = false,
  selection = EMPTY_SELECTION,
  editingId = null,
  onSelectionChange,
  onToggleCollapse,
  onBeginEdit,
  onCommitTitle,
  onCancelEdit,
  onMoveTopics,
  onDetachTopics,
  viewport: controlledViewport,
  initialViewport,
  onViewportChange,
  className,
  ariaLabel,
}: MindMapViewerProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [innerViewport, setInnerViewport] = useState<Viewport>(
    initialViewport ?? { x: 0, y: 0, zoom: 1 },
  );

  // 受控 / 非受控两用：工具栏要「缩放到适应」就必须能读能写视口，
  // 所以页面可以接管；分享页不需要工具栏，就不传，内部自己管。
  const viewport = controlledViewport ?? innerViewport;

  const setViewport = useCallback<ViewerContextValue['setViewport']>(
    (next) => {
      const value = typeof next === 'function' ? next(viewport) : next;
      if (!controlledViewport) setInnerViewport(value);
      onViewportChange?.(value);
    },
    [controlledViewport, viewport, onViewportChange],
  );

  const layout = useMemo(
    () => providedLayout ?? layoutMindmap({ sheet, theme }),
    [providedLayout, sheet, theme],
  );

  const effectiveTheme = sheet.themeOverride ?? theme;

  const toWorld = useCallback<ViewerContextValue['toWorld']>(
    (clientX, clientY) => {
      const rect = svgRef.current?.getBoundingClientRect();
      const left = rect?.left ?? 0;
      const top = rect?.top ?? 0;
      return {
        x: (clientX - left - viewport.x) / viewport.zoom,
        y: (clientY - top - viewport.y) / viewport.zoom,
      };
    },
    [viewport],
  );

  const visibleBounds = useCallback(() => {
    const rect = svgRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 0;
    const height = rect?.height ?? 0;
    return {
      x: -viewport.x / viewport.zoom,
      y: -viewport.y / viewport.zoom,
      width: width / viewport.zoom,
      height: height / viewport.zoom,
    };
  }, [viewport]);

  const setSelection = useCallback(
    (ids: string[]) => onSelectionChange?.(ids),
    [onSelectionChange],
  );

  const toggleSelection = useCallback(
    (id: string) => {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onSelectionChange?.([...next]);
    },
    [selection, onSelectionChange],
  );

  const toggleCollapse = useCallback(
    (id: string) => onToggleCollapse?.(id),
    [onToggleCollapse],
  );

  const beginEdit = useCallback(
    (id: string) => onBeginEdit?.(id),
    [onBeginEdit],
  );

  const cancelEdit = useCallback(() => onCancelEdit?.(), [onCancelEdit]);
  const commitTitle = useCallback(
    (id: string, title: string, options?: CommitTitleOptions) =>
      onCommitTitle?.(id, title, options),
    [onCommitTitle],
  );

  const moveTopics = useCallback(
    (ids: string[], parentId: string, index?: number) => onMoveTopics?.(ids, parentId, index),
    [onMoveTopics],
  );

  const detachTopics = useCallback(
    (ids: string[]) => onDetachTopics?.(ids),
    [onDetachTopics],
  );

  const context = useMemo<ViewerContextValue>(
    () => ({
      layout,
      sheet,
      theme: effectiveTheme,
      svgRef,
      viewport,
      setViewport,
      toWorld,
      visibleBounds,
      readOnly,
      selection,
      setSelection,
      toggleSelection,
      toggleCollapse,
      editingId,
      beginEdit,
      cancelEdit,
      commitTitle,
      moveTopics,
      detachTopics,
    }),
    [
      layout,
      sheet,
      effectiveTheme,
      viewport,
      setViewport,
      toWorld,
      visibleBounds,
      readOnly,
      selection,
      setSelection,
      toggleSelection,
      toggleCollapse,
      editingId,
      beginEdit,
      cancelEdit,
      commitTitle,
      moveTopics,
      detachTopics,
    ],
  );

  const editingBox = editingId ? layout.boxes.get(editingId) : undefined;
  const editingStyle = editingId ? layout.styles.get(editingId) : undefined;
  const editingSize = editingId ? layout.sizes.get(editingId) : undefined;

  return (
    <ViewerContext.Provider value={context}>
      <div
        className={cn('relative h-full w-full overflow-hidden', className)}
        style={{ backgroundColor: effectiveTheme.palette.backgroundColor }}
      >
        <svg
          ref={svgRef}
          className="block h-full w-full touch-none select-none"
          role={readOnly ? 'img' : 'application'}
          aria-label={ariaLabel ?? sheet.title}
          data-read-only={readOnly ? 'true' : 'false'}
        >
          <g
            className="viewport"
            transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}
          >
            <BoundariesLayer sheet={sheet} layout={layout} theme={effectiveTheme} />

            <EdgesLayer edges={layout.edges} />

            <RelationshipsLayer sheet={sheet} layout={layout} theme={effectiveTheme} />

            <TopicsLayer
              layout={layout}
              selection={selection}
              editingId={editingId}
            />

            <g className="layer-overlay">
              {(plugins ?? []).map((plugin) =>
                plugin.Overlay ? <plugin.Overlay key={plugin.key} /> : null,
              )}
            </g>
          </g>
        </svg>

        {!readOnly && editingBox && editingStyle && onCommitTitle ? (
          <EditingOverlay
            key={editingBox.id}
            box={editingBox}
            style={editingStyle}
            textHeight={editingSize ? editingSize.lines.length * Math.round(editingStyle.fontSize * 1.4) : editingBox.height}
            viewport={viewport}
            initialValue={findTitle(sheet, editingBox.id)}
            onCommit={(value, options) => commitTitle(editingBox.id, value, options)}
            onCancel={cancelEdit}
          />
        ) : null}
      </div>
    </ViewerContext.Provider>
  );
}

function findTitle(sheet: Sheet, id: string): string {
  const stack = [sheet.rootTopic, ...sheet.floatingTopics];
  while (stack.length > 0) {
    const topic = stack.pop();
    if (!topic) continue;
    if (topic.id === id) return topic.title;
    stack.push(...topic.children.attached, ...topic.children.detached);
  }
  return '';
}

interface EditingOverlayProps {
  box: NodeBox;
  style: ComputedStyle;
  /**
   * 文本块的世界高度（不含图片）。
   *
   * 带图片的节点，盒子高度里有一大半是图。输入框若照着盒子高度画，双击一个
   * 带大图的节点就会弹出一块把图整个盖住的白框。只覆盖文本那一段更符合直觉。
   */
  textHeight: number;
  viewport: Viewport;
  initialValue: string;
  onCommit(value: string, options?: CommitTitleOptions): void;
  onCancel(): void;
}

/**
 * 编辑态输入框。
 *
 * 用绝对定位的 `<textarea>` 叠在 SVG 上，而不是 `<foreignObject>`：
 * Safari 对 `foreignObject` 里的表单控件有已知的焦点与输入法问题
 * （docs/05 §4.3 的风险表里也记了这一条）。
 *
 * 位置按当前 viewport 换算成屏幕坐标——所以缩放、平移时输入框会跟着走。
 */
function EditingOverlay({ box, style, textHeight, viewport, initialValue, onCommit, onCancel }: EditingOverlayProps) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const settle = (commit: boolean, options?: CommitTitleOptions) => {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(value, options);
    else onCancel();
  };

  const zoom = viewport.zoom;
  const lineHeight = Math.round(style.fontSize * 1.4);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => settle(true)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          settle(false);
          return;
        }
        // Enter 提交、Shift+Enter 换行：与 XMind 一致，也与「主题内换行」的
        // 直觉一致——用户想换行时会按住 Shift。
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          settle(true, { restoreFocus: true });
          return;
        }
        // Tab 在编辑态 = 「落字并在当前节点下新建子主题」。不吞掉的话
        // 浏览器会把焦点移走，输入框失焦又触发一次提交，等于白按。
        if (event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          settle(true, { addChild: !event.shiftKey, restoreFocus: true });
        }
      }}
      spellCheck={false}
      className="absolute m-0 resize-none overflow-hidden rounded-md border-2 bg-white p-0 outline-none"
      style={{
        left: viewport.x + box.x * zoom,
        top: viewport.y + box.y * zoom,
        width: box.width * zoom,
        height: Math.max(textHeight * zoom + 16, lineHeight * zoom + 16),
        padding: `${8 * zoom}px ${12 * zoom}px`,
        fontFamily: fontStack(style.fontFamily),
        fontSize: style.fontSize * zoom,
        fontWeight: style.fontWeight,
        lineHeight: `${lineHeight * zoom}px`,
        textAlign: style.textAlign,
        color: style.textColor,
        borderColor: 'var(--wmind-selection, #1E88E5)',
      }}
    />
  );
}
