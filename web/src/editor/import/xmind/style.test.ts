import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { importRegistry } from '../builtins';
import { createImportContext } from '../context';
import { resolveLimits } from '../limits';
import { buildExportContext, DEFAULT_EXPORT_OPTIONS } from '../../export/context';
import { toPartialStyle } from './style';

const context = () => createImportContext({ fileName: 'sample.xmind', limits: resolveLimits() }).context;

describe('XMind 标准线条属性', () => {
  it('节点无边框不应使父子连线消失，序列化后仍然可见', () => {
    const properties = {
      'line-color': '#ADADAD', 'line-width': '2pt', 'line-pattern': 'solid',
      'border-line-color': '#000000', 'border-line-width': '0pt', 'border-line-pattern': 'none',
      'line-class': 'org.xmind.branchConnection.curve',
    };
    const bytes = zipSync({ 'content.json': strToU8(JSON.stringify([{
      rootTopic: { id: 'root', title: '根', children: { attached: [{ id: 'a', title: '分支' }] } },
      theme: { mainTopic: { properties } },
    }])) });
    const result = importRegistry.run({ fileName: 'sample.xmind', bytes });
    for (const document of [result.document, JSON.parse(JSON.stringify(result.document))]) {
      const layout = buildExportContext(document, document.sheets[0].id, DEFAULT_EXPORT_OPTIONS).sheets[0]!.layout;
      expect(layout.edges).toHaveLength(1);
      expect(layout.edges[0]).toMatchObject({ lineWidth: 2, lineColor: '#ADADAD', lineStyle: 'curve' });
      expect(layout.styles.get('a')).toMatchObject({ borderWidth: 0, borderColor: '#000000', borderStyle: 'none' });
    }
  });

  it('分支几何取 line-class，节点边框的虚线不改变连线走向', () => {
    expect(toPartialStyle({
      'line-class': 'org.xmind.branchConnection.roundedElbow',
      'border-line-pattern': 'dash', 'line-width': '3', 'border-line-width': '1',
    }, context())).toMatchObject({ lineStyle: 'elbow', borderStyle: 'dash', lineWidth: 3, borderWidth: 1 });
  });

  it('继承值不固化，明确隐藏连线仍有效', () => {
    expect(toPartialStyle({ 'line-width': 'inherited', 'line-color': 'inherited', 'line-class': 'inherited' }, context())).toEqual({});
    expect(toPartialStyle({ 'line-width': '0', 'line-class': 'org.xmind.branchConnection.none' }, context()))
      .toMatchObject({ lineWidth: 0, lineStyle: 'none' });
  });

  it('联系读取自身线宽、虚实、几何和双端箭头', () => {
    expect(toPartialStyle({
      'line-color': '#123456', 'line-width': '4', 'line-pattern': 'dot',
      'shape-class': 'org.xmind.relationshipShape.curved',
      'arrow-begin-class': 'org.xmind.arrowShape.triangle', 'arrow-end-class': 'org.xmind.arrowShape.circle',
    }, context(), 'relationship')).toMatchObject({
      lineColor: '#123456', lineWidth: 4, borderStyle: 'dot', lineStyle: 'curve', lineStart: 'arrow', lineEnd: 'dot',
    });
  });
});
