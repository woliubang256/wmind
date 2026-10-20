/**
 * 导图列表的 query key。
 *
 * 集中在一个文件里，因为「改了一张图之后要把哪些列表刷掉」这个判断会散落在
 * 五六个 mutation 里。写死字符串的结果是某天漏刷一个，用户看到的是「我明明
 * 改了标题，列表还是旧的」——而这种缺陷不会报错。
 */

import type { MapSort } from '@/lib/api/maps';

export interface MapListKey {
  keyword: string;
  sort: MapSort;
}

export const mapKeys = {
  /** 所有导图相关查询的前缀。 */
  root: ['maps'] as const,
  /** 所有列表查询的前缀（含不同关键词/排序）。 */
  lists: () => ['maps', 'list'] as const,
  list: (params: MapListKey) => ['maps', 'list', params] as const,
  /** 回收站列表。与主列表分开：它们的失效时机不同（删除只影响其中一个）。 */
  trash: () => ['maps', 'trash'] as const,
};
