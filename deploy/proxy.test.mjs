import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

for (const name of ['docker-compose.yml', 'docker-compose.postgres.yml']) {
  test(`${name} 默认只信任独立网络内 Web 的固定地址`, () => {
    const compose = readFileSync(new URL(name, import.meta.url), 'utf8');
    assert.match(compose, /WMIND_TRUSTED_PROXIES:\s*\$\{WMIND_TRUSTED_PROXIES:-\$\{WMIND_WEB_IP:-172\.31\.254\.3\}\}/);
    assert.match(compose, /ipv4_address:\s*\$\{WMIND_WEB_IP:-172\.31\.254\.3\}/);
    assert.match(compose, /ipv4_address:\s*\$\{WMIND_API_IP:-172\.31\.254\.2\}/);
    assert.match(compose, /subnet:\s*\$\{WMIND_NETWORK_SUBNET:-172\.31\.254\.0\/29\}/);
    assert.doesNotMatch(compose, /WMIND_TRUSTED_PROXIES:\s*(?:["']?)(?:0\.0\.0\.0|10\.0\.0\.0|172\.16\.0\.0|192\.168\.0\.0)\//);
    if (name.includes('postgres')) assert.match(compose, /ipv4_address:\s*\$\{WMIND_DB_IP:-172\.31\.254\.4\}/);
    const api = /\n  api:\n([\s\S]+?)\n  web:\n/.exec(compose)?.[1];
    assert.ok(api);
    assert.doesNotMatch(api, /^    ports:/m, 'API 不直接暴露到公网');
  });
}

test('专用网络和代理覆盖设置在示例中可发现', () => {
  const env = readFileSync(new URL('.env.example', import.meta.url), 'utf8');
  for (const key of ['WMIND_NETWORK_SUBNET', 'WMIND_API_IP', 'WMIND_WEB_IP', 'WMIND_DB_IP', 'WMIND_TRUSTED_PROXIES']) {
    assert.match(env, new RegExp(`^${key}=`, 'm'));
  }
});
