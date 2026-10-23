import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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
