import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': '/src' },
  },
  /**
   * `react-dom/server` 只被导出对话框用到，而对话框是懒加载的，所以 Vite 在
   * 开发期**第一次**打开导出面板时才会发现这个依赖。发现得晚的代价是：它要
   * 重新预构建依赖并整体换掉 `node_modules/.vite/deps`，正在跑的页面会被强制
   * 刷新，用户手上的编辑状态直接没了。
   *
   * 写进 `include` 让它和 react 一起在冷启动时预构建，之后不再触发重优化。
   */
  optimizeDeps: {
    include: ['react-dom/server', 'mathjax-full/js/mathjax.js', 'mathjax-full/js/input/tex.js', 'mathjax-full/js/output/svg.js', 'mathjax-full/js/adaptors/liteAdaptor.js', 'mathjax-full/js/handlers/html.js', 'mathjax-full/js/input/tex/ams/AmsConfiguration.js'],
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * 把不常变的依赖拆成单独的 chunk。
         *
         * 不拆时 react / react-router / react-query / i18next 全挤在
         * index-<hash>.js 里：每次改一行业务代码，用户就要重新下载这
         * 500KB。拆开之后业务代码单独一个文件，依赖文件命中缓存。
         *
         * 用函数而不是对象映射：对象映射只覆盖列出的包本身，它们的
         * 传递依赖（scheduler、use-sync-external-store 等）仍会留在
         * 主 chunk 里，等于白拆。
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          /**
           * `react-dom/server` 必须**不**归入 react chunk。
           *
           * 它只被懒加载的导出对话框引用，归进 react chunk 就等于让首屏多下载
           * 几十 KB 的序列化器——而那正是把导出对话框做成 `React.lazy` 想避免
           * 的事。返回 undefined 让 Rollup 按引用关系把它放进导出那个动态
           * chunk 里。
           *
           * 两种路径都要匹配：`react-dom/server.browser.js` 是个薄包装，
           * 真正的实现（`react-dom-server.browser.production.js`，几百 KB）
           * 在 `react-dom/cjs/` 下面。只匹配前者等于没匹配。
           */
          if (/[\\/]react-dom[\\/](server\.|cjs[\\/]react-dom-server)/.test(id)) return undefined;
          if (/[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id)) return 'react';
          if (id.includes('@tanstack') || id.includes('/zustand/') || id.includes('/immer/')) return 'data';
          if (id.includes('i18next')) return 'i18n';
          if (id.includes('/mathjax-full/') || id.includes('/mj-context-menu/')) return 'mathjax';
          return 'vendor';
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    // Vite injects its client before <meta>; the response header must protect it too.
    headers: { 'Referrer-Policy': 'strict-origin' },
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      // 上传的图片（头像、导入还原的导图图片）由 Go 进程在根路径 `/uploads`
      // 直接回放，生产里由 Nginx 转发。开发时若不转发，页面上每张图都是 404
      // 破图——看起来像导入功能坏了，实际只是代理少了一条。
      '/uploads': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  preview: {
    headers: { 'Referrer-Policy': 'strict-origin' },
  },
  test: {
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
  },
});
