import { describe, expect, it } from 'vitest';

const sources = Object.entries(import.meta.glob<string>('/src/**/*.tsx', { query: '?raw', import: 'default', eager: true }))
  .filter(([path]) => !path.endsWith('.test.tsx'));

describe('加载入口覆盖守卫', () => {
  it('不再混用旋转圆圈、闪烁骨架或无图片就绪状态的原生图片', () => {
    const missed: string[] = [];
    for (const [path, source] of sources) {
      if (path.endsWith('/ui/loading-image.tsx')) continue;
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (/animate-(?:spin|pulse)|<(?:img|image)\b/.test(code)) missed.push(path);
    }
    expect(missed).toEqual([]);
  });
  it('通用加载文字仅由统一状态组件提供，防止漏掉 W 或重复显示说明', () => {
    const missed = sources.filter(([path, source]) => !path.endsWith('/ui/loading-state.tsx') && /t\(['"]common\.loading['"]\)/.test(source)).map(([path]) => path);
    expect(missed).toEqual([]);
  });
});
