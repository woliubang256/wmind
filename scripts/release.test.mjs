import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { bumpVersion, changelog, checkTag, nextVersion, packageRelease, parseVersion, readVersion, stagePackage } from './release.mjs';

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

const firstNotes = '# v1.0.0\n\n## 新增功能\n\n- 支持通过文字与附件生成导图。\n\n## 问题修复\n\n- 修复保存后重新打开导图时内容丢失的问题。\n';

test('同一功能的多次提交只展示整理结果，文档测试维护不进入日志', t => {
  const { root, put } = fixture(t);
  git(root, 'init');
  git(root, 'config', 'user.name', 'Release Test');
  git(root, 'config', 'user.email', 'release-test@example.invalid');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'feat(ai): 增加生成接口');
  git(root, 'commit', '--allow-empty', '-m', 'feat(ai): 增加生成弹窗');
  git(root, 'commit', '--allow-empty', '-m', 'fix(ai): 调整提示词顺序');
  git(root, 'commit', '--allow-empty', '-m', 'docs: 更新手册');
  git(root, 'commit', '--allow-empty', '-m', 'test: 增加回归');
  git(root, 'commit', '--allow-empty', '-m', 'chore: 清理开发配置');
  put('changelogs/v1.0.0.md', firstNotes);
  assert.equal(changelog('v1.0.0', root), firstNotes);
  git(root, 'tag', 'v1.0.0');
  git(root, 'commit', '--allow-empty', '-m', 'feat(ai): 支持拖拽上传');
  assert.equal(changelog('v1.0.0', root), firstNotes, '同版本重发不重放历史');
  const updated = firstNotes.replace('文字与附件', '文字与拖拽上传的附件');
  put('changelogs/v1.0.0.md', updated);
  assert.equal(changelog('v1.0.0', root), updated, '已存在的 tag 不阻止更新同版整理稿');
});

test('不依赖 Git 历史，只读取当前版本整理稿且省略无内容分类', t => {
  const { root, put } = fixture(t);
  put('changelogs/v1.0.0.md', firstNotes);
  assert.equal(changelog('v1.0.0', root), firstNotes);
  bumpVersion(root);
  const next = '# v1.0.1\n\n## 性能改进\n\n- 减少大导图滚动时的重复绘制。\n';
  put('changelogs/v1.0.1.md', next);
  assert.equal(changelog('v1.0.1', root), next);
  assert.doesNotMatch(changelog('v1.0.1', root), /生成导图|## 新增功能|## 问题修复/);
});

test('缺少整理稿立即失败，不回退到提交记录或其他版本', t => {
  const { root, put } = fixture(t);
  put('changelogs/v0.9.9.md', firstNotes.replaceAll('v1.0.0', 'v0.9.9'));
  assert.throws(() => changelog('v1.0.0', root), /缺少.*changelogs\/v1\.0\.0\.md/);
});

test('三类按固定顺序输出并规范换行', t => {
  const { root, put } = fixture(t);
  put('changelogs/v1.0.0.md', '# v1.0.0\r\n\r\n## 性能改进\r\n- 优化加载。\r\n## 问题修复\r\n- 修复保存。\r\n## 新增功能\r\n- 支持分享。\r\n');
  assert.equal(changelog('v1.0.0', root), '# v1.0.0\n\n## 新增功能\n\n- 支持分享。\n\n## 问题修复\n\n- 修复保存。\n\n## 性能改进\n\n- 优化加载。\n');
});

test('拒绝错误版本、开发分类、空稿、空分类、重复、占位和原样提交', t => {
  const { root, put } = fixture(t);
  for (const [body, message] of [
    [firstNotes.replace('v1.0.0', 'v1.0.1'), /标题.*v1\.0\.0/],
    ['', /标题/],
    ['# v1.0.0\n', /至少一条/],
    ['# v1.0.0\n\n## 文档\n\n- 更新文档。\n', /分类/],
    [firstNotes + '\n## 性能改进\n', /空分类/],
    [firstNotes + '\n## 新增功能\n\n- 另一个功能。\n', /重复分类/],
    [firstNotes + '\n- 修复保存后重新打开导图时内容丢失的问题。\n', /重复条目/],
    [firstNotes.replace('修复保存后重新打开导图时内容丢失的问题。', '支持通过文字与附件生成导图。'), /重复条目/],
    [firstNotes.replace('支持通过文字与附件生成导图。', 'TODO'), /占位/],
    [firstNotes.replace('支持通过文字与附件生成导图。', 'feat(ai): 增加生成弹窗'), /提交/],
    [firstNotes.replace('支持通过文字与附件生成导图。', '新增生成弹窗 (`abcdef1`)'), /提交/],
    ['# v1.0.0\n\n- 无分类条目\n', /分类/],
    [firstNotes + '\n开发随记\n', /格式/],
  ]) {
    put('changelogs/v1.0.0.md', body);
    assert.throws(() => changelog('v1.0.0', root), message, body);
  }
});

test('CLI 输出与整理稿一致，缺稿不会覆盖已有输出', t => {
  const { root, put } = fixture(t);
  put('scripts/release.mjs', readFileSync(new URL('./release.mjs', import.meta.url), 'utf8'));
  put('changelogs/v1.0.0.md', firstNotes);
  execFileSync(process.execPath, ['scripts/release.mjs', 'changelog', 'v1.0.0', 'release/CHANGELOG.md'], { cwd: root });
  assert.equal(readFileSync(join(root, 'release/CHANGELOG.md'), 'utf8'), changelog('v1.0.0', root));
  bumpVersion(root);
  const failed = spawnSync(process.execPath, ['scripts/release.mjs', 'changelog', 'v1.0.1', 'release/CHANGELOG.md'], { cwd: root, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /缺少.*v1\.0\.1/);
  assert.equal(readFileSync(join(root, 'release/CHANGELOG.md'), 'utf8'), firstNotes);
});

test('部署包白名单排除配置、Git凭据与数据，并固定镜像版本', t => {
  const { root, put } = fixture(t);
  for (const file of ['LICENSE', 'backend/.env.example', 'frontend/dist/index.html', 'frontend/dist/assets/app.js', 'deploy/nginx.conf', 'deploy/scripts/backup.sh', 'deploy/scripts/restore.sh']) put(file, 'safe');
  put('backend/wmind-server', 'binary');
  put('changelogs/v1.0.0.md', firstNotes);
  put('notes.md', firstNotes);
  put('deploy/.env.example', 'WMIND_VERSION=latest\nWMIND_JWT_SECRET=example\n');
  const compose = 'services:\n  api:\n    image: ghcr.io/owner/api:${WMIND_VERSION:-latest}\n    build:\n      context: ..\n      dockerfile: deploy/Dockerfile.backend\n      args:\n        VERSION: ${WMIND_VERSION:-dev}\n    ports: [8080]\n';
  // Use the actual Compose shape (build args included) to exercise package filtering.
  put('deploy/docker-compose.yml', compose);
  put('deploy/docker-compose.postgres.yml', compose);
  for (const file of ['.git/config', '.env', 'backend/.env', 'deploy/.env', 'backend/data/wmind.db', 'frontend/node_modules/secret.txt']) put(file, 'never-package');
  const destination = join(root, 'staged');
  stagePackage(root, destination, 'v1.0.0', join(root, 'backend/wmind-server'), join(root, 'notes.md'));
  assert.equal(readFileSync(join(destination, 'backend/wmind-server'), 'utf8'), 'binary');
  assert.equal(readFileSync(join(destination, 'CHANGELOG.md'), 'utf8'), changelog('v1.0.0', root));
  assert.equal(readFileSync(join(destination, 'frontend/dist/assets/app.js'), 'utf8'), 'safe');
  for (const file of ['.git', '.env', 'backend/.env', 'deploy/.env', 'backend/data', 'frontend/node_modules']) assert.equal(existsSync(join(destination, file)), false, file);
  assert.match(readFileSync(join(destination, 'deploy/.env.example'), 'utf8'), /^WMIND_VERSION=v1.0.0\n/);
  const packaged = readFileSync(join(destination, 'deploy/docker-compose.yml'), 'utf8');
  assert.doesNotMatch(packaged, /^\s+(?:build|context|dockerfile|VERSION|args):/m);
  assert.match(packaged, /WMIND_VERSION:-v1.0.0/);
  assert.match(packaged, /ports: \[8080\]/);
  assert.deepEqual(readdirSync(destination).sort(), ['CHANGELOG.md', 'LICENSE', 'RELEASE.md', 'VERSION', 'backend', 'deploy', 'frontend']);
  put('release/CHANGELOG.md', 'stale');
  assert.throws(() => packageRelease('v1.0.0', join(root, 'release'), root), /日志.*不一致/, '须在运行 Go 编译前拒绝旧日志');
});

test('部署包拒绝静态目录中的符号链接', t => {
  const { root, put } = fixture(t);
  put('LICENSE', 'safe');
  put('backend/.env.example', 'safe');
  put('frontend/dist/index.html', 'safe');
  put('changelogs/v1.0.0.md', firstNotes);
  put('notes.md', firstNotes);
  put('outside-secret', 'never-package');
  symlinkSync(join(root, 'outside-secret'), join(root, 'frontend/dist/leak'));
  assert.throws(() => stagePackage(root, join(root, 'staged'), 'v1.0.0', 'unused', join(root, 'notes.md')), /符号链接/);
});
