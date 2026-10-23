import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import assert from 'node:assert/strict';
import { BASE, api, check, ensureUser, launchBrowser, makeUser, newPage, run, summary, uiLogin, waitForCanvas } from './lib/harness.mjs';

run(async () => {
  const user = makeUser('insert'); const token = await ensureUser(user);
  const title = '插入内容验收';
  const created = await api('/maps', { method: 'POST', token, body: { title, document: { format: 'wmind', formatVersion: '1.0', title,
    sheets: [{ id: 'sh', title: '画布', structure: 'mindmap', rootTopic: { id: 'root', title, children: { attached: [{ id: 'a', title: '主题甲' }, { id: 'b', title: '主题乙' }] } } }] } } });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmind-insert-'));
  await mkdir(path.join(directory, '子目录')); await writeFile(path.join(directory, '子目录', '说明.txt'), '目录中的内容');
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser); await uiLogin(page, user); await page.goto(`${BASE}/maps/${created.data.uid}`); await waitForCanvas(page);
    const topic = (id) => page.locator(`g.wmind-topic[data-topic-id="${id}"]`);
    const canvas = page.locator('svg[data-read-only="false"]');
    const select = async (id) => { await canvas.click({ position: { x: 8, y: 8 } }); await topic(id).locator('text[aria-hidden="true"]').first().click({ force: true }); };
    const insert = async (name, link = false) => { await page.getByRole('button', { name: '插入', exact: true }).click(); if (link) await page.getByRole('menuitem', { name: '链接', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click(); await page.locator('dialog[open]').waitFor(); };
    const save = async () => { await page.locator('dialog[open]').getByRole('button', { name: '保存', exact: true }).click(); await page.locator('dialog[open]').waitFor({ state: 'hidden' }); };
    await canvas.click({ position: { x: 8, y: 8 } }); await page.getByRole('button', { name: '插入', exact: true }).click();
    assert.equal(await page.getByRole('menuitem', { name: '备注', exact: true }).getAttribute('aria-disabled'), 'true');
    assert.equal(await page.getByRole('menuitem', { name: /Zone|录音/ }).count(), 0); await page.keyboard.press('Escape'); check('无选区禁用主题内容，菜单排除 Zone 和录音', true);
    await select('a'); await insert('备注'); await page.locator('dialog[open] textarea').fill('应保留的备注内容'); await save();
    assert.match(await topic('a').locator('[data-topic-content-kind="note"] title').textContent(), /应保留/); check('备注保存并在主题显示入口', true);
    await topic('a').locator('[data-topic-content-kind="note"]').click(); assert.equal(await page.locator('dialog[open] textarea').inputValue(), '应保留的备注内容'); await page.keyboard.press('Escape');
    await select('a'); await insert('标签'); await page.locator('dialog[open] textarea').fill('重点\n复查'); await save(); assert.match(await topic('a').textContent(), /# 重点/); check('标签参与节点渲染', true);
    await select('a'); await insert('待办事项'); await save(); await topic('a').locator('[data-topic-content-kind="todo"]').click(); assert.match(await topic('a').textContent(), /☑/); check('待办可直接在画布勾选', true);
    await select('a'); await insert('任务'); await page.getByRole('textbox', { name: '负责人', exact: true }).fill('小明'); await page.getByRole('spinbutton', { name: '进度（%）', exact: true }).fill('50'); await save(); assert.match(await topic('a').textContent(), /50%.*小明/); check('任务进度和负责人保存并显示', true);
    await select('a'); await insert('网页', true); await page.getByRole('textbox', { name: '链接地址', exact: true }).fill('javascript:alert(1)'); await page.locator('dialog[open]').getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('alert').waitFor();
    await page.getByRole('textbox', { name: '链接地址', exact: true }).fill('https://example.com'); await save(); assert.match(await topic('a').textContent(), /example.com/); check('网页链接校验并持久化显示', true);
    await select('a'); await insert('主题', true); await page.getByRole('combobox', { name: '目标主题', exact: true }).click(); await page.getByRole('option', { name: /主题乙/ }).click(); await save(); await topic('a').locator('[data-topic-content-kind="link"]').click(); assert.equal(await topic('b').getAttribute('aria-selected'), 'true'); check('主题链接能导航到目标主题', true);
    await select('b'); await insert('附件'); await page.locator('dialog[open] input[type=file]').setInputFiles({ name: '测试.txt', mimeType: 'text/plain', buffer: Buffer.from('附件原始内容') }); await save();
    const downloadWait = page.waitForEvent('download'); await topic('b').locator('[data-topic-content-kind="attachment"]').click(); const download = await downloadWait; assert.equal(download.suggestedFilename(), '测试.txt'); assert.equal(await readFile(await download.path(), 'utf8'), '附件原始内容'); check('附件可随图保存并下载', true);
    await select('b'); await insert('本地文件', true); await page.locator('dialog[open] input[type=file]').setInputFiles({ name: '链接.txt', mimeType: 'text/plain', buffer: Buffer.from('链接文件') }); await save(); assert.match(await topic('b').textContent(), /链接.txt/); check('本地文件链接插入成功', true);
    await select('b'); await insert('本地文件夹', true); await page.locator('dialog[open] input[type=file]').setInputFiles(directory); await save();
    const folderWait = page.waitForEvent('download'); await topic('b').locator('[data-topic-content-kind="link"]').click(); const folderDownload = await folderWait;
    const archive = unzipSync(new Uint8Array(await readFile(await folderDownload.path()))); assert.ok(Object.keys(archive).some((name) => name.endsWith('子目录/说明.txt'))); check('本地文件夹可下载含原目录层次的 ZIP', true);
    await select('b'); await insert('本地图片'); await page.locator('dialog[open] input[type=file]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64') }); await save(); assert.equal(await topic('b').locator('image:not([data-topic-content-kind])').count(), 1); check('本地图片实际上传并显示', true);
    await select('a'); await insert('贴纸'); await page.locator('dialog[open]').getByRole('button', { name: '星星', exact: true }).click(); await save(); assert.equal(await topic('a').locator('image[data-topic-content-kind="sticker"]').count(), 1); check('贴纸选择后进入主题', true);
    await topic('a').locator('image[data-topic-content-kind="sticker"]').click(); await page.locator('dialog[open]').getByRole('button', { name: '移除', exact: true }).click(); assert.equal(await topic('a').locator('image[data-topic-content-kind="sticker"]').count(), 0);
    await page.getByRole('button', { name: '撤销', exact: true }).click(); assert.equal(await topic('a').locator('image[data-topic-content-kind="sticker"]').count(), 1); check('内容移除支持一次撤销恢复', true);
    await select('a'); await insert('插画'); await page.locator('dialog[open]').getByRole('button', { name: '成长', exact: true }).click(); await save(); assert.equal(await topic('a').locator('image[data-topic-content-kind="illustration"]').count(), 1); check('插画选择后进入主题', true);
    await select('b'); await insert('公式'); await page.getByRole('textbox', { name: 'LaTeX', exact: true }).fill('x=\\frac{1}{2}'); await page.locator('dialog[open] img').waitFor({ timeout: 15000 }); await save(); assert.equal(await topic('b').locator('image[data-topic-content-kind="equation"]').count(), 1); check('公式生成真实矢量图', true);
    await select('a'); await topic('b').locator('text[aria-hidden="true"]').first().click({ modifiers: ['Shift'], force: true }); await page.getByRole('button', { name: '插入', exact: true }).click(); assert.equal(await page.getByRole('menuitem', { name: '备注', exact: true }).getAttribute('aria-disabled'), 'true'); assert.equal(await page.getByRole('menuitem', { name: '标签', exact: true }).getAttribute('aria-disabled'), null); await page.keyboard.press('Escape'); check('多选区分单值操作与批量操作', true);
    // 概要自身进入同一个选区，能与主题建立联系。
    await select('a'); await page.getByRole('button', { name: '概要', exact: true }).click(); const sum = page.locator('[data-summary-id]').first(); await sum.locator('text').first().click(); assert.equal(await sum.getAttribute('aria-selected'), 'true');
    await topic('b').locator('text[aria-hidden="true"]').first().click({ modifiers: ['Shift'], force: true }); await page.getByRole('button', { name: '联系', exact: true }).click(); assert.equal(await page.locator('[data-relationship-id]').count(), 1); check('概要与主题混合选择后可建立联系', true);
    await page.keyboard.press('ControlOrMeta+s');
    await page.waitForFunction(() => document.body.innerText.includes('已保存'), { timeout: 15000 }); await page.reload(); await waitForCanvas(page);
    assert.match(await topic('a').textContent(), /重点/); assert.equal(await topic('b').locator('image[data-topic-content-kind="equation"]').count(), 1); assert.equal(await page.locator('[data-relationship-id]').count(), 1); check('刷新保留插入内容与概要联系', true);
    await page.getByRole('button', { name: '导出', exact: true }).click(); await page.locator('dialog[open]').waitFor();
    await page.locator('dialog[open]').getByRole('radio', { name: /^SVG/ }).click();
    const svgWait = page.waitForEvent('download'); await page.locator('dialog[open]').getByRole('button', { name: /下载 SVG/ }).click(); const svgDownload = await svgWait;
    const svgText = await readFile(await svgDownload.path(), 'utf8'); assert.ok(svgText.includes('data-topic-content-kind="equation"')); assert.ok(svgText.includes('data-topic-content-kind="illustration"')); assert.ok(svgText.includes('data:image/svg+xml;base64,')); check('SVG 导出保留内容与自包含公式素材', true);
    await page.locator('dialog[open]').waitFor({ state: 'hidden' }); await page.getByRole('button', { name: '导出', exact: true }).click(); await page.locator('dialog[open]').getByRole('radio', { name: /^PNG/ }).click();
    const pngWait = page.waitForEvent('download'); await page.locator('dialog[open]').getByRole('button', { name: /下载 PNG/ }).click(); const pngDownload = await pngWait; const png = await readFile(await pngDownload.path());
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); await writeFile('/tmp/wmind-insert-export.png', png); check('PNG 导出成功且文件可解码', true);
    await page.locator('dialog[open]').waitFor({ state: 'hidden' });
    if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    check('没有浏览器异常', errors.length === 0, errors.join('\n')); return summary();
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
