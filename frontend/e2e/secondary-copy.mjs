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
  const shares = [];
  const maps = new Map();
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    const request = route.request();
    let data = [];
    if (path === '/auth/me') data = { uid: 'copy-admin', username: 'admin', nickname: '', email: 'copy@example.test', role: 'admin', status: 'active', settings: {} };
    if (path === '/site/config') data = { siteName: 'wmind', brand: 'wmind', logoUrl: '', description: '', icp: '', version: '1.0.0', passwordMinLength: 8, registrationEnabled: true, shareEnabled: true, shareDefaultExpireDays: 7, shareDefaultAllowDownload: false, importEnabled: true, exportEnabled: true, userTemplateEnabled: true };
    if (path === '/maps' && request.method() === 'POST') {
      const input = request.postDataJSON();
      data = { ...input, uid: `copy-map-${maps.size + 1}`, version: 1, nodeCount: 5, sizeBytes: 1024, deleted: false, createdAt: nextRuns[0], updatedAt: nextRuns[0], thumbnailUrl: '' };
      maps.set(data.uid, data);
    }
    if (path.startsWith('/maps/copy-map-')) data = maps.get(path.split('/')[2]);
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
    if (path === '/shares' || path === '/maps/demo/shares') {
      if (request.method() === 'POST') {
        const input = request.postDataJSON();
        data = { ...input, uid: 'copy-share', url: '/s/copy-share', mapUid: 'demo', mapTitle: '产品规划', createdAt: nextRuns[0], expiresAt: nextRuns[1], viewCount: 0 };
        shares.push(data);
      } else data = shares;
    }
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

async function editorChecks(page, t, locale) {
  const verify = (name, pass) => check(`${locale} ${name}`, pass);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/maps/demo`);
  await page.locator('g.wmind-topic').first().waitFor();
  const panel = page.locator('#editor-canvas-panel');
  verify('全画布与选中主题的作用范围仍明确', await panel.getByRole('heading', { name: t('editor.panel.style.shapeSectionCanvas'), exact: true }).isVisible() && await panel.getByText(t('editor.panel.style.single'), { exact: true }).isVisible());
  await panel.getByRole('tab', { name: t('editor.panel.tabs.palette'), exact: true }).click();
  const rainbow = panel.getByRole('checkbox', { name: t('editor.panel.canvas.rainbowBranch'), exact: true });
  const before = await rainbow.getAttribute('aria-checked');
  verify('彩虹分支只保留一处开关标签', await rainbow.count() === 1 && !(await panel.getByRole('heading').allTextContents()).includes(locale === 'zh-CN' ? '彩虹分支' : 'Rainbow branches'));
  await rainbow.click();
  await page.locator('[data-editor-toolbar]').getByRole('button', { name: t('editor.undo'), exact: true }).click();
  verify('去掉重复标题不影响开关与撤销', await rainbow.getAttribute('aria-checked') === before);
  await panel.getByRole('tab', { name: t('editor.panel.tabs.structure'), exact: true }).click();
  const canvas = page.locator('svg[data-read-only="false"]').first();
  await canvas.click({ position: { x: 12, y: 12 } });
  const relationship = panel.locator('section').filter({ has: page.getByRole('heading', { name: t('editor.annotation.relationship'), exact: true }) });
  verify('无有效选区时说明新建要求', await relationship.getByText(t('editor.annotation.relationshipHint'), { exact: true }).isVisible() && await relationship.getByRole('button', { name: t('editor.annotation.add'), exact: true }).isDisabled());
  const selectPair = async () => {
    await canvas.click({ position: { x: 12, y: 12 } });
    await page.locator('g.wmind-topic').filter({ hasText: '用户研究' }).first().click();
    await page.locator('g.wmind-topic').filter({ hasText: '功能设计' }).first().click({ modifiers: ['Shift'] });
  };
  await selectPair();
  verify('已有联系且选区有效时不重复教程', await relationship.getByText(t('editor.annotation.relationshipHint'), { exact: true }).count() === 0 && await relationship.locator('li').count() === 1);
  const summaries = panel.locator('section').filter({ has: page.getByRole('heading', { name: t('editor.annotation.summary'), exact: true }) });
  await summaries.getByRole('button', { name: t('editor.annotation.add'), exact: true }).click();
  await summaries.locator('li').waitFor();
  await selectPair();
  verify('创建概要后保留范围摘要且不显示多余引导', await summaries.getByText(t('editor.annotation.summaryHint'), { exact: true }).count() === 0 && (await summaries.locator('li').innerText()).includes('用户研究'));
  await canvas.click({ position: { x: 12, y: 12 } });
  verify('清空选区后按需恢复禁用原因', await summaries.getByText(t('editor.annotation.summaryHint'), { exact: true }).isVisible() && await summaries.getByRole('button', { name: t('editor.annotation.add'), exact: true }).isDisabled());
  await page.getByRole('button', { name: t('share.action'), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: t('share.title', { title: '产品规划' }), exact: true });
  await dialog.waitFor();
  verify('分享保留密码限制而不复述下载开关', await dialog.getByText(t('share.create.passwordHint'), { exact: true }).isVisible() && !/关闭后分享页不显示下载入口|When off, the share page hides/.test(await dialog.innerText()));
  await dialog.getByRole('button', { name: t('share.create.submit'), exact: true }).click();
  await dialog.getByText(t('share.create.done'), { exact: true }).waitFor();
  verify('创建结果保留链接与复制入口', await dialog.locator('code').first().textContent() !== '' && await dialog.getByRole('button', { name: t('share.copy'), exact: true }).count() > 0);
  await page.setViewportSize({ width: 375, height: 900 });
  verify('窄屏分享弹窗不溢出', await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth));
  await page.screenshot({ path: `/tmp/wmind-copy-share-${locale}.png` });
  await dialog.getByRole('button', { name: t('common.close'), exact: true }).click();
}

async function transferChecks(page, t, locale) {
  const verify = (name, pass) => check(`${locale} ${name}`, pass);
  const fits = (dialog) => dialog.evaluate((node) => node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().right <= innerWidth);
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto(BASE);
  await page.getByRole('button', { name: t('import.dialog.title'), exact: true }).click();
  const importing = page.getByRole('dialog', { name: t('import.dialog.title'), exact: true });
  await importing.waitFor();
  verify('导入格式上限仅在上传区出现一次且没有空副标题', await importing.getAttribute('aria-describedby') === null && (await importing.innerText()).split('XMind / Markdown / OPML').length === 2 && await fits(importing));
  await importing.locator('input[type=file]').setInputFiles({ name: 'copy.md', mimeType: 'text/markdown', buffer: Buffer.from('# Copy test\n## Branch') });
  const parsed = page.getByRole('dialog', { name: t('import.dialog.summaryTitle'), exact: true });
  await parsed.waitFor();
  verify('导入保留摘要确认与创建入口', await parsed.getByText(t('import.dialog.summaryDescription'), { exact: true }).isVisible() && await parsed.getByRole('button', { name: t('import.dialog.create'), exact: true }).isEnabled());
  await parsed.getByRole('button', { name: t('common.cancel'), exact: true }).click();

  await page.getByRole('button', { name: t('maps.create'), exact: true }).first().click();
  const picker = page.getByRole('dialog', { name: t('templates.picker.title'), exact: true });
  await picker.waitFor();
  verify('模板无泛化副标题但保留点击后果', await picker.getAttribute('aria-describedby') === null && await picker.getByText(t('templates.picker.hint'), { exact: true }).isVisible() && await fits(picker));
  const search = picker.getByRole('textbox', { name: t('templates.picker.search'), exact: true });
  await search.fill(t('templates.builtin.fishbone'));
  const template = picker.getByRole('button').filter({ hasText: t('templates.builtin.fishbone') });
  await template.locator('svg text').first().waitFor();
  verify('模板搜索与实际预览仍有效', await template.count() === 1 && await template.locator('svg text').count() >= 5);
  await template.click();
  await page.waitForURL('**/maps/copy-map-*');
  await page.locator('g.wmind-topic').first().waitFor();
  verify('选择模板仍直接创建并进入编辑器', await page.getByRole('dialog').count() === 0 && await page.locator('g.wmind-topic').count() >= 5);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/maps/demo`);
  await page.locator('g.wmind-topic').first().waitFor();
  await page.getByRole('button', { name: t('templates.saveAs'), exact: true }).click();
  const saving = page.getByRole('dialog', { name: t('templates.saveAs'), exact: true });
  await saving.waitFor();
  verify('另存模板保留副本独立性而不展示实现细节', await saving.getByText(t('templates.saveAsHint'), { exact: true }).isVisible() && !/缩略图|thumbnail/.test(await saving.innerText()) && await saving.getByRole('button', { name: t('common.save'), exact: true }).isEnabled());
  await saving.getByRole('button', { name: t('common.cancel'), exact: true }).click();

  const openExport = async () => {
    await page.getByRole('button', { name: t('editor.exportEntry'), exact: true }).click();
    const dialog = page.getByRole('dialog', { name: t('editor.export.title'), exact: true });
    await dialog.waitFor();
    return dialog;
  };
  let exporting = await openExport();
  await page.setViewportSize({ width: 375, height: 900 });
  for (const format of ['Svg', 'Png', 'Jpeg', 'Pdf', 'Xmind', 'Md', 'Opml']) {
    await exporting.getByRole('radio', { name: t(`editor.export.format${format}`), exact: true }).click();
    verify(`${format} 无重复通用介绍且窄屏不溢出`, (await exporting.getAttribute('aria-describedby') !== null) === (format === 'Pdf') && !/预览即最终结果|preview is exactly what you get/i.test(await exporting.innerText()) && await fits(exporting));
    if (format === 'Pdf') {
      verify('PDF明确提示位图文字不可选中', await exporting.getByText(t('editor.export.descriptionPdf'), { exact: true }).isVisible());
      await page.screenshot({ path: `/tmp/wmind-copy-export-${locale}.png` });
    }
    if (format === 'Jpeg') {
      const transparent = exporting.getByRole('checkbox', { name: t('editor.export.transparent'), exact: true });
      if (await transparent.getAttribute('aria-checked') !== 'true') await transparent.click();
      verify('JPEG透明冲突按需提示', await exporting.getByText(t('editor.export.jpegOpaque'), { exact: true }).isVisible());
    }
    if (format === 'Md' || format === 'Opml') verify(`${format} 保留样式丢失警告`, await exporting.getByText(t('editor.export.textWarning'), { exact: true }).isVisible());
    if (format === 'Xmind') verify('XMind保留范围说明与真实大纲预览', await exporting.getByText(t('editor.export.xmindNote'), { exact: true }).isVisible() && (await exporting.getByTestId('export-text-preview').innerText()).includes('产品规划'));
  }
  await exporting.getByRole('button', { name: t('editor.export.cancel'), exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const format of ['Svg', 'Pdf']) {
    exporting = await openExport();
    await exporting.getByRole('radio', { name: t(`editor.export.format${format}`), exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      exporting.getByRole('button', { name: t('editor.export.downloadAs', { format: t(`editor.export.format${format}`) }), exact: true }).click(),
    ]);
    const bytes = readFileSync(await download.path());
    verify(`${format} 实际下载仍有效`, format === 'Pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : bytes.toString().includes('<svg') && bytes.toString().includes('产品规划'));
    await exporting.waitFor({ state: 'hidden' });
  }
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
        await editorChecks(page, i18n.t.bind(i18n), locale);
        await transferChecks(page, i18n.t.bind(i18n), locale);
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
