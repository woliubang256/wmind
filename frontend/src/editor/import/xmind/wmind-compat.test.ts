import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { importRegistry } from '../builtins';
import { isLegacyWmindMetadata } from './wmind-compat';

describe('旧版 wmind XMind 样式兼容', () => {
  it('只有带已知来源且缺新标记的包使用旧约定', () => {
    expect(isLegacyWmindMetadata('{"creator":{"name":"wmind","version":1}}')).toBe(true);
    for (const value of [null, '{bad', '{}', '{"creator":{"name":"XMind"}}', '{"creator":{"name":"wmind"},"wmindStyleVersion":2}']) {
      expect(isLegacyWmindMetadata(value)).toBe(false);
    }
  });

  it('保留旧导出的主题边框、分支、自由主题与联系双端箭头', () => {
    const oldTopic = { properties: {
      'line-color': '#111111', 'line-width': '0', 'line-pattern': 'none',
      'border-line-color': '#123456', 'border-line-width': '4', 'border-line-pattern': 'dash',
    } };
    const content = [{ rootTopic: { id: 'r', title: '根', style: oldTopic,
      children: { attached: [{ id: 'a', title: '分支', style: oldTopic }], detached: [{ id: 'f', title: '自由', style: oldTopic }] } },
    relationships: [{ end1Id: 'a', end2Id: 'f', style: { properties: {
      'border-line-color': '#654321', 'border-line-width': '3', 'border-line-pattern': 'curve',
      'line-pattern': 'dot', 'line-start-marker': 'arrow', 'line-end-marker': 'dot',
    } } }],
    }];
    const bytes = zipSync({ 'content.json': strToU8(JSON.stringify(content)), 'metadata.json': strToU8('{"creator":{"name":"wmind"}}') });
    const sheet = importRegistry.run({ fileName: 'old.xmind', bytes }).document.sheets[0]!;
    for (const topic of [sheet.rootTopic, sheet.rootTopic.children.attached[0]!, sheet.floatingTopics[0]!]) {
      expect(topic.style).toMatchObject({ borderColor: '#111111', borderWidth: 0, borderStyle: 'none', lineColor: '#123456', lineWidth: 4, lineStyle: 'elbow' });
    }
    expect(sheet.relationships[0]!.style).toMatchObject({ lineColor: '#654321', lineWidth: 3, lineStyle: 'curve', borderStyle: 'dot', lineStart: 'arrow', lineEnd: 'dot' });
  });
});
