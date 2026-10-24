// 独立接口夹具：验收设置表单响应式布局，不改开发或线上数据。
import { readFileSync } from 'node:fs';
import { createInstance } from 'i18next';
import { BASE, check, launchBrowser, newContext, newPage, run, summary } from './lib/harness.mjs';

const initial = {
  'site.name': 'wmind', 'site.brand': 'wmind', 'site.logo': '', 'site.description': '', 'site.icp': '', 'site.base_url': '',
  'auth.registration_enabled': true, 'auth.default_role': 'user', 'auth.password_min_length': 8, 'auth.login_max_attempts': 5, 'auth.login_lock_minutes': 15,
  'limit.maps_per_user': 0, 'limit.upload_max_mb': 10, 'trash.retention_days': 30,
  'feature.import_enabled': true, 'feature.export_enabled': true, 'feature.user_template_enabled': true,
  'share.public_link_enabled': true, 'share.default_expire_days': 7, 'share.default_allow_download': false, 'share.require_password': false, 'share.max_links_per_map': 10,
};
const nextRuns = ['2026-11-01T03:00:00Z'];

async function fixture(page) {
  let settings = { ...initial };
  let configuration = {
    enabled: false, retainCount: 30, skipUnchanged: false, cron: '0 3 * * *', timezone: 'Asia/Shanghai', target: 's3',
    webdav: { url: '', username: '', passwordSet: false },
    s3: { endpoint: '', region: 'us-east-1', bucket: '', prefix: 'wmind', pathStyle: true },
  };
  const saved = [];
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    const user = { uid: 'layout-admin', username: 'admin', nickname: '', email: '', role: 'admin', status: 'active' };
    const state = () => ({ configuration, nextRuns, history: [], busy: false, maxUploadBytes: 2 * 1024 ** 3 });
    let data = [];
    if (path === '/auth/me') data = user;
    if (path === '/auth/refresh') data = { user, accessToken: 'fixture-token', expiresIn: 900 };
    if (path === '/site/config') data = { siteName: settings['site.name'], brand: 'wmind', passwordMinLength: 8 };
    if (path === '/admin/settings') {
      if (route.request().method() === 'PUT') { const patch = route.request().postDataJSON(); settings = { ...settings, ...patch }; saved.push(patch); }
      data = settings;
    }
    if (path === '/admin/backups') data = state();
    if (path === '/admin/backups/schedule') data = { nextRuns };
    if (path === '/admin/backups/config') { configuration = route.request().postDataJSON(); data = state(); }
    await route.fulfill({ json: { data } });
  });
  return { saved };
}

const rect = (locator) => locator.evaluate((node) => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, bottom: box.bottom, right: box.right }; });
const sameRow = (...boxes) => boxes.every((box) => Math.abs(box.y - boxes[0].y) < 2);

run(async () => {
  const browser = await launchBrowser();
  try {
    for (const locale of ['zh-CN', 'en-US']) {
      const i18n = createInstance();
      await i18n.init({ lng: locale, resources: { [locale]: { translation: JSON.parse(readFileSync(new URL(`../src/lib/i18n/locales/${locale}.json`, import.meta.url), 'utf8')) } } });
      const t = i18n.t.bind(i18n);
      const verify = (name, pass, detail) => check(`${locale} ${name}`, pass, detail);
      const context = await newContext(browser);
      const { page, errors } = await newPage(browser, { context });
      await context.addInitScript((value) => localStorage.setItem('wmind:locale', value), locale);
      const { saved } = await fixture(page);
      await page.goto(`${BASE}/admin/settings`);
      const control = (key) => page.getByRole(key === 'auth.default_role' ? 'combobox' : key === 'site.description' || key.startsWith('site.') ? 'textbox' : 'spinbutton', { name: t(`admin.settings.${{
        'site.name': 'fieldSiteName', 'site.brand': 'fieldSiteBrand', 'site.logo': 'fieldSiteLogo', 'site.description': 'fieldSiteDescription', 'site.icp': 'fieldSiteIcp', 'site.base_url': 'fieldSiteBaseUrl',
        'auth.default_role': 'fieldDefaultRole', 'auth.password_min_length': 'fieldPasswordMinLength', 'auth.login_max_attempts': 'fieldLoginMaxAttempts', 'auth.login_lock_minutes': 'fieldLoginLockMinutes',
        'limit.maps_per_user': 'fieldMapsPerUser', 'limit.upload_max_mb': 'fieldUploadMaxMb',
      }[key]}`), exact: true });
      await control('site.name').waitFor();
      const desktop = {};
      for (const key of Object.keys(initial).filter((key) => key.startsWith('site.') || key.startsWith('limit.') || ['auth.default_role', 'auth.password_min_length', 'auth.login_max_attempts', 'auth.login_lock_minutes'].includes(key))) desktop[key] = await rect(control(key));
      verify('桌面名称、品牌、Logo 三列同行', sameRow(desktop['site.name'], desktop['site.brand'], desktop['site.logo']) && desktop['site.name'].right < desktop['site.brand'].x && desktop['site.brand'].right < desktop['site.logo'].x);
      verify('桌面描述独行占满整行', desktop['site.description'].y > desktop['site.logo'].y && desktop['site.description'].width > desktop['site.name'].width * 2.5);
      verify('桌面ICP备案与站点地址并排', sameRow(desktop['site.icp'], desktop['site.base_url']) && desktop['site.icp'].right < desktop['site.base_url'].x);
      verify('桌面默认角色与密码长度并排', sameRow(desktop['auth.default_role'], desktop['auth.password_min_length']));
      verify('桌面失败次数与锁定时长并排', sameRow(desktop['auth.login_max_attempts'], desktop['auth.login_lock_minutes']));
      verify('桌面资源限制并排', sameRow(desktop['limit.maps_per_user'], desktop['limit.upload_max_mb']));
      await control('site.name').fill('布局保存测试');
      await page.getByRole('button', { name: t('admin.settings.save'), exact: true }).click();
      await page.getByText(t('admin.settings.saved', { count: 1 }), { exact: true }).waitFor();
      verify('布局调整不影响差异保存', saved.length === 1 && JSON.stringify(saved[0]) === JSON.stringify({ 'site.name': '布局保存测试' }));
      await control('auth.password_min_length').fill('7');
      await page.getByRole('button', { name: t('admin.settings.save'), exact: true }).click();
      verify('校验提示仍在对应字段且不提交', await page.getByRole('alert').filter({ hasText: t('admin.settings.min', { min: 8 }) }).isVisible() && saved.length === 1);
      await control('auth.password_min_length').fill('8');
      await page.screenshot({ path: `/tmp/wmind-admin-layout-${locale}-1440.png`, fullPage: true });
      await page.getByRole('tab', { name: t('backup.tab'), exact: true }).click();
      const frequency = page.getByRole('combobox', { name: t('backup.frequency'), exact: true });
      const timezone = page.getByRole('combobox', { name: t('backup.timezone'), exact: true });
      await frequency.waitFor();
      verify('桌面备份频率与时区并排', sameRow(await rect(frequency), await rect(timezone)));
      const target = page.getByRole('combobox', { name: t('backup.target'), exact: true });
      verify('备份方式使用接口默认 S3', await target.getAttribute('data-value') === 's3');
      await target.click();
      await page.getByRole('option', { name: 'WebDAV', exact: true }).click();
      await page.getByRole('button', { name: t('backup.save'), exact: true }).click();
      await page.getByText(t('backup.saved'), { exact: true }).waitFor();
      await page.reload();
      await page.getByRole('tab', { name: t('backup.tab'), exact: true }).click();
      await target.waitFor();
      verify('已保存 WebDAV 刷新后不被 S3 默认值覆盖', await target.getAttribute('data-value') === 'webdav');
      await frequency.click();
      await page.getByRole('option', { name: t('backup.presets.custom'), exact: true }).click();
      const expression = page.getByRole('textbox', { name: t('backup.expression'), exact: true });
      const advanced = await rect(expression);
      verify('复杂Cron展开到整行且在频率与时区之后', advanced.y > (await rect(timezone)).bottom && advanced.width > (await rect(timezone)).width * 1.8);
      await page.screenshot({ path: `/tmp/wmind-admin-backup-layout-${locale}-1440.png`, fullPage: true });
      await page.setViewportSize({ width: 375, height: 812 });
      verify('手机备份频率与时区单列', (await rect(timezone)).y > (await rect(frequency)).bottom && Math.abs((await rect(timezone)).x - (await rect(frequency)).x) < 2);
      verify('手机复杂Cron无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `/tmp/wmind-admin-backup-layout-${locale}-375.png`, fullPage: true });
      await page.getByRole('tab', { name: t('backup.generalTab'), exact: true }).click();
      for (const keys of [['site.name', 'site.brand', 'site.logo'], ['site.icp', 'site.base_url'], ['auth.default_role', 'auth.password_min_length', 'auth.login_max_attempts', 'auth.login_lock_minutes'], ['limit.maps_per_user', 'limit.upload_max_mb']]) {
        const boxes = await Promise.all(keys.map((key) => rect(control(key))));
        verify(`手机${keys[0]}字段单列排列`, boxes.every((box, index) => index === 0 || box.y > boxes[index - 1].bottom));
      }
      await page.screenshot({ path: `/tmp/wmind-admin-layout-${locale}-375.png`, fullPage: true });
      verify('页面无异常、无水平溢出', errors.length === 0 && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), errors.join('\n'));
      await context.close();
    }
    return summary();
  } finally { await browser.close(); }
});
