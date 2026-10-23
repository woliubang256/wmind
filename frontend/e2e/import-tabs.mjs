import { strToU8, zipSync } from 'fflate';
import { BASE, check, launchBrowser, newPage, run, summary, waitForCanvas } from './lib/harness.mjs';

// 接口全部由浏览器夹具接管，不创建账号或写入开发数据库。
run(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser);
    const user = { uid: 'import-user', username: 'import_test', nickname: '导入测试', email: '', role: 'user', status: 'active' };
    let created;
    let createCount = 0;
    let uploadCount = 0;
    let releaseUpload;
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
      const method = route.request().method();
      let data = [];
      if (path === '/auth/me') data = user;
      if (path === '/auth/refresh') data = { accessToken: 'fixture-token' };
      if (path === '/site/config') data = { siteName: 'wmind', passwordMinLength: 8, importEnabled: true, exportEnabled: true, shareEnabled: true };
      if (path === '/maps' && method === 'POST') {
        const input = route.request().postDataJSON();
        createCount += 1;
        created = { ...input, uid: 'import-fixture-map', version: 1, nodeCount: 4, sizeBytes: 1024, deleted: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), thumbnailUrl: '' };
        data = created;
      }
      if (path === '/maps/import-fixture-map') data = created;
      if (path === '/files') {
        uploadCount += 1;
        await new Promise((resolve) => { releaseUpload = resolve; });
        data = { url: '/uploads/fixture.png', uid: 'fixture-image', width: 1, height: 1, format: 'png', bytes: 1 };
      }
      await route.fulfill({ json: { data, pagination: { page: 1, pageSize: 24, total: 0, totalPages: 1 } } });
    });
    const openImport = async () => {
      await page.getByRole('button', { name: '导入导图', exact: true }).click();
      await page.getByRole('dialog').waitFor();
    };
    const dialog = page.getByRole('dialog');
    const fileTab = dialog.getByRole('tab', { name: '文件导入', exact: true });
    const textTab = dialog.getByRole('tab', { name: '文本导入', exact: true });
    const text = dialog.getByRole('textbox', { name: 'Markdown 文本', exact: true });
    const parse = dialog.getByRole('button', { name: '解析', exact: true });
    await page.goto(BASE);
    await openImport();
    check('默认进入文件导入并保留文件格式', await fileTab.getAttribute('aria-selected') === 'true' && (await dialog.locator('input[type=file]').getAttribute('accept')).split(',').sort().join(',') === '.markdown,.md,.opml,.xmind,.xml');
    await fileTab.focus();
    await page.keyboard.press('ArrowRight');
    check('方向键切换Tab并移动焦点', await textTab.getAttribute('aria-selected') === 'true' && await textTab.evaluate((node) => node === document.activeElement));
    check('Tab关联面板且只有当前Tab参与键盘顺序', await textTab.getAttribute('aria-controls') === await dialog.getByRole('tabpanel').getAttribute('id') && await fileTab.getAttribute('tabindex') === '-1');
    check('空文本禁用解析', await parse.isDisabled());
    await text.fill(' \n\t ');
    check('纯空白文本禁用解析', await parse.isDisabled());
    const markdown = '# 项目计划\n## 需求\n- 中文要点\n## 发布';
    await text.fill(markdown);
    await fileTab.click();
    await textTab.click();
    check('切换Tab保留已输入Markdown', await text.inputValue() === markdown);
    await parse.click();
    await dialog.getByRole('heading', { name: '导入完成', exact: true }).waitFor();
    check('文本解析进入现有摘要而不直接创建', createCount === 0 && await dialog.getByText('项目计划', { exact: true }).count() === 1 && (await dialog.innerText()).includes('Markdown 文件'));
    await fileTab.click();
    await dialog.locator('input[type=file]').setInputFiles({ name: '文件计划.md', mimeType: 'text/markdown', buffer: Buffer.from('# 文件计划\n## 子项') });
    await dialog.getByRole('heading', { name: '导入完成', exact: true }).waitFor();
    check('文件导入仍解析并显示文件摘要', await dialog.getByText('文件计划', { exact: true }).count() === 1 && await fileTab.getAttribute('aria-selected') === 'true');
    await textTab.click();
    check('文件摘要切回文本仍保留输入', await text.inputValue() === markdown);
    await text.fill('<html>unsupported</html>');
    await parse.click();
    await dialog.getByText('导入失败', { exact: true }).waitFor();
    check('文本导入错误走原有错误提示', await dialog.getByRole('button', { name: '修改文本', exact: true }).count() === 1 && createCount === 0);
    await dialog.getByRole('button', { name: '修改文本', exact: true }).click();
    check('解析失败后返回原文本', await text.inputValue() === '<html>unsupported</html>');
    await text.fill(markdown);
    await page.setViewportSize({ width: 375, height: 812 });
    const box = await dialog.boundingBox();
    check('移动端Tab和文本框不横向溢出', box.x >= 0 && box.x + box.width <= 375 && await text.evaluate((node) => node.getBoundingClientRect().right <= innerWidth));
    await page.setViewportSize({ width: 1440, height: 900 });
    await parse.click();
    await dialog.getByRole('heading', { name: '导入完成', exact: true }).waitFor();
    await dialog.getByRole('button', { name: '创建导图', exact: true }).click();
    await page.waitForURL('**/maps/import-fixture-map');
    await waitForCanvas(page);
    check('确认后只创建一次且中文层级正确', createCount === 1 && created.document.sheets[0].rootTopic.title === '项目计划' && created.document.sheets[0].rootTopic.children.attached[0].title === '需求' && created.document.sheets[0].rootTopic.children.attached[0].children.attached[0].title === '中文要点');
    check('创建后编辑器显示导入内容', await page.locator('g.wmind-topic').filter({ hasText: '中文要点' }).count() === 1);

    await page.goto(BASE);
    await openImport();
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function () {
        if (this.name === 'slow.md') await new Promise((resolve) => setTimeout(resolve, 600));
        return original.call(this);
      };
    });
    await dialog.locator('input[type=file]').setInputFiles({ name: 'slow.md', mimeType: 'text/markdown', buffer: Buffer.from('# 不该回写\n## 旧结果') });
    check('读取解析期间禁用来源Tab', await fileTab.isDisabled() && await textTab.isDisabled());
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await openImport();
    await page.waitForTimeout(800);
    check('关闭后旧异步结果不污染重开的对话框', await dialog.getByRole('heading', { name: '导入导图', exact: true }).count() === 1 && await dialog.getByText('把文件拖到这里', { exact: true }).count() === 1);
    await textTab.click();
    check('重新打开从空文本开始', await text.inputValue() === '');
    await fileTab.click();
    const content = [{ id: 's1', rootTopic: { id: 'r', title: '上传中的旧导图', image: { src: 'xap:resources/a.png' }, children: { attached: [{ id: 'a', title: '第二张', image: { src: 'xap:resources/b.png' } }] } } }];
    const archive = zipSync({ 'content.json': strToU8(JSON.stringify(content)), 'resources/a.png': new Uint8Array([1]), 'resources/b.png': new Uint8Array([2]) });
    await dialog.locator('input[type=file]').setInputFiles({ name: 'images.xmind', mimeType: 'application/zip', buffer: Buffer.from(archive) });
    await dialog.getByText('正在上传图片 0/2…', { exact: true }).waitFor();
    check('图片上传期间禁用来源Tab', await fileTab.isDisabled() && await textTab.isDisabled());
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await openImport();
    releaseUpload();
    await page.waitForTimeout(250);
    check('关闭上传后不再发下一张且不回写旧结果', uploadCount === 1 && await dialog.getByText('把文件拖到这里', { exact: true }).count() === 1 && createCount === 1);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('main > div.relative').evaluate((node) => {
      const files = new DataTransfer();
      files.items.add(new File(['# 页面拖入\n## 子项'], 'drop.md', { type: 'text/markdown' }));
      node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: files }));
    });
    await dialog.getByRole('heading', { name: '导入完成', exact: true }).waitFor();
    check('页面拖入文件打开文件Tab并解析', await fileTab.getAttribute('aria-selected') === 'true' && await dialog.getByText('页面拖入', { exact: true }).count() === 1);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    const locale = page.locator('header').getByRole('combobox');
    await locale.click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: 'Import a mind map', exact: true }).click();
    await dialog.getByRole('tab', { name: 'Text import', exact: true }).click();
    check('英文文本入口翻译完整', await dialog.getByRole('textbox', { name: 'Markdown text', exact: true }).count() === 1 && await dialog.getByRole('button', { name: 'Parse', exact: true }).isDisabled() && !(await dialog.innerText()).includes('import.dialog.'));
    check('页面没有未捕获异常', errors.length === 0, errors.join('\n'));
    return summary();
  } finally {
    await browser.close();
  }
});
