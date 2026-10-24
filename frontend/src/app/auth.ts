import { useQuery } from '@tanstack/react-query';
import { api, getAccessToken, refreshSession, setAccessToken, type CurrentUser } from '@/lib/api/client';

export const authKeys = {
  currentUser: ['auth', 'me'] as const,
};

export async function loadCurrentUser(): Promise<CurrentUser | null> {
  try {
    // 冷启动的内存中没有令牌；refresh 已返回用户，无需先 401 再查询 me。
    if (!getAccessToken()) return (await refreshSession())?.user ?? null;
    // 页面内已有令牌时正常查询，过期仍由 apiRequest 单飞刷新并重试一次。
    return await api.get<CurrentUser>('/auth/me');
  } catch (error) {
    if (error instanceof Error && 'status' in error && (error.status === 401 || error.status === 403)) {
      setAccessToken(null);
      return null;
    }
    throw error;
  }
}

export function useCurrentUser() {
  return useQuery({
    queryKey: authKeys.currentUser,
    queryFn: loadCurrentUser,
    retry: false,
    staleTime: 60_000,
  });
}
