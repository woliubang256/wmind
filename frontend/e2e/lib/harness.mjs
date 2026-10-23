/**
 * 界面验收脚本的公共骨架。
 *
 * 六个脚本原先各自抄了一份「地址 + 计数 + REST + 建号 + 登录 + 等画布」，
 * 抄到第六份时已经出现三种 `check` 签名和两种 `waitForCanvas` 判据了。
 * 这里收成一份，脚本只留自己的断言。
 *
 * 两条约定：
 *
 * 1. **一个脚本一个进程**。下面的 `results` / `check` / `summary` 是模块级
 *    单例，进程内共享。`run-all.mjs` 用子进程逐个跑，不要改成同进程 import，
 *    否则计数会串在一起。
 * 2. **断言只读 DOM，数据准备走 REST**。界面验收的价值在于「浏览器到底接受
 *    了什么」，凡是能用接口造的数据就不要点着界面造——那样一崩就是十几个
 *    断言连坐，还看不出是产品坏了还是脚本点歪了。
 */

import { chromium } from 'playwright-core';
import { constants, createPublicKey, publicEncrypt } from 'node:crypto';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BASE = process.env.BASE ?? 'http://127.0.0.1:5199';
export const API = process.env.API ?? 'http://127.0.0.1:8080';

/**
 * 用哪个 Chromium。
 *
 * 默认指向 Playwright 的缓存目录——本机 `playwright-core` 是全局装的，没有
 * 走过 `playwright install`，所以不能靠它自己找。换机器时设
 * `PLAYWRIGHT_CHROMIUM` 指到自己的可执行文件即可。
 */
export const CHROME =
  process.env.PLAYWRIGHT_CHROMIUM ??
  `${os.homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

/**
 * 开发用的管理员账号；注册被限流时靠它建号。
 *
 * 注册接口是 **3 次/小时/IP**，而 `run-all.mjs` 有十套脚本、每套一个独立
 * 账号——第四套开始必然走这条路。所以它不是「偶尔用一下的兜底」，是整轮
 * 验收的必经之路，凭据错了后面全红。
 *
 * 凭据优先从 `backend/.env` 读（后端用它种管理员），因为写死的那份迟早和
 * 本机 `.env` 对不上——对不上时的表现是 401，而 401 从 `ensureUser` 里抛出来
 * 长得像「账号密码错了」，完全看不出其实是管理员种子换过了。
 */
function readBackendAdmin() {
  const file = fileURLToPath(new URL('../../../backend/.env', import.meta.url));
  if (!existsSync(file)) return {};
  const found = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(WMIND_ADMIN_EMAIL|WMIND_ADMIN_PASSWORD)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    found[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return found;
}

const backendEnv = readBackendAdmin();

export const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? backendEnv.WMIND_ADMIN_EMAIL ?? 'admin@example.test',
  password: process.env.ADMIN_PASSWORD ?? backendEnv.WMIND_ADMIN_PASSWORD ?? 'share-admin-password',
};

export const stamp = Date.now();

/** 每轮一个独立账号，避免上一轮的数据干扰断言。 */
export function makeUser(prefix, password = `${prefix}-test-password`) {
  return { email: `${prefix}-${stamp}@example.test`, password, username: `${prefix}_${stamp}` };
}

// ---------------------------------------------------------------- 断言计数

const results = [];

export function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  return pass;
}

export function summary() {
  const passed = results.filter((item) => item.pass).length;
  console.log(`\n合计 ${passed}/${results.length} 通过`);
  for (const item of results.filter((entry) => !entry.pass)) console.log(`  失败：${item.name}`);
  return passed === results.length;
}

// ------------------------------------------------------------------- REST

/**
 * 调 `/api/v1` 下的接口。
 *
 * `raw: true` 时不抛错，返回 `{ status, text, payload }`——「这个请求应该被
 * 拒」的断言必须看状态码，让它抛异常就没法断言了。
 */
export async function api(path, { method = 'GET', token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const payload = text === '' ? null : JSON.parse(text);
  if (raw) return { status: res.status, text, payload };
  if (!res.ok) throw new Error(`${method} ${path} = ${res.status}: ${text}`);
  return payload;
}

/**
 * 登录。
 *
 * 登录接口是 5 次/分钟/IP 限流，而九套脚本一轮下来要登录十几次——**限流不是
 * 被测对象**，撞上了就按服务端给的 `retryAfter` 等一等再试。不等的话，
 * `npm run e2e` 连跑两轮必然有一套挂在 429 上，报错还长得像「登录接口坏了」，
 * 排查时容易一路查到鉴权代码里去。
 *
 * 最多重试两次（单次等待上限 30s）：真被限死了应该报错，不该无限等下去。
 */
export async function login(identifier, password, attempt = 0) {
  try {
    const { data: challenge } = await api('/auth/login/challenge', { method: 'POST', body: { identifier } });
    const encryptedPassword = publicEncrypt({
      key: createPublicKey({ key: challenge.publicKey, format: 'jwk' }),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
      oaepLabel: Buffer.from(`wmind/login/v1:${challenge.challengeId}`),
    }, Buffer.from(password)).toString('base64');
    const res = await api('/auth/login', { method: 'POST', body: { identifier, challengeId: challenge.challengeId, encryptedPassword } });
    return res.data.accessToken;
  } catch (error) {
    const retryAfter = /"retryAfter":(\d+)/.exec(String(error))?.[1];
    if (retryAfter === undefined || attempt >= 2) throw error;
    const waitMs = Math.min(Number(retryAfter) * 1000 + 500, 30_000);
    console.log(`  （登录被限流，等 ${Math.round(waitMs / 1000)}s 后重试）`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return login(identifier, password, attempt + 1);
  }
}

/**
 * 建号，返回 token。
 *
 * 注册接口是 3 次/小时/IP 限流。连着跑几轮验收必然撞上 429，撞上就改走
 * 管理员建号——**限流不是被测对象**，不该让脚本因为跑得勤而红。
 */
export async function ensureUser(user) {
  try {
    await api('/auth/register', {
      method: 'POST',
      body: { username: user.username, email: user.email, password: user.password },
    });
  } catch (error) {
    // 三种「注册这条路走不通」都改走管理员建号：
    // 429 是限流（跑得勤），403 REGISTRATION_CLOSED 是站点关着注册——
    // 后者通常意味着上一轮 `register.mjs` / `locale.mjs` 被中途打断，
    // 站点停在「已关站」。409 是这个账号上一轮已经建过（同一个 stamp 重跑）。
    // 这三种都不是被测对象，不该让后面的套件全红。
    const text = String(error);
    if (!text.includes('429') && !text.includes('REGISTRATION_CLOSED') && !text.includes('409')) {
      throw error;
    }
    let token;
    try {
      token = await login(ADMIN.email, ADMIN.password);
    } catch (loginError) {
      throw new Error(
        `注册被限流/关闭后要改走管理员建号，但管理员登录失败（${ADMIN.email}）。` +
          `检查 backend/.env 里的 WMIND_ADMIN_EMAIL / WMIND_ADMIN_PASSWORD，` +
          `或用 ADMIN_EMAIL / ADMIN_PASSWORD 环境变量覆盖。原始错误：${loginError.message}`,
      );
    }
    try {
      await api('/admin/users', {
        method: 'POST',
        token,
        body: { username: user.username, email: user.email, password: user.password, role: 'user' },
      });
    } catch (createError) {
      // 已经存在就直接登录，别再抛——重跑同一套脚本时会走到这里。
      if (!String(createError).includes('409')) throw createError;
    }
  }
  return login(user.email, user.password);
}

// ---------------------------------------------------------------- 浏览器

/**
 * 再开一个独立上下文（分享页要匿名、断网提示要干净存储）。
 *
 * 这里同样必须钉 `locale`：语言偏好的 `system` 那一档读的是
 * `navigator.languages`，而 Playwright 新建上下文的默认语言是 `en-US`。
 * 不钉的话，匿名上下文里的分享页会整页英文——断言中文文案的用例只能超时，
 * 而且报错只说「等不到某个标题」，看不出是语言问题。
 */
export async function newContext(browser, { width = 1440, height = 900, locale = 'zh-CN' } = {}) {
  return browser.newContext({ viewport: { width, height }, locale });
}

/**
 * 起浏览器。
 *
 * `locale` 显式钉成中文：应用现在有语言切换器，而 `system` 那一档读的是
 * `navigator.languages`——不钉的话，同一份脚本在英文系统的机器上会先渲染出
 * 英文界面，所有 `getByLabel('用户名或邮箱')` 立刻超时。断言写的是中文文案，
 * 环境就该是中文，不能靠跑脚本的机器碰巧是中文系统。
 */
export async function launchBrowser({ width = 1440, height = 900, locale = 'zh-CN' } = {}) {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--font-render-hinting=none'],
  });
  // 显式建默认上下文，`contexts()[0]` 才稳定存在——`newPage` 靠它。
  await newContext(browser, { width, height, locale });
  return browser;
}

/**
 * 开一页，顺手把未捕获异常收集到 `errors`。
 *
 * - 传 `context` 就在那个上下文里开（分享页要匿名上下文，不能带上登录态）；
 * - 传 `errors` 就复用同一个收集数组（同一轮里的几个页面要一起判）。
 *
 * 注意 `pageerror` **不会**为被错误边界接住的异常触发——崩溃兜底页那一条
 * 只能断言页面内容，不能指望这里冒出来。
 */
export async function newPage(browser, { context, errors } = {}) {
  const ctx = context ?? browser.contexts()[0];
  if (ctx === undefined) throw new Error('newPage 之前要先 launchBrowser');
  const page = await ctx.newPage();
  const sink = errors ?? [];
  page.on('pageerror', (error) => sink.push(String(error)));
  return { page, errors: sink, context: ctx };
}

export async function uiLogin(page, user) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('用户名或邮箱').fill(user.email);
  await page.getByLabel('密码').fill(user.password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
}

/**
 * 等画布画出来。
 *
 * 两种判据都要认：编辑器渲染的是 `g.wmind-topic`（带无障碍语义的那层），
 * 只读查看器（分享页、模板预览）不一定有，但一定有 `svg text`。原先两份脚本
 * 各押一种，换个页面就超时。
 */
export async function waitForCanvas(page) {
  await page.waitForFunction(
    () => document.querySelector('g.wmind-topic') !== null || document.querySelector('svg text') !== null,
    undefined,
    { timeout: 30000 },
  );
}

/** 点画布上的某个节点（按文字找）。 */
export async function clickNode(page, text, settleMs = 0) {
  await page.locator('g.wmind-topic').filter({ hasText: text }).first().click();
  if (settleMs > 0) await page.waitForTimeout(settleMs);
}

/** SVG 里的文字。`innerText` 拿不到 SVG，必须单独取 `textContent`。 */
export function svgTexts(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('svg text')).map((node) => node.textContent ?? ''),
  );
}

// ------------------------------------------------------------------ 出口

/**
 * 跑主流程并决定退出码。
 *
 * 抛异常时**先打汇总再退**：原先各脚本的 `catch` 直接 `exit(1)`，前面已经
 * 跑过的几十条断言结果就丢了，只剩一条栈——排查时最想知道「挂在第几条、
 * 前面都过了没」。
 */
export function run(main) {
  main()
    .then((ok) => {
      const passed = ok ?? summary();
      process.exit(passed ? 0 : 1);
    })
    .catch((error) => {
      console.error(`\n脚本异常中止：${error?.stack ?? error}`);
      summary();
      process.exit(1);
    });
}
