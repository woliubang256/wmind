import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { BASE, check, launchBrowser, newPage, run, summary, waitForCanvas } from './lib/harness.mjs';

// Optional private sample stays outside the repository. CI uses anonymous native XMind properties.
const properties = { 'line-width': '2pt', 'line-color': '#ADADAD', 'border-line-width': '0pt', 'border-line-pattern': 'none', 'line-class': 'org.xmind.branchConnection.curve' };
const sample = process.env.XMIND_IMPORT_SAMPLE ? readFileSync(process.env.XMIND_IMPORT_SAMPLE) : Buffer.from(zipSync({
  'content.json': strToU8(JSON.stringify([{
    rootTopic: { id: 'root', title: '原生样本', children: { attached: Array.from({ length: 94 }, (_, i) => ({ id: `a${i}`, title: `分支 ${i + 1}` })) } },
    theme: { mainTopic: { properties }, subTopic: { properties } },
  }])),
}));
const markdown = (name, title = name) => ({ name: `${name}.md`, mimeType: 'text/markdown', buffer: Buffer.from(`# ${title}\n## 子主题`) });

run(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser);
    const maps = new Map();
    const requests = [];
    const fail = new Set();
    let activeCreates = 0;
    let maxActiveCreates = 0;
    let saves = 0;
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
      const method = route.request().method();
      let data = [];
      if (path === '/auth/me') data = { uid: 'batch-user', username: 'batch', nickname: '批量测试', email: '', role: 'user', status: 'active' };
      if (path === '/auth/refresh') data = { accessToken: 'fixture-token' };
      if (path === '/site/config') data = { siteName: 'wmind', importEnabled: true, exportEnabled: true, shareEnabled: true };
      if (path === '/maps' && method === 'POST') {
        const input = route.request().postDataJSON();
        requests.push(input.title);
        activeCreates += 1;
        maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
        await new Promise((resolve) => setTimeout(resolve, 40));
        activeCreates -= 1;
        if (fail.has(input.title)) {
          await route.fulfill({ status: 503, json: { error: { code: 'INTERNAL_ERROR', message: 'fixture failure' } } });
          return;
        }
        const uid = `batch-${requests.length}`;
        data = { ...input, uid, version: 1, nodeCount: 95, sizeBytes: 1024, deleted: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), thumbnailUrl: '' };
        maps.set(uid, data);
      }
      if (/^\/maps\/batch-\d+$/.test(path)) {
        const uid = path.slice('/maps/'.length);
        data = maps.get(uid);
        if (method === 'PUT') {
          data = { ...data, ...route.request().postDataJSON(), version: data.version + 1 };
          maps.set(uid, data);
          saves += 1;
        }
      }
      await route.fulfill({ json: { data, pagination: { page: 1, pageSize: 24, total: 0, totalPages: 1 } } });
    });
    const dialog = page.getByRole('dialog');
    const open = async () => {
      await page.goto(BASE);
      await page.getByRole('button', { name: '导入导图', exact: true }).click();
      await dialog.waitFor();
    };
    const ready = () => dialog.getByRole('heading', { name: '导入完成', exact: true }).waitFor();
    const confirm = async () => {
      await dialog.getByRole('button', { name: /创建导图/ }).click();
      await page.waitForURL('**/maps/batch-*');
      await waitForCanvas(page);
    };
    const visibleEdges = () => page.locator('g[data-edge-id] path').evaluateAll((nodes) => nodes.filter((node) => Number.parseFloat(getComputedStyle(node).strokeWidth) > 0 && getComputedStyle(node).stroke !== 'none' && node.getAttribute('d')).length);
    await open();
    assert.equal(await dialog.locator('input[type=file]').getAttribute('multiple'), '');
    check('文件选择器支持多选', true);
    await dialog.locator('input[type=file]').setInputFiles([
      markdown('第一份'), { name: 'native.xmind', mimeType: 'application/zip', buffer: sample },
      { name: 'bad.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid') },
    ]);
    await ready();
    assert.match(await dialog.innerText(), /2 \/ 3/);
    assert.deepEqual(await dialog.locator('details summary').evaluateAll((nodes) => nodes.map((node) => node.firstChild.textContent)), ['第一份.md', 'native.xmind']);
    assert.match(await dialog.getByRole('alert').innerText(), /bad.bin/);
    check('多个文件按选择顺序展示独立摘要，坏文件单独报错', true);
    await dialog.locator('details').nth(1).locator('summary').click();
    assert.ok((await dialog.locator('details').nth(1).innerText()).includes('需要注意'));
    check('批次内仍可展开查看各文件的导入警告', true);
    await dialog.getByRole('button', { name: /创建导图/ }).evaluate((button) => { button.click(); button.click(); });
    await page.waitForURL('**/maps/batch-2');
    await waitForCanvas(page);
    assert.deepEqual(requests, ['第一份', 'native']);
    assert.equal(maxActiveCreates, 1);
    check('双击确认不会重复创建，创建串行并自动打开最后成功项', true);
    assert.equal(await visibleEdges(), 94);
    check('95 主题 XMind 首次打开即显示全部 94 条连线', true);
    const rootId = maps.get('batch-2').document.sheets[0].rootTopic.id;
    const rootTitle = maps.get('batch-2').document.sheets[0].rootTopic.title;
    const saved = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/v1/maps/batch-2');
    await page.locator(`g.wmind-topic[data-topic-id="${rootId}"]`).dblclick();
    await page.locator('textarea').fill(`${rootTitle}（验收）`);
    await page.keyboard.press('Enter');
    await saved;
    await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('已保存'), undefined, { timeout: 20000 });
    assert.ok(saves > 0);
    await page.reload();
    await waitForCanvas(page);
    assert.equal(await visibleEdges(), 94);
    assert.ok(maps.get('batch-2').document.sheets[0].rootTopic.title.endsWith('（验收）'));
    check('编辑保存并刷新后全部连线仍然显示，无需切换主题', true);

    await open();
    const beforeFailure = requests.length;
    fail.add('中间失败'); fail.add('最后失败');
    await dialog.locator('input[type=file]').setInputFiles(['成功一', '中间失败', '成功二', '最后失败'].map((title) => markdown(title)));
    await ready();
    await confirm();
    assert.deepEqual(requests.slice(beforeFailure), ['成功一', '中间失败', '成功二', '最后失败']);
    assert.ok(page.url().endsWith(`/maps/batch-${beforeFailure + 3}`));
    assert.ok((await page.locator('[data-sonner-toaster]').innerText()).includes('最后失败.md'));
    check('创建失败不阻断后续，末项失败时打开前一个成功项并提示失败文件', true);

    await open();
    fail.add('全失败一'); fail.add('全失败二');
    await dialog.locator('input[type=file]').setInputFiles([markdown('全失败一'), markdown('全失败二')]);
    await ready();
    await dialog.getByRole('button', { name: /创建导图/ }).click();
    await dialog.getByRole('alert').filter({ hasText: '全失败二.md' }).waitFor();
    assert.equal(await dialog.getByRole('alert').count(), 2);
    assert.ok(!new URL(page.url()).pathname.startsWith('/maps/batch-'));
    check('全部创建失败时保留逐项错误并允许重试', true);
    fail.clear();
    await confirm();
    check('显式重试失败项后打开最后成功创建的导图', true);

    const drop = async (inside, names) => {
      await page.locator(inside ? 'dialog[open] input[type=file]' : 'main > div.relative').waitFor({ state: 'attached' });
      await page.evaluate(({ inside, names }) => {
        const dataTransfer = new DataTransfer();
        for (const name of names) dataTransfer.items.add(new File([`# ${name}\n## 子项`], `${name}.md`, { type: 'text/markdown' }));
        const zone = inside ? document.querySelector('dialog[open] input[type=file]').parentElement : document.querySelector('main > div.relative');
        zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      }, { inside, names });
    };
    await open();
    await drop(true, ['弹窗一', '弹窗二']);
    await ready();
    assert.equal(await dialog.locator('details').count(), 2);
    const beforeDialog = requests.length;
    await confirm();
    assert.deepEqual(requests.slice(beforeDialog), ['弹窗一', '弹窗二']);
    check('弹窗拖放保留全部文件，冒泡不会重复处理', true);
    await page.goto(BASE);
    await drop(false, ['页面一', '页面二']);
    await ready();
    const beforePage = requests.length;
    await confirm();
    assert.deepEqual(requests.slice(beforePage), ['页面一', '页面二']);
    assert.ok(page.url().endsWith(`/maps/batch-${requests.length}`));
    check('页面拖放支持多文件并打开最后一个', true);

    await open();
    await page.evaluate(() => {
      window.batchReads = [];
      const read = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function () {
        window.batchReads.push(this.name);
        if (this.name === 'slow.md') await new Promise((resolve) => setTimeout(resolve, 500));
        return read.call(this);
      };
    });
    await dialog.locator('input[type=file]').setInputFiles([markdown('slow'), markdown('never-read')]);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '导入导图', exact: true }).click();
    await page.waitForTimeout(650);
    assert.equal(await page.evaluate(() => window.batchReads.includes('never-read.md')), false);
    assert.equal(await dialog.locator('input[type=file]').count(), 1);
    check('取消批次后不读取下一个文件，旧结果不会污染重开的窗口', true);
    await dialog.locator('input[type=file]').setInputFiles(['one.bin', 'two.bin'].map((name) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('invalid') })));
    await ready();
    assert.equal(await dialog.getByRole('alert').count(), 2);
    assert.equal(await dialog.getByRole('button', { name: /创建导图/ }).count(), 0);
    await dialog.getByRole('button', { name: '换一个文件', exact: true }).click();
    check('所有文件解析失败时显示每项错误并可重新选择', true);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('header').getByRole('combobox').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: 'Import a mind map', exact: true }).click();
    await dialog.locator('input[type=file]').setInputFiles([markdown('long-filename-'.repeat(8)), markdown('English')]);
    await dialog.getByRole('button', { name: 'Create maps (2)', exact: true }).waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    assert.ok(!(await dialog.innerText()).includes('import.dialog.'));
    assert.equal(await dialog.evaluate((node) => node.scrollWidth > node.clientWidth), false);
    check('英文和窄屏批量摘要翻译完整且无横向溢出', true);
    check('页面没有未捕获异常', errors.length === 0, errors.join('\n'));
    return summary();
  } finally { await browser.close(); }
});
