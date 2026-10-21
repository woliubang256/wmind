/**
 * 登录页 / 注册页的语言切换验收。
 *
 * 为什么单独一套：语言切换器原先只在 `/account` 里，而那是**登录之后**才到得了
 * 的地方。第一次来的人——浏览器报 `en-US`、界面却是中文，或者反过来——在登录页
 * 没有任何出路：进不了设置页，也读不懂「用户名」三个字。所以这个入口必须验，
 * 而且验的不只是「有个控件」：
 *
 * - 它得在**右上角**（几何位置），不是埋在表单底下；
 * - 它得是**第一个**可聚焦元素（Tab 一下就到），因为找不到它的人正在挨个试；
 * - 切完之后**整块卡片**都不该再有中文（连站点名、按钮、占位提示一起扫）。
 *
 * 最后一条用克隆节点 + 摘掉 `<select>` 的方式做：下拉里永远有「中文」两个字
 * （语言名按该语言自己的写法显示），不摘掉的话这条断言永远红。
 *
 * 这套脚本**会改站点设置**（关一次注册），`finally` 里无条件恢复。
 */

import { ADMIN, BASE, api, check, launchBrowser, login, newPage, run } from './lib/harness.mjs';

async function setRegistration(token, enabled) {
  return api('/admin/settings', {
    method: 'PUT',
    token,
    body: { 'auth.registration_enabled': enabled },
  });
}

/**
 * 卡片正文（不含语言选择器本身）。
 *
 * 用 `cloneNode` 而不是 `innerText`：`innerText` 会按渲染结果裁掉不可见文字，
 * 而这里要抓的正是「漏翻但被 `sr-only` 藏起来」的那类文案。
 *
 * 只摘 `<select>`，**不能**顺手摘 `<label>`：输入框的「Username or email」
 * 与「Password」也是 `<label>`，一起摘掉的话这条断言会因为「找不到英文」而红，
 * 看起来像翻译缺失，实际是脚本把要验的东西删了。
 */
function cardTextWithoutSwitcher(page) {
  return page.evaluate(() => {
    const card = document.querySelector('section');
    if (card === null) return '';
    const clone = card.cloneNode(true);
    clone.querySelectorAll('select').forEach((node) => node.remove());
    return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/** 选择器相对卡片的右上角距离（px）。 */
function switcherOffset(page) {
  return page.evaluate(() => {
    const select = document.querySelector('select');
    const card = select?.closest('section');
    if (select === null || card === null || card === undefined) return null;
    const s = select.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    return { gapRight: Math.round(c.right - s.right), gapTop: Math.round(s.top - c.top) };
  });
}

async function main() {
  const browser = await launchBrowser();
  // 管理员令牌只用来开关注册，不参与界面断言。
  const adminToken = await login(ADMIN.email, ADMIN.password);

  try {
    const { page, errors } = await newPage(browser);

    // ── 1. 登录页：入口存在、在右上角、第一个 Tab 就到 ──────────
    await page.goto(`${BASE}/login`);
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 30000 });

    const select = page.getByLabel('界面语言');
    check('IE-M8-01 登录页有语言选择器', (await select.count()) === 1, `匹配 ${await select.count()} 个`);

    const offset = await switcherOffset(page);
    check(
      'IE-M8-02 选择器贴在卡片右上角',
      offset !== null && offset.gapRight >= 0 && offset.gapRight <= 40 && offset.gapTop >= 0 && offset.gapTop <= 40,
      JSON.stringify(offset),
    );

    // 从 body 起按一次 Tab。若选择器不是第一个可聚焦元素，落点会是输入框。
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.keyboard.press('Tab');
    const firstFocus = await page.evaluate(() => document.activeElement?.tagName ?? '');
    check('IE-M8-03 第一个 Tab 落在选择器上', firstFocus === 'SELECT', `落点 ${firstFocus}`);

    // ── 2. 默认中文 ────────────────────────────────────────────
    const zhHeading = (await page.getByRole('heading', { level: 1 }).textContent()) ?? '';
    check('IE-M8-04 默认是中文界面', zhHeading.includes('登录') && (await page.getByRole('button', { name: '登录' }).count()) === 1, zhHeading);

    // ── 3. 切到英文 ────────────────────────────────────────────
    await select.selectOption('en-US');
    await page.waitForFunction(() => document.documentElement.lang === 'en-US', undefined, { timeout: 10000 });
    // 等 h1 真的换了文字，而不是只等 `html[lang]`：后者在 `changeLanguage`
    // 之前就已经改好了（`applyLocale` 先跑），单看它会拿到一个还在渲染中文的中间态。
    await page.getByRole('heading', { level: 1, name: /Sign in to/ }).waitFor({ timeout: 10000 });

    const enText = await cardTextWithoutSwitcher(page);
    const cjk = /[\u4e00-\u9fa5]+/.exec(enText)?.[0] ?? '';
    check(
      'IE-M8-05 英文下整块登录卡片没有残留中文',
      enText.includes('Sign in to') && enText.includes('Username') && enText.includes('Password') && cjk === '',
      cjk === '' ? '无中文' : `残留：${cjk}`,
    );
    check(
      'IE-M8-06 切英文后 html[lang] 同步',
      (await page.evaluate(() => document.documentElement.lang)) === 'en-US',
    );
    const stored = await page.evaluate(() => window.localStorage.getItem('wmind:locale'));
    check('IE-M8-07 偏好写进 localStorage', stored === 'en-US', `wmind:locale=${stored}`);

    // ── 4. 刷新后仍是英文 ──────────────────────────────────────
    await page.reload();
    await page.getByRole('heading', { level: 1, name: /Sign in to/ }).waitFor({ timeout: 30000 });
    check(
      'IE-M8-08 刷新后登录页仍是英文',
      (await page.evaluate(() => document.documentElement.lang)) === 'en-US',
    );

    // ── 5. 注册页同样有入口，且跟着当前语言走 ──────────────────
    await page.goto(`${BASE}/register`);
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 30000 });
    const registerOffset = await switcherOffset(page);
    const registerText = await cardTextWithoutSwitcher(page);
    check(
      'IE-M8-09 注册页也有右上角选择器，且界面是英文',
      (await page.getByLabel('Language').count()) === 1 &&
        registerOffset !== null &&
        registerOffset.gapRight <= 40 &&
        registerOffset.gapTop <= 40 &&
        registerText.includes('Create account'),
      JSON.stringify(registerOffset),
    );

    // ── 6. 关站页：最需要切换的那一页 ──────────────────────────
    await setRegistration(adminToken, false);
    await page.goto(`${BASE}/register`);
    await page.getByRole('heading', { level: 1, name: 'Registration is closed' }).waitFor({ timeout: 30000 });
    const closedOffset = await switcherOffset(page);
    check(
      'IE-M8-10 关站提示页仍有语言选择器',
      (await page.getByLabel('Language').count()) === 1 && closedOffset !== null && closedOffset.gapTop <= 48,
      JSON.stringify(closedOffset),
    );
    await setRegistration(adminToken, true);

    // ── 7. 切回中文 ────────────────────────────────────────────
    await page.goto(`${BASE}/login`);
    await page.getByLabel('Language').selectOption('zh-CN');
    await page.getByRole('heading', { level: 1, name: /登录/ }).waitFor({ timeout: 10000 });
    check(
      'IE-M8-11 切回中文后登录页恢复中文',
      (await page.getByRole('button', { name: '登录' }).count()) === 1 &&
        (await page.evaluate(() => document.documentElement.lang)) === 'zh-CN',
    );

    check('IE-M8-12 全程没有未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    // 上面中途失败也要把注册开回去，否则后面几套全挂在 403 上。
    await setRegistration(adminToken, true).catch(() => undefined);
    await browser.close();
  }
}

run(main);
