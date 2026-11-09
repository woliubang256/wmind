/**
 * 字体就绪等待：**字体 → 测量 → 布局**，顺序不可颠倒。
 *
 * 布局引擎用 Canvas `measureText` 算节点宽度。若首帧用回退字体测量、webfont
 * 到达后重排，整张导图的节点尺寸都会变、画面跳一下（ADR-016 第 6 条）。所以
 * 首屏必须阻塞等待所需分片，等待期显示骨架屏。
 *
 * 三个关键细节：
 *
 * 1. **先有 `@font-face`，再问「就绪了吗」**。`document.fonts.load()` 对还没注册
 *    任何 face 的字体族会**立刻 resolve**（返回空数组），拿到的是「假就绪」——
 *    接着就用回退字体量了宽度。所以本模块先注入该族的样式表（每族一份，见
 *    `scripts/fetch-fonts.mjs`），等它 load 完再调 `document.fonts.load()`。
 * 2. **按真实文本加载**。`document.fonts.load(font)` 不带文本参数时会加载该字体
 *    描述符下的**所有**分片——Noto Sans SC 有 101 个、4.29 MB。传第二个参数
 *    （文档里的全部文字）后，浏览器只取覆盖这些码位的分片。实测：一段九个汉字
 *    的默认文档、五个字重，命中 12~14 个分片、约 315 KB（分片文件跨字重共享，
 *    多等几个字重几乎只增加请求数、不增加字节）。
 * 3. **必须带超时**。字体文件走网络，弱网下 `load()` 可能迟迟不 resolve。没有
 *    超时的话编辑器会一直停在骨架屏上——比跳一下严重得多。超时后按回退字体
 *    继续渲染，并记一条 warning 供排查。
 */

import type { FontFamily } from '../model/types';
import { FONT_DEFINITIONS, fontStack } from './fonts';

/** 等待上限。样式表与分片共用这一个预算，不是各自一份。 */
export const FONT_LOAD_TIMEOUT_MS = 4000;

/** 空文档时的兜底样本：至少把最常用的那几片拉下来。 */
const FALLBACK_SAMPLE = '思维导图 wmind 0123';

export interface FontLoadResult {
  /** 全部所需字重都已就绪。 */
  ready: boolean;
  /** 超时被中断（`ready` 为 false 且此项为 true）。 */
  timedOut: boolean;
  /** 实际等待的字重，便于日志定位。 */
  weights: number[];
}

/**
 * 每族样式表只注入一次。
 *
 * 缓存的是 Promise 而不是「已注入」标记：同一帧里 `sans` 与 `serif` 都被用到时，
 * 第二次调用要能等到第一次的 load 事件，而不是插进第二个 `<link>` 后立刻返回。
 */
const stylesheetLoads = new Map<string, Promise<boolean>>();

/** 注入一份字体样式表；解析出 load / error 的成败，不抛异常。 */
function loadStylesheet(href: string): Promise<boolean> {
  const cached = stylesheetLoads.get(href);
  if (cached) return cached;

  const pending = new Promise<boolean>((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.wmindFont = href;
    link.addEventListener('load', () => resolve(true));
    link.addEventListener('error', () => resolve(false));
    document.head.append(link);
  });
  stylesheetLoads.set(href, pending);
  return pending;
}

type Outcome<T> = { ok: true; value: T } | { ok: false };

/** 在截止时间之前等一个 Promise；到点就返回 `{ ok: false }`，不 reject。 */
async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<Outcome<T>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { ok: false };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), remaining);
  });

  try {
    return await Promise.race([promise.then((value) => ({ ok: true as const, value })), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 等待一组字重就绪。
 *
 * `text` 决定要拉哪些分片：传空串会退化成「加载全部分片」，所以调用方必须传
 * 文档里的真实文字。取不到文字时（空文档）用一小段常用字兜底。
 */
export async function ensureFonts(
  family: FontFamily,
  weights: number[],
  text: string,
  timeoutMs = FONT_LOAD_TIMEOUT_MS,
): Promise<FontLoadResult> {
  const definition = FONT_DEFINITIONS[family];
  const requested = [...new Set(weights.filter((weight) => Number.isFinite(weight) && weight > 0))];

  // 非打包字体（system）没有分片要等；没有 FontFaceSet 的环境（SSR、老浏览器）
  // 直接放行——等待一个不存在的 API 只会永远卡住。
  if (!definition.bundled || requested.length === 0 || typeof document === 'undefined' || !document.fonts) {
    return { ready: true, timedOut: false, weights: requested };
  }

  const deadline = Date.now() + timeoutMs;

  if (definition.cssPath !== null) {
    const sheet = await beforeDeadline(loadStylesheet(definition.cssPath), deadline);
    if (!sheet.ok) return { ready: false, timedOut: true, weights: requested };
    if (!sheet.value) {
      // 样式表 404：没有任何 face 可等，继续等下去只会白等满 4 秒。
      console.warn(`字体样式表加载失败（${definition.cssPath}），先用回退字体渲染。`);
      return { ready: true, timedOut: false, weights: requested };
    }
  }

  const sample = text.trim() === '' ? FALLBACK_SAMPLE : text;
  const stack = fontStack(family);
  const loads = requested.map((weight) => document.fonts.load(`${weight} 16px ${stack}`, sample));

  const faces = await beforeDeadline(Promise.allSettled(loads), deadline);
  return { ready: faces.ok, timedOut: !faces.ok, weights: requested };
}

/**
 * 从一份文档里取出所有会被渲染的文字。
 *
 * 只取标题：备注不画在节点上，样式里的字体名也不参与测量。拼成一个字符串比
 * 逐条 `load()` 快得多——`load()` 每次都要遍历一遍字体集。
 */
export function collectDocumentText(titles: Iterable<string>): string {
  return Array.from(titles).join('');
}
