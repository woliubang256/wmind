/**
 * 分享相关的 react-query 键。
 *
 * `mine` 与 `byMap` 分开：同一个「我的分享」页按 `mapUid` 过滤时是**另一个**
 * 查询，共用键会让过滤结果覆盖掉未过滤的缓存。
 */

export const shareKeys = {
  root: ['shares'] as const,
  byMap: (mapUid: string) => ['shares', 'map', mapUid] as const,
  mine: (mapUid?: string) => ['shares', 'mine', mapUid ?? ''] as const,
  public: (token: string) => ['shares', 'public', token] as const,
};
