/**
 * 导图接口。
 *
 * 与后端 `handler/maps.go` 的 DTO 一一对应。三个形状的差别是有意的：
 *
 * - `MapSummary`：列表项，**不含 document**（一页 20 张图就是 20 MB）；
 * - `MapDetail`：详情，多一份完整文档；
 * - `SaveResult`：保存响应，只有版本号与计数——自动保存每几秒一次，
 *   把 1 MB 的文档原样回传是纯浪费，客户端本来就有那份。
 */

import type { WmindDocument } from '@/editor/model/types';
import { api } from './client';
import { query } from './query';
import type { Paged } from './types';

export interface MapSummary {
  uid: string;
  title: string;
  thumbnailUrl: string;
  nodeCount: number;
  sizeBytes: number;
  version: number;
  deleted: boolean;
  deletedAt?: string;
  /** Calculated by the server using the current global retention policy. */
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MapDetail extends MapSummary {
  document: WmindDocument;
}

export interface SaveResult {
  uid: string;
  version: number;
  nodeCount: number;
  updatedAt: string;
}

export interface MapListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  sort?: MapSort;
}

/**
 * 列表排序。
 *
 * 与后端 `domain.MapSort` 一一对应。**故意不提供「相关度」**：搜索走的是
 * 标题子串匹配，没有打分可言，排一个「相关度」出来只是按长度蒙人。
 */
export type MapSort = 'updated' | 'title' | 'created';

/** 服务端在 409 里带回来的信息：前端据此显示「你的 v3 / 服务器 v5」。 */
export interface MapConflictDetails {
  currentVersion: number;
  currentUpdatedAt?: string;
}

export const mapApi = {
  list: ({ page, pageSize, keyword, sort }: MapListQuery = {}): Promise<Paged<MapSummary>> =>
    api.list<MapSummary>(`/maps${query({ page, page_size: pageSize, q: keyword, sort })}`),

  create: (input: { title: string; document: WmindDocument }): Promise<MapDetail> =>
    api.post<MapDetail>('/maps', input),

  get: (uid: string): Promise<MapDetail> => api.get<MapDetail>(`/maps/${encodeURIComponent(uid)}`),

  save: (uid: string, input: { version: number; title: string; document: WmindDocument }): Promise<SaveResult> =>
    api.put<SaveResult>(`/maps/${encodeURIComponent(uid)}`, input),

  rename: (uid: string, title: string): Promise<MapSummary> =>
    api.patch<MapSummary>(`/maps/${encodeURIComponent(uid)}`, { title }),

  remove: (uid: string): Promise<void> => api.delete<void>(`/maps/${encodeURIComponent(uid)}`),

  duplicate: (uid: string): Promise<MapDetail> =>
    api.post<MapDetail>(`/maps/${encodeURIComponent(uid)}/duplicate`),

  /**
   * 写入缩略图地址。传空串表示清除。
   *
   * 与 `save` 分开：自动保存手里没有缩略图，合进保存路径的话两边会互相覆盖。
   * 服务端只接受站内相对路径（以单个 `/` 开头）。
   */
  setThumbnail: (uid: string, thumbnailUrl: string): Promise<void> =>
    api.put<void>(`/maps/${encodeURIComponent(uid)}/thumbnail`, { thumbnailUrl }),

  listTrash: ({ page, pageSize }: MapListQuery = {}): Promise<Paged<MapSummary>> =>
    api.list<MapSummary>(`/trash${query({ page, page_size: pageSize })}`),

  restore: (uid: string): Promise<MapSummary> =>
    api.post<MapSummary>(`/trash/${encodeURIComponent(uid)}/restore`),

  purge: (uid: string): Promise<void> => api.delete<void>(`/trash/${encodeURIComponent(uid)}`),

  emptyTrash: (): Promise<void> => api.delete<void>('/trash'),
};
