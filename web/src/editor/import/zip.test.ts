/**
 * zip 安全外壳的测试。
 *
 * 重点不是「能读出 content.json」（那是最容易的部分），而是四条防线：
 * 固定文件名、路径穿越、条目爆炸、解压总量。每条都用一个**会失败**的样本
 * 来证明它真的挡住了，而不是只测 happy path。
 */

import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { IMPORT_LIMITS, resolveLimits } from './limits';
import { ImportError } from './errors';
import { isResourceEntryName, isSafeEntryName, looksLikeZip, openZip } from './zip';

function limits(overrides: Partial<typeof IMPORT_LIMITS> = {}) {
  return resolveLimits(overrides);
}

function zipOf(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files);
}

/** 断言抛出的必须是 ImportError 且 code 精确匹配。 */
function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ImportError);
    expect((error as ImportError).code).toBe(code);
    return error as ImportError;
  }
  throw new Error(`预期抛出 ${code}，但什么都没抛`);
}

describe('looksLikeZip', () => {
  it('识别本地文件头与空包签名', () => {
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe(true);
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0]))).toBe(true);
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b, 0x07, 0x08, 0, 0]))).toBe(true);
  });

  it('把普通文本、过短输入判为非 zip', () => {
    expect(looksLikeZip(strToU8('# 标题\n\n正文'))).toBe(false);
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b]))).toBe(false);
    expect(looksLikeZip(new Uint8Array([]))).toBe(false);
  });
});

describe('isSafeEntryName', () => {
  it('放行普通条目名', () => {
    expect(isSafeEntryName('content.json')).toBe(true);
    expect(isSafeEntryName('resources/images/a.png')).toBe(true);
    expect(isSafeEntryName('META-INF/manifest.xml')).toBe(true);
  });

  it('挡住路径穿越与绝对路径', () => {
    // 这些名字如果被当成路径拼出去，就会写到工程目录外面。
    expect(isSafeEntryName('../evil.json')).toBe(false);
    expect(isSafeEntryName('a/../../evil.json')).toBe(false);
    expect(isSafeEntryName('/etc/passwd')).toBe(false);
    expect(isSafeEntryName('C:/windows/system32')).toBe(false);
    expect(isSafeEntryName('resources/./a.png')).toBe(false);
    expect(isSafeEntryName('resources//a.png')).toBe(false);
    expect(isSafeEntryName('resources\\a.png')).toBe(false);
    expect(isSafeEntryName('a\0b.png')).toBe(false);
  });

  it('挡住空名与超长名', () => {
    expect(isSafeEntryName('')).toBe(false);
    expect(isSafeEntryName('a'.repeat(513))).toBe(false);
  });
});

describe('isResourceEntryName', () => {
  it('只认 resources/ 下且名字合法的条目', () => {
    expect(isResourceEntryName('resources/a.png')).toBe(true);
    expect(isResourceEntryName('resources/deep/b.jpg')).toBe(true);
    // 前缀本身不算条目
    expect(isResourceEntryName('resources/')).toBe(false);
    // 前缀像但不是
    expect(isResourceEntryName('resourcesx/a.png')).toBe(false);
    expect(isResourceEntryName('resources/../a.png')).toBe(false);
    expect(isResourceEntryName('content.json')).toBe(false);
  });
});

describe('openZip 结构读取', () => {
  it('读出白名单结构文件，忽略缩略图与附件', () => {
    const archive = openZip(
      zipOf({
        'content.json': strToU8('{"a":1}'),
        'Thumbnails/thumbnail.png': new Uint8Array([1, 2, 3]),
        'attachments/x.docx': new Uint8Array([4, 5]),
      }),
      limits(),
    );

    expect(archive.has('content.json')).toBe(true);
    expect(archive.text('content.json')).toBe('{"a":1}');
    // 缩略图与附件不解压，也不出现在可读集合里
    expect(archive.has('Thumbnails/thumbnail.png')).toBe(false);
    expect(archive.bytes('Thumbnails/thumbnail.png')).toBeNull();
    // 但条目名清单里有——诊断信息要用
    expect(archive.entries()).toContain('Thumbnails/thumbnail.png');
  });

  it('不存在的结构文件返回 null 而不是抛错', () => {
    const archive = openZip(zipOf({ 'content.xml': strToU8('<x/>') }), limits());
    expect(archive.text('content.json')).toBeNull();
    expect(archive.bytes('styles.xml')).toBeNull();
    expect(archive.text('content.xml')).toBe('<x/>');
  });

  it('拒绝白名单之外的名字，即使它在包里存在', () => {
    // 白名单是精确集合，不是前缀匹配：`content.json.bak` 不该被读出来。
    const archive = openZip(
      zipOf({ 'content.json.bak': strToU8('{}'), 'content.json': strToU8('{"ok":1}') }),
      limits(),
    );
    expect(archive.text('content.json.bak')).toBeNull();
    expect(archive.text('content.json')).toBe('{"ok":1}');
  });

  it('UTF-8 解码去掉 BOM', () => {
    // 带 BOM 的 JSON 直接 JSON.parse 会炸，这里必须吃掉。
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8('{"b":2}')]);
    const archive = openZip(zipOf({ 'content.json': withBom }), limits());
    expect(archive.text('content.json')).toBe('{"b":2}');
  });

  it('支持 stored（未压缩）条目', () => {
    const archive = openZip(
      zipSync({ 'content.json': [strToU8('{"s":1}'), { level: 0 }] }),
      limits(),
    );
    expect(archive.text('content.json')).toBe('{"s":1}');
  });
});

describe('openZip 安全闸门', () => {
  it('非 zip 抛 NOT_A_ZIP', () => {
    expectCode(() => openZip(strToU8('just text'), limits()), 'NOT_A_ZIP');
  });

  it('输入本身超限抛 FILE_TOO_LARGE', () => {
    const bytes = zipOf({ 'content.json': strToU8('{}') });
    expectCode(() => openZip(bytes, limits({ maxInputBytes: 10 })), 'FILE_TOO_LARGE');
  });

  it('解压总量超限抛 UNZIP_LIMIT_EXCEEDED', () => {
    // 4KB 的明文压成几百字节，压缩比 > 10。把上限设成 1KB，
    // 走的就是「200MB 处中止」同一条代码路径。
    const payload = new Uint8Array(4096);
    const bytes = zipOf({ 'content.json': payload });
    expect(bytes.length).toBeLessThan(4096);
    expectCode(
      () => openZip(bytes, limits({ maxTotalUncompressedBytes: 1024 })),
      'UNZIP_LIMIT_EXCEEDED',
    );
  });

  it('真实压缩包在 4MB 上限处中止（8MB 全零载荷）', () => {
    const payload = new Uint8Array(8 * 1024 * 1024);
    const bytes = zipOf({ 'content.json': payload });
    const error = expectCode(
      () => openZip(bytes, limits({ maxTotalUncompressedBytes: 4 * 1024 * 1024 })),
      'UNZIP_LIMIT_EXCEEDED',
    );
    expect(error.params.limit).toBe(4 * 1024 * 1024);
  });

  it('单条目超限抛 ENTRY_TOO_LARGE', () => {
    const bytes = zipOf({ 'content.json': new Uint8Array(2048) });
    expectCode(
      () => openZip(bytes, limits({ maxEntryBytes: 1024 })),
      'ENTRY_TOO_LARGE',
    );
  });

  it('条目数超限抛 TOO_MANY_ENTRIES', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 10; i += 1) files[`Thumbnails/t${i}.png`] = strToU8('x');
    expectCode(() => openZip(zipOf(files), limits({ maxEntries: 5 })), 'TOO_MANY_ENTRIES');
  });

  it('两次扫描共享同一份预算，不会各算各的', () => {
    // 结构文件 600B + 资源 600B = 1200B。上限 1000B：
    // 结构扫描通过（600 < 1000），资源扫描必须因为累计到 1200 而失败。
    // 如果两次扫描各自记账，这里会静默通过——那正是要防的漏洞。
    const bytes = zipOf({
      'content.json': new Uint8Array(600),
      'resources/a.png': new Uint8Array(600),
    });
    const archive = openZip(bytes, limits({ maxTotalUncompressedBytes: 1000 }));
    expect(archive.text('content.json')).not.toBeNull();
    expectCode(() => archive.resources(), 'UNZIP_LIMIT_EXCEEDED');
  });
});

describe('openZip resources', () => {
  it('只解压 resources/ 下的条目，并缓存结果', () => {
    const bytes = zipOf({
      'content.json': strToU8('{}'),
      'resources/a.png': new Uint8Array([1, 2, 3]),
      'resources/deep/b.png': new Uint8Array([4]),
      'Thumbnails/thumbnail.png': new Uint8Array([9]),
    });
    const archive = openZip(bytes, limits());

    const first = archive.resources();
    expect([...first.keys()].sort()).toEqual(['resources/a.png', 'resources/deep/b.png']);
    expect(first.get('resources/a.png')).toEqual(new Uint8Array([1, 2, 3]));

    // 第二次必须是同一个对象（缓存），否则每张图都要重解压一遍整个包
    expect(archive.resources()).toBe(first);
  });

  it('没有 resources/ 时返回空表', () => {
    const archive = openZip(zipOf({ 'content.json': strToU8('{}') }), limits());
    expect(archive.resources().size).toBe(0);
  });
});

describe('默认上限', () => {
  it('与 docs/06 §2.1.2 的数字一致', () => {
    expect(IMPORT_LIMITS.maxInputBytes).toBe(50 * 1024 * 1024);
    expect(IMPORT_LIMITS.maxTotalUncompressedBytes).toBe(200 * 1024 * 1024);
    expect(IMPORT_LIMITS.maxEntryBytes).toBe(50 * 1024 * 1024);
    expect(IMPORT_LIMITS.maxTopics).toBe(20_000);
  });

  it('resolveLimits 忽略非法覆盖值，避免把上限变成 NaN', () => {
    const resolved = resolveLimits({ maxTopics: Number.NaN, maxEntryBytes: -1 });
    expect(resolved.maxTopics).toBe(IMPORT_LIMITS.maxTopics);
    expect(resolved.maxEntryBytes).toBe(IMPORT_LIMITS.maxEntryBytes);
  });

  it('resolveLimits 只覆盖传进来的键', () => {
    const resolved = resolveLimits({ maxTopics: 7 });
    expect(resolved.maxTopics).toBe(7);
    expect(resolved.maxInputBytes).toBe(IMPORT_LIMITS.maxInputBytes);
  });
});
