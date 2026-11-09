/** Password query is a transient hint, never an automatic authentication attempt. */
import assert from 'node:assert/strict';
import { BASE, launchBrowser } from './lib/harness.mjs';

const document = { format: 'wmind', formatVersion: '1.0', id: 'prefill-doc', title: '密码链接', sheets: [
  { id: 'sheet', title: '画布', structure: 'mindmap', rootTopic: { id: 'root', title: '中心主题', children: { attached: [], detached: [] } } },
] };
const browser = await launchBrowser();
try {
  const page = await browser.contexts()[0].newPage();
  const errors = [];
  const requests = [];
  const attempts = [];
  const passwords = { one: 'Ab+9', two: 'Zz8y', third: 'Kk7p' };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push({ url: request.url(), referer: request.headers().referer ?? '' }));
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    let data = {};
    if (url.pathname.endsWith('/site/config')) data = { siteName: 'wmind', shareEnabled: true, exportEnabled: false };
    else if (url.pathname.includes('/public/shares/')) {
      const token = url.pathname.split('/')[5];
      if (token === 'invalid') return route.fulfill({ status: 404, json: { error: { code: 'SHARE_NOT_FOUND', message: '链接已失效' } } });
      if (url.pathname.endsWith('/verify')) {
        const input = req.postDataJSON();
        attempts.push({ token, password: input.password });
        if (input.password !== passwords[token]) return route.fulfill({ status: 401, json: { error: { code: 'SHARE_PASSWORD_INVALID', message: '访问密码错误' } } });
        data = { accessToken: `access:${token}`, expiresIn: 1800 };
      } else {
        if (token !== 'open' && req.headers()['x-share-access'] !== `access:${token}`) {
          return route.fulfill({ status: 401, json: { error: { code: 'SHARE_PASSWORD_REQUIRED', message: '需要访问密码' } } });
        }
        data = { title: document.title, document, allowDownload: false, showNotes: false, siteName: 'wmind', ownerNickname: '作者', createdAt: '2026-10-25T00:00:00Z' };
      }
    }
    await route.fulfill({ json: { data } });
  });
  const navigate = async (path) => page.evaluate((target) => {
    history.pushState({ ...history.state, key: crypto.randomUUID() }, '', target);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  const input = page.getByLabel('访问密码', { exact: true });
  await page.goto(`${BASE}/s/one?psw=Ab%2B9&source=link#canvas`);
  await input.waitFor();
  assert.equal(await input.inputValue(), 'Ab+9');
  await page.waitForURL('**/s/one?source=link#canvas');
  assert.equal(attempts.length, 0, 'opening URL must not verify automatically');
  assert.equal(await page.evaluate(() => document.referrerPolicy ?? document.querySelector('meta[name="referrer"]').content), 'strict-origin');
  await input.fill('wrong');
  await page.getByRole('button', { name: '查看导图', exact: true }).click();
  await page.getByText('访问密码不正确。', { exact: true }).waitFor();
  assert.deepEqual(attempts, [{ token: 'one', password: 'wrong' }]);
  assert.equal(await input.inputValue(), 'wrong', 'failed verification remains editable');
  await page.reload();
  await input.waitFor();
  assert.equal(await input.inputValue(), '', 'scrubbed hint is not restored on refresh');
  assert.equal(attempts.length, 1);
  await input.fill('Ab+9');
  await page.getByRole('button', { name: '查看导图', exact: true }).click();
  await page.locator('[data-topic-id="root"]').waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('wmind:share-access:one')), 'access:one');
  await page.reload();
  await page.locator('[data-topic-id="root"]').waitFor();
  assert.equal(attempts.length, 2, 'verified refresh uses only the scoped access token');
  await navigate('/s/two?psw=Zz8y');
  await input.waitFor();
  assert.equal(await input.inputValue(), 'Zz8y', 'SPA token switch must not reuse old hint or access');
  assert.equal(attempts.length, 2);
  await input.fill('edited');
  await navigate('/s/two?psw=retry&psw=duplicate&from=test#sheet');
  await page.waitForURL('**/s/two?from=test#sheet');
  await page.waitForFunction(() => document.querySelector('input[type="password"]')?.value === 'retry');
  assert.equal(attempts.length, 2, 'same-token hint replacement is still not verification');
  await navigate('/s/third');
  await input.waitFor();
  assert.equal(await input.inputValue(), '', 'token switch without psw must start empty');
  await navigate('/s/third?psw=');
  await page.waitForURL('**/s/third');
  assert.equal(await input.inputValue(), '');
  await navigate(`/s/third?psw=${'a'.repeat(65)}`);
  await page.waitForURL('**/s/third');
  assert.equal(await input.inputValue(), '', 'oversized hints are ignored');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: '/tmp/wmind-share-password-prefill.png' });
  await navigate('/s/open?psw=unused');
  await page.locator('[data-topic-id="root"]').waitFor();
  assert.equal(new URL(page.url()).searchParams.has('psw'), false);
  assert.equal(attempts.length, 2, 'public shares never verify a supplied hint');
  await navigate('/s/invalid?psw=unused');
  await page.getByRole('heading', { name: '分享链接已失效', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.has('psw'), false);
  assert.equal(attempts.length, 2);
  assert.equal(requests.filter((req) => req.url.includes('/api/')).some((req) => new URL(req.url).searchParams.has('psw')), false);
  assert.deepEqual(requests.filter((req) => req.referer.includes('psw=')), [], 'subresource Referer must not contain the hint');
  assert.equal(await page.evaluate(() => [localStorage, sessionStorage].some((store) => Object.values(store).some((value) => /Ab\+9|Zz8y|retry|unused/.test(value)))), false);
  assert.deepEqual(errors, []);
  console.log('PASS: 特殊字符预填 / 不自动验证 / 错误可编辑 / URL清理与刷新 / token与同token切换 / 无密码和失效 / 超长参数 / 无query和Referer泄露');
} finally { await browser.close(); }
