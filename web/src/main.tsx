import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { Providers } from './app/providers';
import { router } from './app/router';
import { ErrorBoundary } from './components/error-boundary';
import './lib/i18n';
import './styles.css';

/**
 * 桌面壳的窗口没有系统标题栏（红绿灯叠在页面左上角）。
 *
 * 在首帧前就打上标记，样式表据此预留红绿灯区域——等 React 挂载后再加类，
 * 首帧会把品牌 logo 画到红绿灯底下，然后跳一下。
 */
if (typeof window !== 'undefined' && window.__WMIND__) {
  document.documentElement.classList.add('wmind-desktop');
  // 平台标记：WebKit（macOS / Linux）对 backdrop-filter 不做 GPU 加速，桌面端
  // 要关掉整屏模糊；Windows 的 WebView2 是 Chromium，模糊很便宜，保留原效果。
  const platform = window.mygo?.platform;
  if (platform) document.documentElement.dataset.platform = platform;

  // 阻止 WebView 的**整页缩放**：Ctrl/⌘ + 滚轮、触控板捏合都会把整个界面
  // （含顶栏文字）一起放大缩小。应用自己的缩放只作用于画布，界面不该跟着变。
  //
  // 只 preventDefault 不 stopPropagation：画布的 Ctrl/⌘+滚轮缩放照样能收到事件。
  window.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  }, { passive: false, capture: true });
  // WebKit（macOS）的捏合走 gesture 事件，不是 wheel。
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    window.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  }
  // 键盘的整页缩放（Windows 上 WebView2 默认开启 Ctrl + +/-/0）也一并挡掉。
  // 只挡默认行为：画布自己的 Ctrl/⌘+0、Ctrl/⌘+1 快捷键照常生效。
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (['+', '=', '-', '_', '0'].includes(event.key)) event.preventDefault();
  }, { capture: true });
}

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
