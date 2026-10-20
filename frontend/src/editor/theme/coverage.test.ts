/**
 * 字体覆盖查询的测试。
 *
 * 用真实的分片数据（`font-coverage.json`）而不是造一份假表：这张表本身是生成的，
 * 一旦生成脚本把区间解析错了，造假表就一起错、测试还是绿的。
 */

import { describe, expect, it } from 'vitest';
import { coverageOf, coveredCodePointCount, isCovered, uncoveredChars } from './coverage';

describe('coverageOf', () => {
  it('随包分发的族有覆盖表，system 没有', () => {
    expect(coverageOf('sans')).not.toBeNull();
    expect(coverageOf('serif')).not.toBeNull();
    expect(coverageOf('mono')).not.toBeNull();
    // system 就是系统字体本身，报它「回退到系统字体」是自相矛盾。
    expect(coverageOf('system')).toBeNull();
  });

  it('思源黑体与思源宋体共用同一套 Google CJK 切分（同一张表）', () => {
    expect(coverageOf('sans')).toBe(coverageOf('serif'));
  });

  it('中文覆盖量在合理区间（不是空的，也不是宣称覆盖全部 Unicode）', () => {
    const count = coveredCodePointCount('sans');
    expect(count).toBeGreaterThan(10_000);
    expect(count).toBeLessThan(100_000);
  });
});

describe('isCovered', () => {
  it('常用汉字、拉丁字母、中文标点都在覆盖内', () => {
    const ranges = coverageOf('sans')!;
    for (const char of ['思', '维', '导', '图', 'w', '0', '，', '。', '〇', 'é', '—']) {
      expect(isCovered(char.codePointAt(0)!, ranges), char).toBe(true);
    }
  });

  it('emoji 与 CJK 扩展 B/C 区不在覆盖内', () => {
    const ranges = coverageOf('sans')!;
    // 😀 U+1F600、𠮷 U+20BB7（扩展 B）、𰻝 U+30EDD（扩展 G）
    for (const char of ['😀', '𠮷', '𰻝']) {
      expect(isCovered(char.codePointAt(0)!, ranges), char).toBe(false);
    }
  });

  it('等宽族只覆盖拉丁，不覆盖汉字', () => {
    const ranges = coverageOf('mono')!;
    expect(isCovered('w'.codePointAt(0)!, ranges)).toBe(true);
    expect(isCovered('思'.codePointAt(0)!, ranges)).toBe(false);
  });
});

describe('uncoveredChars', () => {
  const sans = coverageOf('sans')!;

  it('返回去重后的缺字，保持首次出现顺序', () => {
    expect(uncoveredChars('甲😀乙😀丙𠮷', sans)).toEqual(['😀', '𠮷']);
  });

  it('空白与控制字符不算缺字', () => {
    // 换行、制表、不换行空格、全角空格都不画字形。
    expect(uncoveredChars(' \n\t\u00a0\u3000', sans)).toEqual([]);
  });

  it('代理对不会被拆成两个乱码单元', () => {
    // 按 UTF-16 单元遍历的话，😀 会被报成两个各占一半的代理码位。
    const missing = uncoveredChars('😀', sans);
    expect(missing).toEqual(['😀']);
    expect(missing[0]).toHaveLength(2); // 一个 emoji 在 JS 里是 2 个 code unit
  });

  it('全部覆盖时返回空数组', () => {
    expect(uncoveredChars('产品规划 v2.0（草稿）', sans)).toEqual([]);
  });
});
