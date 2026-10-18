/**
 * `mindmap` 结构布局：根在中间，一级子节点按子树高度均衡分到左右两侧。
 *
 * 算法不是 d3.tree 的 Reingold–Tilford 轮廓合并，而是更朴素的
 * 「每个子树占满一条垂直带」：子树高度 = max(自身高度, 子节点高度之和 + 间距)。
 * 两者的差别是紧凑度——轮廓合并能让相邻子树的空隙互相嵌套，省 10%~20% 高度；
 * 带式布局则永远不会重叠，也不会因为浮点误差出现「两个节点压在一起」。
 *
 * 选择带式布局的理由：它 O(n)、可预测、出错时是「空得多了点」而不是
 * 「重叠了」；后者在导图里是致命的，前者只是不够紧凑。等 M3 有真实数据
 * 对比再考虑换成轮廓合并。
 *
 * 左右分配用贪心：按子树高度从大到小，依次放到当前较矮的一侧。
 * 这不是最优划分（那是 NP-hard 的装箱问题），但胜在稳定——同一份文档
 * 每次打开都分到同一侧，用户不会看到「上次在左边这次跑右边」。
 */

import { resolveStyle, type StyleContext } from '../theme/resolve';
import { countDescendants } from '../model/traverse';
import type { ComputedStyle, Sheet, Theme, Topic } from '../model/types';
import { measureTopic } from './measure';
import { spacingFor } from './constants';
import type { EdgePath, LayoutResult, NodeBox, Side, TopicSize } from './types';

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
  subtreeHeight: number;
}

export function layoutMindmap(input: LayoutInput): LayoutResult {
  const theme = input.sheet.themeOverride ?? input.theme;
  const measure = input.measure ?? ((topic, style) => measureTopic(topic, style));
  const spacing = spacingFor(input.options?.compact ?? theme.layout.compact);
  const autoBalance = input.options?.autoBalance ?? theme.layout.autoBalance;

  const root = measureNode(input.sheet.rootTopic, theme, measure, {
    depth: 0,
    branchIndex: -1,
    isRoot: true,
    isFloating: false,
    isSummary: false,
  });

  const boxes = new Map<string, NodeBox>();
  const sizes = new Map<string, TopicSize>();
  const styles = new Map<string, ComputedStyle>();
  const edges: EdgePath[] = [];

  // 先把所有子树高度算出来（用真实间距），再分配左右——分配算法依赖高度，
  // 用 gap=0 算出来的高度会系统性偏小，导致两侧明显不平衡。
  for (const child of root.children) subtreeHeightOf(child, spacing.siblingGap);

  const { left, right } = splitSides(root.children, autoBalance);
  const rightTotal = totalHeight(right, spacing.siblingGap);
  const leftTotal = totalHeight(left, spacing.siblingGap);

  // 根节点的「带」就是它自己：子节点围绕它的中心线上下展开，
  // 而不是把根拉到一个巨大的带中间。
  root.subtreeHeight = root.size.height;

  const rootX = -root.size.width / 2;
  const rootY = -root.size.height / 2;
  const rootBox = place(root, rootX, rootY, 'none', boxes, sizes, styles);

  placeSide(right, 'right', root.size.width / 2 + spacing.levelGap, -rightTotal / 2, spacing, rootBox, boxes, sizes, styles, edges);
  placeSide(left, 'left', -root.size.width / 2 - spacing.levelGap, -leftTotal / 2, spacing, rootBox, boxes, sizes, styles, edges);

  placeFloating(input.sheet, theme, measure, spacing, boxes, sizes, styles, edges);

  return finalize(boxes, sizes, styles, edges, spacing.padding);
}

// ---------------------------------------------------------------------------
// 测量
// ---------------------------------------------------------------------------

function measureNode(
  topic: Topic,
  theme: Theme,
  measure: MeasureFn,
  ctx: StyleContext,
): MeasuredNode {
  const style = resolveStyle(topic, ctx, theme);
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
        }),
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
    subtreeHeight: 0, // 下面统一算
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

// ---------------------------------------------------------------------------
// 左右分配
// ---------------------------------------------------------------------------

interface Sides {
  left: MeasuredNode[];
  right: MeasuredNode[];
}

/**
 * 按**下标奇偶**交替分侧：0、2、4… 在右，1、3、5… 在左。
 *
 * docs/05 §4.4 写的是「按子树高度贪心分配以平衡两侧」。实现时改成了交替，
 * 原因是贪心在编辑过程中**不稳定**：改动一个节点的标题让它变宽变高，
 * 排序结果就变，整棵树的左右分布跟着翻边。实测里改一个二级节点的文字，
 * 四个一级分支全部换了边——用户会以为文档被改坏了。
 *
 * 交替分配的代价是极端情况下不平衡（比如第 0 个分支有 50 个子节点、
 * 其余各 1 个，右侧会很长）。但导图的一级分支通常规模相近，而且
 * 「位置稳定」比「高度均衡」更影响可用性。
 *
 * 关闭 `autoBalance` 时全部排到右侧（对应 XMind 的「自动平衡」开关）。
 */
function splitSides(children: MeasuredNode[], autoBalance: boolean): Sides {
  if (!autoBalance) {
    return { left: [], right: [...children] };
  }

  const left: MeasuredNode[] = [];
  const right: MeasuredNode[] = [];
  children.forEach((child, index) => {
    if (index % 2 === 0) right.push(child);
    else left.push(child);
  });
  return { left, right };
}

// ---------------------------------------------------------------------------
// 摆放
// ---------------------------------------------------------------------------

function place(
  node: MeasuredNode,
  x: number,
  top: number,
  side: Side,
  boxes: Map<string, NodeBox>,
  sizes: Map<string, TopicSize>,
  styles: Map<string, ComputedStyle>,
): NodeBox {
  // 节点在自己的垂直带里居中：带高由子节点撑起来时，父节点落在中间，
  // 视觉上连线才不会全挤在一侧。
  const y = top + (node.subtreeHeight - node.size.height) / 2;
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
  boxes.set(box.id, box);
  sizes.set(box.id, node.size);
  styles.set(box.id, node.style);
  return box;
}

function placeSide(
  nodes: MeasuredNode[],
  side: Side,
  anchorX: number,
  startTop: number,
  spacing: { siblingGap: number; levelGap: number; padding: number },
  rootBox: NodeBox,
  boxes: Map<string, NodeBox>,
  sizes: Map<string, TopicSize>,
  styles: Map<string, ComputedStyle>,
  edges: EdgePath[],
): void {
  let cursor = startTop;
  for (const node of nodes) {
    placeSubtree(node, side, anchorX, cursor, spacing, boxes, sizes, styles, edges);

    // 根到一级分支的连线要单独补：根不经过 placeSubtree，否则它的「带」
    // 会被子节点撑大，根就不再位于中心。
    const childBox = boxes.get(node.topic.id);
    if (childBox) {
      edges.push(makeEdge(rootBox, childBox, node.style, side));
    }

    cursor += node.subtreeHeight + spacing.siblingGap;
  }
}

function makeEdge(parent: NodeBox, child: NodeBox, style: ComputedStyle, side: Side): EdgePath {
  const fromY = parent.y + parent.height / 2;
  const toY = child.y + child.height / 2;
  return {
    id: `${parent.id}->${child.id}`,
    parentId: parent.id,
    childId: child.id,
    from: side === 'left' ? { x: parent.x, y: fromY } : { x: parent.x + parent.width, y: fromY },
    to: side === 'left' ? { x: child.x + child.width, y: toY } : { x: child.x, y: toY },
    // 连线的颜色取自子节点：分支色跟着分支走，而不是跟着父节点。
    lineStyle: style.lineStyle,
    lineEnd: style.lineEnd,
    lineColor: style.lineColor,
    lineWidth: style.lineWidth,
  };
}

function placeSubtree(
  node: MeasuredNode,
  side: Side,
  anchorX: number,
  top: number,
  spacing: { siblingGap: number; levelGap: number; padding: number },
  boxes: Map<string, NodeBox>,
  sizes: Map<string, TopicSize>,
  styles: Map<string, ComputedStyle>,
  edges: EdgePath[],
): void {
  // anchorX 是该层节点靠向根的那条边的 x 坐标。
  const x = side === 'left' ? anchorX - node.size.width : anchorX;
  const box = place(node, x, top, side, boxes, sizes, styles);

  if (node.children.length === 0) return;

  const childAnchorX = side === 'left'
    ? x - spacing.levelGap
    : x + node.size.width + spacing.levelGap;

  // 子节点组在自己的带里居中。带宽由子节点撑起来时偏移为 0；
  // 带宽由父节点自身高度决定时（子树比父节点矮），子节点要落在中间，
  // 否则连线会全挤在父节点上半部分。
  const childrenTotal = totalHeight(node.children, spacing.siblingGap);
  let cursor = top + (node.subtreeHeight - childrenTotal) / 2;
  for (const child of node.children) {
    placeSubtree(child, side, childAnchorX, cursor, spacing, boxes, sizes, styles, edges);

    const childBox = boxes.get(child.topic.id);
    if (childBox) edges.push(makeEdge(box, childBox, child.style, side));

    cursor += child.subtreeHeight + spacing.siblingGap;
  }
}

// ---------------------------------------------------------------------------
// 自由主题
// ---------------------------------------------------------------------------

/**
 * 自由主题排在整棵树的下方，按文档顺序纵向排列。
 *
 * 文档模型里自由主题没有坐标（见 docs/03 §2.2：`floatingTopics` 只是数组），
 * 所以「用户拖到哪里就停在哪里」需要额外的位置字段，那是 M2.5 拖拽才引入的
 * 问题。在那之前用确定性排布：至少它们可见、可编辑、可被拖回树上。
 */
function placeFloating(
  sheet: Sheet,
  theme: Theme,
  measure: MeasureFn,
  spacing: { siblingGap: number; levelGap: number; padding: number },
  boxes: Map<string, NodeBox>,
  sizes: Map<string, TopicSize>,
  styles: Map<string, ComputedStyle>,
  edges: EdgePath[],
): void {
  if (sheet.floatingTopics.length === 0) return;

  let minX = Infinity;
  let maxY = -Infinity;
  for (const box of boxes.values()) {
    if (box.x < minX) minX = box.x;
    if (box.y + box.height > maxY) maxY = box.y + box.height;
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxY = 0;
  }

  let cursor = maxY + spacing.siblingGap * 2;
  for (const floating of sheet.floatingTopics) {
    const measured = measureNode(floating, theme, measure, {
      depth: 1,
      branchIndex: -1,
      isRoot: false,
      isFloating: true,
      isSummary: false,
    });
    subtreeHeightOf(measured, spacing.siblingGap);
    placeSubtree(measured, 'right', minX, cursor, spacing, boxes, sizes, styles, edges);
    cursor += measured.subtreeHeight + spacing.siblingGap;
  }
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

/** 把所有坐标平移到「内容左上角 = (padding, padding)」，并算出包围盒。 */
function finalize(
  boxes: Map<string, NodeBox>,
  sizes: Map<string, TopicSize>,
  styles: Map<string, ComputedStyle>,
  edges: EdgePath[],
  padding: number,
): LayoutResult {
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
