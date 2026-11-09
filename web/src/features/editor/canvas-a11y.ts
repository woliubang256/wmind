/**
 * 画布的读屏播报文案。
 *
 * 拆成纯函数的原因和 `keymap.ts` 一样：**「选中一个节点时该说什么」是这套
 * 无障碍实现里唯一有分支判断的地方**，而它在浏览器里几乎没法断言——读屏的
 * 实际发声不进 DOM。做成「返回 i18n key + 参数」的纯函数，就能用几行测试把
 * 四种情形（未选中 / 叶子 / 有子节点 / 已折叠 / 多选）全部钉住，剩下的只是
 * 把结果交给 `t()`。
 *
 * 为什么不让这个模块自己调 `t()`：内核层（`editor/`）不持有 UI 文案，文案在
 * `lib/i18n/locales` 里，调用方负责翻译。这样同一个播报既能给中文界面用，
 * 也能给以后的英文界面用，而测试不用初始化 i18next。
 */

/** 一条待翻译的播报：key + 插值参数。 */
export interface A11yMessage {
  key: string;
  params: Record<string, string | number>;
}

/** 播报需要的节点信息。字段都是渲染层已经算好的，不在这里重新遍历。 */
export interface SelectedTopicInfo {
  title: string;
  /** 层级，从 1 开始（根节点是 1）。 */
  level: number;
  /** 直接子主题数。 */
  childCount: number;
  collapsed: boolean;
}

/** 画布本身的名称：`<角色>` + 一句摘要，读屏进入画布时先听到它。 */
export function canvasLabel(args: { title: string; nodeCount: number }): A11yMessage {
  return {
    key: 'editor.a11y.canvasLabel',
    params: { title: args.title, total: args.nodeCount },
  };
}

/**
 * 选中变化时的播报。
 *
 * 为什么不播报「删除了 N 个主题」「已加粗」这类动作结果：播报每一件事会让
 * 读屏变成一台不停说话的收音机，用户按方向键连走五步就得听五段无关的话。
 * 选中变化是唯一每步都必须说清楚的——它就是导航本身。
 */
export function selectionAnnouncement(selected: readonly SelectedTopicInfo[]): A11yMessage {
  if (selected.length === 0) {
    return { key: 'editor.a11y.selectionNone', params: {} };
  }

  if (selected.length > 1) {
    return { key: 'editor.a11y.selectionMany', params: { total: selected.length } };
  }

  const topic = selected[0] as SelectedTopicInfo;
  const params = { title: topic.title, level: topic.level, children: topic.childCount };

  // 折叠与「无子节点」互斥：折叠徽标只在有子节点时才出现，所以这两个分支
  // 不会同时命中，不需要再排优先级。
  if (topic.collapsed) return { key: 'editor.a11y.selectionCollapsed', params };
  if (topic.childCount === 0) return { key: 'editor.a11y.selectionLeaf', params };
  return { key: 'editor.a11y.selectionParent', params };
}
