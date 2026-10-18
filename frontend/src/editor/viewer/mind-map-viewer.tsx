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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { layoutMindmap } from '../layout/mindmap';
import type { EdgePath, LayoutResult, NodeBox } from '../layout/types';
import type { ComputedStyle, Sheet, Theme } from '../model/types';
import { fontStack } from '../theme/fonts';
import { ViewerContext } from './viewer-context';
import type { ViewerContextValue, ViewerPlugin, Viewport } from './viewer-types';
import { TopicNode } from './topic-node';
import { EdgeLine } from './edges';
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
  onCommitTitle?(id: string, title: string): void;
  onCancelEdit?(): void;
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
    (id: string, title: string) => onCommitTitle?.(id, title),
    [onCommitTitle],
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
    ],
  );

  const editingBox = editingId ? layout.boxes.get(editingId) : undefined;
  const editingStyle = editingId ? layout.styles.get(editingId) : undefined;

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
            viewport={viewport}
            initialValue={findTitle(sheet, editingBox.id)}
            onCommit={(value) => commitTitle(editingBox.id, value)}
            onCancel={cancelEdit}
          />
        ) : null}
      </div>
    </ViewerContext.Provider>
  );
}

/**
 * 连线层与主题层都做了记忆化。
 *
 * 原因：平移缩放只改 `<g transform>` 一个属性，但如果这两层写在主组件里，
 * 每次 viewport 变化都会重新创建 2000 个 React 元素，React 要把它们逐个
 * diff 一遍——实测 2000 节点时一次滚轮要 300ms，完全不可用。
 *
 * 记忆化之后，viewport 变化只重渲染外层与插件，两层元素数组原样复用，
 * React 直接跳过它们的子树。
 */
const EdgesLayer = memo(function EdgesLayer({ edges }: { edges: EdgePath[] }) {
  return (
    <g className="layer-edges">
      {edges.map((edge) => (
        <EdgeLine key={edge.id} edge={edge} />
      ))}
    </g>
  );
});

interface TopicsLayerProps {
  layout: LayoutResult;
  selection: ReadonlySet<string>;
  editingId: string | null;
}

const TopicsLayer = memo(function TopicsLayer({ layout, selection, editingId }: TopicsLayerProps) {
  return (
    <g className="layer-topics">
      {[...layout.boxes.values()].map((box) => (
        <TopicNode
          key={box.id}
          box={box}
          style={layout.styles.get(box.id) ?? fallbackStyle(box)}
          lines={layout.sizes.get(box.id)?.lines ?? ['']}
          selected={selection.has(box.id)}
          editing={editingId === box.id}
        />
      ))}
    </g>
  );
});

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

/** 理论上每个盒子都有样式；万一没有，用一份中性样式兜底而不是崩溃。 */
function fallbackStyle(box: NodeBox): ComputedStyle {
  return {
    shape: 'rounded-rect',
    fill: '#FFFFFF',
    fillPattern: 'solid',
    borderColor: '#BDBDBD',
    borderWidth: 1,
    borderStyle: 'solid',
    fontFamily: 'sans',
    fontSize: 14,
    fontWeight: 400,
    fontStyle: 'normal',
    textDecoration: 'none',
    textColor: '#333333',
    textAlign: 'center',
    width: box.width,
    autoWidth: true,
    lineStyle: 'curve',
    lineEnd: 'none',
    lineWidth: 2,
    lineColor: '#BDBDBD',
    rainbowBranch: false,
    backgroundColor: null,
  };
}

interface EditingOverlayProps {
  box: NodeBox;
  style: ComputedStyle;
  viewport: Viewport;
  initialValue: string;
  onCommit(value: string): void;
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
function EditingOverlay({ box, style, viewport, initialValue, onCommit, onCancel }: EditingOverlayProps) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const settle = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(value);
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
          settle(true);
        }
      }}
      spellCheck={false}
      className="absolute m-0 resize-none overflow-hidden rounded-md border-2 bg-white p-0 outline-none"
      style={{
        left: viewport.x + box.x * zoom,
        top: viewport.y + box.y * zoom,
        width: box.width * zoom,
        height: Math.max(box.height * zoom, lineHeight * zoom + 16),
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
