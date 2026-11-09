import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type { SiteConfig } from '@/lib/api/types';

export const siteKeys = {
  config: ['site', 'config'] as const,
};

/** 站点默认值：接口还没回来时用它渲染，避免登录页闪一下空标题。 */
const FALLBACK: SiteConfig = {
  siteName: 'wmind',
  brand: 'wmind',
  logoUrl: '',
  description: '',
  icp: '',
  registrationEnabled: false,
  passwordMinLength: 8,
  importEnabled: true,
  aiEnabled: false,
  exportEnabled: true,
  userTemplateEnabled: true,
  shareEnabled: true,
  shareDefaultExpireDays: 7,
  shareDefaultAllowDownload: false,
  version: 'dev',
};

/**
 * 拉取公开的站点配置。
 *
 * 未登录可读，所以 `auth: false`——登录页要在拿到令牌之前就知道
 * 「注册是否开放、密码至少几位」。
 *
 * 失败时回落到 FALLBACK 而不是让页面报错：站点配置读不到时，
 * 登录页仍然应该能用（`registrationEnabled: false` 是安全的一侧）。
 *
 * `fresh: true` 让每次挂载都重新拉一遍，给登录页与注册页用。
 * 这两页的配置直接决定「注册入口在不在」：管理员刚关掉注册，缓存里那份
 * 5 分钟内的旧值会让用户看到「立即注册」，点进去填完表单才被 403 拦住。
 * 代价是一次几百字节的 GET，只在真正落到这两页时发生。
 */
export function useSiteConfig({ fresh = false }: { fresh?: boolean } = {}) {
  const query = useQuery({
    queryKey: siteKeys.config,
    queryFn: () => api.get<SiteConfig>('/site/config', { auth: false }),
    staleTime: 5 * 60_000,
    refetchOnMount: fresh ? 'always' : true,
    retry: 1,
  });
  return { config: query.data ?? FALLBACK, isLoading: query.isLoading };
}
