import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const source = await readFile(new URL('./nginx.conf', import.meta.url), 'utf8');
const nginx = [process.env.WMIND_NGINX_BIN, 'nginx', '/usr/local/opt/nginx/bin/nginx', '/opt/homebrew/opt/nginx/bin/nginx']
  .filter(Boolean).find((candidate) => spawnSync(candidate, ['-v'], { stdio: 'ignore' }).status === 0);

async function freePort() {
  const server = createTcpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('真实 Nginx 静态资源、API 与上传缓存响应', { skip: !nginx && !process.env.WMIND_REQUIRE_NGINX, timeout: 20000 }, async (t) => {
  assert.ok(nginx, '需要 nginx；可设置 WMIND_NGINX_BIN 指定二进制');
  const directory = await mkdtemp(join(tmpdir(), 'wmind-nginx-cache-'));
  let child;
  let upstream;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    if (upstream?.listening) {
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  });
  const site = join(directory, 'site');
  const files = {
    'index.html': '<html>WMIND_SPA</html>',
    'assets/app-0123456789.js': 'window.wmind = true;',
    'assets/app-0123456789.css': 'body{color:black}',
    'assets/fonts/sans-0123456789.css': '/* font fixture */'.repeat(100),
    'assets/fonts/sans/1-0123456789.woff2': 'font-bytes',
    'assets/wmind-logo-0123456789.jpg': 'logo-bytes',
    'fonts/sans.css': '/* legacy font fixture */'.repeat(100),
    'fonts/sans/1.woff2': 'legacy-font-bytes',
    'fonts/manifest.json': '{}',
    'wmind-logo.jpg': 'legacy-logo-bytes',
  };
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(site, path)), { recursive: true });
    await writeFile(join(site, path), body);
  }
  upstream = createServer((request, response) => {
    response.setHeader('X-Mock-Path', request.url);
    if (!request.url.startsWith('/uploads/missing') && !request.url.startsWith('/uploads/no-policy')) {
      response.setHeader('Cache-Control', request.url.startsWith('/uploads/private') ? 'no-store' : 'public, max-age=300');
    }
    response.statusCode = request.url.includes('missing') ? 404 : request.url.includes('error-policy') ? 500 : 200;
    response.end('mock API');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const port = await freePort();
  const config = source
    .replace('listen 80;', `listen 127.0.0.1:${port};`)
    .replace('root /usr/share/nginx/html;', `root "${site}";`)
    .replaceAll('/var/log/nginx/access.log', `${directory}/access.log`)
    .replaceAll('http://api:8080', `http://127.0.0.1:${upstream.address().port}`);
  const filename = join(directory, 'nginx.conf');
  await mkdir(join(directory, 'logs'));
  await writeFile(filename, `error_log stderr crit; pid "${directory}/nginx.pid"; events {} http { types { text/html html; text/css css; application/javascript js; font/woff2 woff2; image/jpeg jpg; application/json json; } ${config} }`);
  const validation = spawnSync(nginx, ['-p', `${directory}/`, '-c', filename, '-t'], { encoding: 'utf8' });
  assert.equal(validation.status, 0, validation.stderr);
  child = spawn(nginx, ['-p', `${directory}/`, '-c', filename, '-g', 'daemon off; master_process off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { const response = await fetch(url); await response.text(); ready = true; break; } catch { /* start-up */ }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready, `Nginx 启动失败：${stderr}`);
  const request = async (path, headers) => {
    const response = await fetch(`${url}${path}`, { headers, redirect: 'manual' });
    const body = await response.text();
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN', path);
    assert.equal(response.headers.get('referrer-policy'), 'strict-origin', path);
    assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()', path);
    return { response, body };
  };

  await t.test('内容哈希资源一年缓存，条件请求 304 仍保留同一策略', async () => {
    for (const path of Object.keys(files).filter((path) => path.startsWith('assets/'))) {
      const { response } = await request(`/${path}`);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable', path);
      assert.ok(response.headers.get('etag'), path);
      const conditional = await request(`/${path}`, { 'If-None-Match': response.headers.get('etag') });
      assert.equal(conditional.response.status, 304, path);
      assert.equal(conditional.response.headers.get('cache-control'), 'public, max-age=31536000, immutable', path);
    }
    const partial = await request('/assets/app-0123456789.js', { Range: 'bytes=0-4' });
    assert.equal(partial.response.status, 206);
    assert.equal(partial.body, 'windo');
    assert.equal(partial.response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });
  await t.test('固定字体与 Logo 仅短缓存，页面入口每次重验证', async () => {
    for (const path of ['fonts/sans.css', 'fonts/sans/1.woff2', 'fonts/manifest.json', 'wmind-logo.jpg']) {
      const { response } = await request(`/${path}`);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=3600', path);
      const conditional = await request(`/${path}`, { 'If-None-Match': response.headers.get('etag') });
      assert.equal(conditional.response.status, 304, path);
      assert.equal(conditional.response.headers.get('cache-control'), 'public, max-age=3600', path);
    }
    for (const path of ['/', '/index.html', '/maps/example', '/s/example']) {
      const { response, body } = await request(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'no-cache', path);
      assert.match(body, /WMIND_SPA/);
    }
  });
  await t.test('静态文件缺失真实 404 且不缓存，不返回 SPA', async () => {
    for (const path of ['/assets/missing.js', '/fonts/missing.css', '/fonts/sans/missing.woff2', '/missing.jpg', '/missing.css']) {
      const { response, body } = await request(path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      assert.doesNotMatch(body, /WMIND_SPA/);
    }
  });
  await t.test('缺失字体样式表不能返回 SPA 200', async () => {
    const { response, body } = await request('/fonts/missing.css');
    assert.equal(response.status, 404);
    assert.doesNotMatch(body, /WMIND_SPA/);
  });
  await t.test('字体后缀不能抢占 API 代理', async () => {
    const { response } = await request('/api/file.woff2');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-mock-path'), '/api/file.woff2');
  });
  await t.test('API 无缓存且路径不被后缀规则抢占，备份根无重定向', async () => {
    for (const path of ['/api/v1/auth/me', '/api/file.woff2', '/api/missing.css', '/api/v1/admin/backups', '/api/v1/admin/backups/restore/preview']) {
      const { response } = await request(path);
      assert.equal(response.status, path.includes('missing') ? 404 : 200, path);
      assert.equal(response.headers.get('x-mock-path'), path, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
    }
  });
  await t.test('上传沿用后端私有文件与公开头像策略', async () => {
    for (const path of ['/uploads/private.woff2', '/uploads/avatar.jpg']) {
      const { response } = await request(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('x-mock-path'), path, path);
      assert.equal(response.headers.get('cache-control'), path.includes('private') ? 'no-store' : 'public, max-age=300', path);
    }
  });
  await t.test('上传未知路径、错误和缺少缓存策略时禁止缓存', async () => {
    for (const [path, status] of [['/uploads/missing/nested.png', 404], ['/uploads/no-policy.jpg', 200], ['/uploads/error-policy.jpg', 500]]) {
      const { response } = await request(path);
      assert.equal(response.status, status, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
    }
  });
  await t.test('代理连接失败的 API 响应也不缓存', async () => {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    const { response } = await request('/api/v1/site/config');
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const uploaded = await request('/uploads/avatar.jpg');
    assert.equal(uploaded.response.status, 502);
    assert.equal(uploaded.response.headers.get('cache-control'), 'no-store');
  });
});
