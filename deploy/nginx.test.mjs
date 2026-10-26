import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { stagePackage } from '../scripts/release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = readFileSync(join(root, 'deploy/nginx.conf'), 'utf8');

function backupContract(source) {
  const root = /location\s+=\s+\/api\/v1\/admin\/backups\s*\{([^}]+)\}/.exec(source)?.[1];
  assert.ok(root, '不带末尾斜线的备份接口必须精确代理，不能触发 Nginx 自动 301');
  assert.match(root, /proxy_pass\s+http:\/\/api:8080\s*;/, '保持后端不带斜线的接口路径');
  assert.doesNotMatch(root, /return\s+30[1278]|rewrite|try_files/);
  const upload = /location\s+=\s+\/api\/v1\/admin\/backups\/restore\/preview\s*\{([^}]+)\}/.exec(source)?.[1];
  assert.ok(upload, '仅实际恢复ZIP上传路由允许大请求体');
  assert.match(upload, /client_max_body_size\s+2g\s*;/);
  assert.match(upload, /proxy_read_timeout\s+900s\s*;/);
  assert.match(upload, /proxy_request_buffering\s+off\s*;/, '应用鉴权前不可把匿名大请求完整缓冲到代理磁盘');
  assert.match(upload, /proxy_http_version\s+1\.1\s*;/, '分块上传也须流式发送到应用');
  assert.match(upload, /proxy_pass\s+http:\/\/api:8080\s*;/);
  assert.doesNotMatch(source, /location\s+\^~\s+\/api\/v1\/admin\/backups\//, '普通备份控制路由不能继承2GiB上传额度');
  assert.equal(source.match(/client_max_body_size\s+2g\s*;/g)?.length, 1, '大额度只存在于恢复预检ZIP上传');
  const api = /location\s+\^~\s+\/api\/\s*\{([^}]+)\}/.exec(source)?.[1];
  assert.ok(api);
  assert.doesNotMatch(api, /client_max_body_size\s+2g/, '不能扩大普通 API 的上传限制');
}

test('备份根接口不重定向，恢复子接口保留独立上传限制', () => {
  backupContract(config);
});

test('分享密码不进入内置访问日志或同源引用地址', () => {
  const format = /log_format\s+wmind_privacy\s+([^;]+);/.exec(config)?.[1];
  assert.ok(format, '显式隐私日志格式，不能继承含查询参数与Referer的combined格式');
  assert.match(format, /\$request_method \$uri \$server_protocol/);
  assert.doesNotMatch(format, /\$(?:request(?:_uri)?|args|query_string|http_referer)\b/);
  assert.match(config, /access_log\s+\/var\/log\/nginx\/access\.log\s+wmind_privacy\s*;/);
  assert.doesNotMatch(config, /strict-origin-when-cross-origin/);
  assert.match(config, /Referrer-Policy "strict-origin"/);
  const html = readFileSync(join(root, 'frontend/index.html'), 'utf8');
  assert.match(html, /<meta name="referrer" content="strict-origin"\s*\/?\s*>/);
});

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
  backupContract(packaged);
  const dockerfile = readFileSync(join(root, 'deploy/Dockerfile.frontend'), 'utf8');
  assert.match(dockerfile, /COPY\s+deploy\/nginx\.conf\s+\/etc\/nginx\/conf\.d\/default\.conf/);
});
