/**
 * 模板相关的 react-query 键。
 *
 * 集中定义是为了让「另存为模板后要刷新哪些缓存」只有一处答案：`root` 前缀
 * 一失效，列表与详情都跟着失效，调用点不需要知道有哪些查询存在。
 */

export const templateKeys = {
  root: ['templates'] as const,
  list: () => [...templateKeys.root, 'list'] as const,
  detail: (uid: string) => [...templateKeys.root, 'detail', uid] as const,
};
