import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./desktop-update-deltas.mjs', import.meta.url));

function packageFixture(root, target, bases, missing = []) {
  const dir = join(root, target);
  mkdirSync(dir);
  const full = { version: '1.1.8', url: `https://example.com/wmind-1.1.8-${target}.tar.gz`, size: 100, signature: 'full-signature' };
  const deltas = bases.map(from => {
    const name = `wmind-${from}-to-1.1.8-${target}.delta`;
    if (!missing.includes(from)) writeFileSync(join(dir, name), 'delta');
    return { from, url: `https://example.com/${name}`, size: 10, signature: 'delta-signature' };
  });
  const manifest = join(dir, `update-${target}.json`);
  writeFileSync(manifest, JSON.stringify({ ...full, deltas, previous: [{ version: '1.1.5' }] }));
  const archive = join(dir, `wmind-1.1.8-${target}.tar.gz`);
  writeFileSync(archive, 'full archive');
  return {
    full, deltas,
    manifest: () => JSON.parse(readFileSync(manifest, 'utf8')),
    archive: () => readFileSync(archive, 'utf8'),
    hasDelta: from => existsSync(join(dir, `wmind-${from}-to-1.1.8-${target}.delta`)),
  };
}

test('只发布上一正式桌面版的可用增量，缺包的平台保留签名全量归档', t => {
  const root = mkdtempSync(join(tmpdir(), 'wmind-release-deltas-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const linux = packageFixture(root, 'linux-amd64', ['1.1.5', '1.1.7']);
  const darwin = packageFixture(root, 'darwin-arm64', ['1.1.5']);
  const windows = packageFixture(root, 'windows-amd64', ['1.1.7'], ['1.1.7']);
  execFileSync(process.execPath, [script, '1.1.8', root], {
    input: 'desktop-v1.1.8\nv1.1.7\nv1.1.8\ndesktop-v1.1.7\ndesktop-v1.1.5\ndesktop-v1.1.9\n',
  });
  assert.deepEqual(linux.manifest(), { ...linux.full, deltas: [linux.deltas[1]] });
  assert.equal(linux.hasDelta('1.1.7'), true);
  assert.equal(linux.hasDelta('1.1.5'), false);
  assert.deepEqual(darwin.manifest(), darwin.full);
  assert.equal(darwin.hasDelta('1.1.5'), false);
  assert.deepEqual(windows.manifest(), windows.full);
  for (const platform of [linux, darwin, windows]) assert.equal(platform.archive(), 'full archive');
});

test('没有已发布的桌面基线时仅发布全量包', t => {
  const root = mkdtempSync(join(tmpdir(), 'wmind-release-deltas-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const linux = packageFixture(root, 'linux-amd64', ['1.1.7']);
  execFileSync(process.execPath, [script, '1.1.8', root], { input: 'v1.1.7\ndesktop-v1.1.8\n' });
  assert.deepEqual(linux.manifest(), linux.full);
  assert.equal(linux.hasDelta('1.1.7'), false);
  assert.equal(linux.archive(), 'full archive');
});
