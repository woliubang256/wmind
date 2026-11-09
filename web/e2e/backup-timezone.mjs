/** 固定时区与搜索交互；所有 API 使用独立夹具，不写真实配置或远端备份。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInstance } from 'i18next';
import { BASE, check, launchBrowser, newContext, newPage, run, summary } from './lib/harness.mjs';

const nextRuns = Array.from({ length: 5 }, (_, index) => `2026-11-${String(index + 1).padStart(2, '0')}T03:00:00Z`);

async function fixture(page, timezone = 'Asia/Shanghai') {
  let configuration = {
    enabled: false, retainCount: 30, skipUnchanged: false, cron: '0 3 * * *', timezone, target: 'webdav',
    webdav: { url: 'https://backup.example.test', username: '', passwordSet: false },
    s3: { endpoint: '', region: 'us-east-1', bucket: '', prefix: 'wmind', pathStyle: true },
  };
  const saved = [];
  const schedules = [];
  const state = () => ({ configuration, nextRuns, history: [], busy: false, maxUploadBytes: 2 * 1024 ** 3 });
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    const user = { uid: 'timezone-admin', username: 'admin', nickname: '', email: '', role: 'admin', status: 'active' };
    let data = [];
    if (path === '/auth/me') data = user;
    if (path === '/auth/refresh') data = { user, accessToken: 'fixture-token', expiresIn: 900 };
    if (path === '/site/config') data = { siteName: 'wmind', brand: 'wmind', passwordMinLength: 8 };
    if (path === '/admin/settings') data = {};
    if (path === '/admin/backups') data = state();
    if (path === '/admin/backups/schedule') { schedules.push(route.request().postDataJSON()); data = { nextRuns }; }
    if (path === '/admin/backups/config') { configuration = route.request().postDataJSON(); saved.push(configuration); data = state(); }
    await route.fulfill({ json: { data } });
  });
  return { saved, schedules };
}

run(async () => {
  const browser = await launchBrowser();
  try {
    for (const locale of ['zh-CN', 'en-US']) {
      const i18n = createInstance();
      await i18n.init({ lng: locale, resources: { [locale]: { translation: JSON.parse(readFileSync(new URL(`../src/lib/i18n/locales/${locale}.json`, import.meta.url), 'utf8')) } } });
      const t = i18n.t.bind(i18n);
      const verify = (name, pass, detail) => check(`${locale} ${name}`, pass, detail);
      const context = await newContext(browser, { locale });
      const { page, errors } = await newPage(browser, { context });
      const { saved, schedules } = await fixture(page);
      await page.goto(`${BASE}/admin/settings`);
      await page.getByRole('tab', { name: t('backup.tab'), exact: true }).click();
      const trigger = page.getByRole('combobox', { name: t('backup.timezone'), exact: true });
      const save = page.getByRole('button', { name: t('backup.save'), exact: true });
      const search = page.getByRole('combobox', { name: t('backup.searchTimezone'), exact: true });
      const list = page.getByRole('listbox', { name: t('backup.timezone'), exact: true });
      await page.locator('#settings-panel-backup ol li').first().waitFor();
      verify('默认时区保持上海，控件不允许自由填写', await trigger.getAttribute('data-value') === 'Asia/Shanghai' && await trigger.evaluate((node) => node.tagName === 'BUTTON'));
      const initialSchedules = schedules.length;
      await trigger.click();
      await search.waitFor();
      verify('内置完整固定列表并自动聚焦搜索', await list.getByRole('option').count() > 400 && await search.evaluate((node) => node === document.activeElement));
      verify('浏览器可以格式化全部内置时区', await page.evaluate(async () => {
        const { TIMEZONES } = await import('/src/features/admin/timezones.ts');
        return TIMEZONES.every((timeZone) => { try { new Intl.DateTimeFormat('en', { timeZone }).format(new Date()); return true; } catch { return false; } });
      }));
      await search.fill(' sHaNgHaI ');
      verify('忽略大小写和首尾空格搜索', await list.getByRole('option').count() === 1 && await list.getByRole('option', { name: 'Asia/Shanghai', exact: true }).isVisible());
      verify('搜索不修改配置、不请求调度或保存', await trigger.getAttribute('data-value') === 'Asia/Shanghai' && schedules.length === initialSchedules && saved.length === 0 && await save.isDisabled());
      await search.press('Escape');
      verify('Esc 取消搜索并恢复触发器焦点', await list.count() === 0 && await trigger.evaluate((node) => node === document.activeElement));
      await trigger.click();
      await search.waitFor();
      const selectedVisible = await list.getByRole('option', { name: 'Asia/Shanghai', exact: true }).evaluate((node) => {
        const list = node.parentElement;
        const box = node.getBoundingClientRect();
        const bounds = list.getBoundingClientRect();
        return box.top >= bounds.top + list.clientTop && box.bottom <= bounds.top + list.clientTop + list.clientHeight;
      });
      verify('重新打开搜索清空且选中项真实可见', await search.inputValue() === '' && selectedVisible && await list.getByRole('option', { name: 'Asia/Shanghai', exact: true }).getAttribute('aria-selected') === 'true');
      await search.fill('not/a-real-timezone');
      await search.press('Enter');
      verify('无结果提示不允许创建任意值或提交表单', await list.getByRole('option').count() === 0 && await page.getByText(t('backup.noTimezone'), { exact: true }).isVisible() && await trigger.getAttribute('data-value') === 'Asia/Shanghai' && saved.length === 0);
      await search.fill('new york');
      verify('空格可搜索含下划线的城市标识', await list.getByRole('option').count() === 1 && await list.getByRole('option', { name: 'America/New_York', exact: true }).isVisible());
      await search.press('ArrowDown');
      await search.press('Enter');
      verify('方向键和回车选择固定时区并关闭弹层', await list.count() === 0 && await trigger.getAttribute('data-value') === 'America/New_York');
      await page.waitForResponse((response) => response.url().endsWith('/admin/backups/schedule') && response.request().postDataJSON().timezone === 'America/New_York');
      await save.click();
      await page.getByText(t('backup.saved'), { exact: true }).waitFor();
      verify('仅选择后更新预览且保存正确标识', schedules.at(-1).timezone === 'America/New_York' && saved.at(-1).timezone === 'America/New_York');
      await page.reload();
      await page.getByRole('tab', { name: t('backup.tab'), exact: true }).click();
      await trigger.waitFor();
      verify('刷新后保留已保存时区', await trigger.getAttribute('data-value') === 'America/New_York');
      await trigger.click();
      await search.fill('utc');
      const dimensions = await list.evaluate((node) => ({ client: node.clientHeight, scroll: node.scrollHeight }));
      verify('短搜索结果无微小滚动溢出', dimensions.client === dimensions.scroll, JSON.stringify(dimensions));
      const typeStyle = await search.evaluate((node) => ({ size: getComputedStyle(node).fontSize, weight: getComputedStyle(node).fontWeight }));
      const optionStyle = await list.getByRole('option').evaluate((node) => ({ size: getComputedStyle(node).fontSize, weight: getComputedStyle(node).fontWeight }));
      verify('搜索输入与选项实际字号一致', typeStyle.size === '14px' && optionStyle.size === '14px' && typeStyle.weight === '400');
      await search.evaluate((node) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
      verify('输入法确认按键不会误选时区', await list.isVisible() && await trigger.getAttribute('data-value') === 'America/New_York');
      await search.press('Tab');
      verify('Tab 离开关闭弹层且不更改时区', await list.count() === 0 && await trigger.getAttribute('data-value') === 'America/New_York');
      await trigger.click();
      await search.waitFor();
      await search.click();
      verify('点击搜索框不会误关闭菜单', await list.isVisible());
      await page.getByRole('heading', { name: t('admin.settings.title'), exact: true }).click();
      verify('点击外部取消搜索且不更改配置', await list.count() === 0 && await trigger.getAttribute('data-value') === 'America/New_York');
      for (const viewport of [{ width: 375, height: 812 }, { width: 900, height: 320 }]) {
        await page.setViewportSize(viewport);
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();
        const bounds = await search.locator('..').evaluate((node) => { const box = node.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, right: box.right, client: node.clientHeight, scroll: node.scrollHeight }; });
        verify(`${viewport.width}x${viewport.height} 菜单不越界并保留列表滚动`, bounds.top >= 8 && bounds.bottom <= viewport.height - 8 && bounds.right <= viewport.width - 8 && await list.evaluate((node) => node.scrollHeight > node.clientHeight));
        await page.screenshot({ path: `/tmp/wmind-timezone-${locale}-${viewport.width}.png` });
        await search.press('Escape');
      }
      verify('无页面异常或横向溢出', errors.length === 0 && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), errors.join('\n'));
      await context.close();
    }

    const context = await newContext(browser);
    const { page } = await newPage(browser, { context });
    await fixture(page, 'Etc/GMT-8');
    await page.goto(`${BASE}/admin/settings`);
    await page.getByRole('tab', { name: '备份与恢复', exact: true }).click();
    const trigger = page.getByRole('combobox', { name: '执行时区', exact: true });
    await trigger.waitFor();
    await trigger.click();
    check('已有列表外合法别名保持显示且可选，不静默替换', await trigger.getAttribute('data-value') === 'Etc/GMT-8' && await page.getByRole('option', { name: 'Etc/GMT-8', exact: true }).getAttribute('aria-selected') === 'true');
    await context.close();
    assert.ok(summary());
    return true;
  } finally { await browser.close(); }
});
