import { TopicDetailsView, type TopicContentLabels } from './topic-details';
import type { TopicDetails } from '../layout/topic-details';
/**
 * 单个主题节点的渲染。
 *
 * `React.memo` + 自定义比较器是必需的：一张 1000 节点的导图每次按键都会重渲染
 * 整个 `<g>`，如果不做浅比较，React 会重建 1000 个节点的 vDOM 再 diff 一遍。
 * 比较器只比引用与原始值，不做深比较——`box` 与 `style` 都来自缓存，
 * 引用稳定是布局层与样式层共同保证的。
 */

import { memo } from 'react';
import type { ComputedStyle } from '../model/types';
import type { ImageSize, MarkerLayout, NodeBox } from '../layout/types';
import { NODE_METRICS } from '../layout/constants';
import { fontStack } from '../theme/fonts';
import { topicElementId } from './a11y-ids';
import { TopicShape } from './shapes';
import { MarkerIcon } from './marker-icon';
import { topicContentGeometry } from '../layout/topic-content';

export interface TopicNodeProps {
  box: NodeBox;
  style: ComputedStyle;
  lines: string[];
  /**
   * 未折行的原始标题。
   *
   * `lines` 是**测量产物**（按盒子宽度折过行），拿它当读屏标签会读出
   * 「分支\nA」这种带断行的名字，而读屏会把换行当停顿。所以标题单独传一份。
   */
  title: string;
  /** 节点内的图片（含地址与显示尺寸）；没有图片为 null。 */
  image?: ImageSize | null;
  markers?: MarkerLayout;
  details?: TopicDetails;
  selected: boolean;
  editing: boolean;
  /**
   * 是否画折叠徽标与悬停折叠按钮。
   *
   * 导出必须传 `false`：徽标是编辑器的交互产物（它本身就是按钮），
   * 出现在导出的图片里等于把「这里可以点」印在成品上。
   */
  showBadges?: boolean;
  /**
   * 是否作为 `role="tree"` 的子项参与读屏。
   *
   * 只有可编辑的画布传 `true`；只读预览与导出都不传——那两种场景下整张图
   * 是一个 `img`，里面再挂 treeitem 会让读屏报出一棵无名树。
   */
  treeItem?: boolean;
  contentReadOnly?: boolean;
  contentInteractive?: boolean;
  contentLabels?: TopicContentLabels;
}

const SELECTION_INSET = 3;
const BADGE_RADIUS = 9;

export const TopicNode = memo(function TopicNode({
  box,
  style,
  lines,
  title,
  image = null,
  markers,
  details,
  selected,
  editing,
  showBadges = true,
  treeItem = false,
  contentReadOnly = false,
  contentInteractive = false,
  contentLabels,
}: TopicNodeProps) {
  const lineHeight = Math.round(style.fontSize * NODE_METRICS.lineHeightRatio);
  const showImage = image !== null && image.src !== '';
  const geometry = topicContentGeometry(box, style, lines, image, markers, details);
  const { textX, textAnchor: anchor, firstY, imageX, imageY, markerRects } = geometry;

  // 折叠徽标放在「远离根」的一侧：左侧分支在左边缘，右侧在右边缘，
  // 自上而下的结构（org-chart）在下沿。
  const badgeX = box.side === 'left' ? box.x : box.side === 'bottom' ? box.x + box.width / 2 : box.x + box.width;
  const badgeY = box.side === 'bottom' ? box.y + box.height : box.y + box.height / 2;
  const showBadge = showBadges && box.collapsed && box.hiddenChildren > 0;
  const hasChildren = box.childCount > 0;

  return (
    <g
      className="wmind-topic"
      id={treeItem ? topicElementId(box.id) : undefined}
      data-topic-id={box.id}
      data-topic-side={box.side}
      /*
        画布在编辑态是一棵 `role="tree"`，每个主题就是一个 treeitem。层级用
        `depth + 1`：ARIA 的 aria-level 从 1 开始，而布局的 depth 从 0 开始
        （根节点 depth=0）。

        `aria-expanded` 只在**有子节点**时给：给叶子节点加 aria-expanded="false"
        会让读屏念「已折叠」，而它根本没有可展开的东西。

        只读预览与导出传 `treeItem=false`，这些属性整体不出现——那里整张图
        是一个 `img`，不属于任何树。
      */
      role={treeItem ? 'treeitem' : undefined}
      aria-level={treeItem ? box.depth + 1 : undefined}
      aria-selected={treeItem ? selected : undefined}
      aria-expanded={treeItem && hasChildren ? !box.collapsed : undefined}
      aria-label={treeItem && title !== '' ? title : undefined}
    >
      <TopicShape box={box} style={style} />
      {details ? <TopicDetailsView details={details} box={box} geometry={geometry} color={style.textColor} interactive={showBadges && contentInteractive} readOnly={contentReadOnly} labels={contentLabels} /> : null}

      {showImage ? (
        <image
          href={image.src}
          x={imageX}
          y={imageY}
          width={image.width}
          height={image.height}
          // `meet` 而不是 `slice`：宁可留白也不裁掉图的内容——导图里的图
          // 通常是截图或图表，裁掉边角会丢信息。
          preserveAspectRatio="xMidYMid meet"
          // 点击要落到节点形状上（选中、拖拽、双击编辑都由形状接管），
          // 图片自己不该成为命中目标。
          pointerEvents="none"
          // 名字已经由外层 treeitem 的 aria-label 提供，图再念一遍是重复。
          aria-hidden="true"
        />
      ) : null}

      {markerRects.map(({ marker, x, y, size }, index) => <MarkerIcon key={`${marker.markerId}-${index}`} markerId={marker.markerId} backdrop
        x={x} y={y} width={size} height={size} pointerEvents="none" />)}

      <text
        x={textX}
        y={firstY}
        textAnchor={anchor}
        dominantBaseline="central"
        pointerEvents="none"
        aria-hidden="true"
        style={{
          // 与 Canvas 测量用同一串字体栈，否则测出来的宽度与实际渲染对不上。
          fontFamily: fontStack(style.fontFamily),
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          fontStyle: style.fontStyle,
          textDecoration: style.textDecoration,
          fill: style.textColor,
        }}
      >
        {lines.map((line, index) => (
          <tspan key={index} x={textX} y={firstY + index * lineHeight}>
            {line === '' ? '\u00a0' : line}
          </tspan>
        ))}
      </text>

      {showBadge ? (
        <g data-collapse-toggle={box.id} aria-hidden="true" style={{ cursor: 'pointer' }}>
          <circle
            cx={badgeX}
            cy={badgeY}
            r={BADGE_RADIUS}
            fill="var(--wmind-badge-bg, #FFFFFF)"
            stroke={style.lineColor}
            strokeWidth={1.5}
          />
          <text
            x={badgeX}
            y={badgeY}
            textAnchor="middle"
            dominantBaseline="central"
            pointerEvents="none"
            style={{ fontSize: 10, fontWeight: 600, fill: style.lineColor }}
          >
            {box.hiddenChildren > 99 ? '99+' : box.hiddenChildren}
          </text>
        </g>
      ) : null}

      {/* 展开态且有子节点：悬停时浮现「折叠」按钮（减号）。
          折叠态那个带数字的徽标本身就是展开按钮，两者语义相同、位置相同。 */}
      {showBadges && !box.collapsed && box.childCount > 0 ? (
        <g className="wmind-collapse-toggle" data-collapse-toggle={box.id} aria-hidden="true" style={{ cursor: 'pointer' }}>
          <circle
            cx={badgeX}
            cy={badgeY}
            r={BADGE_RADIUS}
            fill="var(--wmind-badge-bg, #FFFFFF)"
            stroke={style.lineColor}
            strokeWidth={1.5}
          />
          <path
            d={`M ${badgeX - 4} ${badgeY} H ${badgeX + 4}`}
            stroke={style.lineColor}
            strokeWidth={1.5}
            strokeLinecap="round"
            pointerEvents="none"
          />
        </g>
      ) : null}

      {selected && !editing ? (
        <rect
          x={box.x - SELECTION_INSET}
          y={box.y - SELECTION_INSET}
          width={box.width + SELECTION_INSET * 2}
          height={(box.outerHeight ?? box.height) + SELECTION_INSET * 2}
          rx={Math.min(12, box.height / 2) + SELECTION_INSET}
          fill="none"
          stroke="var(--wmind-selection, #1E88E5)"
          strokeWidth={2}
          strokeDasharray="6 4"
          pointerEvents="none"
        />
      ) : null}
    </g>
  );
}, areEqual);

function areEqual(prev: TopicNodeProps, next: TopicNodeProps): boolean {
  return (
    prev.box === next.box &&
    prev.style === next.style &&
    prev.lines === next.lines &&
    prev.title === next.title &&
    prev.image === next.image &&
    prev.markers === next.markers && prev.details === next.details &&
    prev.showBadges === next.showBadges &&
    prev.selected === next.selected &&
    prev.editing === next.editing &&
    prev.contentLabels === next.contentLabels &&
    prev.contentInteractive === next.contentInteractive &&
    prev.contentReadOnly === next.contentReadOnly &&
    prev.treeItem === next.treeItem
  );
}
