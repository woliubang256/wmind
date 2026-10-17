import { createBrowserRouter, Navigate } from 'react-router';
import { AuthLayout, PublicLayout, RequireAdmin, RequireAuth } from './layouts';
import { LoginPage } from '@/features/auth/login-page';
import { PlaceholderPage, PublicSharePage, RecentPage, RegisterPage } from '@/features/dashboard/pages';

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
          { path: '/shares', element: <PlaceholderPage page="account" /> },
          { path: '/trash', element: <PlaceholderPage page="trash" /> },
          { path: '/account', element: <PlaceholderPage page="account" /> },
          {
            element: <RequireAdmin />,
            children: [
              { path: '/admin/users', element: <PlaceholderPage page="users" /> },
              { path: '/admin/settings', element: <PlaceholderPage page="settings" /> },
            ],
          },
          { path: '/maps/:uid', element: <PlaceholderPage page="templates" /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
