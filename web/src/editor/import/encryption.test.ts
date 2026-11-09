/**
 * 加密判定的测试（验收项 IE-06）。
 *
 * 三条证据各自单独测一遍，再测一遍「都不成立时不许误报」——误报比漏报更糟：
 * 一个正常文件被说成「已加密」，用户会真的去 XMind 里找密码，然后发现没有。
 */

import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { assertNotEncrypted, hasSecretKey, looksBinary } from './encryption';
import { ImportError } from './errors';
import { resolveLimits } from './limits';
import { importRegistry } from './builtins';
import { createImportInput, createImportRegistry } from './registry';
import { openZip } from './zip';
import { xmindAdapter } from './xmind';

const LEGACY_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" version="2.0">
  <sheet id="s1"><topic id="root"><title>中心主题</title></topic></sheet>
</xmap-content>`;

const MODERN_CONTENT = JSON.stringify([
  { id: 's1', title: '画布', rootTopic: { id: 'root', title: '中心主题' } },
]);

function archiveOf(files: Record<string, Uint8Array>) {
  return openZip(zipSync(files), resolveLimits());
}

/** 断言抛出的必须是 ImportError 且 code 精确匹配。 */
function expectCode(fn: () => unknown, code: string): ImportError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ImportError);
    expect((error as ImportError).code).toBe(code);
    return error as ImportError;
  }
  throw new Error(`预期抛出 ${code}，但什么都没抛`);
}

describe('looksBinary', () => {
  it('普通 UTF-8 文本不算二进制', () => {
    expect(looksBinary(strToU8('<xmap-content>中心主题</xmap-content>'))).toBe(false);
  });

  it('制表、换行、回车是文本里合法的控制字符', () => {
    expect(looksBinary(new Uint8Array([0x09, 0x0a, 0x0d, 0x41]))).toBe(false);
  });

  it('其余 C0 控制字节一律算二进制', () => {
    expect(looksBinary(new Uint8Array([0x41, 0x00, 0x42]))).toBe(true);
    expect(looksBinary(new Uint8Array([0x41, 0x01]))).toBe(true);
    expect(looksBinary(new Uint8Array([0x1f, 0x41]))).toBe(true);
  });

  it('只看前 512 字节：控制字节在探测窗口之后就不判', () => {
    const bytes = new Uint8Array(600).fill(0x41);
    bytes[520] = 0x00;
    expect(looksBinary(bytes)).toBe(false);
  });

  it('空字节数组不算二进制', () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });
});

describe('hasSecretKey', () => {
  it('顶层键命中', () => {
    expect(hasSecretKey({ password: 'x' })).toBe(true);
    expect(hasSecretKey({ encryption: {} })).toBe(true);
  });

  it('嵌套与数组里的键也算', () => {
    expect(hasSecretKey({ fileEntries: { 'content.json': { passwordHint: '' } } })).toBe(true);
    expect(hasSecretKey([{ a: 1 }, { encrypt: { algorithm: 'AES' } }])).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(hasSecretKey({ PasswordHint: '' })).toBe(true);
  });

  it('普通清单不误报', () => {
    expect(hasSecretKey({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } })).toBe(
      false,
    );
    expect(hasSecretKey([])).toBe(false);
    expect(hasSecretKey(null)).toBe(false);
    expect(hasSecretKey('password')).toBe(false);
  });

  it('超过深度上限后不再下钻', () => {
    let nested: Record<string, unknown> = { password: 'x' };
    for (let index = 0; index < 12; index += 1) nested = { a: nested };
    expect(hasSecretKey(nested)).toBe(false);
  });
});

describe('assertNotEncrypted', () => {
  it('manifest.xml 声明 password-hint（空串）时判为加密', () => {
    const archive = archiveOf({
      'content.xml': strToU8(LEGACY_CONTENT),
      'META-INF/manifest.xml': strToU8(
        '<manifest xmlns="urn:xmind:xmap:xmlns:manifest:1.0" password-hint="">'
          + '<file-entry full-path="content.xml" media-type="text/xml"/></manifest>',
      ),
    });
    expectCode(() => assertNotEncrypted(archive), 'ENCRYPTED');
  });

  it('manifest.xml 带密码提醒文本时同样判为加密', () => {
    const archive = archiveOf({
      'content.xml': strToU8(LEGACY_CONTENT),
      'META-INF/manifest.xml': strToU8('<manifest password-hint="生日">'),
    });
    expectCode(() => assertNotEncrypted(archive), 'ENCRYPTED');
  });

  it('清单正文里提到这几个字、但没有属性赋值时不误报', () => {
    const archive = archiveOf({
      'content.xml': strToU8(LEGACY_CONTENT),
      'META-INF/manifest.xml': strToU8('<manifest><!-- password-hint --></manifest>'),
    });
    expect(() => assertNotEncrypted(archive)).not.toThrow();
  });

  it('manifest.json 里有 password 键时判为加密', () => {
    const archive = archiveOf({
      'content.json': strToU8(MODERN_CONTENT),
      'manifest.json': strToU8('{"file-entries":{},"password-hint":""}'),
    });
    expectCode(() => assertNotEncrypted(archive), 'ENCRYPTED');
  });

  it('metadata.json 里有 encryption 键时判为加密', () => {
    const archive = archiveOf({
      'content.json': strToU8(MODERN_CONTENT),
      'metadata.json': strToU8('{"encryption":{"algorithm":"AES-256"}}'),
    });
    expectCode(() => assertNotEncrypted(archive), 'ENCRYPTED');
  });

  it('content.json 是密文（含控制字节）时判为加密', () => {
    const archive = archiveOf({
      'content.json': new Uint8Array([0x53, 0x61, 0x6c, 0x74, 0x00, 0x01, 0x02, 0x03]),
    });
    expectCode(() => assertNotEncrypted(archive), 'ENCRYPTED');
  });

  it('content.xml 是密文时判为加密', () => {
    const archive = archiveOf({ 'content.xml': new Uint8Array([0x00, 0xff, 0x13, 0x37]) });
    expectCode(() => assertNotEncrypted(archive), 'ENCRYPTED');
  });

  it('正常的现代包不抛', () => {
    const archive = archiveOf({
      'content.json': strToU8(MODERN_CONTENT),
      'metadata.json': strToU8('{}'),
      'manifest.json': strToU8('{"file-entries":{"content.json":{}}}'),
    });
    expect(() => assertNotEncrypted(archive)).not.toThrow();
  });

  it('正常的经典包不抛', () => {
    const archive = archiveOf({
      'content.xml': strToU8(LEGACY_CONTENT),
      'META-INF/manifest.xml': strToU8(
        '<manifest xmlns="urn:xmind:xmap:xmlns:manifest:1.0">'
          + '<file-entry full-path="content.xml" media-type="text/xml"/></manifest>',
      ),
    });
    expect(() => assertNotEncrypted(archive)).not.toThrow();
  });

  it('清单自己坏掉时不影响判定（证据作废，不阻断）', () => {
    const archive = archiveOf({
      'content.json': strToU8(MODERN_CONTENT),
      'manifest.json': strToU8('{ 不是 json'),
    });
    expect(() => assertNotEncrypted(archive)).not.toThrow();
  });

  it('损坏但仍属文本的 content.xml 不算加密', () => {
    const archive = archiveOf({ 'content.xml': strToU8('<xmap-content><sheet></xmap-content>') });
    expect(() => assertNotEncrypted(archive)).not.toThrow();
  });

  it('空包不抛（没有内容不等于加密）', () => {
    expect(() => assertNotEncrypted(archiveOf({ 'meta.xml': strToU8('<meta/>') }))).not.toThrow();
  });
});

describe('接进 XMind 适配器', () => {
  const registry = createImportRegistry([xmindAdapter]);

  it('加密的经典包仍被判为 XMind，但报 ENCRYPTED 而不是 PARSE_FAILED', () => {
    const bytes = zipSync({
      'content.xml': new Uint8Array([0x00, 0x11, 0x22, 0x33]),
      'META-INF/manifest.xml': strToU8('<manifest password-hint="提示">'),
    });
    const detected = registry.detect(createImportInput('加密.xmind', bytes, resolveLimits()));
    expect(detected?.id).toBe('xmind');
    expectCode(() => importRegistry.run({ fileName: '加密.xmind', bytes }), 'ENCRYPTED');
  });

  it('加密的现代包报 ENCRYPTED', () => {
    const bytes = zipSync({
      'content.json': new Uint8Array([0x9c, 0x00, 0x4a, 0x7f]),
      'manifest.json': strToU8('{"password-hint":""}'),
    });
    expectCode(() => importRegistry.run({ fileName: '加密.xmind', bytes }), 'ENCRYPTED');
  });

  it('未加密的文件不受影响', () => {
    const bytes = zipSync({ 'content.json': strToU8(MODERN_CONTENT) });
    const result = importRegistry.run({ fileName: '正常.xmind', bytes });
    expect(result.summary.topics).toBe(1);
  });
});
