/**
 * `MindMapViewer`：几何 + 样式 → SVG。
 *
 * 这个组件**不含任何交互逻辑**。平移缩放、选中、编辑、拖拽全部是插件
 * （见 viewer-types.ts）。只读分享页只要不传那些插件，页面上就不存在
 * 编辑能力——不是藏起来，是根本没有。
 *
 * 分层顺序（从下到上）：
 *
 *   边界 → 父子连线 → 关系线 → 概要 → 主题 → 插件 overlay
 *
 * 边界在最下是因为它是一块底色；关系线在父子连线之上是因为它通常是
 * 跨分支的细线，被密集的分支线盖住就看不见了。概要在主题之前、关系线之后：
 * 概要节点挂在范围的右侧，正常情况下不与主题重叠，但它的括号横臂会伸进
 * 兄弟节点之间的空隙，画在主题之前才不会被节点挡住起点。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { layoutMindmap } from '../layout/mindmap';
import { layoutAnnotations } from '../layout/annotations';
import type { LayoutResult, NodeBox, Rect } from '../layout/types';
import type { ComputedStyle, Sheet, Theme } from '../model/types';
import { walkSheet } from '../model/traverse';
import { fontStack } from '../theme/fonts';
import { ViewerContext } from './viewer-context';
import type { CommitTitleOptions, ViewerContextValue, ViewerPlugin, Viewport } from './viewer-types';
import { EdgesLayer, TopicsLayer } from './layers';
import { BoundariesLayer, RelationshipsLayer, SummariesLayer } from './decorations';
import { CULL_THRESHOLD } from './cull';

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
  /**
   * 当前选中的附属结构 id（概要 / 边界 / 关系线）。
   *
   * 与 `selection`（主题）分开：主题的选中会驱动树形导航与键盘焦点，
   * 附属结构只是「面板里正在编辑哪一条」，混进同一个数组会让方向键在
   * 主题之间移动时撞上一个不存在的节点。
   */
  selectedAnnotationId?: string | null;
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
  selectedAnnotationId = null,
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

  /*
    附属结构（概要 / 边界 / 关系线）的几何。

    依赖 layout 与 effectiveTheme：主题换了配色，边界与概要的颜色跟着变，
    但位置不变——重算一次是 O(附属结构数量)，与节点数无关。
  */
  const annotations = useMemo(
    () => layoutAnnotations(sheet, layout, effectiveTheme),
    [sheet, layout, effectiveTheme],
  );

  /*
    读屏标签用的 `id → 原始标题` 表。

    必须用原始标题而不是 `layout.sizes` 里的 `lines`：后者是按盒子宽度折过行
    的，拿它当 `aria-label` 会读出「分支\nA」——读屏把换行当停顿，名字听起来
    像两截。这张表只在 `sheet` 变化时重建，一次 O(n) 遍历。
  */
  const titles = useMemo(() => {
    const map = new Map<string, string>();
    walkSheet(sheet, (topic) => {
      map.set(topic.id, topic.title);
    });
    return map;
  }, [sheet]);

  /*
    视口裁剪用的容器尺寸。

    必须用 ResizeObserver 量一次存进 state，而不是渲染时读
    `getBoundingClientRect()`：后者在渲染期读布局会让 React 报「render 期间读
    布局属性」的告警，而且量到的还是上一帧的尺寸。只在尺寸变化时更新，
    平移缩放不会触发这里。
  */
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return undefined;
    const apply = (width: number, height: number) => {
      setCanvasSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) apply(rect.width, rect.height);
    });
    observer.observe(element);
    const rect = element.getBoundingClientRect();
    apply(rect.width, rect.height);
    return () => observer.disconnect();
  }, []);

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

  /*
    裁剪矩形（世界坐标）。`null` 表示不裁剪：小图不裁剪更快（多一次全量遍历
    反而亏），导出也不该裁剪。
  */
  const cullRect = useMemo<Rect | null>(() => {
    if (layout.boxes.size <= CULL_THRESHOLD) return null;
    if (canvasSize.width <= 0 || canvasSize.height <= 0) return null;
    return {
      x: -viewport.x / viewport.zoom,
      y: -viewport.y / viewport.zoom,
      width: canvasSize.width / viewport.zoom,
      height: canvasSize.height / viewport.zoom,
    };
  }, [layout.boxes.size, canvasSize, viewport]);

  /*
    选中的与被编辑的节点永远渲染，哪怕在视口外：`aria-activedescendant` 指向
    一个不存在的 id 时读屏会静默失声，而且键盘把选区移出视口之后，元素一旦被
    裁掉就再没有任何痕迹。
  */
  const keep = useMemo<ReadonlySet<string>>(() => {
    if (selection.size === 0 && editingId === null) return EMPTY_SELECTION;
    const set = new Set(selection);
    if (editingId !== null) set.add(editingId);
    return set;
  }, [selection, editingId]);

  return (
    <ViewerContext.Provider value={context}>
      <div
        className={cn('relative h-full w-full overflow-hidden', className)}
        style={{ backgroundColor: effectiveTheme.palette.backgroundColor }}
      >
        <svg
          ref={svgRef}
          className="block h-full w-full touch-none select-none"
          /*
            只读态：整张图是一个 `img`，名字由页面给。
            编辑态：`role="none"`——树的角色由外层那个可聚焦容器声明（见
            editor-page），这里让出角色，避免 SVG 默认的 `graphics-document`
            在树与 treeitem 之间插进一个没有意义的中间节点。子元素的
            `treeitem` 不受影响：`role="none"` 只移除元素自身。
          */
          role={readOnly ? 'img' : 'none'}
          aria-label={readOnly ? (ariaLabel ?? sheet.title) : undefined}
          data-read-only={readOnly ? 'true' : 'false'}
        >
          <g
            className="viewport"
            transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}
          >
            <BoundariesLayer annotations={annotations} selectedId={selectedAnnotationId} />

            <EdgesLayer edges={layout.edges} cullRect={cullRect} />

            <RelationshipsLayer annotations={annotations} selectedId={selectedAnnotationId} />

            <SummariesLayer annotations={annotations} selectedId={selectedAnnotationId} />

            <TopicsLayer
              layout={layout}
              selection={selection}
              editingId={editingId}
              titles={titles}
              treeItems={!readOnly}
              cullRect={cullRect}
              keep={keep}
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
