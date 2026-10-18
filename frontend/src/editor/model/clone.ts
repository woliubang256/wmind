/**
 * 子树深拷贝。
 *
 * 复制 / 粘贴、复制导图、以及「从模板创建」都要用它。**必须重新生成 id**：
 * 两个节点同 id 会让 `findTopic` 静默返回先遇到的那个，之后所有编辑都改错
 * 地方，而且这种错误在 UI 上完全看不出来。
 *
 * 样式与 notes 等字段是普通对象，这里整体复制而不是共享引用——共享会让
 * 「改粘贴出来的节点样式」意外改到原节点（immer 的 draft 写入只影响被写的
 * 路径，但两个节点指向同一个 style 对象时，写其中一个会生成新对象，
 * 另一个仍指向旧的，表面上没问题；真正的问题是 `style` 的引用相等被当作
 * memo 的缓存键时会失效。深拷贝把这类隐患一次性消掉。）
 */

import type { Topic } from './types';

export interface CloneOptions {
  /** 生成新 id 的函数。传 `undefined` 表示保留原 id（仅在确定无冲突时使用）。 */
  nextId: () => string;
  /** 是否保留 collapsed 状态。粘贴时通常重置为展开，避免粘贴出看不见的内容。 */
  keepCollapsed?: boolean;
  /** 是否保留 href / notes / labels / markers / image。默认保留。 */
  keepAnnotations?: boolean;
}

export function cloneTopic(topic: Topic, options: CloneOptions): Topic {
  const { nextId, keepCollapsed = true, keepAnnotations = true } = options;
  return {
    id: nextId(),
    title: topic.title,
    titleFormat: topic.titleFormat,
    structure: topic.structure,
    style: topic.style ? { ...topic.style } : null,
    collapsed: keepCollapsed ? topic.collapsed : false,
    href: keepAnnotations ? topic.href : '',
    notes: keepAnnotations ? { ...topic.notes } : { plain: '', html: '' },
    labels: keepAnnotations ? [...topic.labels] : [],
    markers: keepAnnotations ? topic.markers.map((m) => ({ ...m })) : [],
    image: keepAnnotations && topic.image ? { ...topic.image } : null,
    children: {
      attached: topic.children.attached.map((child) => cloneTopic(child, options)),
      detached: topic.children.detached.map((child) => cloneTopic(child, options)),
    },
    summaries: keepAnnotations
      ? topic.summaries.map((s) => ({ ...s, range: [...s.range], style: s.style ? { ...s.style } : null }))
      : [],
    boundaries: keepAnnotations
      ? topic.boundaries.map((b) => ({ ...b, range: [...b.range], style: b.style ? { ...b.style } : null }))
      : [],
    extensions: [...topic.extensions],
  };
}
