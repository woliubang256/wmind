/**
 * 用户模板接口。
 *
 * 内置的 8 个模板**不走这里**：它们编译进前端包
 * （`features/templates/builtin.ts`），因为选择对话框要渲染实时预览，
 * 文档得在请求回来之前就存在。这里只管「用户把自己的导图另存为模板」。
 *
 * 列表刻意不含 `document`：一份模板可能到 8 MiB，而卡片只需要名字、结构与
 * 缩略图。真要用某个模板建图时，`get` 单独取一次完整文档。
 */

import type { StructureClass, WmindDocument } from '@/editor/model/types';
import { api } from './client';

/** 列表里的一条模板（不含文档）。 */
export interface TemplateSummary {
  uid: string;
  name: string;
  /** 一期恒为 `user`。 */
  category: string;
  structure: StructureClass;
  /** 站内相对路径；空串表示源导图没有缩略图。 */
  thumbnailUrl: string;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 单条读取的结果：在摘要之上带完整文档。 */
export interface TemplateDetail extends TemplateSummary {
  document: WmindDocument;
}

const enc = encodeURIComponent;

export const templateApi = {
  /** 当前用户的模板（不含内置的 8 个）。 */
  list: (): Promise<TemplateSummary[]> => api.get<TemplateSummary[]>('/templates'),

  get: (uid: string): Promise<TemplateDetail> => api.get<TemplateDetail>(`/templates/${enc(uid)}`),

  /** 从导图另存为模板。文档与缩略图都由服务端从源导图复制。 */
  createFromMap: (input: { name: string; mapUid: string }): Promise<TemplateDetail> =>
    api.post<TemplateDetail>('/templates', input),

  rename: (uid: string, name: string): Promise<TemplateSummary> =>
    api.patch<TemplateSummary>(`/templates/${enc(uid)}`, { name }),

  remove: (uid: string): Promise<void> => api.delete<void>(`/templates/${enc(uid)}`),
};
