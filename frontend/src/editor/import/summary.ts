/**
 * 从文档反推「导入了什么」。
 *
 * 摘要对话框的每个勾都要有据可查：这里**扫最终文档**，而不是让适配器自己
 * 报「我导入了备注」——适配器说导入了、实际却没写进去的情况太容易发生，
 * 而用户看到的对话框就成了谎言。
 */

import { walkSheet } from '../model/traverse';
import type { WmindDocument } from '../model/types';
import type { ImportedFeature, ImportSummary } from './types';

export function summarizeImport(document: WmindDocument): ImportSummary {
  let topics = 0;
  let maxDepth = 0;
  const restored = new Set<ImportedFeature>();

  for (const sheet of document.sheets) {
    if (sheet.structure !== 'mindmap') restored.add('structure');
    if (sheet.themeOverride !== null) restored.add('style');
    if (sheet.relationships.length > 0) restored.add('relationships');
    if (sheet.boundaries.length > 0) restored.add('boundaries');
    if (sheet.summaries.length > 0) restored.add('summaries');

    walkSheet(sheet, (topic, ctx) => {
      topics += 1;
      // 根节点 depth 为 0，所以「层数」要 +1：单节点文档是 1 层。
      if (ctx.depth + 1 > maxDepth) maxDepth = ctx.depth + 1;

      if (topic.structure !== null) restored.add('structure');
      if (topic.style !== null && Object.keys(topic.style).length > 0) restored.add('style');
      if (topic.notes.plain !== '' || topic.notes.html !== '') restored.add('notes');
      if (topic.labels.length > 0) restored.add('labels');
      if (topic.markers.length > 0) restored.add('markers');
      if (topic.href !== '') restored.add('href');
      if (topic.image !== null) restored.add('image');
      if (topic.collapsed) restored.add('collapsed');
      if (topic.boundaries.length > 0) restored.add('boundaries');
      if (topic.summaries.length > 0) restored.add('summaries');
    });
  }

  // 顺序固定，方便界面按固定次序渲染、测试直接断言数组。
  const order: ImportedFeature[] = [
    'structure',
    'style',
    'notes',
    'labels',
    'markers',
    'href',
    'image',
    'relationships',
    'boundaries',
    'summaries',
    'collapsed',
  ];

  return {
    sheets: document.sheets.length,
    topics,
    maxDepth,
    restored: order.filter((feature) => restored.has(feature)),
  };
}
