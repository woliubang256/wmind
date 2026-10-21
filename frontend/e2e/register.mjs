/**
 * 关闭注册的验收：入口要消失，接口要报 REGISTRATION_CLOSED。
 *
 * 这条链路上有三个各自独立的地方会出错，所以分开断言：
 *
 * 1. **入口**。登录页的「立即注册」与 `/register` 表单都读公开站点配置。
 *    配置读不到时兜底值是「未开放」，所以入口消失是安全的默认；危险的是
 *    反向——管理员刚关掉，缓存里那份旧配置还挂着入口，用户填完表单才被拦。
 * 2. **接口**。关站之后 `/auth/register` 必须回 403 REGISTRATION_CLOSED。
 *    曾经这里是 429 RATE_LIMITED：闸门挂在限流器后面，关站期间的每次探测
 *    都消耗 3 次/小时的注册配额，连点三下就把自己的 IP 锁一小时，而且报错
 *    看起来跟「关站」毫无关系。
 * 3. **配额**。关站期间的探测不该消耗配额——否则重开站之后，刚才点过的人
 *    仍然被 429 挡着，而原因看起来跟关站毫无关系。这条在 R8 里是结构性证明
 *    的：配额只有 3 次/小时，只要探测消耗配额，第 4 次必然变成 429。确定性
 *    版本（进程内新建限流器、重开后第一次注册必须 201）在 Go 侧的
 *    `TestRegisterClosedOverHTTP`，因为 e2e 的配额是几套脚本共用的全局状态。
 */

import {
  ADMIN,
  BASE,
  api,
  check,
  launchBrowser,
  login,
  newPage,
  run,
  stamp,
} from './lib/harness.mjs';

const CLOSED = { username: `closed-${stamp}`, email: `closed-${stamp}@example.test`, password: 'closed-test-password' };

/** 改注册开关。走管理员接口，不点界面——界面那条由 UI 断言负责。 */
async function setRegistration(token, enabled) {
  return api('/admin/settings', {
    method: 'PUT',
    token,
    body: { 'auth.registration_enabled': enabled },
  });
}

/** 直接用接口试注册，返回状态码与错误码。 */
async function tryRegister(attempt) {
  const res = await api('/auth/register', {
    method: 'POST',
    body: attempt,
    raw: true,
  });
  return { status: res.status, code: res.payload?.error?.code ?? null };
}

async function main() {
  const adminToken = await login(ADMIN.email, ADMIN.password);

  // 先确保是开放状态：上一轮若是异常中止在「已关闭」，这轮的前两条会直接红。
  await setRegistration(adminToken, true);

  const browser = await launchBrowser();
  const { page, errors } = await newPage(browser);

  try {
    // ── 1. 开放时的基线：入口在，表单在 ──────────────────────
    await page.goto(`${BASE}/login`);
    await page.getByRole('link', { name: '立即注册' }).waitFor({ timeout: 30000 });
    check('IE-M7-R1 开放注册时登录页有「立即注册」入口', true);

    await page.goto(`${BASE}/register`);
    await page.locator('input[name="username"]').waitFor({ timeout: 30000 });
    check('IE-M7-R2 开放注册时 /register 有注册表单', true);

    // ── 2. 管理员关闭注册 ───────────────────────────────────
    await setRegistration(adminToken, false);
    const config = await api('/site/config', { raw: true });
    check(
      'IE-M7-R3 关闭后公开配置立刻为 false',
      config.payload?.data?.registrationEnabled === false,
      JSON.stringify(config.payload?.data?.registrationEnabled),
    );

    await page.goto(`${BASE}/login`);
    await page.waitForTimeout(600);
    const loginLinks = await page.getByRole('link', { name: '立即注册' }).count();
    const loginText = (await page.locator('section').first().textContent()) ?? '';
    check('IE-M7-R4 关闭后登录页没有注册入口', loginLinks === 0, `入口数 ${loginLinks}`);
    check(
      'IE-M7-R5 关闭后登录页明说「暂未开放注册」',
      loginText.includes('暂未开放注册'),
      loginText.slice(-60),
    );

    await page.goto(`${BASE}/register`);
    await page.waitForTimeout(600);
    check(
      'IE-M7-R6 关闭后直接访问 /register 也拿不到表单',
      (await page.locator('input[name="username"]').count()) === 0 &&
        (await page.locator('section').first().textContent())?.includes('暂未开放注册') === true,
      (await page.locator('section').first().textContent())?.slice(0, 60),
    );

    // ── 3. 接口层：403 REGISTRATION_CLOSED，且不消耗限流配额 ──
    const first = await tryRegister(CLOSED);
    check(
      'IE-M7-R7 关闭后注册接口返回 403 REGISTRATION_CLOSED',
      first.status === 403 && first.code === 'REGISTRATION_CLOSED',
      `${first.status} ${first.code}`,
    );

    // 连打 5 次（配额是 3 次/小时）。闸门排在限流器之后的话，第 4 次就会变成
    // 429 RATE_LIMITED——这正是修之前的行为。
    const burst = [];
    for (let i = 0; i < 5; i += 1) burst.push(await tryRegister(CLOSED));
    check(
      'IE-M7-R8 关站期间连打 5 次仍是 403，不会退化成 429',
      burst.every((item) => item.status === 403 && item.code === 'REGISTRATION_CLOSED'),
      burst.map((item) => `${item.status}/${item.code}`).join(' '),
    );

    // ── 4. 重新开放：入口回来，闸门真的放开 ──────────────────
    await setRegistration(adminToken, true);

    await page.goto(`${BASE}/login`);
    await page.getByRole('link', { name: '立即注册' }).waitFor({ timeout: 30000 });
    check('IE-M7-R9 重新开放后登录页入口恢复', true);

    // 这里**不断言 201**。注册配额是 3 次/小时/IP，前面几套脚本各建一个号就会
    // 把它用完，此时重开站后第一次注册拿到 429 是正确的——那是限流，不是闸门。
    // 「关站期间的探测不吃配额」由上面 R8 结构性证明（配额只有 3 次，若探测
    // 消耗配额，第 4 次必然 429），确定性版本在 Go 侧的
    // TestRegisterClosedOverHTTP（进程内新建限流器，不受外部状态影响）。
    const reopened = await tryRegister(CLOSED);
    check(
      'IE-M7-R10 重开注册后接口不再返回 REGISTRATION_CLOSED',
      reopened.code !== 'REGISTRATION_CLOSED',
      `${reopened.status} ${reopened.code ?? ''}`,
    );

    check('IE-M7-R11 全程没有未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    // 无论成败都把注册恢复成开放：这套脚本会被别的套件跟在后面跑，
    // 留一个「已关站」的实例会让别人的注册全部失败。
    await setRegistration(adminToken, true).catch(() => undefined);
    await browser.close();
  }
}

run(main);
