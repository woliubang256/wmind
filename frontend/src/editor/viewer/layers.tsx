/**
 * 画布的三层内容：连线、主题、装饰。
 *
 * 从 `mind-map-viewer.tsx` 抽出来，是因为**导出也要用同一套元素生成函数**
 * （docs/06 §3.2）。导出如果另写一份「差不多」的 SVG，两边迟早会跑偏，
 * 而验收标准里有一条是「导出的 PNG 与画布所见像素级一致」——那等于要求
 * 两边逐像素相同，共用组件是唯一可行的做法。
 *
 * 这里的组件全部是纯渲染：不读 store、不挂事件、不碰视口。
 */

import { memo } from 'react';
import type { EdgePath, LayoutResult, NodeBox, Rect } from '../layout/types';
import type { ComputedStyle } from '../model/types';
import { cullBoxes, cullEdges } from './cull';
import { EdgeLine } from './edges';
import { TopicNode } from './topic-node';

const EMPTY_SELECTION: ReadonlySet<string> = new Set();
const EMPTY_KEEP: ReadonlySet<string> = new Set();

/**
 * 连线层。
 *
 * 记忆化的原因：平移缩放只改 `<g transform>` 一个属性，但如果这层写在主
 * 组件里，每次 viewport 变化都会重新创建 2000 个 React 元素，React 要把
 * 它们逐个 diff 一遍——实测 2000 节点时一次滚轮要 300ms，完全不可用。
 */
export const EdgesLayer = memo(function EdgesLayer({
  edges,
  cullRect = null,
}: {
  edges: EdgePath[];
  /** 世界坐标的视口矩形；`null` 表示不裁剪（小图与导出）。 */
  cullRect?: Rect | null;
}) {
  const visible = cullEdges(edges, cullRect);
  return (
    <g className="layer-edges">
      {visible.map((edge) => (
        <EdgeLine key={edge.id} edge={edge} />
      ))}
    </g>
  );
});

export interface TopicsLayerProps {
  layout: LayoutResult;
  selection?: ReadonlySet<string>;
  editingId?: string | null;
  /** 导出传 `false`：折叠徽标是交互产物，不该出现在成品里。 */
  showBadges?: boolean;
  /**
   * `id → 原始标题`。只用于 `aria-label`（`lines` 是折行后的，不能当名字）。
   *
   * 导出路径不传：导出的 SVG 里没有读屏可言，少建一张表也就少一次遍历。
   */
  titles?: ReadonlyMap<string, string>;
  /**
   * 是否把每个主题渲染成 `treeitem`。
   *
   * 只有**可编辑**的画布才需要：那时画布是一个 `role="tree"`，节点是它的
   * 子项。只读预览整张图是一个 `img`，里面再冒出 4 个 treeitem 会让读屏
   * 报出一棵「没有名字的树」，比不报还糟。导出同理（`false`）。
   */
  treeItems?: boolean;
  /**
   * 世界坐标的视口矩形；`null` 表示不裁剪（小图与导出）。
   *
   * 传了它就只渲染视口附近的节点——一次选中变化要 diff 的元素从 2001 个降到
   * 视口内的几百个，这是按方向键从 50ms 降到个位数毫秒的关键。
   */
  cullRect?: Rect | null;
  /** 无论是否在视口内都要保留的 id（选中的、正在编辑的）。 */
  keep?: ReadonlySet<string>;
}

export const TopicsLayer = memo(function TopicsLayer({
  layout,
  selection = EMPTY_SELECTION,
  editingId = null,
  showBadges = true,
  titles,
  treeItems = false,
  cullRect = null,
  keep = EMPTY_KEEP,
}: TopicsLayerProps) {
  const visible = cullBoxes(layout.boxes.values(), cullRect, keep);
  return (
    <g className="layer-topics">
      {visible.map((box) => {
        const size = layout.sizes.get(box.id);
        return (
          <TopicNode
            key={box.id}
            box={box}
            style={layout.styles.get(box.id) ?? fallbackStyle(box)}
            lines={size?.lines ?? ['']}
            title={titles?.get(box.id) ?? ''}
            image={size?.image ?? null}
            markers={size?.markers}
            details={size?.details}
            selected={selection.has(box.id)}
            editing={editingId === box.id}
            showBadges={showBadges}
            treeItem={treeItems}
          />
        );
      })}
    </g>
  );
});

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
