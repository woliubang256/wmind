import { useQuery } from '@tanstack/react-query';
import { api, setAccessToken, type CurrentUser } from '@/lib/api/client';

export const authKeys = {
  currentUser: ['auth', 'me'] as const,
};

async function loadCurrentUser(): Promise<CurrentUser | null> {
  try {
    // apiRequest coalesces an expired-token refresh and retries /auth/me once.
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
