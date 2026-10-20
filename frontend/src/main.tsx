import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { Providers } from './app/providers';
import { router } from './app/router';
import { ErrorBoundary } from './components/error-boundary';
import './lib/i18n';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/*
      边界包在 Providers **外面**：QueryClient 建不出来、SiteHead 崩了这些
      路由根本还没轮到的情况，也得有个页面能看。路由内部的错误由 router 顶层
      的 errorElement 兜（见 app/router.tsx），两层各管一段。
    */}
    <ErrorBoundary>
      <Providers>
        <RouterProvider router={router} />
      </Providers>
    </ErrorBoundary>
  </StrictMode>,
);
