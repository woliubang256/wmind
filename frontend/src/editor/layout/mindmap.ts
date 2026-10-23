import { walkSheet } from '../model/traverse';
/**
 * 结构布局：文档 + 主题 → 几何。
 *
 * 八种结构分成三族：
 *
 * - **横向树**（`mindmap` / `logic-right` / `logic-left` / `tree-right` / `brace`）：
 *   共用 `layoutHorizontal`，差别只在分侧与连线形状；
 * - **纵向树**（`org-chart`）：横向树的转置；
 * - **专用几何**（`timeline` / `fishbone` / `tree-table`）：主轴、鱼骨、表格，
 *   各有一套摆放规则，见文件后半部分。
 *
 * 算法不是 d3.tree 的 Reingold–Tilford 轮廓合并，而是更朴素的
 * 「每个子树占满一条带」：横向树按高度分带，纵向树按宽度分列。
 * 两者的差别是紧凑度——轮廓合并能让相邻子树的空隙互相嵌套，省 10%~20%；
 * 带式布局则永远不会重叠，也不会因为浮点误差出现「两个节点压在一起」。
 *
 * 选择带式布局的理由：它 O(n)、可预测、出错时是「空得多了点」而不是
 * 「重叠了」；后者在导图里是致命的，前者只是不够紧凑。
 */

import { resolveStyle, type StyleContext } from '../theme/resolve';
import { countDescendants } from '../model/traverse';
import type { ComputedStyle, ShapeClass, Sheet, StructureClass, Theme, Topic } from '../model/types';
import { defaultBackend, measureTopic } from './measure';
import { spacingFor, type LayoutSpacing } from './constants';
import type { EdgePath, EdgeShape, LayoutResult, NodeBox, Side, TopicSize } from './types';

/** 共用「一层一列」几何的结构。其余结构各有各的摆法。 */
const HORIZONTAL_STRUCTURES = new Set<StructureClass>([
  'mindmap',
  'logic-right',
  'logic-left',
  'tree-right',
  'brace',
]);

export type MeasureFn = (topic: Topic, style: ComputedStyle) => TopicSize;

export interface LayoutOptions {
  compact: boolean;
  /** 关闭后所有一级分支都排到右侧（对应 XMind 的「自动平衡」开关）。 */
  autoBalance: boolean;
  alignSiblings: boolean;
}

export interface LayoutInput {
  sheet: Sheet;
  theme: Theme;
  /** 测试可注入固定的测量函数，避免依赖字体度量。 */
  measure?: MeasureFn;
  options?: Partial<LayoutOptions>;
}

interface MeasuredNode {
  topic: Topic;
  style: ComputedStyle;
  size: TopicSize;
  depth: number;
  branchIndex: number;
  hiddenChildren: number;
  children: MeasuredNode[];
  /** 横向树里子树占的垂直高度；纵向树不用。 */
  subtreeHeight: number;
  /** 纵向树里子树占的水平宽度；横向树不用。 */
  subtreeWidth: number;
}

/** 布局过程中累积的输出。收在一个对象里，免得每个函数都带四个 Map 参数。 */
interface Out {
  boxes: Map<string, NodeBox>;
  sizes: Map<string, TopicSize>;
  styles: Map<string, ComputedStyle>;
  edges: EdgePath[];
}

interface Ctx {
  spacing: LayoutSpacing;
  structure: StructureClass;
  out: Out;
  /** 「同级对齐」开启时的列坐标；关闭或纵向树为 null。 */
  columns: Columns | null;
}

/**
 * 「同级主题对齐」的列坐标。
 *
 * 普通布局里，子节点的 x 是「父节点右边 + 间距」算出来的，于是同一层里宽度
 * 不同的父节点会把各自的子节点推到不同的列——看上去像随手撒的。对齐打开后
 * 每层预留该层最宽的节点，所有同层节点落在同一列。
 *
 * 代价是画布变宽：一层里只要有一个长标题，整层都按它的宽度留白。所以这是
 * 开关而不是默认。
 */
interface Columns {
  /** 右侧：每层节点的**左**边缘。 */
  right: Map<number, number>;
  /** 左侧：每层节点的**右**边缘。 */
  left: Map<number, number>;
}

function buildColumns(root: MeasuredNode, spacing: LayoutSpacing): Columns {
  const maxWidth = new Map<number, number>();
  let maxDepth = 0;
  const visit = (node: MeasuredNode): void => {
    maxWidth.set(node.depth, Math.max(maxWidth.get(node.depth) ?? 0, node.size.width));
    maxDepth = Math.max(maxDepth, node.depth);
    for (const child of node.children) visit(child);
  };
  visit(root);

  const right = new Map<number, number>([[1, root.size.width / 2 + spacing.levelGap]]);
  const left = new Map<number, number>([[1, -root.size.width / 2 - spacing.levelGap]]);
  for (let depth = 2; depth <= maxDepth; depth += 1) {
    const prevRight = right.get(depth - 1) ?? 0;
    const prevLeft = left.get(depth - 1) ?? 0;
    right.set(depth, prevRight + (maxWidth.get(depth - 1) ?? 0) + spacing.levelGap);
    left.set(depth, prevLeft - (maxWidth.get(depth - 1) ?? 0) - spacing.levelGap);
  }
  return { right, left };
}

export function layoutMindmap(input: LayoutInput): LayoutResult {
  const theme = input.sheet.themeOverride ?? input.theme;
  const titles = new Map<string, string>();
  if (!input.measure) walkSheet(input.sheet, (topic) => { titles.set(topic.id, topic.title); });
  const measure = input.measure ?? ((topic, style) => measureTopic(topic, style, defaultBackend(), titles.get(topic.href.slice(7))));
  const structure = input.sheet.structure;
  const spacing = spacingFor(input.options?.compact ?? theme.layout.compact);
  const autoBalance = input.options?.autoBalance ?? theme.layout.autoBalance;
  const alignSiblings = input.options?.alignSiblings ?? theme.layout.alignSiblings;

  const root = measureNode(input.sheet.rootTopic, theme, measure, {
    depth: 0,
    branchIndex: -1,
    isRoot: true,
    isFloating: false,
    isSummary: false,
  }, input.sheet.topicShape);

  const out: Out = { boxes: new Map(), sizes: new Map(), styles: new Map(), edges: [] };
  const ctx: Ctx = {
    spacing,
    structure,
    out,
    // 列对齐只对「一层一列」的横向树有意义；纵向树对齐的是行，其余三种
    // 结构有自己的摆放规则。
    columns: alignSiblings && HORIZONTAL_STRUCTURES.has(structure) ? buildColumns(root, spacing) : null,
  };

  switch (structure) {
    case 'org-chart':
      layoutVertical(root, ctx);
      break;
    case 'timeline':
      layoutTimeline(root, ctx);
      break;
    case 'fishbone':
      layoutFishbone(root, ctx);
      break;
    case 'tree-table':
      layoutTreeTable(root, ctx);
      break;
    default:
      layoutHorizontal(root, autoBalance, ctx);
  }

  placeFloating(input.sheet, theme, measure, ctx);

  return finalize(out, spacing.padding);
}

// ---------------------------------------------------------------------------
// 测量
// ---------------------------------------------------------------------------

function measureNode(
  topic: Topic,
  theme: Theme,
  measure: MeasureFn,
  ctx: StyleContext,
  shape?: ShapeClass,
): MeasuredNode {
  const resolved = resolveStyle(topic, ctx, theme);
  // 画布统一形状先于测量生效；不修改主题缓存及节点原有的显式样式。
  const style = shape === undefined || shape === resolved.shape ? resolved : { ...resolved, shape };
  const size = measure(topic, style);

  // 折叠节点不测量子树——这既是性能优化，也是语义：折叠的含义就是「别管里面」。
  const children: MeasuredNode[] = [];
  if (!topic.collapsed) {
    topic.children.attached.forEach((child, index) => {
      children.push(
        measureNode(child, theme, measure, {
          depth: ctx.depth + 1,
          branchIndex: ctx.depth === 0 ? index : ctx.branchIndex,
          isRoot: false,
          isFloating: false,
          isSummary: false,
        }, shape),
      );
    });
  }

  return {
    topic,
    style,
    size,
    depth: ctx.depth,
    branchIndex: ctx.branchIndex,
    hiddenChildren: topic.collapsed ? countDescendants(topic) : 0,
    children,
    subtreeHeight: 0,
    subtreeWidth: 0,
  };
}

/** 子树占据的垂直高度。叶子就是自身高度。 */
function subtreeHeightOf(node: MeasuredNode, siblingGap: number): number {
  if (node.children.length === 0) {
    node.subtreeHeight = node.size.height;
    return node.subtreeHeight;
  }
  let sum = 0;
  for (const child of node.children) {
    sum += subtreeHeightOf(child, siblingGap);
  }
  sum += siblingGap * (node.children.length - 1);
  node.subtreeHeight = Math.max(node.size.height, sum);
  return node.subtreeHeight;
}

function totalHeight(nodes: MeasuredNode[], siblingGap: number): number {
  if (nodes.length === 0) return 0;
  let sum = 0;
  for (const node of nodes) sum += node.subtreeHeight;
  return sum + siblingGap * (nodes.length - 1);
}

/** 子树占据的水平宽度。纵向树用它排兄弟。 */
function subtreeWidthOf(node: MeasuredNode, siblingGap: number): number {
  if (node.children.length === 0) {
    node.subtreeWidth = node.size.width;
    return node.subtreeWidth;
  }
  let sum = 0;
  for (const child of node.children) {
    sum += subtreeWidthOf(child, siblingGap);
  }
  sum += siblingGap * (node.children.length - 1);
  node.subtreeWidth = Math.max(node.size.width, sum);
  return node.subtreeWidth;
}

function totalWidth(nodes: MeasuredNode[], siblingGap: number): number {
  if (nodes.length === 0) return 0;
  let sum = 0;
  for (const node of nodes) sum += node.subtreeWidth;
  return sum + siblingGap * (nodes.length - 1);
}

// ---------------------------------------------------------------------------
// 横向树（mindmap / logic-* / tree-right）
// ---------------------------------------------------------------------------

interface Sides {
  left: MeasuredNode[];
  right: MeasuredNode[];
}

/**
 * 一级分支分侧。
 *
 * `logic-left` 全左，`logic-right` / `tree-right` 全右，`mindmap` 按**下标奇偶**
 * 交替（0、2、4… 在右）。
 *
 * docs/05 §4.4 写的是「按子树高度贪心分配以平衡两侧」。实现时改成了交替，
 * 原因是贪心在编辑过程中**不稳定**：改动一个节点的标题让它变宽变高，排序
 * 结果就变，整棵树的左右分布跟着翻边。实测里改一个二级节点的文字，四个
 * 一级分支全部换了边——用户会以为文档被改坏了。
 *
 * 交替分配的代价是极端情况下不平衡（第 0 个分支有 50 个子节点、其余各 1 个，
 * 右侧会很长）。但导图的一级分支通常规模相近，而且「位置稳定」比「高度均衡」
 * 更影响可用性。
 */
function splitSides(children: MeasuredNode[], autoBalance: boolean, structure: StructureClass): Sides {
  if (structure === 'logic-left') return { left: [...children], right: [] };
  if (structure === 'logic-right' || structure === 'tree-right' || structure === 'brace') {
    return { left: [], right: [...children] };
  }
  if (!autoBalance) return { left: [], right: [...children] };

  const left: MeasuredNode[] = [];
  const right: MeasuredNode[] = [];
  children.forEach((child, index) => {
    if (index % 2 === 0) right.push(child);
    else left.push(child);
  });
  return { left, right };
}

function layoutHorizontal(root: MeasuredNode, autoBalance: boolean, ctx: Ctx): void {
  const { siblingGap, levelGap } = ctx.spacing;

  // 先把所有子树高度算出来（用真实间距），再分配左右——分配算法依赖高度，
  // 用 gap=0 算出来的高度会系统性偏小，导致两侧明显不平衡。
  for (const child of root.children) subtreeHeightOf(child, siblingGap);

  const { left, right } = splitSides(root.children, autoBalance, ctx.structure);
  const rightTotal = totalHeight(right, siblingGap);
  const leftTotal = totalHeight(left, siblingGap);

  // 根节点的「带」就是它自己：子节点围绕它的中心线上下展开，
  // 而不是把根拉到一个巨大的带中间。
  root.subtreeHeight = root.size.height;

  const rootBox = placeNodeAt(root, -root.size.width / 2, -root.size.height / 2, 'none', ctx);

  placeSide(right, 'right', root.size.width / 2 + levelGap, -rightTotal / 2, rootBox, ctx);
  placeSide(left, 'left', -root.size.width / 2 - levelGap, -leftTotal / 2, rootBox, ctx);
}

function placeSide(
  nodes: MeasuredNode[],
  side: Side,
  anchorX: number,
  startTop: number,
  rootBox: NodeBox,
  ctx: Ctx,
): void {
  let cursor = startTop;
  for (const node of nodes) {
    placeSubtreeH(node, side, anchorX, cursor, ctx);

    // 根到一级分支的连线要单独补：根不经过 placeSubtree，否则它的「带」
    // 会被子节点撑大，根就不再位于中心。
    const childBox = ctx.out.boxes.get(node.topic.id);
    if (childBox) {
      ctx.out.edges.push(makeEdgeH(rootBox, childBox, node.style, side, ctx));
    }

    cursor += node.subtreeHeight + ctx.spacing.siblingGap;
  }
}

function placeSubtreeH(
  node: MeasuredNode,
  side: Side,
  anchorX: number,
  top: number,
  ctx: Ctx,
  useColumns = true,
): void {
  const { siblingGap, levelGap } = ctx.spacing;
  const columns = useColumns ? ctx.columns : null;
  // anchorX 是该层节点靠向根的那条边的 x 坐标。
  const naturalX = side === 'left' ? anchorX - node.size.width : anchorX;
  const x = columns
    ? side === 'left'
      ? (columns.left.get(node.depth) ?? naturalX) - node.size.width
      : (columns.right.get(node.depth) ?? naturalX)
    : naturalX;
  // 节点在自己的垂直带里居中：带高由子节点撑起来时，父节点落在中间，
  // 视觉上连线才不会全挤在一侧。
  const y = top + (node.subtreeHeight - node.size.height) / 2;
  const box = placeNodeAt(node, x, y, side, ctx);

  if (node.children.length === 0) return;

  const childAnchorX = side === 'left'
    ? x - levelGap
    : x + node.size.width + levelGap;

  // 子节点组在自己的带里居中。带宽由子节点撑起来时偏移为 0；
  // 带宽由父节点自身高度决定时（子树比父节点矮），子节点要落在中间，
  // 否则连线会全挤在父节点上半部分。
  const childrenTotal = totalHeight(node.children, siblingGap);
  let cursor = top + (node.subtreeHeight - childrenTotal) / 2;
  for (const child of node.children) {
    placeSubtreeH(child, side, childAnchorX, cursor, ctx, useColumns);

    const childBox = ctx.out.boxes.get(child.topic.id);
    if (childBox) ctx.out.edges.push(makeEdgeH(box, childBox, child.style, side, ctx));

    cursor += child.subtreeHeight + siblingGap;
  }
}

function makeEdgeH(parent: NodeBox, child: NodeBox, style: ComputedStyle, side: Side, ctx: Ctx): EdgePath {
  const fromY = parent.y + parent.height / 2;
  const toY = child.y + child.height / 2;
  return {
    id: `${parent.id}->${child.id}`,
    parentId: parent.id,
    childId: child.id,
    from: side === 'left' ? { x: parent.x, y: fromY } : { x: parent.x + parent.width, y: fromY },
    to: side === 'left' ? { x: child.x + child.width, y: toY } : { x: child.x, y: toY },
    orientation: 'h',
    // 连线的颜色取自子节点：分支色跟着分支走，而不是跟着父节点。
    lineStyle: edgeLineStyle(style, ctx),
    lineEnd: style.lineEnd,
    lineColor: style.lineColor,
    lineWidth: style.lineWidth,
  };
}

/**
 * `tree-right` 与 `logic-right` 的几何完全相同，差别只在连线样式（折线 vs 曲线）。
 *
 * 在布局层覆盖而不是让渲染层判断结构：渲染层只认识 `EdgePath`，让它去读
 * `sheet.structure` 就等于把「结构」这个概念漏进渲染层。
 */
function edgeLineStyle(style: ComputedStyle, ctx: Ctx): EdgeShape {
  if (ctx.structure === 'brace') return 'brace';
  if (ctx.structure === 'tree-right') return 'elbow';
  return style.lineStyle;
}

// ---------------------------------------------------------------------------
// 纵向树（org-chart）
// ---------------------------------------------------------------------------

function layoutVertical(root: MeasuredNode, ctx: Ctx): void {
  const { siblingGap } = ctx.spacing;
  subtreeWidthOf(root, siblingGap);
  // 根的水平中心放在 x = 0，整棵树随后由 finalize 平移到内边距处。
  placeSubtreeV(root, -root.subtreeWidth / 2, 0, 'none', ctx);
}

/**
 * 自上而下：父节点水平居中于「首尾子节点中心」的中点。
 *
 * 与横向树的结构对称——横向树是「每个子树占一条垂直带、父节点在带里垂直居中」，
 * 纵向树是「每个子树占一条水平带、父节点在带里水平居中」。
 *
 * 但父节点**不是**在带里居中，而是跟着子节点走（d3.tree 的规则）。两个理由：
 *
 * 1. 只有一个子节点时，父与子的中心对齐，连线是一条竖直的直线；按带居中的话
 *    会画出一条斜线，看起来像连错了。
 * 2. 兄弟子树的宽度常常相差很多（一个分支深、一个分支浅），按带居中会让父节点
 *    明显偏离自己的子节点群，视觉上像是挂到了隔壁分支。
 *
 * 因此必须**先排子节点、再定父节点**，这也决定了这个函数要返回 box（边要在
 * 父节点位置确定之后才能算）。
 */
function placeSubtreeV(node: MeasuredNode, left: number, top: number, side: Side, ctx: Ctx): NodeBox {
  const { siblingGap, levelGap } = ctx.spacing;

  if (node.children.length === 0) {
    const x = left + (node.subtreeWidth - node.size.width) / 2;
    return placeNodeAt(node, x, top, side, ctx);
  }

  const childrenTotal = totalWidth(node.children, siblingGap);
  let cursor = left + (node.subtreeWidth - childrenTotal) / 2;
  const childTop = top + node.size.height + levelGap;

  const childBoxes: NodeBox[] = [];
  for (const child of node.children) {
    childBoxes.push(placeSubtreeV(child, cursor, childTop, 'bottom', ctx));
    cursor += child.subtreeWidth + siblingGap;
  }

  const first = childBoxes[0]!;
  const last = childBoxes[childBoxes.length - 1]!;
  const centerX = (first.x + first.width / 2 + last.x + last.width / 2) / 2;
  const box = placeNodeAt(node, centerX - node.size.width / 2, top, side, ctx);

  for (const childBox of childBoxes) {
    const style = ctx.out.styles.get(childBox.id);
    if (style) ctx.out.edges.push(makeEdgeV(box, childBox, style, ctx));
  }
  return box;
}

function makeEdgeV(parent: NodeBox, child: NodeBox, style: ComputedStyle, ctx: Ctx): EdgePath {
  return {
    id: `${parent.id}->${child.id}`,
    parentId: parent.id,
    childId: child.id,
    from: { x: parent.x + parent.width / 2, y: parent.y + parent.height },
    to: { x: child.x + child.width / 2, y: child.y },
    orientation: 'v',
    lineStyle: edgeLineStyle(style, ctx),
    lineEnd: style.lineEnd,
    lineColor: style.lineColor,
    lineWidth: style.lineWidth,
  };
}

// ---------------------------------------------------------------------------
// 堆叠布局（timeline / fishbone 共用）
// ---------------------------------------------------------------------------

/**
 * 堆叠布局里子树占的高度。
 *
 * 与横向树的 `subtreeHeightOf` 不同：那里是 `max(自身, 子树和)`（父节点在带里
 * 居中，与子节点重叠是允许的），这里是 `自身 + 间距 + 子树和`——时间轴和鱼骨
 * 里后代是**往一个方向排出去**的，不能和父节点重叠。
 */
function stackHeightOf(node: MeasuredNode, gap: number): number {
  if (node.children.length === 0) return node.size.height;
  let sum = 0;
  for (const child of node.children) sum += stackHeightOf(child, gap);
  return node.size.height + gap + sum + gap * (node.children.length - 1);
}

/** 堆叠布局里子树占的宽度：每往下一层缩进一个 `levelGap`。 */
function stackWidthOf(node: MeasuredNode, levelGap: number): number {
  if (node.children.length === 0) return node.size.width;
  let widest = 0;
  for (const child of node.children) widest = Math.max(widest, stackWidthOf(child, levelGap));
  return Math.max(node.size.width, levelGap + widest);
}

interface StackOptions {
  /** 子节点相对父节点的水平方向。时间轴向右、鱼骨向左。 */
  dirX: 1 | -1;
  /** 同带间距（比兄弟间距更紧：堆叠时上下是一家人）。 */
  gap: number;
  /** 父子间距。 */
  levelGap: number;
  /** `tree` 走横线，`bone` 走斜线。 */
  edge: 'tree' | 'bone';
}

/**
 * 把一个子树按「带」堆叠下去。
 *
 * `dirY = 1` 表示后代向下排（节点落在带的顶部），`-1` 表示向上排（节点落在
 * 带的底部）——时间轴的上下两侧、鱼骨的上下两排都靠这个方向参数。
 */
function stackSubtree(
  node: MeasuredNode,
  x: number,
  bandTop: number,
  dirY: 1 | -1,
  opts: StackOptions,
  ctx: Ctx,
): NodeBox {
  const bandHeight = stackHeightOf(node, opts.gap);
  const y = dirY === 1 ? bandTop : bandTop + bandHeight - node.size.height;
  const box = placeNodeAt(node, x, y, 'bottom', ctx);
  if (node.children.length === 0) return box;

  let cursor = dirY === 1 ? y + node.size.height + opts.gap : y - opts.gap;
  for (const child of node.children) {
    const childHeight = stackHeightOf(child, opts.gap);
    const childTop = dirY === 1 ? cursor : cursor - childHeight;
    const childX = opts.dirX === 1
      ? x + opts.levelGap
      : x - opts.levelGap - stackWidthOf(child, opts.levelGap);
    const childBox = stackSubtree(child, childX, childTop, dirY, opts, ctx);
    const style = ctx.out.styles.get(childBox.id);
    if (style) {
      ctx.out.edges.push(
        opts.edge === 'tree'
          ? makeEdgeH(box, childBox, style, 'right', ctx)
          : makeBone(box, childBox, style),
      );
    }
    cursor = dirY === 1 ? cursor + childHeight + opts.gap : cursor - childHeight - opts.gap;
  }
  return box;
}

/** 鱼骨的斜线：从父节点中心拉到子节点中心，节点画在连线之上，视觉上就是一根骨。 */
function makeBone(parent: NodeBox, child: NodeBox, style: ComputedStyle): EdgePath {
  return {
    id: `${parent.id}->${child.id}`,
    parentId: parent.id,
    childId: child.id,
    from: { x: parent.x + parent.width / 2, y: parent.y + parent.height / 2 },
    to: { x: child.x + child.width / 2, y: child.y + child.height / 2 },
    orientation: 'h',
    lineStyle: 'straight',
    lineEnd: 'none',
    lineColor: style.lineColor,
    lineWidth: style.lineWidth,
  };
}

// ---------------------------------------------------------------------------
// 时间轴（timeline）
// ---------------------------------------------------------------------------

/**
 * 时间轴：根在左，一条水平主轴向右，一级分支上下交替，后代朝外侧堆叠。
 *
 * 主轴不是单独画的元素，而是所有 `axis` 连线的横段叠出来的：每条连线都是
 * 「从主轴高度横着走到节点的 x，再竖着落到节点上」。这样竖段天然成为刻度，
 * 也不需要渲染层认识「主轴」这个概念。
 */
function layoutTimeline(root: MeasuredNode, ctx: Ctx): void {
  const { siblingGap, levelGap } = ctx.spacing;
  const gap = siblingGap * 0.75;
  const spineY = 0;
  const rootBox = placeNodeAt(root, 0, -root.size.height / 2, 'none', ctx);
  const opts: StackOptions = { dirX: 1, gap, levelGap, edge: 'tree' };

  let cursorX = root.size.width + levelGap * 1.5;
  root.children.forEach((child, index) => {
    const below = index % 2 === 0;
    const bandHeight = stackHeightOf(child, gap);
    const bandWidth = stackWidthOf(child, levelGap);
    const offset = 36;
    const top = below ? spineY + offset : spineY - offset - bandHeight;

    const box = stackSubtree(child, cursorX, top, below ? 1 : -1, opts, ctx);
    const style = ctx.out.styles.get(box.id);
    if (style) {
      ctx.out.edges.push({
        id: `${rootBox.id}->${box.id}`,
        parentId: rootBox.id,
        childId: box.id,
        from: { x: rootBox.x + rootBox.width, y: spineY },
        to: { x: box.x + box.width / 2, y: below ? box.y : box.y + box.height },
        orientation: 'h',
        lineStyle: 'axis',
        lineEnd: 'none',
        lineColor: style.lineColor,
        lineWidth: style.lineWidth,
      });
    }
    cursorX += bandWidth + siblingGap * 1.5;
  });
}

// ---------------------------------------------------------------------------
// 鱼骨图（fishbone）
// ---------------------------------------------------------------------------

/**
 * 鱼骨：鱼头（根）在右，主轴向左，主骨上下交替斜插，支骨沿主骨向外排。
 *
 * 主轴同样不是独立元素：`spine:<rootId>` 是一条从鱼头左边缘拉到最远附着点的
 * 直线。它是**合成边**（`parentId` / `childId` 只是借位），`EdgePath` 本身不
 * 要求两端真有父子关系，渲染层只负责画。
 */
function layoutFishbone(root: MeasuredNode, ctx: Ctx): void {
  const { siblingGap, levelGap } = ctx.spacing;
  const gap = siblingGap * 0.75;
  const spineY = 0;
  const rootBox = placeNodeAt(root, 0, -root.size.height / 2, 'none', ctx);
  const opts: StackOptions = { dirX: -1, gap, levelGap, edge: 'bone' };

  let cursorX = -levelGap * 1.5;
  let furthest = cursorX;
  root.children.forEach((child, index) => {
    const above = index % 2 === 0;
    const bandHeight = stackHeightOf(child, gap);
    const bandWidth = stackWidthOf(child, levelGap);
    const attachX = cursorX;
    const offset = 40;
    const top = above ? spineY - offset - bandHeight : spineY + offset;

    const box = stackSubtree(child, cursorX - bandWidth, top, above ? -1 : 1, opts, ctx);
    const style = ctx.out.styles.get(box.id);
    if (style) {
      ctx.out.edges.push({
        id: `${rootBox.id}->${box.id}`,
        parentId: rootBox.id,
        childId: box.id,
        from: { x: attachX, y: spineY },
        to: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        orientation: 'h',
        lineStyle: 'straight',
        lineEnd: 'none',
        lineColor: style.lineColor,
        lineWidth: style.lineWidth,
      });
    }
    furthest = Math.min(furthest, cursorX - bandWidth);
    cursorX -= bandWidth + siblingGap * 1.5;
  });

  // 主轴：从鱼头左边缘拉到最远的附着点。
  const last = root.children[root.children.length - 1];
  const rootStyle = ctx.out.styles.get(rootBox.id);
  if (last && rootStyle) {
    ctx.out.edges.push({
      id: `spine:${rootBox.id}`,
      parentId: rootBox.id,
      childId: last.topic.id,
      from: { x: rootBox.x, y: spineY },
      to: { x: furthest, y: spineY },
      orientation: 'h',
      lineStyle: 'straight',
      lineEnd: 'none',
      lineColor: rootStyle.lineColor,
      lineWidth: rootStyle.lineWidth,
    });
  }
}

// ---------------------------------------------------------------------------
// 树型表格（tree-table）
// ---------------------------------------------------------------------------

/**
 * 树型表格：一层一列、一叶一行，父节点居中于首末子节点之间。
 *
 * 行高取**所有节点的最大高度**再加一点间距。按每个叶子自己的高度排行会紧凑
 * 一些，但父节点可能比它那一行还高，于是压到上一行去——表格里出现重叠比
 * 浪费几像素难看得多。
 */
function layoutTreeTable(root: MeasuredNode, ctx: Ctx): void {
  const { siblingGap, levelGap } = ctx.spacing;

  const maxWidth = new Map<number, number>();
  let maxHeight = 0;
  let maxDepth = 0;
  const walk = (node: MeasuredNode): void => {
    maxWidth.set(node.depth, Math.max(maxWidth.get(node.depth) ?? 0, node.size.width));
    maxHeight = Math.max(maxHeight, node.size.height);
    maxDepth = Math.max(maxDepth, node.depth);
    for (const child of node.children) walk(child);
  };
  walk(root);

  const colX = new Map<number, number>([[0, 0]]);
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    colX.set(depth, (colX.get(depth - 1) ?? 0) + (maxWidth.get(depth - 1) ?? 0) + levelGap);
  }

  const rowPitch = maxHeight + siblingGap * 0.6;
  let row = 0;

  const place = (node: MeasuredNode): number => {
    const x = colX.get(node.depth) ?? 0;
    if (node.children.length === 0) {
      const centerY = row * rowPitch;
      row += 1;
      placeNodeAt(node, x, centerY - node.size.height / 2, 'right', ctx);
      return centerY;
    }

    const centers = node.children.map(place);
    const centerY = (centers[0]! + centers[centers.length - 1]!) / 2;
    const box = placeNodeAt(node, x, centerY - node.size.height / 2, 'right', ctx);
    for (const child of node.children) {
      const childBox = ctx.out.boxes.get(child.topic.id);
      const style = childBox ? ctx.out.styles.get(childBox.id) : undefined;
      if (!childBox || !style) continue;
      // 表格的连线一律折线：横向到层间空隙、竖直对齐、再横向进子节点。
      ctx.out.edges.push({ ...makeEdgeH(box, childBox, style, 'right', ctx), lineStyle: 'elbow' });
    }
    return centerY;
  };

  place(root);
}

// ---------------------------------------------------------------------------
// 摆放
// ---------------------------------------------------------------------------

function placeNodeAt(node: MeasuredNode, x: number, y: number, side: Side, ctx: Ctx): NodeBox {
  const box: NodeBox = {
    id: node.topic.id,
    x,
    y,
    width: node.size.width,
    height: node.size.height,
    depth: node.depth,
    branchIndex: node.branchIndex,
    side,
    collapsed: node.topic.collapsed,
    childCount: node.topic.children.attached.length,
    hiddenChildren: node.hiddenChildren,
  };
  ctx.out.boxes.set(box.id, box);
  ctx.out.sizes.set(box.id, node.size);
  ctx.out.styles.set(box.id, node.style);
  return box;
}

// ---------------------------------------------------------------------------
// 自由主题
// ---------------------------------------------------------------------------

/**
 * 自由主题排在整棵树的下方，按文档顺序纵向排列（横向展开）。
 *
 * 文档模型里自由主题没有坐标（见 docs/03 §2.2：`floatingTopics` 只是数组），
 * 所以「用户拖到哪里就停在哪里」需要额外的位置字段。在那之前用确定性排布：
 * 至少它们可见、可编辑、可被拖回树上。
 *
 * 无论主结构是横向还是纵向，自由主题都按横向排列——它们是脱离结构的东西，
 * 混进纵向树里反而更乱。
 */
function placeFloating(sheet: Sheet, theme: Theme, measure: MeasureFn, ctx: Ctx): void {
  if (sheet.floatingTopics.length === 0) return;
  const { siblingGap } = ctx.spacing;

  let minX = Infinity;
  let maxY = -Infinity;
  for (const box of ctx.out.boxes.values()) {
    if (box.x < minX) minX = box.x;
    if (box.y + box.height > maxY) maxY = box.y + box.height;
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxY = 0;
  }

  let cursor = maxY + siblingGap * 2;
  for (const floating of sheet.floatingTopics) {
    const measured = measureNode(floating, theme, measure, {
      depth: 1,
      branchIndex: -1,
      isRoot: false,
      isFloating: true,
      isSummary: false,
    }, sheet.topicShape);
    subtreeHeightOf(measured, siblingGap);
    // 自由主题不参与列对齐：它们的起点是整棵树的左边界，套用主树的列坐标
    // 会被拽到树中间去。
    placeSubtreeH(measured, 'right', minX, cursor, ctx, false);
    cursor += measured.subtreeHeight + siblingGap;
  }
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

/** 把所有坐标平移到「内容左上角 = (padding, padding)」，并算出包围盒。 */
function finalize(out: Out, padding: number): LayoutResult {
  const { boxes, sizes, styles, edges } = out;

  if (boxes.size === 0) {
    return {
      boxes,
      edges,
      sizes,
      styles,
      bounds: { x: 0, y: 0, width: padding * 2, height: padding * 2 },
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes.values()) {
    if (box.x < minX) minX = box.x;
    if (box.y < minY) minY = box.y;
    if (box.x + box.width > maxX) maxX = box.x + box.width;
    if (box.y + box.height > maxY) maxY = box.y + box.height;
  }

  const dx = padding - minX;
  const dy = padding - minY;

  if (dx !== 0 || dy !== 0) {
    for (const box of boxes.values()) {
      box.x += dx;
      box.y += dy;
    }
    for (const edge of edges) {
      edge.from.x += dx;
      edge.from.y += dy;
      edge.to.x += dx;
      edge.to.y += dy;
    }
  }

  return {
    boxes,
    edges,
    sizes,
    styles,
    bounds: {
      x: 0,
      y: 0,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    },
  };
}
