/**
 * 自定义主题接口。
 *
 * 与后端 `handler/themes.go` 的 DTO 一一对应。**只有用户主题走这里**：
 * 10 套内置配色是包内静态资源（`editor/theme/palettes.json`），编辑器首帧
 * 就要解析样式，等不了一个请求。见 docs/04 §5.5。
 *
 * `config` 是一整份 `Theme` 对象，不是 `Palette`：用户存的是「现在这个样子」，
 * 包括调色板、全局字体字号、各角色样式、彩虹开关与布局开关。只存调色板的话，
 * 保存出来的主题和应用出来的效果会差一截。
 */

import type { Theme } from '@/editor/model/types';
import { api } from './client';
import type { Paged } from './types';

export interface CustomTheme {
  uid: string;
  name: string;
  /** 一期恒为 `custom`。 */
  category: string;
  /**
   * 服务端会把它规范成「id = uid、name = 主题名、category = custom」，
   * 但字段本身可能是旧版本前端写下的，所以读取时仍要 `themeFromCustomConfig`
   * 兜一次底（见 `editor/theme/custom.ts`）。
   */
  config: Theme;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const themeApi = {
  list: (): Promise<Paged<CustomTheme>> => api.list<CustomTheme>('/themes'),

  create: (input: { name: string; config: Theme }): Promise<CustomTheme> =>
    api.post<CustomTheme>('/themes', input),

  update: (uid: string, input: { name: string; config: Theme }): Promise<CustomTheme> =>
    api.put<CustomTheme>(`/themes/${encodeURIComponent(uid)}`, input),

  remove: (uid: string): Promise<void> => api.delete<void>(`/themes/${encodeURIComponent(uid)}`),
};
