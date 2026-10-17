import { useState, type PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { useSystemThemeSync } from './theme-store';
import { SiteHead } from '@/features/site/site-head';

export function Providers({ children }: PropsWithChildren) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
      },
      mutations: { retry: 0 },
    },
  }));

  // 系统深色模式变化的订阅只装一次：挂在 Providers 而不是每个页面，
  // 否则路由切换会反复解绑/重绑，切页瞬间的变化会漏掉。
  useSystemThemeSync();

  return (
    <QueryClientProvider client={queryClient}>
      <SiteHead />
      {children}
      <Toaster position="bottom-right" richColors />
    </QueryClientProvider>
  );
}
