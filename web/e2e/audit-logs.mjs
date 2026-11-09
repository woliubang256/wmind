/** Audit UI uses page-local API fixtures only; it never reads development credentials or data. */
import assert from 'node:assert/strict';
import os from 'node:os';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5199';
const CHROME = process.env.PLAYWRIGHT_CHROMIUM ?? `${os.homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const actor = { uid: 'audit-actor', username: 'zhangsan', nickname: '张三' };
const entry = (id, action, targetType, targetName, detail = {}) => ({
  id, actorId: 7, actor, action, targetType, targetId: `object-${id}`,
  targetName, detail, ip: '203.0.113.7', createdAt: `2026-10-${String(26 - Math.floor((id - 1) / 3)).padStart(2, '0')}T03:00:00Z`,
});
const secrets = ['SECRET_PASSWORD_AUDIT', 'SECRET_APIKEY_AUDIT', 'SECRET_TOKEN_AUDIT'];
const longTitle = `超长导图${'项目规划'.repeat(55)}`;
const logs = [
  entry(1, 'share.create', 'share', '项目计划', { mapUid: 'map-one', mapTitle: '项目计划', hasPassword: true, allowDownload: true, showNotes: false, expiresAt: '2026-11-02T03:00:00Z', password: secrets[0], apiKey: secrets[1], token: secrets[2] }),
  entry(2, 'share.revoke', 'share', '项目计划', { mapUid: 'map-one', mapTitle: '项目计划', hasPassword: true, allowDownload: false, showNotes: false, expiresAt: null }),
  entry(3, 'settings.update', 'settings', '', { keys: ['site.brand'] }),
  entry(4, 'settings.update', 'settings', '', { keys: ['ai.config'] }),
  entry(5, 'user.role', 'user', 'lisi', { from: 'user', to: 'admin' }),
  { ...entry(6, 'share.create', 'share', '', { mapUid: 'legacy-map', allowDownload: false }), actor: null, actorId: null },
  entry(7, 'unknown.action', 'unknown', '', { password: secrets[0], apiKey: secrets[1], token: secrets[2], keys: ['unrecognized.secret_field'] }),
  entry(8, 'share.create', 'share', longTitle, { mapUid: 'long-map', mapTitle: longTitle, allowDownload: false }),
  entry(9, 'user.update', 'user', 'malformed', 'invalid historical json'),
  ...Array.from({ length: 18 }, (_, index) => entry(index + 10, 'user.create', 'user', `fixture-user-${index + 10}`, { username: `fixture-user-${index + 10}` })),
];
let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log(`[PASS] ${name}`);
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--font-render-hinting=none'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  const errors = [];
  const auditRequests = [];
  const adminWrites = [];
  let role = 'admin';
  let auditMode = 'success';
  let releaseAudit;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    if (path.startsWith('/admin/') && request.method() !== 'GET') adminWrites.push({ path, method: request.method() });
    const user = { uid: 'audit-current', username: 'fixture', nickname: '', email: 'fixture@example.test', role, status: 'active', settings: {} };
    let data = [];
    let pagination = { page: 1, pageSize: 20, total: 0, totalPages: 1 };
    if (path === '/auth/refresh') data = { accessToken: 'fixture', expiresIn: 900, user };
    else if (path === '/auth/me') data = user;
    else if (path === '/site/config') data = { siteName: 'wmind', importEnabled: true, exportEnabled: true, shareEnabled: true };
    else if (path === '/admin/stats') data = { userCount: 3, activeUserCount: 2, mapCount: 5, mapCountToday: 1, storageUsedBytes: 12345, trend: [] };
    else if (path === '/admin/audit-logs') {
      auditRequests.push(url);
      const mode = auditMode;
      if (mode === 'deferred') await new Promise((resolve) => { releaseAudit = resolve; });
      if (mode === 'error') {
        await route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'fixture audit unavailable' } } }).catch(() => {});
        return;
      }
      const query = url.searchParams;
      let filtered = mode === 'empty' ? [] : logs.filter((log) => (!query.get('action') || log.action === query.get('action'))
        && (!query.get('from') || Date.parse(log.createdAt) >= Date.parse(query.get('from')))
        && (!query.get('to') || Date.parse(log.createdAt) <= Date.parse(query.get('to'))));
      const pageNumber = Number(query.get('page') || 1);
      const pageSize = Number(query.get('page_size') || 20);
      pagination = { page: pageNumber, pageSize, total: filtered.length, totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)) };
      data = filtered.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
    }
    await route.fulfill({ json: { data, pagination } }).catch(() => {});
  });
  await page.goto(`${BASE}/admin`);
  await page.getByText('最近操作', { exact: true }).waitFor();
  await page.getByText('share.create', { exact: true }).first().waitFor({ timeout: 1500 }).catch(() => {});
  if (process.env.AUDIT_BASELINE === '1') {
    const text = await page.locator('main').innerText();
    check('baseline exposes untranslated share actions', text.includes('share.create') && text.includes('share.revoke'));
    check('baseline exposes raw setting keys', text.includes('site.brand') && text.includes('ai.config'));
    check('baseline omits the operator name', !text.includes('张三'));
    await context.close();
  } else {
    const row = (id) => page.locator(`[data-audit-id="${id}"]`);
    const mainText = () => page.locator('main').innerText();
    const waitRows = async (count) => page.waitForFunction((expected) => document.querySelectorAll('main [data-audit-id]').length === expected, count);
    const responseFor = (predicate = () => true) => page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/v1/admin/audit-logs' && predicate(url.searchParams);
    });
    const switchLanguage = async (language, current = 'zh-CN') => {
      await page.getByRole('combobox', { name: current === 'zh-CN' ? '界面语言' : 'Language', exact: true }).click();
      await page.getByRole('option', { name: language, exact: true }).click();
    };
    await row(1).waitFor();
    check('recent activity names the operator and target map', (await row(1).innerText()).includes('张三') && (await row(1).innerText()).includes('项目计划'));
    check('recent activity translates share actions and setting keys', !/share\.(?:create|revoke)|site\.brand|ai\.config/.test(await mainText()));
    check('recent activity does not use object IDs as primary summaries', !(await row(1).innerText()).includes('object-1'));
    check('legacy activity stays readable without invented names', !(await row(6).innerText()).includes('张三'));
    const longSummary = row(8).locator('summary p').first();
    check('collapsed long titles occupy at most two summary lines', (await longSummary.boundingBox()).height <= 48);
    await row(8).locator('summary').click();
    check('expanded long titles show the full untruncated text', (await longSummary.boundingBox()).height > 48 && (await longSummary.textContent()).includes(longTitle));
    await row(8).locator('summary').click();
    await page.screenshot({ path: '/tmp/wmind-audit-overview.png', fullPage: true });
    await row(1).locator('summary').click();
    const shareDetail = await row(1).innerText();
    check('share details explain access permissions and expiration', shareDetail.includes('下载') && shareDetail.includes('备注') && /2026|11/.test(shareDetail));
    let completeText = await page.locator('main').textContent();
    check('expanded details never expose credential values', secrets.every((secret) => !completeText.includes(secret)));
    await row(5).locator('summary').click();
    check('role changes display meaningful old and new roles', (await row(5).innerText()).includes('普通用户') && (await row(5).innerText()).includes('管理员'));
    check('unknown action avoids raw technical text in the primary summary', !(await row(7).innerText()).includes('unknown.action'));
    await page.getByRole('link', { name: '查看全部', exact: true }).click();
    await page.getByRole('heading', { name: '操作日志', exact: true }).waitFor();
    await waitRows(20);
    check('full audit view loads the first 20 entries', await page.locator('main [data-audit-id]').count() === 20);
    const userTrigger = page.getByRole('button', { name: '用户菜单', exact: true });
    await userTrigger.press('ArrowUp');
    const userMenu = page.getByRole('menu', { name: '用户菜单', exact: true });
    await userMenu.waitFor();
    const menuLabels = await userMenu.getByRole('menuitem').evaluateAll((items) => items.map((item) => item.querySelector('span')?.textContent?.trim()));
    check('the administrator menu contains all five translated destinations', menuLabels.join(',') === '个人设置,管理概览,用户管理,网站设置,操作日志');
    check('ArrowUp opens the menu on the new last audit destination', await userMenu.getByRole('menuitem', { name: '操作日志', exact: true }).evaluate((element) => element === document.activeElement));
    await page.keyboard.press('Enter');
    check('keyboard activation of the audit destination closes the menu', !await userMenu.isVisible() && new URL(page.url()).pathname === '/admin/audit-logs');
    check('malformed historical details do not crash or leak raw JSON', await row(9).count() === 1 && !(await mainText()).includes('invalid historical json'));

    const pageTwo = responseFor((query) => query.get('page') === '2');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await pageTwo;
    await waitRows(7);
    check('pagination requests and displays the next page', auditRequests.at(-1).searchParams.get('page') === '2' && await row(21).count() === 1);
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await waitRows(20);
    check('pagination can return to the first page', await row(1).count() === 1);

    await page.getByRole('combobox', { name: '操作类型', exact: true }).click();
    await page.getByRole('option', { name: '创建分享', exact: true }).click();
    const beforeDraft = auditRequests.length;
    await page.getByLabel('开始日期', { exact: true }).fill('2026-10-26');
    await page.getByLabel('结束日期', { exact: true }).fill('2026-10-26');
    check('editing filter drafts does not silently request new results', auditRequests.length === beforeDraft);
    const applied = responseFor((query) => query.get('action') === 'share.create');
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await applied;
    await waitRows(1);
    const appliedQuery = auditRequests.at(-1).searchParams;
    check('action filtering resets pagination to the first page', appliedQuery.get('page') === '1' && appliedQuery.get('action') === 'share.create');
    check('date filtering uses complete local-day UTC boundaries', appliedQuery.get('from') === '2026-10-25T16:00:00.000Z' && appliedQuery.get('to') === '2026-10-26T15:59:59.999999999Z');
    check('combined date and action filtering shows only matching entries', await row(1).count() === 1 && await row(2).count() === 0);
    await page.getByLabel('开始日期', { exact: true }).fill('2026-10-27');
    const beforeInvalid = auditRequests.length;
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByRole('alert').waitFor();
    check('reversed dates show validation without a request', auditRequests.length === beforeInvalid);
    await page.getByRole('button', { name: '重置', exact: true }).click();
    await waitRows(20);
    check('reset clears drafts and returns to unfiltered page one', (await page.getByLabel('开始日期', { exact: true }).inputValue()) === '' && await row(1).count() === 1 && await row(20).count() === 1);
    await page.getByRole('combobox', { name: '操作类型', exact: true }).click();
    await page.getByRole('option', { name: '创建用户', exact: true }).click();
    const partialDate = page.getByLabel('开始日期', { exact: true });
    await partialDate.focus();
    await partialDate.press('1');
    check('the browser identifies a partially entered date as invalid', await partialDate.evaluate((element) => element.value === '' && element.validity.badInput));
    const beforePartial = auditRequests.length;
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.waitForTimeout(100);
    check('partially entered dates show validation instead of sending an unbounded query', auditRequests.length === beforePartial && await page.getByRole('alert').count() > 0);
    await page.getByRole('button', { name: '重置', exact: true }).click();
    check('reset clears partial native date input and its validity state', await partialDate.evaluate((element) => element.value === '' && element.validity.valid));
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    check('a reset date filter can be applied without a stale validation error', await page.getByRole('alert').count() === 0);

    await switchLanguage('English');
    await page.getByRole('heading', { name: 'Audit log', exact: true }).waitFor();
    check('switching language updates action summaries immediately', !/share\.(?:create|revoke)|site\.brand|ai\.config/.test(await mainText()) && !(await row(1).innerText()).includes('创建'));
    await row(1).locator('summary').click();
    check('English details translate permission fields', /download/i.test(await row(1).innerText()) && !/允许下载|主题备注/.test(await row(1).innerText()));
    completeText = await page.locator('main').textContent();
    check('English rendering still hides all credential values', secrets.every((secret) => !completeText.includes(secret)));
    await page.getByRole('button', { name: 'User menu', exact: true }).click();
    const englishMenu = page.getByRole('menu', { name: 'User menu', exact: true });
    await englishMenu.waitFor();
    check('all five administrator destinations translate into English', (await englishMenu.getByRole('menuitem').evaluateAll((items) => items.map((item) => item.querySelector('span')?.textContent?.trim()))).join(',') === 'Account,Overview,Users,Site settings,Audit log');
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 375, height: 900 });
    check('mobile audit layout has no horizontal page overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    check('long titles fit within the mobile row', await row(8).evaluate((element) => element.scrollWidth <= element.clientWidth));
    await page.getByRole('button', { name: 'User menu', exact: true }).click();
    await englishMenu.waitFor();
    const menuBox = await englishMenu.boundingBox();
    check('the five-item menu fits on mobile screens', menuBox.x >= 0 && menuBox.x + menuBox.width <= 375 && await englishMenu.getByRole('menuitem', { name: 'Audit log', exact: true }).isVisible());
    await page.keyboard.press('Escape');
    await switchLanguage('中文', 'en-US');
    await page.getByRole('heading', { name: '操作日志', exact: true }).waitFor();
    await page.screenshot({ path: '/tmp/wmind-audit-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });

    auditMode = 'empty';
    const emptyResponse = responseFor();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await emptyResponse;
    await waitRows(0);
    check('empty results are a readable empty state', /记录|日志/.test(await mainText()));
    auditMode = 'error';
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('button', { name: '重试', exact: true }).waitFor();
    check('request failures expose a retry action', await page.getByRole('button', { name: '重试', exact: true }).isVisible());
    auditMode = 'success';
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await waitRows(20);
    check('retry recovers the complete result list', await row(1).count() === 1);
    auditMode = 'deferred';
    await page.reload();
    await page.waitForFunction(() => Boolean(document.querySelector('[role="status"]')));
    check('loading is announced while the audit request is pending', await page.getByRole('status').count() > 0);
    for (let attempts = 0; !releaseAudit && attempts < 100; attempts += 1) await page.waitForTimeout(10);
    assert.ok(releaseAudit, 'the deferred audit fixture receives its request');
    auditMode = 'success';
    releaseAudit();
    await waitRows(20);
    check('loading resolves to the complete result list', await row(1).count() === 1);
    check('browsing and filtering audits never sends mutation requests', adminWrites.length === 0);

    role = 'user';
    const beforeForbidden = auditRequests.length;
    await page.goto(`${BASE}/admin/audit-logs`);
    await page.waitForURL((url) => url.pathname === '/');
    check('non-admin navigation cannot load the audit view', auditRequests.length === beforeForbidden && await page.locator('[data-audit-id]').count() === 0);
    await page.getByRole('button', { name: '用户菜单', exact: true }).click();
    const regularMenu = page.getByRole('menu', { name: '用户菜单', exact: true });
    await regularMenu.waitFor();
    check('ordinary accounts have no audit or administrator menu destinations', await regularMenu.getByRole('menuitem').count() === 1 && await regularMenu.getByRole('menuitem', { name: '操作日志', exact: true }).count() === 0);
    check('audit scenarios have no browser runtime errors', errors.length === 0);
    await context.close();
  }
  console.log(`\n${passed} audit UI checks passed`);
} finally { await browser.close(); }
