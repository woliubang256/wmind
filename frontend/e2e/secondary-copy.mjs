/** 次级文案回归使用独立接口夹具，不操作开发数据库或真实远端存储。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInstance } from 'i18next';
import { BASE, check, launchBrowser, newContext, newPage, run, summary } from './lib/harness.mjs';

const resources = Object.fromEntries(['zh-CN', 'en-US'].map((locale) => [locale, {
  translation: JSON.parse(readFileSync(new URL(`../src/lib/i18n/locales/${locale}.json`, import.meta.url), 'utf8')),
}]));
const nextRuns = Array.from({ length: 5 }, (_, index) => `2026-11-${String(index + 1).padStart(2, '0')}T03:00:00Z`);

async function fixture(page) {
  let configuration = {
    enabled: false, retainCount: 30, skipUnchanged: false, cron: '0 3 * * *', timezone: 'Asia/Shanghai', target: 'webdav',
    webdav: { url: 'https://dav.example.test/backups', username: 'backup', passwordSet: true },
    s3: { endpoint: '', region: 'us-east-1', bucket: 'backup', prefix: 'wmind', pathStyle: true, accessKeySet: true, secretKeySet: true, sessionTokenSet: true },
  };
  const state = () => ({ configuration, nextRuns, history: [], busy: false, maxUploadBytes: 2 * 1024 ** 3 });
  const saved = [];
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    const request = route.request();
    let data = [];
    if (path === '/auth/me') data = { uid: 'copy-admin', username: 'admin', nickname: '', email: 'copy@example.test', role: 'admin', status: 'active', settings: {} };
    if (path === '/site/config') data = { siteName: 'wmind', passwordMinLength: 8, registrationEnabled: true, shareEnabled: true, importEnabled: true, exportEnabled: true, userTemplateEnabled: true };
    if (path === '/admin/settings') data = { 'auth.registration_enabled': true, 'auth.default_role': 'user', 'share.public_link_enabled': true, 'limit.maps_per_user': 0, 'limit.upload_max_mb': 10 };
    if (path === '/admin/backups') data = state();
    if (path === '/admin/backups/config') {
      configuration = request.postDataJSON();
      saved.push(configuration);
      data = state();
    }
    if (path === '/admin/backups/schedule') {
      if (request.postDataJSON().cron.trim().split(/\s+/).length !== 5) return route.fulfill({ status: 422, json: { error: { code: 'BACKUP_CONFIG_INVALID', message: 'Invalid schedule' } } });
      data = { nextRuns };
    }
    if (path === '/admin/backups/restore/preview') data = { id: 'preview-copy', createdAt: nextRuns[0], database: { driver: 'sqlite', schema: 1 }, files: 3, bytes: 1024 };
    await route.fulfill({ json: { data, pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } } });
  });
  return { saved };
}

async function adminChecks(page, t, locale, saved) {
  const verify = (name, pass) => check(`${locale} ${name}`, pass);
  await page.goto(`${BASE}/admin/settings`);
  await page.getByRole('heading', { name: t('admin.settings.title'), exact: true }).waitFor();
  const general = page.getByRole('tabpanel', { name: t('backup.generalTab'), exact: true });
  verify('不展示泛化页面提醒或接口状态码', !/请留意提示|read the warnings|403/.test(await page.locator('main').innerText()));
  const unlimited = general.getByText(t('admin.settings.hintMapsPerUser'), { exact: true });
  verify('不限提示只归属于导图数量字段', await unlimited.count() === 1 && (await unlimited.locator('..').innerText()).includes(t('admin.settings.fieldMapsPerUser')));
  await general.getByRole('switch', { name: t('admin.settings.fieldRegistrationEnabled'), exact: true }).click();
  await general.getByRole('combobox', { name: t('admin.settings.fieldDefaultRole'), exact: true }).click();
  await page.getByRole('option', { name: t('admin.settings.roleAdmin'), exact: true }).click();
  verify('同组独立风险同时保留且各出现一次', await general.getByText(t('admin.settings.warnDefaultAdmin'), { exact: true }).count() === 1 && await general.getByText(t('admin.settings.warnRegistrationClosed'), { exact: true }).count() === 1);
  await general.getByRole('switch', { name: t('admin.settings.fieldPublicLinkEnabled'), exact: true }).click();
  verify('关闭分享只显示一次影响提示', await general.getByText(t('admin.settings.warnShareDisabled'), { exact: true }).count() === 1);

  await page.getByRole('tab', { name: t('backup.tab'), exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: t('backup.tab'), exact: true });
  const pick = async (key, option) => {
    await panel.getByRole('combobox', { name: t(key), exact: true }).click();
    await page.getByRole('option', { name: t(option), exact: true }).click();
  };
  const expression = panel.getByRole('textbox', { name: t('backup.expression'), exact: true });
  await panel.getByLabel(t('backup.retainCount'), { exact: true }).waitFor();
  verify('默认30份与关闭的去重由控件表达', await panel.getByLabel(t('backup.retainCount'), { exact: true }).inputValue() === '30' && await panel.getByRole('switch', { name: t('backup.skipUnchanged'), exact: true }).getAttribute('aria-checked') === 'false' && !/默认 30|默认关闭|Off by default|Default 30/.test(await panel.innerText()));
  verify('预设模式不展示高级规则和语法', await expression.count() === 0 && await panel.getByText(t('backup.cronHint'), { exact: true }).count() === 0);
  await panel.locator('ol li').first().waitFor();
  verify('保留时区与五次执行预览', await panel.getByLabel(t('backup.timezone'), { exact: true }).isVisible() && await panel.locator('ol li').count() === 5);
  await panel.getByLabel(t('backup.retainCount'), { exact: true }).fill('0');
  verify('份数错误按需显示并阻止保存', await panel.getByRole('alert').getByText(t('backup.invalidRetainCount'), { exact: true }).count() === 1 && await panel.getByRole('button', { name: t('backup.save'), exact: true }).isDisabled());
  await panel.getByLabel(t('backup.retainCount'), { exact: true }).fill('30');
  verify('修正份数后不残留错误说明', await panel.getByText(t('backup.invalidRetainCount'), { exact: true }).count() === 0);
  await pick('backup.frequency', 'backup.presets.custom');
  verify('自定义展开但不改写原表达式', await expression.inputValue() === '0 3 * * *' && await panel.getByText(t('backup.cronHint'), { exact: true }).isVisible());
  await expression.fill('10 4 * * MON-FRI');
  await panel.getByRole('button', { name: t('backup.save'), exact: true }).click();
  await page.getByText(t('backup.saved'), { exact: true }).waitFor();
  assert.equal(saved.at(-1).cron, '10 4 * * MON-FRI');
  await page.reload();
  await page.getByRole('tab', { name: t('backup.tab'), exact: true }).click();
  await expression.waitFor();
  verify('已保存的自定义表达式刷新后自动展开', await expression.inputValue() === '10 4 * * MON-FRI');
  await expression.fill('* * * * * *');
  await panel.getByText(t('backup.invalidSchedule'), { exact: true }).waitFor();
  verify('高级编辑仍显示错误并禁止保存', await panel.getByRole('button', { name: t('backup.save'), exact: true }).isDisabled());
  await pick('backup.frequency', 'backup.presets.weekly');
  verify('切回预设收起高级规则', await expression.count() === 0);
  await pick('backup.frequency', 'backup.presets.custom');
  verify('预设生成正确表达式且保留其他设置', await expression.inputValue() === '0 3 * * 1' && await panel.getByLabel(t('backup.timezone'), { exact: true }).inputValue() === 'Asia/Shanghai');
  await pick('backup.target', 'backup.s3Compatible');
  verify('多项凭据的留空规则只出现一次', await panel.getByText(t('backup.secretRetained'), { exact: true }).count() === 1 && await panel.getByLabel('S3 Access Key', { exact: true }).getAttribute('placeholder') === '••••••••');
  await panel.getByLabel(t('backup.chooseZIP'), { exact: true }).setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: Buffer.from('fixture') });
  const restore = page.getByRole('dialog', { name: t('backup.confirmTitle'), exact: true });
  await restore.waitFor();
  verify('恢复覆盖风险与确认门仍保留', await restore.getByText(t('backup.overwriteWarning'), { exact: true }).isVisible() && await restore.getByRole('button', { name: t('backup.confirmRestore'), exact: true }).isDisabled());
  await restore.getByRole('button', { name: t('common.cancel'), exact: true }).click();
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    verify(`${width}px无横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  if (locale === 'en-US') verify('英文备份区域没有中文', !/[\u4e00-\u9fff]/.test(await panel.innerText()));
  await page.screenshot({ path: `/tmp/wmind-copy-backup-${locale}.png`, fullPage: true });
}

run(async () => {
  const browser = await launchBrowser();
  try {
    for (const locale of ['zh-CN', 'en-US']) {
      const i18n = createInstance();
      await i18n.init({ resources, lng: locale, fallbackLng: locale, interpolation: { escapeValue: false } });
      const context = await newContext(browser, { locale });
      const { page, errors } = await newPage(browser, { context });
      const { saved } = await fixture(page);
      try {
        await adminChecks(page, i18n.t.bind(i18n), locale, saved);
      } catch (error) {
        console.error('页面异常：', errors, await page.locator('body').innerText());
        throw error;
      }
      check(`${locale} 无浏览器异常`, errors.length === 0, errors.join('\n'));
      await context.close();
    }
    return summary();
  } finally { await browser.close(); }
});
