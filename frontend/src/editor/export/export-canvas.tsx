/**
 * 导出用的 SVG 画布。
 *
 * 与 `MindMapViewer` 共用 `TopicsLayer` / `EdgesLayer` / `BoundariesLayer` /
 * `RelationshipsLayer`——docs/06 §3.2 要求「同一套元素生成函数」，因为验收里
 * 有一条是「导出的 PNG 与画布所见像素级一致」。另写一份渲染逻辑就永远对不齐。
 *
 * 与画布的三处差异，都是「成品不该带编辑器痕迹」：
 *
 * 1. **不画折叠徽标**（`showBadges={false}`）——徽标本身是按钮；
 * 2. **不画选区、不画编辑框**——导出时它们不该存在；
 * 3. **坐标不经过视口变换**——导出尺寸由内容包围盒决定，与用户当前缩放到
 *    多少、平移到哪里无关。
 */

import { fontStack } from '../theme/fonts';
import { layoutAnnotations } from '../layout/annotations';
import { BoundariesLayer, RelationshipsLayer, SummariesLayer } from '../viewer/decorations';
import { EdgesLayer, TopicsLayer } from '../viewer/layers';
import type { ExportContext, ExportSheet } from './context';

/** 品牌标识与日期的颜色：中性灰，不抢内容。 */
const FOOTER_COLOR = '#8C8C8C';
const FOOTER_SIZE = 12;

function SheetGroup({ sheet }: { sheet: ExportSheet }) {
  const annotations = layoutAnnotations(sheet.sheet, sheet.layout, sheet.theme);
  return (
    <g
      data-export-sheet={sheet.id}
      transform={`translate(${sheet.offsetX - sheet.bounds.x} ${sheet.offsetY - sheet.bounds.y})`}
    >
      <BoundariesLayer annotations={annotations} />
      <EdgesLayer edges={sheet.layout.edges} />
      <RelationshipsLayer annotations={annotations} />
      <SummariesLayer annotations={annotations} />
      <TopicsLayer layout={sheet.layout} showBadges={false} />
    </g>
  );
}

export function ExportCanvas({ ctx }: { ctx: ExportContext }) {
  const { width, height, scale } = ctx;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      xmlnsXlink="http://www.w3.org/1999/xlink"
      width={Math.round(width * scale)}
      height={Math.round(height * scale)}
      viewBox={`0 0 ${width} ${height}`}
      // 字体栈写在根上而不是逐个元素：文字元素自己的 style 里已经带了完整
      // 字体栈，这一层只是给「没写字体」的元素（比如日期）一个兜底。
      style={{ fontFamily: fontStack('sans') }}
    >
      {ctx.fontCss === '' ? null : (
        // 内嵌字体的 `@font-face`。必须放在 SVG 内部：`<img>` 载入的 SVG 不许
        // 引用外部资源，`data:` 是自身的一部分所以不受限。见 `font-embed.ts`。
        <defs>
          <style>{ctx.fontCss}</style>
        </defs>
      )}

      {ctx.background === null ? null : (
        <rect x={0} y={0} width={width} height={height} fill={ctx.background} />
      )}

      {ctx.sheets.map((sheet) => (
        <SheetGroup key={sheet.id} sheet={sheet} />
      ))}

      {ctx.border.stroke === null ? null : (
        <rect
          // 描边画在画布内侧：`width / 2` 的偏移让 1px 线落在像素中心上，
          // 否则导出 PNG 时那条线会被摊成两个半透明的像素。
          x={ctx.border.width / 2}
          y={ctx.border.width / 2}
          width={Math.max(0, width - ctx.border.width)}
          height={Math.max(0, height - ctx.border.width)}
          fill="none"
          stroke={ctx.border.stroke}
          strokeWidth={ctx.border.width}
        />
      )}

      {ctx.date === null ? null : (
        <text x={12} y={height - 10} style={{ fontSize: FOOTER_SIZE, fill: FOOTER_COLOR }}>
          {ctx.date}
        </text>
      )}

      {ctx.brand ? (
        <text
          x={width - 12}
          y={height - 10}
          textAnchor="end"
          style={{ fontSize: FOOTER_SIZE, fill: FOOTER_COLOR }}
        >
          {ctx.brandText}
        </text>
      ) : null}
    </svg>
  );
}
