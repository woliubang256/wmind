/**
 * 演示文档。
 *
 * M2.6 之前编辑器还没有持久化，先给一份内置内容，让渲染 / 布局 / 交互
 * 能在真实形状上被看见和验证。M2.6 接通后端后，这份数据会被
 * `GET /maps/{uid}` 的结果取代，此文件退化为「新建导图」的初始内容。
 */

import { createDocument, createTopic } from '@/editor/model/create';
import type { WmindDocument } from '@/editor/model/types';

const GROUPS: { title: string; items: string[] }[] = [
  { title: '用户研究', items: ['访谈 12 位用户', '问卷 300 份', '竞品拆解'] },
  { title: '功能设计', items: ['大纲视图', '主题配色', '导入 XMind', '多人协作'] },
  { title: '技术方案', items: ['SVG 渲染', '自动保存', '乐观锁', '双方言存储'] },
  { title: '上线计划', items: ['内测', '公测', '正式发布'] },
];

export function createDemoDocument(): WmindDocument {
  const doc = createDocument({ title: '产品规划' });
  const sheet = doc.sheets[0];
  if (!sheet) return doc;

  const root = sheet.rootTopic;
  root.title = '产品规划';

  for (const group of GROUPS) {
    const branch = createTopic({ title: group.title });
    for (const item of group.items) {
      branch.children.attached.push(createTopic({ title: item }));
    }
    root.children.attached.push(branch);
  }

  // 折叠「上线计划」：演示折叠徽标上的隐藏后代数量。
  const last = root.children.attached[root.children.attached.length - 1];
  if (last) last.collapsed = true;

  // 一个自由主题：演示它不参与左右平衡，也不属于树的任何分支。
  sheet.floatingTopics.push(
    createTopic({
      title: '待定：AI 自动生成大纲',
      style: { shape: 'capsule' },
    }),
  );

  // 一条跨分支关系线：演示关系层画在父子连线之上。
  const [first, second] = root.children.attached;
  if (first && second) {
    sheet.relationships.push({
      id: 'rel-demo',
      end1Id: first.id,
      end2Id: second.id,
      title: '驱动',
      style: null,
    });
  }

  return doc;
}

/**
 * 压测文档：`n` 个节点的规则树（10 个一级分支，其余平分到二级）。
 *
 * 走 `/maps/stress` 触发。它不是产品功能，是给验收标准 3（「1000 节点打开
 * < 1.5s，2000 节点不卡顿」）留一个可复现的入口——没有它，性能回归只能靠
 * 手工造数据，实际结果是没人测。
 */
export function createStressDocument(total = 2000): WmindDocument {
  const doc = createDocument({ title: `压测 ${total} 节点` });
  const sheet = doc.sheets[0];
  if (!sheet) return doc;

  const branches = 10;
  const perBranch = Math.max(1, Math.floor((total - 1) / branches));
  sheet.rootTopic.title = '压测根节点';

  for (let b = 0; b < branches; b += 1) {
    const branch = createTopic({ title: `分支 ${b + 1}` });
    for (let i = 0; i < perBranch; i += 1) {
      branch.children.attached.push(createTopic({ title: `节点 ${b + 1}-${i + 1}` }));
    }
    sheet.rootTopic.children.attached.push(branch);
  }
  return doc;
}
