import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { build, loadConfigFromFile } from 'vite';

const fixtures = [];
const fontRegistry = resolve(import.meta.dirname, '../editor/theme/fonts.ts');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 20);

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wmind-public-assets-')));
  fixtures.push(root);
  await mkdir(join(root, 'public/fonts'), { recursive: true });
  for (const family of ['sans', 'serif', 'mono']) {
    await mkdir(join(root, `public/fonts/${family}`));
    await writeFile(join(root, `public/fonts/${family}/1.woff2`), `${family}-font`);
    await writeFile(join(root, `public/fonts/${family}.css`), `@font-face { font-family: '${family}'; font-style: normal; font-weight: 400; src: url('/fonts/${family}/1.woff2') format('woff2'); unicode-range: U+4E00-9FFF; }\n`);
  }
  await writeFile(join(root, 'public/wmind-logo.jpg'), 'logo-v1');
  await writeFile(join(root, 'index.html'), '<html><head><link rel="icon" href="/wmind-logo.jpg"></head><body><script type="module" src="/main.ts"></script></body></html>');
  await writeFile(join(root, 'main.ts'), `import { FONT_DEFINITIONS } from ${JSON.stringify(fontRegistry)}; import { publicAssetUrl } from 'virtual:wmind-public-assets'; globalThis.fixtureFonts = FONT_DEFINITIONS; globalThis.fixtureLogo = publicAssetUrl('/wmind-logo.jpg'); globalThis.fixtureCustom = publicAssetUrl('https://example.test/logo.jpg');`);
  return root;
}

async function compile(root) {
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, resolve(import.meta.dirname, '../../vite.config.ts'));
  if (!loaded) throw new Error('Missing frontend build configuration');
  const result = await build({
    ...loaded.config,
    root,
    configFile: false,
    logLevel: 'silent',
    build: { write: false, minify: false, modulePreload: false },
  });
  if (!('output' in result)) throw new Error('Expected one Vite output');
  const files = new Map(result.output.map((file) => [file.fileName, file.type === 'asset' ? file.source : file.code]));
  const entry = result.output.find((file) => file.type === 'chunk' && file.isEntry);
  if (!entry || entry.type !== 'chunk') throw new Error('Missing fixture entry');
  const scope = {};
  runInNewContext(entry.code, { globalThis: scope });
  return { files, fonts: scope.fixtureFonts, logo: scope.fixtureLogo, custom: scope.fixtureCustom, html: String(files.get('index.html')) };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('生产公共资源内容版本', () => {
  it('字体 CSS、实际分片与图标都有对应内容哈希，源文件保持不变', async () => {
    const root = await fixture();
    const result = await compile(root);
    for (const family of ['sans', 'serif', 'mono']) {
      const cssUrl = result.fonts[family].cssPath;
      expect(cssUrl).toMatch(new RegExp(`^/assets/fonts/${family}-[a-f0-9]{20}\\.css$`));
      const css = String(result.files.get(cssUrl.slice(1)));
      const shardUrl = `/assets/fonts/${family}/1-${digest(`${family}-font`)}.woff2`;
      expect(css).toContain(`url('${shardUrl}')`);
      expect(css).toContain('font-weight: 400');
      expect(css).toContain('unicode-range: U+4E00-9FFF');
      expect(cssUrl).toContain(digest(css));
      expect(Buffer.from(result.files.get(shardUrl.slice(1)))).toEqual(Buffer.from(`${family}-font`));
      expect(await readFile(join(root, `public/fonts/${family}.css`), 'utf8')).toContain(`/fonts/${family}/1.woff2`);
    }
    expect(result.fonts.system.cssPath).toBeNull();
    expect(result.html).toContain(`/assets/wmind-logo-${digest('logo-v1')}.jpg`);
    expect(result.logo).toBe(`/assets/wmind-logo-${digest('logo-v1')}.jpg`);
    expect(result.custom).toBe('https://example.test/logo.jpg');
  });

  it('相同内容跨构建稳定，单片变化只更新所属 CSS，Logo 独立更新', async () => {
    const root = await fixture();
    const first = await compile(root);
    const repeat = await compile(root);
    expect([...repeat.files.keys()].sort()).toEqual([...first.files.keys()].sort());
    await writeFile(join(root, 'public/fonts/sans/1.woff2'), 'sans-font-v2');
    await writeFile(join(root, 'public/wmind-logo.jpg'), 'logo-v2');
    const changed = await compile(root);
    expect(changed.fonts.sans.cssPath).not.toBe(first.fonts.sans.cssPath);
    expect(changed.fonts.serif.cssPath).toBe(first.fonts.serif.cssPath);
    expect(changed.fonts.mono.cssPath).toBe(first.fonts.mono.cssPath);
    expect(changed.html).toContain(`/assets/wmind-logo-${digest('logo-v2')}.jpg`);
    expect(String(changed.files.get(changed.fonts.sans.cssPath.slice(1)))).toContain(digest('sans-font-v2'));
  });

  it('缺失分片中止构建，不发布引用不存在字体的样式表', async () => {
    const root = await fixture();
    await rm(join(root, 'public/fonts/sans/1.woff2'));
    await expect(compile(root)).rejects.toThrow(/1\.woff2/);
  });
});
