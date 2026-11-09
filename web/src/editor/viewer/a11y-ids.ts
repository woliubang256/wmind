/**
 * 画布节点的 DOM id。
 *
 * `aria-activedescendant` 靠 id 指向「当前活动项」，而焦点的落点是画布容器
 * 而不是节点本身（`<g>` 在 SVG 里没法真正获得焦点）。所以两边必须用**同一个
 * 函数**算 id：渲染层写 `id`，页面写 `aria-activedescendant`，谁也不能自己拼
 * 字符串——一处改前缀、另一处忘了改，读屏就静默地什么都不念，而且没有任何报错。
 */

const PREFIX = 'wmind-topic-';

export function topicElementId(topicId: string): string {
  return `${PREFIX}${topicId}`;
}
