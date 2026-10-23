/**
 * 一次跑完十五套界面验收。
 *
 * 逐个**子进程**跑，不 import：每套脚本的计数是模块级单例（见 lib/harness.mjs），
 * 同进程跑会串台；而且一套崩了不该带塌其余十四套。
 *
 * 用法：
 *   node e2e/run-all.mjs            # 十五套全跑
 *   node e2e/run-all.mjs a11y share # 只跑指定的
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { API, BASE } from './lib/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 顺序有讲究：先快后慢，崩得早的放前面，省得等两分钟才知道环境没起来。 */
const SUITE = [
  ['errors', '错误处理（断网提示）'],
  ['register', '关闭注册'],
  ['locale', '登录页语言切换'],
  ['templates', '模板选择与管理'],
  ['canvas', '多画布 / 大纲 / ZEN'],
  ['a11y', '画布无障碍'],
  ['annotations', '概要 / 边界 / 联系'],
  ['toolbar', '操作提示 / 独立主题按钮'],
  ['insert-content', 'Insert 内容编辑与导出'],
  ['summary-endpoints', '概要选中与联系端点'],
  ['relationship-routing', '联系线走向调整'],
  ['markers', '主题标记'],
  ['culling', '视口裁剪'],
  ['export', '导出与界面语言'],
  ['share', '分享链接'],
];

function probe(url) {
  return fetch(url, { signal: AbortSignal.timeout(5000) }).then(
    (res) => res.ok,
    () => false,
  );
}

function runOne(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(HERE, `${name}.mjs`)], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => resolve({ name, code: code ?? 1, ms: Date.now() - started }));
    child.on('error', (error) => {
      console.error(`无法启动 ${name}.mjs：${error.message}`);
      resolve({ name, code: 1, ms: Date.now() - started });
    });
  });
}

async function main() {
  const wanted = process.argv.slice(2);
  const suites = wanted.length === 0 ? SUITE : SUITE.filter(([name]) => wanted.includes(name));
  if (suites.length === 0) {
    console.error(`没有匹配的套件。可选：${SUITE.map(([name]) => name).join(' / ')}`);
    process.exit(2);
  }

  // 环境没起来时给出人话，而不是让六套脚本各超时一次。
  const [apiUp, webUp] = await Promise.all([probe(`${API}/api/v1/health/live`), probe(`${BASE}/`)]);
  if (!apiUp || !webUp) {
    console.error(`后端 ${API} ${apiUp ? '正常' : '连不上'}；前端 ${BASE} ${webUp ? '正常' : '连不上'}。`);
    console.error('先把后端和前端起起来，见 e2e/README.md。');
    process.exit(2);
  }

  const results = [];
  for (const [name, label] of suites) {
    console.log(`\n${'═'.repeat(70)}\n${label}（${name}.mjs）\n${'═'.repeat(70)}`);
    results.push(await runOne(name));
  }

  console.log(`\n${'═'.repeat(70)}\n汇总\n${'═'.repeat(70)}`);
  for (const item of results) {
    const label = SUITE.find(([name]) => name === item.name)?.[1] ?? item.name;
    // 不 padEnd：标签是中英混排，按字符数补空格只会越补越歪。
    console.log(`${item.code === 0 ? '通过' : '失败'}  ${label} — ${(item.ms / 1000).toFixed(1)}s`);
  }
  const failed = results.filter((item) => item.code !== 0);
  console.log(`\n${results.length - failed.length}/${results.length} 套通过`);
  if (failed.length > 0) console.log(`失败：${failed.map((item) => item.name).join(' / ')}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
