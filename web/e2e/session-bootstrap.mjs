/** 真实页面与完整会话夹具；不连接后端、不写入真实账号。 */
import assert from 'node:assert/strict';
import { BASE, check, launchBrowser, newContext, newPage, run, summary } from './lib/harness.mjs';

const user = { uid: 'bootstrap-user', username: 'bootstrap', nickname: '会话测试', email: '', avatarUrl: '', role: 'user', status: 'active' };
const site = { siteName: 'wmind', brand: 'wmind', version: '1.0.0', passwordMinLength: 8, registrationEnabled: true };

async function fixture(page, state) {
  state.requests = [];
  state.refreshes = 0;
  state.authenticated ??= true;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    state.requests.push({ path, headers: request.headers(), method: request.method() });
    const fail = (status, code) => route.fulfill({ status, json: { error: { code, message: 'session fixture' } } });
    if (path === '/auth/refresh') {
      state.refreshes++;
      if (state.offline) return route.abort('failed');
      if (state.status) return fail(state.status, state.status === 503 ? 'SERVICE_UNAVAILABLE' : 'AUTH_REFRESH_INVALID');
      if (!state.authenticated) return fail(401, 'AUTH_REFRESH_INVALID');
      await new Promise((resolve) => setTimeout(resolve, 25));
      state.token = `restored-${state.refreshes}`;
      return route.fulfill({ json: { data: { accessToken: state.token, expiresIn: 900, user } } });
    }
    if (path === '/auth/logout') {
      state.authenticated = false;
      return route.fulfill({ status: 204 });
    }
    if (path === '/site/config') return route.fulfill({ json: { data: site } });
    if (request.headers().authorization !== `Bearer ${state.token}`) return fail(401, 'AUTH_TOKEN_EXPIRED');
    if (path.startsWith('/session-probe') && state.deniedCode) return fail(state.deniedStatus, state.deniedCode);
    const data = path === '/auth/me' ? user : path.startsWith('/session-probe') ? { ok: true } : [];
    return route.fulfill({ json: { data, pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } } });
  });
}

run(async () => {
  const browser = await launchBrowser();
  try {
    if (process.env.SESSION_CASE !== 'server') {
      const context = await newContext(browser);
      await context.addCookies([{ name: 'wmind_refresh', value: 'fixture-cookie', domain: new URL(BASE).hostname, path: '/api/v1/auth', httpOnly: true, sameSite: 'Lax' }]);
      const { page, errors } = await newPage(browser, { context });
      const state = {};
      await fixture(page, state);
      await page.goto(`${BASE}/trash`);
      await page.getByRole('heading', { name: '回收站', exact: true }).waitFor();
      check('有效会话启动只刷新一次，不发送 me', state.refreshes === 1 && !state.requests.some((request) => request.path === '/auth/me'));
      const first = state.requests.find((request) => request.path === '/auth/refresh');
      check('启动恢复使用 POST 和 HttpOnly Cookie，不携带旧 Bearer', first.method === 'POST' && first.headers.cookie?.includes('wmind_refresh=fixture-cookie') && !first.headers.authorization);
      check('业务请求在会话恢复后携带有效访问令牌', state.requests.some((request) => request.path === '/trash' && request.headers.authorization === `Bearer ${state.token}`));
      await page.reload();
      await page.getByRole('heading', { name: '回收站', exact: true }).waitFor();
      check('真实页面刷新仍只恢复一次，没有先失败的 me', state.refreshes === 2 && !state.requests.some((request) => request.path === '/auth/me'));
      const secure = await page.evaluate(() => !document.cookie.includes('wmind_refresh')
        && !JSON.stringify({ ...localStorage, ...sessionStorage }).includes('restored-'));
      check('令牌不持久化，刷新 Cookie 对脚本不可读', secure);
      const results = await page.evaluate(async () => {
        const { api, setAccessToken } = await import('/src/lib/api/client.ts');
        setAccessToken('expired-token');
        return Promise.all([api.get('/session-probe/a'), api.get('/session-probe/b'), api.get('/session-probe/c')]);
      });
      check('运行中并发过期仍只刷新一次并全部成功', state.refreshes === 3 && results.every((result) => result.ok));
      await page.getByRole('button', { name: '退出登录', exact: true }).click();
      await page.getByLabel('用户名或邮箱', { exact: true }).waitFor();
      check('退出后无效会话正常回到登录页，不探测 me', new URL(page.url()).pathname === '/login' && !state.requests.some((request) => request.path === '/auth/me'));
      check('会话初始化和退出没有页面异常', errors.length === 0, errors.join('\n'));
      await context.close();

      for (const status of [401, 403]) {
        const anonymous = await newContext(browser);
        const { page, errors } = await newPage(browser, { context: anonymous });
        const state = { status };
        await fixture(page, state);
        await page.goto(`${BASE}/trash`);
        await page.getByLabel('用户名或邮箱', { exact: true }).waitFor();
        check(`失效或禁用会话 ${status} 正常回到登录且无 me 请求`, new URL(page.url()).pathname === '/login' && !state.requests.some((request) => request.path === '/auth/me') && errors.length === 0);
        await anonymous.close();
      }

      for (const action of ['disabled', 'deleted']) {
        const context = await newContext(browser);
        const { page, errors } = await newPage(browser, { context });
        const state = {};
        await fixture(page, state);
        await page.goto(`${BASE}/trash`);
        await page.getByRole('heading', { name: '回收站', exact: true }).waitFor();
        state.deniedStatus = 403;
        state.deniedCode = 'AUTH_FORBIDDEN';
        await page.evaluate(async () => {
          const { api } = await import('/src/lib/api/client.ts');
          await api.get('/session-probe/forbidden').catch(() => {});
        });
        check(`${action} 场景中普通 403 保持登录且不刷新`, new URL(page.url()).pathname === '/trash' && state.refreshes === 1);
        state.deniedStatus = action === 'disabled' ? 403 : 401;
        state.deniedCode = action === 'disabled' ? 'AUTH_ACCOUNT_DISABLED' : 'AUTH_TOKEN_INVALID';
        state.authenticated = false;
        await page.evaluate(async () => {
          const { api } = await import('/src/lib/api/client.ts');
          await api.get('/session-probe/revoked').catch(() => {});
        });
        await page.getByLabel('用户名或邮箱', { exact: true }).waitFor();
        check(`${action} 下一次请求退出登录并清理内存令牌`, new URL(page.url()).pathname === '/login' && await page.evaluate(async () => (await import('/src/lib/api/client.ts')).getAccessToken() === null));
        check(`${action} 退出过程无页面异常且不写入浏览器存储`, errors.length === 0 && await page.evaluate(() => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes('restored-')));
        await context.close();
      }
    }

    for (const failure of ['server', 'offline']) {
      const context = await newContext(browser);
      const { page, errors } = await newPage(browser, { context });
      const state = failure === 'server' ? { status: 503 } : { offline: true };
      await fixture(page, state);
      await page.goto(`${BASE}/trash`);
      const retry = page.getByRole('button', { name: '重试', exact: true });
      await retry.waitFor({ timeout: 5000 });
      check(`${failure} 不伪装成退出登录，保留目标地址和重试入口`, new URL(page.url()).pathname === '/trash' && await page.getByRole('alert').isVisible() && state.refreshes === 1);
      state.status = undefined;
      state.offline = false;
      await retry.click();
      await page.getByRole('heading', { name: '回收站', exact: true }).waitFor();
      check(`${failure} 恢复后原地重试成功且没有 me 请求`, state.refreshes === 2 && !state.requests.some((request) => request.path === '/auth/me') && errors.length === 0);
      await context.close();
    }
    assert.ok(summary());
    return true;
  } finally {
    await browser.close();
  }
});
