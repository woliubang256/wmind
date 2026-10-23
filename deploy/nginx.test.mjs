import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { stagePackage } from '../scripts/release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = readFileSync(join(root, 'deploy/nginx.conf'), 'utf8');

function uploadsContract(source) {
  // ^~ keeps uploaded file extensions out of regex static-file locations.
  const uploads = /location\s+\^~\s+\/uploads\/\s*\{([^}]+)\}/.exec(source)?.[1];
  assert.ok(uploads, '/uploads/ 必须有优先于 SPA 和静态扩展名规则的独立路由');
  // A URI/trailing slash on proxy_pass would strip the /uploads/ prefix.
  assert.match(uploads, /proxy_pass\s+http:\/\/api:8080\s*;/, '上传路径应完整转发到提供 /uploads 的 API');
  assert.doesNotMatch(uploads, /try_files|error_page/, '不存在的上传文件应保留 API 的 404，不能回退为 SPA HTML');
  assert.match(uploads, /proxy_set_header\s+Host\s+\$host\s*;/);
  assert.match(uploads, /proxy_set_header\s+X-Forwarded-Proto\s+\$scheme\s*;/);
  assert.match(source, /location\s+\/\s*\{[^}]*try_files\s+\$uri\s+\$uri\/\s+\/index\.html\s*;/, '普通前端路由仍须回退 SPA');
}

test('生产上传资源完整代理到 API，缺失文件不返回 SPA', () => {
  uploadsContract(config);
});

test('部署包保留与 Web 镜像相同的上传代理配置', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'wmind-nginx-package-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const put = (path, text) => {
    const file = join(fixture, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  put('VERSION', '1.0.0\n');
  put('package.json', '{"version":"1.0.0"}');
  put('frontend/package.json', '{"version":"1.0.0"}');
  for (const path of ['LICENSE', 'backend/.env.example', 'frontend/dist/index.html', 'deploy/scripts/backup.sh', 'deploy/scripts/restore.sh']) put(path, 'fixture');
  put('deploy/nginx.conf', config);
  put('deploy/.env.example', 'WMIND_VERSION=latest\n');
  for (const path of ['deploy/docker-compose.yml', 'deploy/docker-compose.postgres.yml']) put(path, 'services:\n  api:\n    image: api:${WMIND_VERSION:-latest}\n');
  put('binary', 'fixture-binary');
  put('changelog', '# v1.0.0');
  const destination = join(fixture, 'package');
  stagePackage(fixture, destination, 'v1.0.0', join(fixture, 'binary'), join(fixture, 'changelog'));
  const packaged = readFileSync(join(destination, 'deploy/nginx.conf'), 'utf8');
  assert.equal(packaged, config);
  uploadsContract(packaged);
  const dockerfile = readFileSync(join(root, 'deploy/Dockerfile.frontend'), 'utf8');
  assert.match(dockerfile, /COPY\s+deploy\/nginx\.conf\s+\/etc\/nginx\/conf\.d\/default\.conf/);
});
