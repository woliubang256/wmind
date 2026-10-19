/**
 * 自定义主题的数据通道：拉列表 + 保存 + 删除。
 *
 * 只在 `enabled` 为真时发请求。编辑器有两条本地入口（`/maps/demo`、
 * `/maps/stress`）不连后端：那两个页面里发一次 `GET /themes` 会拿到 401，
 * 而 401 会触发一次静默刷新，刷新再失败就会把用户踢到登录页——点开演示
 * 却要求登录，是最容易被当成「坏了」的那种 bug。
 *
 * 缓存键只有 `['themes']`：主题是「当前用户的」，没有跨用户共享的部分。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { Theme } from '@/editor/model/types';
import { themeApi, type CustomTheme } from '@/lib/api/themes';

export const CUSTOM_THEMES_KEY = ['themes'] as const;

export interface CustomThemesController {
  themes: CustomTheme[];
  loading: boolean;
  /** 拉列表失败时的提示；成功时为 null。 */
  error: string | null;
  saving: boolean;
  removing: boolean;
  save: (name: string, theme: Theme) => Promise<boolean>;
  remove: (uid: string) => Promise<boolean>;
}

export function useCustomThemes(enabled: boolean): CustomThemesController {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: CUSTOM_THEMES_KEY,
    queryFn: async () => (await themeApi.list()).items,
    enabled,
    // 主题列表变动极少，但「刚保存完就该看见」——失效由 mutation 主动触发，
    // 这里不需要短 staleTime。
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: CUSTOM_THEMES_KEY });

  const create = useMutation({
    mutationFn: (input: { name: string; theme: Theme }) =>
      themeApi.create({ name: input.name, config: input.theme }),
    onSuccess: (created) => {
      void invalidate();
      toast.success(t('editor.panel.canvas.customSaved', { name: created.name }));
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : t('editor.panel.canvas.customSaveFailed'));
    },
  });

  const destroy = useMutation({
    mutationFn: (uid: string) => themeApi.remove(uid),
    onSuccess: () => {
      void invalidate();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : t('editor.panel.canvas.customRemoveFailed'));
    },
  });

  return {
    themes: query.data ?? [],
    loading: query.isPending && enabled,
    error: query.isError ? (query.error instanceof Error ? query.error.message : t('editor.panel.canvas.customLoadFailed')) : null,
    saving: create.isPending,
    removing: destroy.isPending,
    // 返回 boolean 而不是抛出：调用方（面板里的输入框）只需要知道「要不要清空
    // 名字」，错误已经通过 toast 说过了。再往外抛会让每个调用点写一遍 try/catch。
    save: async (name, theme) => {
      try {
        await create.mutateAsync({ name, theme });
        return true;
      } catch {
        return false;
      }
    },
    remove: async (uid) => {
      try {
        await destroy.mutateAsync(uid);
        return true;
      } catch {
        return false;
      }
    },
  };
}
