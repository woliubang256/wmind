import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { bumpVersion, changelog, checkTag, nextVersion, parseVersion, readVersion, stagePackage } from './release.mjs';

function fixture(t, version = '1.0.0') {
  const root = mkdtempSync(join(tmpdir(), 'wmind-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  put('VERSION', `${version}\n`);
  put('package.json', `${JSON.stringify({ name: 'fixture', version })}\n`);
  put('frontend/package.json', `${JSON.stringify({ name: 'fixture-frontend', version })}\n`);
  return { root, put };
}

test('版本按十进制跨位递增', () => {
  for (const [current, next] of [['1.0.0', '1.0.1'], ['1.0.8', '1.0.9'], ['1.0.9', '1.1.0'], ['1.9.9', '2.0.0'], ['9.9.9', '10.0.0']]) {
    assert.equal(nextVersion(current), next);
  }
  for (const value of ['v1.0.0', '1.0.10', '1.10.0', '01.0.0', '-1.0.0', '1.0.0-rc.1', '1.0.0\n']) {
    assert.throws(() => parseVersion(value), /版本必须/);
  }
});

test('标签与三个版本来源一致，递增同步包元数据', t => {
  const { root, put } = fixture(t, '1.9.9');
  assert.equal(checkTag('v1.9.9', root), 'v1.9.9');
  assert.throws(() => checkTag('1.9.9', root), /发布标签/);
  assert.throws(() => checkTag('v1.9.8', root), /不一致/);
  assert.equal(bumpVersion(root), '2.0.0');
  assert.equal(readVersion(root), '2.0.0');
  put('frontend/package.json', '{"version":"1.9.9"}');
  assert.throws(() => readVersion(root), /frontend\/package.json/);
  assert.throws(() => bumpVersion(root), /不一致/);
  assert.equal(readFileSync(join(root, 'VERSION'), 'utf8'), '2.0.0\n');
});

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('首发包含全部历史并按提交类型分组，后续版只收录区间', t => {
  const { root, put } = fixture(t);
  git(root, 'init');
  git(root, 'config', 'user.name', 'Release Test');
  git(root, 'config', 'user.email', 'release-test@example.invalid');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'feat(editor): 增加主题');
  git(root, 'commit', '--allow-empty', '-m', 'fix: 修复保存');
  git(root, 'commit', '--allow-empty', '-m', 'docs: 更新手册');
  const initialBranch = git(root, 'branch', '--show-current');
  const first = changelog('v1.0.0', root);
  assert.match(first, /首次正式发布/);
  assert.match(first, /## 新增功能\n\n- editor：增加主题/);
  assert.match(first, /## 问题修复\n\n- 修复保存/);
  assert.match(first, /## 文档\n\n- 更新手册/);
  git(root, 'tag', 'v1.0.0');
  bumpVersion(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'feat(api)!: 改变接口');
  // A malformed tag must not become the changelog baseline.
  git(root, 'tag', 'v-next');
  const second = changelog('v1.0.1', root);
  assert.match(second, /自 v1.0.0 以来/);
  assert.match(second, /\*\*不兼容变更\*\* api：改变接口/);
  assert.doesNotMatch(second, /增加主题|修复保存|更新手册/);
  assert.match(second, /compare\/v1.0.0\.\.\.v1.0.1/);
  // An unrelated branch/tag cannot truncate the release history.
  git(root, 'checkout', '--orphan', 'unrelated');
  put('unrelated', 'other');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'chore: 不相关分支');
  git(root, 'tag', 'v1.0.1');
  git(root, 'checkout', initialBranch);
  bumpVersion(root);
  const third = changelog('v1.0.2', root);
  assert.match(third, /自 v1.0.0 以来/);
  assert.match(third, /改变接口/);
  assert.doesNotMatch(third, /不相关分支/);
});

test('部署包白名单排除配置、Git凭据与数据，并固定镜像版本', t => {
  const { root, put } = fixture(t);
  for (const file of ['LICENSE', 'backend/.env.example', 'frontend/dist/index.html', 'frontend/dist/assets/app.js', 'deploy/nginx.conf', 'deploy/scripts/backup.sh', 'deploy/scripts/restore.sh']) put(file, 'safe');
  put('backend/wmind-server', 'binary');
  put('notes.md', '# v1.0.0');
  put('deploy/.env.example', 'WMIND_VERSION=latest\nWMIND_JWT_SECRET=example\n');
  const compose = 'services:\n  api:\n    image: ghcr.io/owner/api:${WMIND_VERSION:-latest}\n    build:\n      context: ..\n      dockerfile: deploy/Dockerfile.backend\n      args:\n        VERSION: ${WMIND_VERSION:-dev}\n    ports: [8080]\n';
  // Use the actual Compose shape (build args included) to exercise package filtering.
  put('deploy/docker-compose.yml', compose);
  put('deploy/docker-compose.postgres.yml', compose);
  for (const file of ['.git/config', '.env', 'backend/.env', 'deploy/.env', 'backend/data/wmind.db', 'frontend/node_modules/secret.txt']) put(file, 'never-package');
  const destination = join(root, 'staged');
  stagePackage(root, destination, 'v1.0.0', join(root, 'backend/wmind-server'), join(root, 'notes.md'));
  assert.equal(readFileSync(join(destination, 'backend/wmind-server'), 'utf8'), 'binary');
  assert.equal(readFileSync(join(destination, 'frontend/dist/assets/app.js'), 'utf8'), 'safe');
  for (const file of ['.git', '.env', 'backend/.env', 'deploy/.env', 'backend/data', 'frontend/node_modules']) assert.equal(existsSync(join(destination, file)), false, file);
  assert.match(readFileSync(join(destination, 'deploy/.env.example'), 'utf8'), /^WMIND_VERSION=v1.0.0\n/);
  const packaged = readFileSync(join(destination, 'deploy/docker-compose.yml'), 'utf8');
  assert.doesNotMatch(packaged, /^\s+(?:build|context|dockerfile|VERSION|args):/m);
  assert.match(packaged, /WMIND_VERSION:-v1.0.0/);
  assert.match(packaged, /ports: \[8080\]/);
  assert.deepEqual(readdirSync(destination).sort(), ['CHANGELOG.md', 'LICENSE', 'RELEASE.md', 'VERSION', 'backend', 'deploy', 'frontend']);
});

test('部署包拒绝静态目录中的符号链接', t => {
  const { root, put } = fixture(t);
  put('LICENSE', 'safe');
  put('backend/.env.example', 'safe');
  put('frontend/dist/index.html', 'safe');
  put('outside-secret', 'never-package');
  symlinkSync(join(root, 'outside-secret'), join(root, 'frontend/dist/leak'));
  assert.throws(() => stagePackage(root, join(root, 'staged'), 'v1.0.0', 'unused', 'unused'), /符号链接/);
});
