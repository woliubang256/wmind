import { createBrowserRouter, Navigate } from 'react-router';
import { AuthLayout, PublicLayout, RequireAdmin, RequireAuth } from './layouts';
import { LoginPage } from '@/features/auth/login-page';
import { RegisterPage } from '@/features/auth/register-page';
import { AccountPage } from '@/features/account/account-page';
import { PlaceholderPage } from '@/features/dashboard/pages';
import { RecentPage } from '@/features/maps/recent-page';
import { TrashPage } from '@/features/maps/trash-page';
import { PublicSharePage } from '@/features/share/public-share-page';
import { SharesPage } from '@/features/share/shares-page';

/**
 * 管理后台三个页面按需加载。
 *
 * 普通用户永远看不到它们，把这几千行（表格、设置表单、审计列表）塞进
 * 主 bundle 只会让所有人的首屏变慢。React.lazy 在路由层就够用，不必
 * 手写 Suspense。
 */
const adminRoutes = [
  {
    path: '/admin',
    lazy: async () => ({ Component: (await import('@/features/admin/overview-page')).AdminOverviewPage }),
  },
  {
    path: '/admin/users',
    lazy: async () => ({ Component: (await import('@/features/admin/users-page')).AdminUsersPage }),
  },
  {
    path: '/admin/settings',
    lazy: async () => ({ Component: (await import('@/features/admin/settings-page')).AdminSettingsPage }),
  },
];

export const router = createBrowserRouter([
  {
    element: <AuthLayout />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
    ],
  },
  {
    element: <PublicLayout />,
    // 公开分享页：**不套 RequireAuth**。访客通常没有账号，安全边界由
    // 令牌与可选的访问密码承担，见 features/share/public-share-page.tsx。
    children: [{ path: '/s/:token', element: <PublicSharePage /> }],
  },
  {
    element: <RequireAuth />,
    children: [
      {
        lazy: async () => {
          const { AppLayout } = await import('./shell');
          return { Component: AppLayout };
        },
        children: [
          { path: '/', element: <RecentPage /> },
          { path: '/templates', element: <PlaceholderPage page="templates" /> },
          { path: '/shares', element: <SharesPage /> },
          { path: '/trash', element: <TrashPage /> },
          { path: '/account', element: <AccountPage /> },
          {element: <RequireAdmin />, children: adminRoutes},
          {
            path: '/maps/:uid',
            lazy: async () => ({ Component: (await import('@/features/editor/editor-page')).EditorPage }),
          },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
