/**
 * 视口裁剪。
 *
 * 为什么需要它：一次选中变化会让 `TopicsLayer` 重新创建**全部**节点的 React
 * 元素。`React.memo` 能拦住 DOM 更新，但拦不住「2001 个元素逐个 diff」这件事
 * 本身——压测文档实测按一次方向键 50ms、p90 124ms，手感是明显的顿。
 * 裁掉视口外的节点之后，同一次按键只剩视口内的几百个要过一遍。
 *
 * 两个容易做错的地方：
 *
 * 1. **裁剪矩形要有余量**。贴着视口边缘裁，快速拖动时会在边上看到节点「长出来」。
 *    余量取一个视口尺寸的比例，滚一格不会露出空白。
 * 2. **选中的节点必须保留**，哪怕它在视口外。`aria-activedescendant` 指向一个
 *    不存在的 id 时读屏会静默失声，而且键盘把选区移到视口外之后，元素一旦被裁掉
 *    就再也没有任何痕迹了。
 */

import type { EdgePath, NodeBox, Rect } from '../layout/types';

/**
 * 裁剪余量（世界坐标）：视口尺寸的这个比例，加一个固定值。
 *
 * 固定值兜住「缩放到很大」的情形——那时 0.5 倍视口的世界尺寸很小，
 * 单靠比例算出来的余量不够一次拖拽。
 */
const MARGIN_RATIO = 0.5;
const MARGIN_MIN = 240;

export function expandRect(rect: Rect, ratio = MARGIN_RATIO, min = MARGIN_MIN): Rect {
  const extraX = Math.max(rect.width * ratio, min);
  const extraY = Math.max(rect.height * ratio, min);
  return {
    x: rect.x - extraX,
    y: rect.y - extraY,
    width: rect.width + extraX * 2,
    height: rect.height + extraY * 2,
  };
}

export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * 挑出与视口相交的节点。
 *
 * `rect` 传 `null` 表示不裁剪（小图、导出），原样返回——调用方不用在两层各写一遍
 * 判断。
 *
 * `keep` 里的 id 无条件保留（选中的、正在编辑的）。它只在裁剪真正生效时才有
 * 意义，不裁剪时也不需要额外查表。
 */
export function cullBoxes(
  boxes: Iterable<NodeBox>,
  rect: Rect | null,
  keep?: ReadonlySet<string>,
): NodeBox[] {
  const all = [...boxes];
  if (rect === null) return all;

  const viewport = expandRect(rect);
  return all.filter((box) => intersects(box, viewport) || (keep?.has(box.id) ?? false));
}

/**
 * 挑出与视口相交的连线。
 *
 * 用两端点围出的包围盒判断，而不是精确的贝塞尔求交：连线都很短，包围盒近似
 * 足够，而精确求交要在每帧对几千条曲线做数学，得不偿失。代价是视口边缘可能多
 * 画几条其实不相交的线——只多不省，不会缺。
 */
export function cullEdges(edges: readonly EdgePath[], rect: Rect | null): EdgePath[] {
  if (rect === null) return edges as EdgePath[];

  const viewport = expandRect(rect);
  return edges.filter((edge) => {
    const box: Rect = {
      x: Math.min(edge.from.x, edge.to.x),
      y: Math.min(edge.from.y, edge.to.y),
      width: Math.abs(edge.from.x - edge.to.x),
      height: Math.abs(edge.from.y - edge.to.y),
    };
    return intersects(box, viewport);
  });
}

/**
 * 超过这个节点数才裁剪。
 *
 * 小图上裁剪反而更慢：多一次全量遍历、多一组对象分配，而且每帧都要重算。
 * 400 是个经验值——几百个节点的一次全量 diff 还在 10ms 以内，感觉不出来。
 */
export const CULL_THRESHOLD = 400;
