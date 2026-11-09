import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { layoutMindmap } from '@/editor/layout/mindmap';
import { createStarterDocument } from '@/features/editor/demo-document';
import { TopicsLayer } from './layers';

/**
 * 主题文字必须**垂直居中**，而且不能依赖 `dominant-baseline`。
 *
 * 回归点：桌面客户端（WKWebView / WebKitGTK）对 `dominant-baseline: central`
 * 支持不可靠，会退回默认基线，文字整体上移约半个字高——这就是「新建导图
 * 文字没有垂直居中」的原因。现在 `y` 由「行盒中心 + 字体基线偏移」算出来，
 * 各引擎结果一致。
 */

function renderRoot() {
  const doc = createStarterDocument('Untitled map', 'Branch topic');
  const sheet = doc.sheets[0]!;
  const layout = layoutMindmap({ sheet, theme: doc.theme });
  const root = layout.boxes.get(sheet.rootTopic.id)!;
  const size = layout.sizes.get(root.id)!;
  const svg = renderToStaticMarkup(<svg><TopicsLayer layout={layout} selection={new Set()} /></svg>);
  return { root, size, svg };
}

describe('主题文字居中', () => {
  it('文字基线落在「盒子中心 + 字体基线偏移」上', () => {
    const { root, size, svg } = renderRoot();
    const match = /<text[^>]*\by="([\d.]+)"/.exec(svg);
    expect(match).not.toBeNull();
    const y = Number(match![1]);
    const expected = root.y + root.height / 2 + size.baselineOffset;
    expect(y).toBeCloseTo(expected, 3);
    // 单行文字：字形在盒子里上下对称（误差不到 1px）。
    const inkCenter = y - size.baselineOffset;
    expect(Math.abs(inkCenter - (root.y + root.height / 2))).toBeLessThan(1);
  });

  it('不写 dominant-baseline，避免 WebKit 退回默认基线', () => {
    const { svg } = renderRoot();
    expect(svg).not.toContain('dominant-baseline');
    expect(svg).not.toContain('dominantBaseline');
  });
});
