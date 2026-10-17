import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': '/src' },
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
          if (/[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id)) return 'react';
          if (id.includes('@tanstack') || id.includes('/zustand/') || id.includes('/immer/')) return 'data';
          if (id.includes('i18next')) return 'i18n';
          return 'vendor';
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
  },
});
