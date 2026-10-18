/**
 * 编辑器内核的测试夹具。
 *
 * 只有测试会 import 它，应用代码不引用，因此不会进生产包。
 * 手工构造树（而不是走命令）是为了让每个测试的文档形状一眼可见——
 * 用命令搭树会让测试失败时很难判断是命令错了还是遍历错了。
 */

import { createDocument, createSheet, createTopic } from './model/create';
import type { Sheet, Topic, WmindDocument } from './model/types';

/** 用显式 id 造一个节点，子节点按传入顺序挂在 attached 上。 */
export function topic(id: string, title: string, children: Topic[] = []): Topic {
  const base = createTopic({ id, title });
  base.children.attached = children;
  return base;
}

/**
 * 固定形状的文档：
 *
 *   root
 *   ├── a
 *   │   ├── a1
 *   │   └── a2 (collapsed) ── a2x
 *   └── b
 *       └── b1
 *
 * 外加一个自由主题 f1（带子节点 f1x）。
 */
export function docWithTree(): WmindDocument {
  const root = topic('root', '中心主题', [
    topic('a', 'A', [
      topic('a1', 'A1'),
      { ...topic('a2', 'A2', [topic('a2x', 'A2X')]), collapsed: true },
    ]),
    topic('b', 'B', [topic('b1', 'B1')]),
  ]);

  const sheet: Sheet = {
    ...createSheet({ id: 'sh-1', title: '画布 1' }),
    rootTopic: root,
    floatingTopics: [topic('f1', '自由主题', [topic('f1x', 'F1X')])],
  };

  const doc = createDocument({ title: '测试导图' });
  doc.id = 'doc-1';
  doc.sheets = [sheet];
  return doc;
}

/** 确定性 id 生成器：`id-1`、`id-2`……让断言不受随机 ULID 影响。 */
export function deterministicIds(prefix = 'id'): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}
