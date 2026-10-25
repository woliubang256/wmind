import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('构建前校验整理稿，发布页与附件和部署包共用同一日志输出', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const steps = workflow.split('\n      - name: ').slice(1);
  const render = steps.findIndex(step => step.startsWith('Validate and render curated changelog\n'));
  const dependencies = steps.findIndex(step => step.startsWith('Install frontend dependencies\n'));
  const archives = steps.findIndex(step => step.includes('release.mjs package "$GITHUB_REF_NAME" release'));
  assert.ok(render >= 0 && render < dependencies && dependencies < archives, '缺稿须在耗时安装与构建之前失败');
  assert.match(steps[render], /release\.mjs changelog "\$GITHUB_REF_NAME" release\/CHANGELOG\.md/);
  assert.equal((workflow.match(/release\.mjs changelog /g) ?? []).length, 1, '只生成一次经过校验的整理稿');
  const release = steps.find(step => step.includes('uses: softprops/action-gh-release@'));
  assert.match(release, /body_path: release\/CHANGELOG\.md/);
  assert.match(release, /files:\s*\|[\s\S]*\n\s+release\/CHANGELOG\.md\n/);
  assert.doesNotMatch(release, /generate_release_notes: true|append_body: true/, '不得追加自动生成的提交记录');
});

test('两个固定镜像构建成功后才晋升 latest，最后创建正式 Release', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const steps = workflow.split('\n      - name: ').slice(1);
  const builds = steps.filter(step => step.includes('uses: docker/build-push-action@'));
  assert.equal(builds.length, 2);
  for (const step of builds) {
    assert.match(step, /push: true/);
    assert.doesNotMatch(step, /ghcr\.io\/[^\s]+:latest/, '构建阶段不得提前更新 latest');
  }
  const promotion = steps.find(step => step.startsWith('Promote both images to latest\n'));
  assert.ok(promotion, '必须在两镜像成功后统一晋升 latest');
  const release = steps.find(step => step.includes('uses: softprops/action-gh-release@'));
  assert.ok(release);
  assert.ok(builds.every(step => steps.indexOf(step) < steps.indexOf(promotion)));
  assert.ok(steps.indexOf(promotion) < steps.indexOf(release));
  // 不允许即便构建失败也运行晋升/Release；GitHub 默认 success() 是此处的边界。
  assert.doesNotMatch(promotion + release, /if:.*(?:always\(|failure\(|!cancelled\()/);
  const commands = promotion.split('\n').filter(line => line.includes('docker buildx imagetools create'));
  assert.equal(commands.length, 2);
  for (const name of ['api', 'web']) {
    const command = commands.find(line => line.includes(`wmind-${name}:latest`));
    assert.ok(command, `${name} 缺少 latest 晋升`);
    assert.ok(command.includes(`--tag "ghcr.io/woliubang256/wmind-${name}:latest"`));
    assert.ok(command.includes(`"ghcr.io/woliubang256/wmind-${name}:$GITHUB_REF_NAME"`), `${name} 必须从同标签固定镜像晋升`);
  }
});

test('API 镜像预建上传卷挂载点并交给默认非 root 用户', () => {
  const dockerfile = readFileSync(new URL('../deploy/Dockerfile.backend', import.meta.url), 'utf8');
  const runtime = dockerfile.split(/\nFROM alpine:[^\n]+\n/)[1];
  assert.ok(runtime);
  assert.match(runtime, /mkdir -p \/data\/uploads\b/, '新命名卷必须从已设置属主的上传挂载点初始化');
  assert.match(runtime, /chown -R 10001:10001 \/data\b/);
  assert.match(runtime, /\nUSER 10001:10001\n/);
  assert.ok(runtime.indexOf('mkdir -p /data/uploads') < runtime.indexOf('chown -R 10001:10001 /data'));
});

test('全新上传卷和 SQLite 整栈冒烟均在 latest 晋升之前运行并隔离清理', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const steps = workflow.split('\n      - name: ').slice(1);
  const apiBuild = steps.findIndex(step => step.startsWith('Build and publish API image\n'));
  const webBuild = steps.findIndex(step => step.startsWith('Build and publish Web image\n'));
  const promotion = steps.findIndex(step => step.startsWith('Promote both images to latest\n'));
  const volume = steps.findIndex(step => step.startsWith('Verify fresh uploads volume permissions\n'));
  const sqlite = steps.findIndex(step => step.startsWith('Smoke-test SQLite deployment\n'));
  assert.ok(apiBuild < volume && volume < promotion, '上传卷必须通过已发布 API 镜像验证');
  assert.ok(webBuild < sqlite && sqlite < promotion, '整栈必须在 API/Web 都完成后且 latest 之前验证');
  assert.match(steps[volume], /GITHUB_RUN_ID.*GITHUB_RUN_ATTEMPT/);
  assert.match(steps[volume], /trap cleanup EXIT/);
  assert.match(steps[volume], /docker volume rm/);
  assert.match(steps[volume], /target=\/data\/uploads/);
  assert.match(steps[volume], /test "\$\(id -u\)" -eq 10001/);
  assert.doesNotMatch(steps[volume], /--user\b/, '冒烟必须使用镜像默认用户');
  assert.match(steps[sqlite], /HTTP_PORT: '0'/);
  assert.match(steps[sqlite], /--project-name "\$project" --env-file \/dev\/null/);
  assert.match(steps[sqlite], /trap cleanup EXIT/);
  assert.match(steps[sqlite], /down --volumes --remove-orphans/);
  assert.match(steps[sqlite], /up -d --no-build --wait/);
  assert.match(steps[sqlite], /\/api\/v1\/site\/config/);
  assert.match(steps[sqlite], /process\.env\.GITHUB_REF_NAME/);
  assert.match(steps[sqlite], /\/uploads\/wmind-release-upload-smoke\.txt/);
  assert.match(steps[sqlite], /test "\$missing_status" = '404'/);
});
