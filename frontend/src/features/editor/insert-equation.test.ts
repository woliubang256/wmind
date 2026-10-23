import { describe, expect, it } from 'vitest';
import { renderEquation } from './insert-equation';

describe('公式 SVG', () => {
  it('分式、上下标和根号产生自包含字形，尺寸可测量', () => {
    const result = renderEquation('x=\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}');
    const svg = atob(result.src.split(',')[1]);
    expect(svg).toContain('<path'); expect(svg).not.toContain('foreignObject');
    expect(result.width).toBeGreaterThan(30); expect(result.height).toBeGreaterThan(20);
  });
  it('空输入、未知命令与畸形公式不能写入文档', () => {
    for (const input of ['', '\\notarealcommand{a}', '\\frac{']) expect(() => renderEquation(input)).toThrow('equation');
  });
});
