import { useState, type PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { useBrowserLocaleSync } from './locale-store';
import { useSystemThemeSync } from './theme-store';
import { OfflineBanner } from './offline-banner';
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
  // 语言同理：`system` 档下浏览器语言变了要跟着切，订阅也只装一次。
  useBrowserLocaleSync();

  return (
    <QueryClientProvider client={queryClient}>
      <SiteHead />
      {children}
      {/* 断网提示挂在最外层：所有布局、所有页面共用一条，不各写一份。 */}
      <OfflineBanner />
      <Toaster position="bottom-right" richColors />
    </QueryClientProvider>
  );
}
