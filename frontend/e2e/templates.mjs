/**
 * M5 验收：模板选择与模板管理（路线图判据 1）。
 *
 * 「从 8 个内置模板各创建一次导图，结构符合模板定义」——这条必须走真实界面：
 * 卡片预览是不是真的画出来了、点了之后落到的编辑器里结构下拉框是不是那个值，
 * 都只有渲染出来才知道。
 *
 * 数据准备走 REST，断言走 DOM。
 */

import {
  ADMIN,
  BASE,
  api,
  check,
  ensureUser,
  launchBrowser,
  login,
  makeUser,
  newPage,
  run,
  stamp,
  summary,
  uiLogin,
} from './lib/harness.mjs';

const USER = makeUser('tpl');

/** 期望：模板名 → 它应该落到编辑器里的结构值。 */
const EXPECTED = [
  ['思维导图', 'mindmap'],
  ['逻辑图', 'logic-right'],
  ['括号图', 'brace'],
  ['组织架构图', 'org-chart'],
  ['树状图', 'tree-right'],
  ['时间轴', 'timeline'],
  ['鱼骨图', 'fishbone'],
  ['树型表格', 'tree-table'],
];

/** 打开模板选择对话框。 */
async function openPicker(page) {
  await page.goto(`${BASE}/`);
  await page.getByRole('button', { name: '新建导图' }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '新建导图' }).first().click();
  const dialog = page.locator('dialog[open]').filter({ hasText: '选择模板' });
  await dialog.waitFor({ timeout: 30000 });
  return dialog;
}

async function main() {
  const token = await ensureUser(USER);
  const adminToken = await login(ADMIN.email, ADMIN.password);

  const browser = await launchBrowser();
  const { page, errors } = await newPage(browser);

  try {
    await uiLogin(page, USER);

    // ── 1. 新建打开模板选择，8 个内置模板都在 ────────────────────────────
    let dialog = await openPicker(page);
    const cardTitles = await dialog.locator('button span.truncate').allInnerTexts();
    check(
      'IE-TPL-01 「新建导图」打开模板选择并列出 8 个内置模板',
      EXPECTED.every(([name]) => cardTitles.includes(name)) && cardTitles.length === 8,
      cardTitles.join(' | '),
    );

    // 预览是真渲染：等字体就绪后每张卡里都该有 SVG 文字。
    await page.waitForFunction(
      () => document.querySelectorAll('dialog[open] svg text').length > 0,
      undefined,
      { timeout: 30000 },
    );
    const previewTexts = await dialog.locator('svg text').count();
    check('IE-TPL-02 每张卡都有实时预览（SVG 真的画出来了）', previewTexts >= 8 * 5, `svg text 节点 ${previewTexts}`);

    // ── 2. 分类筛选与搜索 ────────────────────────────────────────────────
    await dialog.getByRole('tab', { name: '我的模板' }).click();
    const mineEmpty = await dialog.getByText('还没有自己的模板').first().isVisible();
    check('IE-TPL-03 「我的模板」空态有引导文案', mineEmpty);

    await dialog.getByRole('tab', { name: /^基本/ }).click();
    const basicCount = await dialog.locator('button span.truncate').count();
    check('IE-TPL-04 「基本」筛选只显示 8 个内置模板', basicCount === 8, `count=${basicCount}`);

    await dialog.getByRole('textbox', { name: '搜索模板' }).fill('鱼骨');
    await page.waitForTimeout(300);
    const filtered = await dialog.locator('button span.truncate').allInnerTexts();
    check('IE-TPL-05 搜索能过滤到单个模板', filtered.length === 1 && filtered[0] === '鱼骨图', filtered.join('|'));

    await dialog.getByRole('textbox', { name: '搜索模板' }).fill('不存在的名字');
    await page.waitForTimeout(300);
    const noMatch = await dialog.getByText('没有匹配的模板').isVisible();
    check('IE-TPL-06 搜索无结果时显示空态', noMatch);

    // ── 3. 八个模板各建一次，结构要对 ────────────────────────────────────
    const created = [];
    for (const [name, structure] of EXPECTED) {
      dialog = await openPicker(page);
      await dialog.locator('button', { hasText: name }).first().click();
      await page.waitForURL((url) => url.pathname.startsWith('/maps/'), { timeout: 30000 });
      const uid = page.url().split('/maps/')[1].split(/[?#]/)[0];
      // 自绘下拉不是 <select>，`inputValue()` 用不了；值挂在 `data-value` 上。
      const select = page.locator('header').getByLabel('结构');
      await select.waitFor({ timeout: 30000 });
      const actual = await select.getAttribute('data-value');
      created.push({ name, structure, actual, uid });
      check(`IE-TPL-07 从「${name}」建图后结构是 ${structure}`, actual === structure, `实际 ${actual}`);
    }

    // ── 4. 另存为模板 ────────────────────────────────────────────────────
    const source = created[0];
    await page.goto(`${BASE}/maps/${source.uid}`);
    const saveButton = page.getByRole('button', { name: '另存为模板' });
    await saveButton.waitFor({ timeout: 30000 });
    check('IE-TPL-08 编辑器顶部有「另存为模板」', await saveButton.isVisible());

    await saveButton.click();
    const saveDialog = page.locator('dialog[open]').filter({ hasText: '另存为模板' });
    await saveDialog.waitFor({ timeout: 30000 });
    const nameField = saveDialog.getByLabel('模板名称');
    await nameField.fill(`我的起点 ${stamp}`);
    await saveDialog.getByRole('button', { name: '保存' }).click();
    await page.getByText('已存为模板').waitFor({ timeout: 30000 });
    check('IE-TPL-09 另存为模板成功并有提示', true);

    // ── 5. 模板页 ────────────────────────────────────────────────────────
    await page.goto(`${BASE}/templates`);
    await page.getByRole('heading', { name: '模板', exact: true }).waitFor({ timeout: 30000 });
    const basicSection = await page.locator('section').first().locator('button span.truncate').allInnerTexts();
    check('IE-TPL-10 模板页上半是 8 个内置模板', basicSection.length === 8, `${basicSection.length} 个`);

    const mineCard = page.locator('div.rounded-2xl').filter({ hasText: `我的起点 ${stamp}` }).first();
    await mineCard.waitFor({ timeout: 30000 });
    check('IE-TPL-11 模板页下半出现刚存的模板', true);

    // 改名
    await mineCard.getByRole('button', { name: '重命名' }).click();
    const renameDialog = page.locator('dialog[open]').filter({ hasText: '重命名模板' });
    await renameDialog.waitFor({ timeout: 30000 });
    await renameDialog.getByLabel('模板名称').fill(`改名后的模板 ${stamp}`);
    await renameDialog.getByRole('button', { name: '保存' }).click();
    await page.getByText('已重命名').waitFor({ timeout: 30000 });
    const renamed = page.locator('div.rounded-2xl').filter({ hasText: `改名后的模板 ${stamp}` }).first();
    check('IE-TPL-12 我的模板可重命名', await renamed.isVisible());

    // 用我的模板建图，结构应与源导图一致
    await renamed.locator('button').first().click();
    await page.waitForURL((url) => url.pathname.startsWith('/maps/'), { timeout: 30000 });
    const mineStructure = await page.locator('header').getByLabel('结构').getAttribute('data-value');
    check(
      'IE-TPL-13 用「我的模板」建图，结构沿用源导图',
      mineStructure === source.structure,
      `期望 ${source.structure}，实际 ${mineStructure}`,
    );

    // 删除
    await page.goto(`${BASE}/templates`);
    const toDelete = page.locator('div.rounded-2xl').filter({ hasText: `改名后的模板 ${stamp}` }).first();
    await toDelete.waitFor({ timeout: 30000 });
    await toDelete.getByRole('button', { name: '删除' }).click();
    const confirm = page.locator('dialog[open]').filter({ hasText: '删除这个模板？' });
    await confirm.getByRole('button', { name: '删除' }).click();
    await page.getByText('已删除').waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    const gone = await page.locator('div.rounded-2xl').filter({ hasText: `改名后的模板 ${stamp}` }).count();
    check('IE-TPL-14 我的模板可删除', gone === 0);

    // ── 6. 站点开关 ──────────────────────────────────────────────────────
    await api('/admin/settings', {
      method: 'PUT',
      token: adminToken,
      body: { 'feature.user_template_enabled': false },
    });
    const siteOff = await api('/site/config');
    check('IE-TPL-15 关闭后站点配置 userTemplateEnabled=false', siteOff.data.userTemplateEnabled === false);

    await page.goto(`${BASE}/templates`);
    await page.getByText('站点已关闭用户模板').first().waitFor({ timeout: 30000 });
    check('IE-TPL-16 关闭后模板页给出「已关闭」提示而不是报错', true);

    await page.goto(`${BASE}/maps/${source.uid}`);
    await page.locator('header').getByLabel('结构').waitFor({ timeout: 30000 });
    const saveHidden = await page.getByRole('button', { name: '另存为模板' }).count();
    check('IE-TPL-17 关闭后编辑器不再显示「另存为模板」', saveHidden === 0);

    const blocked = await api('/templates', {
      method: 'POST',
      token,
      body: { name: '关闭后', mapUid: source.uid },
      raw: true,
    });
    check(
      'IE-TPL-18 关闭后另存接口返回 403 TEMPLATE_DISABLED',
      blocked.status === 403 && blocked.payload?.error?.code === 'TEMPLATE_DISABLED',
      `${blocked.status} ${blocked.payload?.error?.code}`,
    );

    // 内置模板不受影响：关闭后仍能新建
    dialog = await openPicker(page);
    const stillThere = await dialog.locator('button span.truncate').count();
    check('IE-TPL-19 关闭用户模板后 8 个内置模板仍然可用', stillThere === 8, `count=${stillThere}`);

    await api('/admin/settings', {
      method: 'PUT',
      token: adminToken,
      body: { 'feature.user_template_enabled': true },
    });

    check('IE-TPL-20 全程没有页面级 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
  }

  return summary();
}

run(main);
