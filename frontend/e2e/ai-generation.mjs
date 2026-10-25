import { BASE, check, launchBrowser, newPage, run, summary, waitForCanvas } from './lib/harness.mjs';
import { aiFixtures, makePDF } from './lib/ai-fixtures.mjs';

// All API calls are page-local fixtures. No development accounts or maps are changed.
run(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser);
    const admin = { uid: 'ai-admin', username: 'ai-admin', nickname: 'AI测试', email: 'ai@example.test', role: 'admin', status: 'active' };
    let configuration = { enabled: false, baseUrl: '', model: '', apiKeySet: false, systemPrompt: '固定系统提示词，必须生成 title/children JSON。' };
    let generateMode = 'success';
    let failSave = false;
    let releaseGenerate;
    const generations = [], creations = [], saves = [];
    let created;
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
      const method = route.request().method();
      let data = [];
      if (path === '/auth/refresh') data = { accessToken: 'fixture', expiresIn: 900, user: admin };
      if (path === '/auth/me') data = admin;
      if (path === '/site/config') data = { siteName: 'wmind', aiEnabled: configuration.enabled, importEnabled: true, exportEnabled: true, shareEnabled: true, passwordMinLength: 8 };
      if (path === '/admin/settings') data = { 'site.name': 'wmind', 'auth.password_min_length': 8 };
      if (path === '/admin/backups') data = { configuration: { enabled: false, retainCount: 30, skipUnchanged: false, cron: '0 3 * * *', timezone: 'Asia/Shanghai', target: 's3', webdav: { url: '', username: '' }, s3: { endpoint: '', region: 'us-east-1', bucket: '', prefix: '', pathStyle: true } }, busy: false, history: [], nextRuns: [], maxUploadBytes: 1000 };
      if (path === '/admin/backups/schedule') data = { nextRuns: [] };
      if (path === '/admin/ai') {
        if (method === 'PUT') {
          const input = route.request().postDataJSON(); saves.push(input);
          configuration = { ...configuration, enabled: input.enabled, baseUrl: input.baseUrl, model: input.model, apiKeySet: Boolean(input.apiKey) || configuration.apiKeySet };
        }
        data = configuration;
      }
      if (path === '/ai/generate') {
        generations.push(route.request().postDataJSON());
        if (generateMode === 'deferred') await new Promise((resolve) => { releaseGenerate = resolve; });
        if (generateMode === 'failure') { await route.fulfill({ status: 502, json: { error: { code: 'AI_PROVIDER_FAILED', message: 'provider failure' } } }); return; }
        data = generateMode === 'invalid' ? { title: '', children: [] } : { title: 'AI项目计划', children: [{ title: '需求', children: [{ title: '细节', children: [] }] }, { title: '发布', children: [] }] };
      }
      if (path === '/maps' && method === 'POST') {
        const input = route.request().postDataJSON(); creations.push(input);
        if (failSave) { await route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR', message: 'save failed' } } }); return; }
        created = { ...input, uid: 'ai-generated-fixture', nodeCount: 4, version: 1, sizeBytes: 1024, thumbnailUrl: '', deleted: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        data = created;
      }
      if (path === '/maps/ai-generated-fixture') data = created;
      await route.fulfill({ json: { data, pagination: { page: 1, pageSize: 24, total: 0, totalPages: 1 } } }).catch(() => {});
    });

    await page.goto(BASE);
    await page.getByRole('button', { name: '新建导图', exact: true }).waitFor();
    check('默认关闭时不显示AI入口，普通新建与导入仍可用', await page.getByRole('button', { name: 'AI生成', exact: true }).count() === 0 && await page.getByRole('button', { name: '导入导图', exact: true }).isVisible());
    await page.goto(`${BASE}/admin/settings`);
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    const enabled = page.getByRole('switch', { name: '启用 AI 功能', exact: true });
    await enabled.waitFor();
    check('后台AI开关默认关闭', await enabled.getAttribute('aria-checked') === 'false');
    await page.getByText('追加提示词', { exact: true }).click();
    check('追加提示词可查看但不能编辑', await page.getByRole('textbox', { name: '追加提示词', exact: true }).getAttribute('readonly') !== null);
    await page.getByRole('textbox', { name: 'Base URL', exact: true }).fill('https://fixture.example/v1');
    await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('fixture-key');
    await page.getByRole('textbox', { name: 'Model', exact: true }).fill('vision-model');
    await enabled.click();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('AI 配置已保存', { exact: true }).waitFor();
    check('保存Provider不提交只读提示词，成功后清空密钥输入', saves.length === 1 && saves[0].model === 'vision-model' && !('systemPrompt' in saves[0]) && await page.getByRole('textbox', { name: 'API Key', exact: true }).inputValue() === '');
    const controls = ['Base URL', 'API Key', 'Model'];
    const desktop = await Promise.all(controls.map((name) => page.getByRole('textbox', { name, exact: true }).boundingBox()));
    check('桌面Provider三个短字段并排', desktop.every((box) => Math.abs(box.y - desktop[0].y) < 2));
    await page.setViewportSize({ width: 375, height: 812 });
    const mobile = await Promise.all(controls.map((name) => page.getByRole('textbox', { name, exact: true }).boundingBox()));
    check('手机Provider字段单列且不溢出', mobile.every((box) => box.x >= 0 && box.x + box.width <= 375) && mobile[1].y > mobile[0].y && mobile[2].y > mobile[1].y);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('textbox', { name: 'Model', exact: true }).fill('vision-model-2');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '保存', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('input[aria-label="Model"]')?.value === 'vision-model-2');
    await page.getByRole('tab', { name: 'AI', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    check('三个设置Tab支持方向键循环', await page.getByRole('tab').first().getAttribute('aria-selected') === 'true');

    await page.goto(BASE);
    const aiButton = page.getByRole('button', { name: 'AI生成', exact: true });
    await aiButton.waitFor();
    const aiBox = await aiButton.boundingBox(), newBox = await page.getByRole('button', { name: '新建导图', exact: true }).first().boundingBox();
    check('AI生成位于新建导图左边', aiBox.x < newBox.x && Math.abs(aiBox.y - newBox.y) < 2);
    const open = async () => { await aiButton.click(); await page.getByRole('dialog').waitFor(); };
    const dialog = page.getByRole('dialog');
    const prompt = dialog.getByRole('textbox', { name: '生成要求', exact: true });
    const generate = dialog.getByRole('button', { name: '生成导图', exact: true });
    const form = dialog.locator('form');
    const transfer = async (files) => page.evaluateHandle((items) => {
      const data = new DataTransfer();
      for (const item of items) data.items.add(new File([Uint8Array.from(atob(item.base64), (char) => char.charCodeAt(0))], item.name, { type: item.mimeType, lastModified: 123 }));
      return data;
    }, files.map(({ buffer, ...file }) => ({ ...file, base64: buffer.toString('base64') })));
    const drop = async (data) => {
      await form.dispatchEvent('dragenter', { dataTransfer: data });
      await form.dispatchEvent('dragover', { dataTransfer: data });
      await form.dispatchEvent('drop', { dataTransfer: data });
    };
    await open();
    check('空输入禁用生成，上传包含已确认的格式', await generate.isDisabled() && (await dialog.locator('input[type=file]').getAttribute('accept')).includes('.docx,.xlsx,.pdf'));
    const dropped = await transfer(aiFixtures().slice(0, 2));
    await form.dispatchEvent('dragenter', { dataTransfer: dropped });
    check('文件拖入高亮并显示松开提示', await form.getAttribute('data-file-drop-state') === 'active' && await dialog.getByRole('button', { name: '松开添加文件', exact: true }).isVisible());
    await prompt.dispatchEvent('dragenter', { dataTransfer: dropped });
    await prompt.dispatchEvent('dragleave', { dataTransfer: dropped });
    check('在子元素间拖动不闪烁', await form.getAttribute('data-file-drop-state') === 'active');
    await form.dispatchEvent('dragleave', { dataTransfer: dropped });
    check('拖离恢复上传区域', await form.getAttribute('data-file-drop-state') === 'idle');
    const textDrag = await form.evaluate((node) => {
      const dataTransfer = new DataTransfer(); dataTransfer.setData('text/plain', '文字拖动');
      return node.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    });
    check('文字拖动保持原生行为', textDrag && await form.getAttribute('data-file-drop-state') === 'idle');
    await drop(dropped); await drop(dropped);
    check('多文件拖入按顺序添加、重复拖入去重且不打开背景导入', await dialog.getByRole('listitem').count() === 2 && (await dialog.getByRole('listitem').allTextContents())[0].includes('需求.docx') && await page.getByRole('dialog').count() === 1 && await form.getAttribute('data-file-drop-state') === 'idle');
    const invalidDrop = await transfer([{ name: '旧格式.doc', mimeType: 'application/msword', buffer: Buffer.from('old') }]);
    await drop(invalidDrop);
    check('拖入不支持格式时保留已有附件', await dialog.getByRole('alert').isVisible() && await dialog.getByRole('listitem').count() === 2);
    const tooManyDrop = await transfer(aiFixtures().map((file, index) => ({ ...file, name: `额外${index}.pdf` })));
    await drop(tooManyDrop);
    check('拖入超数量限制不丢已有附件', await dialog.getByRole('alert').isVisible() && await dialog.getByRole('listitem').count() === 2);
    const tooLargeDrop = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(20 * 1024 * 1024 + 1)], '过大.pdf', { type: 'application/pdf' }));
      return data;
    });
    await drop(tooLargeDrop);
    check('拖入超大小限制不丢已有附件', await dialog.getByRole('alert').isVisible() && await dialog.getByRole('listitem').count() === 2);
    await dialog.getByRole('button', { name: '移除 需求.docx', exact: true }).click();
    await dialog.getByRole('button', { name: '移除 预算.xlsx', exact: true }).click();
    const chooserPromise = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: '上传或拖拽文件', exact: true }).focus();
    await page.keyboard.press('Enter');
    const chooser = await chooserPromise;
    await chooser.setFiles([]);
    check('键盘仍可打开文件选择器', await dialog.locator('input[type=file]').getAttribute('multiple') !== null);
    await prompt.fill('综合所有附件整理一个项目计划。');
    await dialog.locator('input[type=file]').setInputFiles(aiFixtures());
    check('五个附件按选择顺序显示', await dialog.getByRole('listitem').count() === 5 && await dialog.getByText('需求.docx', { exact: true }).isVisible());
    await page.setViewportSize({ width: 375, height: 812 });
    const box = await dialog.boundingBox();
    check('手机弹窗与附件不横向溢出', box.x >= 0 && box.x + box.width <= 375 && await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth));
    await page.screenshot({ path: '/tmp/wmind-ai-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: '/tmp/wmind-ai-desktop.png' });
    failSave = true;
    await generate.click();
    await dialog.getByRole('button', { name: '重试保存', exact: true }).waitFor({ timeout: 30_000 });
    const material = generations[0]?.sources;
    check('Word与Excel提取文字，PDF提取文本，扫描PDF和图片送入视觉内容', material?.length === 5 && material[0].text.includes('Word 项目要求') && material[1].text.includes('C1: 1200') && material[2].text.includes('PDF project plan') && material[3].images[0]?.startsWith('data:image/jpeg') && material[4].images[0]?.startsWith('data:image/jpeg'));
    check('保存失败保留素材并给出重试保存入口', creations.length === 1 && await prompt.inputValue() === '综合所有附件整理一个项目计划。' && await dialog.getByRole('listitem').count() === 5);
    failSave = false;
    await dialog.getByRole('button', { name: '重试保存', exact: true }).click();
    await page.waitForURL('**/maps/ai-generated-fixture');
    await waitForCanvas(page);
    check('重试保存不再次调用AI，自动打开可编辑原生导图', generations.length === 1 && creations.length === 2 && created.document.sheets[0].rootTopic.children.attached[0].children.attached[0].title === '细节' && await page.locator('g.wmind-topic').filter({ hasText: '细节' }).count() === 1);

    await page.goto(BASE); await open();
    await dialog.locator('input[type=file]').setInputFiles({ name: '过多页.pdf', mimeType: 'application/pdf', buffer: makePDF({ pages: 21 }) });
    await generate.click();
    await dialog.getByRole('alert').waitFor();
    check('PDF页数超限不调用Provider，保留文件可移除', (await dialog.getByRole('alert').innerText()).includes('20 页') && generations.length === 1);
    await dialog.getByRole('button', { name: '移除 过多页.pdf', exact: true }).click();
    generateMode = 'failure'; await prompt.fill('失败后保留这段内容'); await generate.click();
    await dialog.getByRole('alert').waitFor();
    check('Provider失败保留输入并恢复可操作状态', await prompt.inputValue() === '失败后保留这段内容' && await generate.isEnabled() && (await dialog.getByRole('alert').innerText()).includes('AI 调用失败'));
    generateMode = 'invalid'; await generate.click();
    await dialog.getByText('AI 未返回有效的导图结构，请减少内容或重新生成。', { exact: true }).waitFor();
    check('错误树不会生成空导图', creations.length === 2);
    generateMode = 'deferred'; await generate.click();
    await dialog.getByRole('button', { name: '正在生成…', exact: true }).waitFor();
    check('生成中禁用重复操作', await prompt.isDisabled() && await dialog.getByRole('button', { name: '正在生成…', exact: true }).isDisabled());
    await drop(await transfer(aiFixtures().slice(0, 2)));
    check('生成中拖放被拦截且不接收文件', await form.getAttribute('data-file-drop-state') === 'disabled' && await dialog.getByRole('listitem').count() === 0 && await page.getByRole('dialog').count() === 1);
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await open(); releaseGenerate();
    check('取消后重开为空，旧请求不会创建文件', await prompt.inputValue() === '' && creations.length === 2);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('header').getByRole('combobox').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: 'Generate with AI', exact: true }).click();
    check('英文生成界面翻译完整', await dialog.getByRole('textbox', { name: 'Generation instructions', exact: true }).isVisible() && !(await dialog.innerText()).includes('ai.'));
    check('浏览器没有未捕获异常', errors.length === 0, errors.join('\n'));
    return summary();
  } finally { await browser.close(); }
});
