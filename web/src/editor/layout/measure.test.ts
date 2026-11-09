import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearMeasureCache,
  defaultBackend,
  measureText,
  measureTopic,
  setMeasureBackend,
  type FontSpec,
  type MeasureBackend,
} from './measure';
import { computeStyle } from '../theme/resolve';
import { defaultTheme, createTopic } from '../model/create';
import type { TopicImage } from '../model/types';

/**
 * 每个字符固定 `size * 0.5` 宽的后端：让折行位置可精确断言。
 * 默认后端在没有 DOM 时是启发式估算，系数会变，不适合断言具体行数。
 */
const halfEm: MeasureBackend = {
  widthOf: (text, font) => [...text].length * font.size * 0.5,
};

const font: FontSpec = { family: 'sans', size: 20, weight: 400, italic: false };

beforeEach(() => {
  setMeasureBackend(halfEm);
});

describe('measureText 折行', () => {
  it('空字符串返回一行空文本', () => {
    const result = measureText('', font, 100);
    expect(result.lines).toEqual(['']);
    expect(result.width).toBe(0);
    expect(result.height).toBe(Math.round(20 * 1.4));
  });

  it('中文按字断行（10px/字，宽度 50 时每行 5 字）', () => {
    const result = measureText('一二三四五六七八九十', font, 50);
    expect(result.lines).toEqual(['一二三四五', '六七八九十']);
    expect(result.width).toBe(50);
  });

  it('英文按词断行，不把单词拆开', () => {
    // 每个字符 10px；"alpha" 50px、"beta" 40px、空格 10px
    const result = measureText('alpha beta gamma', font, 100);
    expect(result.lines).toEqual(['alpha beta', 'gamma']);
  });

  it('单个词超宽时按字符硬断，避免溢出节点', () => {
    const result = measureText('abcdefghij', font, 30);
    expect(result.lines).toEqual(['abc', 'def', 'ghi', 'j']);
  });

  it('\\n 强制换行且保留空行', () => {
    const result = measureText('甲\n\n乙', font, 200);
    expect(result.lines).toEqual(['甲', '', '乙']);
  });

  it('行首不保留空格，行尾空格被裁掉', () => {
    const result = measureText('aaa bbb', font, 35);
    expect(result.lines).toEqual(['aaa', 'bbb']);
  });

  it('高度 = 行数 × 行高（1.4 倍字号，取整）', () => {
    const result = measureText('一\n二\n三', font, 200);
    expect(result.lines).toHaveLength(3);
    expect(result.height).toBe(3 * Math.round(20 * 1.4));
  });

  it('宽度四舍五入到 0.5px', () => {
    const odd: MeasureBackend = { widthOf: () => 10.3 };
    setMeasureBackend(odd);
    expect(measureText('x', font, 100).width).toBe(10.5);
  });

  it('maxWidth <= 0 时不折行', () => {
    expect(measureText('一二三', font, 0).lines).toEqual(['一二三']);
  });
});

describe('measureText 缓存', () => {
  it('相同文本与字体只调用一次后端', () => {
    let calls = 0;
    setMeasureBackend({
      widthOf: (text, f) => {
        calls += 1;
        return [...text].length * f.size;
      },
    });
    measureText('缓存', font, 200);
    const afterFirst = calls;
    measureText('缓存', font, 200);
    expect(calls).toBe(afterFirst);
  });

  it('缓存键含字体，换字号不会命中旧结果', () => {
    let calls = 0;
    setMeasureBackend({
      widthOf: (text, f) => {
        calls += 1;
        return [...text].length * f.size;
      },
    });
    const a = measureText('同样文本', font, 500);
    const b = measureText('同样文本', { ...font, size: 40 }, 500);
    expect(b.width).toBe(a.width * 2);
    expect(calls).toBeGreaterThan(1);
  });

  it('缓存键含字重与斜体', () => {
    let calls = 0;
    setMeasureBackend({
      widthOf: () => {
        calls += 1;
        return 10;
      },
    });
    measureText('x', font, 100);
    measureText('x', { ...font, weight: 700 }, 100);
    measureText('x', { ...font, italic: true }, 100);
    expect(calls).toBe(3);
  });
});

describe('measureTopic', () => {
  const theme = defaultTheme();

  function sizeOf(title: string, styleOverrides = {}) {
    const topic = createTopic({ id: 't', title });
    const style = {
      ...computeStyle(topic, { depth: 1, branchIndex: 0, isRoot: false, isFloating: false, isSummary: false }, theme),
      ...styleOverrides,
    };
    return { topic, style, size: measureTopic(topic, style) };
  }

  it('自动宽度：内容宽 + 左右内边距', () => {
    // 5 个字 × 7px = 35px，小于最小内容宽 60 → 取 60 + 24 = 84
    const { size } = sizeOf('五个汉字');
    expect(size.width).toBe(84);
  });

  it('自动宽度：内容超过最小宽度时按内容算', () => {
    // depth 1 用 mainTopic，字号 16 → 每字 8px。20 字 = 160 + 24 = 184
    const { size } = sizeOf('一二三四五六七八九十一二三四五六七八九十');
    expect(size.width).toBe(184);
  });

  it('自动宽度封顶 320 + 内边距，超出折行', () => {
    const { size } = sizeOf('字'.repeat(100));
    expect(size.width).toBe(320 + 24);
    expect(size.lines.length).toBeGreaterThan(1);
  });

  it('固定宽度直接采用 style.width，文本按减去内边距后的宽度折行', () => {
    const { size } = sizeOf('一二三四五六七八九十', { autoWidth: false, width: 100 });
    expect(size.width).toBe(100);
    // 可用内容宽 100 - 24 = 76，每字 8px → 每行 9 字（72），第 10 字换行
    expect(size.lines).toEqual(['一二三四五六七八九', '十']);
  });

  it('高度 = 行数 × 行高 + 上下内边距', () => {
    const { size } = sizeOf('甲\n乙', { autoWidth: false, width: 200 });
    expect(size.lines).toHaveLength(2);
    // 字号 16 → 行高 round(16 * 1.4) = 22
    expect(size.height).toBe(2 * Math.round(16 * 1.4) + 16);
  });
});

describe('measureTopic 带图片', () => {
  const theme = defaultTheme();

  function sizeOf(title: string, image: TopicImage | null) {
    const topic = createTopic({ id: 't', title });
    topic.image = image;
    const style = computeStyle(
      topic,
      { depth: 1, branchIndex: 0, isRoot: false, isFloating: false, isSummary: false },
      theme,
    );
    return measureTopic(topic, style);
  }

  it('没有图片时 image 为 null', () => {
    expect(sizeOf('标题', null).image).toBeNull();
  });

  it('高度加上间距与图片高，宽度取文本与图片的较大者', () => {
    const text = sizeOf('标题', null);
    const withImage = sizeOf('标题', { src: '/uploads/a.png', width: 200, height: 100 });

    expect(withImage.image).toEqual({ src: '/uploads/a.png', width: 200, height: 100 });
    // 图片比文本宽 → 盒子宽度跟着图片走（200 + 左右内边距 24）
    expect(withImage.width).toBe(224);
    expect(withImage.height).toBe(text.height + 6 + 100);
  });

  it('图片比文本窄时盒子宽度仍由文本决定', () => {
    const text = sizeOf('一二三四五六七八九十', null);
    const withImage = sizeOf('一二三四五六七八九十', { src: '/uploads/a.png', width: 40, height: 40 });
    expect(withImage.width).toBe(text.width);
    expect(withImage.height).toBe(text.height + 6 + 40);
  });

  it('超大图片等比缩小到上限，不撑爆布局', () => {
    // 5000×5000：缩到 240×240（受最大高度约束），比例不变
    const size = sizeOf('标题', { src: '/uploads/big.png', width: 5000, height: 5000 });
    expect(size.image?.width).toBe(240);
    expect(size.image?.height).toBe(240);
  });

  it('小图不放大，只保证不小于最小尺寸', () => {
    expect(sizeOf('标题', { src: '/uploads/s.png', width: 8, height: 4 }).image).toEqual({
      src: '/uploads/s.png',
      width: 16,
      height: 16,
    });
  });

  it('只给一个维度时按 4:3 补另一个', () => {
    const size = sizeOf('标题', { src: '/uploads/x.png', width: 0, height: 60 });
    expect(size.image?.height).toBe(60);
    expect(size.image?.width).toBe(80);
  });
});

describe('后端选择', () => {
  it('没有 DOM 时默认用启发式后端且不抛错', () => {
    setMeasureBackend(null);
    expect(() => defaultBackend().widthOf('测试', font)).not.toThrow();
  });

  it('启发式后端里 CJK 比拉丁字符宽', () => {
    setMeasureBackend(null);
    const impl = defaultBackend();
    expect(impl.widthOf('中', font)).toBeGreaterThan(impl.widthOf('a', font));
  });
});

describe('clearMeasureCache', () => {
  it('清空后重新量一遍（换字体族后必须作废旧宽度）', () => {
    let calls = 0;
    setMeasureBackend({
      widthOf: (text, spec) => {
        calls += 1;
        return [...text].length * spec.size;
      },
    });

    measureText('一二三', font, 1000);
    const afterFirst = calls;
    measureText('一二三', font, 1000);
    // 同样的文本 + 同样的字体规格 → 命中缓存，不再调后端。
    expect(calls).toBe(afterFirst);

    // 字体分片到齐后调用：缓存里存的是回退字体的宽度，必须作废。
    clearMeasureCache();
    measureText('一二三', font, 1000);
    expect(calls).toBeGreaterThan(afterFirst);
  });
});
