import assert from 'node:assert/strict';
import { BASE, api, check, ensureUser, launchBrowser, makeUser, newContext, newPage, run, summary, uiLogin } from './lib/harness.mjs';

run(async () => {
  const user = makeUser('encryptedlogin');
  await ensureUser(user);
  const browser = await launchBrowser();
  const errors = [];
  const requests = [];
  const watch = page => page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/v1/auth/login') requests.push(request.postDataJSON());
  });
  try {
    const { page } = await newPage(browser, { errors });
    watch(page);
    await uiLogin(page, user);
    assert.equal(requests.length, 1);
    const envelope = requests[0];
    assert.deepEqual(Object.keys(envelope).sort(), ['challengeId', 'encryptedPassword', 'identifier']);
    assert.equal(envelope.encryptedPassword.length, 344);
    assert.ok(!JSON.stringify(envelope).includes(user.password));
    check('真实浏览器登录只发送公钥密文及一次性挑战', true);
    assert.ok((await page.context().cookies()).some(cookie => cookie.name === 'wmind_refresh'));
    check('现有 bcrypt 账号通过密码步骤获得正常会话', true);

    const replay = await api('/auth/login', { method: 'POST', body: envelope, raw: true });
    assert.equal(replay.status, 422);
    assert.equal(replay.payload.error.code, 'AUTH_LOGIN_CHALLENGE_INVALID');
    check('捕获的浏览器密文不能重复用于登录', true);
    const plaintext = await api('/auth/login', { method: 'POST', body: { identifier: user.email, password: user.password }, raw: true });
    assert.equal(plaintext.status, 400);
    check('直接原密码登录被后端拒绝', true);

    const retryContext = await newContext(browser);
    const { page: retryPage } = await newPage(browser, { context: retryContext, errors });
    watch(retryPage);
    await retryPage.goto(`${BASE}/login`);
    await retryPage.getByLabel('用户名或邮箱').fill(user.email);
    await retryPage.getByLabel('密码', { exact: true }).fill('wrong-login-password');
    await retryPage.getByRole('button', { name: '登录', exact: true }).click();
    await retryPage.getByRole('alert').filter({ hasText: '账号或密码错误' }).waitFor();
    const rejected = requests.at(-1);
    check('错误密码仍返回统一凭据错误', true);
    await retryPage.getByLabel('密码', { exact: true }).fill(user.password);
    await retryPage.getByRole('button', { name: '登录', exact: true }).click();
    await retryPage.waitForURL(url => !url.pathname.startsWith('/login'));
    assert.notEqual(requests.at(-1).challengeId, rejected.challengeId);
    assert.notEqual(requests.at(-1).encryptedPassword, envelope.encryptedPassword);
    check('修改密码重试会申请新挑战并成功登录', true);

    for (const mode of ['missing-crypto', 'invalid-key']) {
      const context = await newContext(browser);
      if (mode === 'missing-crypto') {
        await context.addInitScript(() => Object.defineProperty(window, 'crypto', { value: {}, configurable: true }));
      } else {
        await context.route('**/api/v1/auth/login/challenge', route => route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ data: { challengeId: 'a'.repeat(43), expiresIn: 120, publicKey: { kty: 'RSA', alg: 'RSA-OAEP-256', n: 'invalid', e: 'AQAB', ext: true, key_ops: ['encrypt'] } } }),
        }));
      }
      const { page: blocked } = await newPage(browser, { context, errors });
      const sent = [];
      blocked.on('request', request => { if (new URL(request.url()).pathname === '/api/v1/auth/login') sent.push(request); });
      await blocked.goto(`${BASE}/login`);
      await blocked.getByLabel('用户名或邮箱').fill(user.email);
      await blocked.getByLabel('密码', { exact: true }).fill(user.password);
      await blocked.getByRole('button', { name: '登录', exact: true }).click();
      await blocked.getByText(mode === 'missing-crypto' ? '请使用 HTTPS 访问本站，当前浏览器无法安全提交登录密码。' : '登录加密失败，请刷新页面后重试。', { exact: true }).waitFor();
      assert.equal(sent.length, 0);
      check(mode === 'missing-crypto' ? 'Web Crypto 不可用时不提交密码' : '无效公钥不会触发明文回退', true);
      await context.close();
    }
    check('浏览器没有未捕获异常', errors.length === 0, errors.join('\n'));
    return summary();
  } finally { await browser.close(); }
});
