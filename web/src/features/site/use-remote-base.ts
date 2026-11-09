/**
 * 桌面端「这份数据在服务器上」的接口前缀。
 *
 * 已登录云端时返回 `/desktop/remote-api`（本机后端转发到远端并注入令牌），
 * 其余情况返回 undefined，调用方用默认的 `/api/v1`。
 *
 * 与 `desktopCapabilities` 的区别：那些是「这个形态有没有这项功能」的静态判断，
 * 这里是「这项功能的数据在哪」的动态判断——同一个客户端，未登录时分享不可用，
 * 登录后分享归服务器管。
 */

import { useQuery } from '@tanstack/react-query';
import { fetchDesktopStatus, isDesktop, REMOTE_API_BASE } from '@/lib/desktop';

export function useRemoteBase(): string | undefined {
  const desktop = isDesktop();
  const status = useQuery({
    queryKey: ['desktop', 'status'],
    queryFn: fetchDesktopStatus,
    enabled: desktop,
    staleTime: 10_000,
  });
  return desktop && status.data?.cloud.connected ? REMOTE_API_BASE : undefined;
}

/** 分享功能是否可用：Web 端一直可用，桌面端登录云端后可用（归服务器管）。 */
export function useSharesEnabled(): boolean {
  const desktop = isDesktop();
  const status = useQuery({
    queryKey: ['desktop', 'status'],
    queryFn: fetchDesktopStatus,
    enabled: desktop,
    staleTime: 10_000,
  });
  return !desktop || status.data?.cloud.connected === true;
}
