/**
 * 按主分支拆分导出（zip）。
 *
 * 一张大导图直接贴出去，字号会被缩到看不清。更常见的用法是「一个主分支一张图」：
 * 每张图只讲一个主题，贴进文档或 PPT 时还能自己排版。
 *
 * 拆分的语义有一条硬规则：**每张图都带中心主题**。只把分支单独画出来会丢掉
 * 「这是哪张导图的哪一支」，而中心主题往往就是上下文本身。所以每个文件是
 * 「中心主题 + 一个主分支」，文件名用分支标题。
 *
 * 分两步，与图片内嵌（`assets.ts`）同样的理由：**收集是纯函数，出图是异步的**。
 * 拆解逻辑（哪些分支、每个分支对应哪张画布）能在 node 里直接测，栅格化则注入。
 */

import { strToU8, zipSync } from 'fflate';
import i18n from '@/lib/i18n';
import type { Sheet, Topic, WmindDocument } from '../model/types';
import { buildExportContext, type ExportContext, type ExportOptions } from './context';
import { buildExportSvg } from './svg';

/** 一个待导出的分支。 */
export interface BranchPlan {
  /** 分支标题，用作文件名（已去重）。 */
  title: string;
  /** 只含「中心主题 + 这一个分支」的画布。 */
  sheet: Sheet;
}

/**
 * 把一张画布拆成「中心主题 + 单个主分支」。
 *
 * 关系线、边界、汇总只保留**两端都还在**的那些：拆出去之后另一端已经不在这张
 * 图里，留着它们只会渲染成半截装饰，或者因为找不到节点被静默丢掉——两种都
 * 不如提前过滤干净。
 */
function isolate(sheet: Sheet, branch: Topic): Sheet {
  const kept = new Set<string>();
  const walk = (topic: Topic) => {
    kept.add(topic.id);
    for (const child of topic.children.attached) walk(child);
  };
  walk(branch);
  kept.add(sheet.rootTopic.id);

  return {
    ...sheet,
    rootTopic: {
      ...sheet.rootTopic,
      children: { ...sheet.rootTopic.children, attached: [branch] },
    },
    floatingTopics: [],
    relationships: sheet.relationships.filter((item) => kept.has(item.end1Id) && kept.has(item.end2Id)),
    boundaries: sheet.boundaries.filter((item) => item.range.every((id) => kept.has(id))),
    summaries: sheet.summaries.filter(
      (item) => kept.has(item.topicId) && item.range.every((id) => kept.has(id)),
    ),
  };
}

/** 文件名里不能出现的字符。与 `svg.ts` 的 `exportFileName` 同一套规则。 */
function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || i18n.t('editor.export.untitledFile');
}

/**
 * 列出拆分计划。分支为空时返回空数组——调用方据此禁用「拆分」选项。
 *
 * 重名分支要加序号：两个分支都叫「一期」时，zip 里同名的第二个文件会覆盖第一个
 * （或者在某些解压工具里直接丢失）。序号从 2 开始，读起来像「副本」而不是「编号」。
 */
export function planBranches(document: WmindDocument, sheetId: string | null): BranchPlan[] {
  const sheet = document.sheets.find((item) => item.id === sheetId) ?? document.sheets[0];
  if (sheet === undefined) return [];

  const used = new Map<string, number>();
  return sheet.rootTopic.children.attached.map((branch) => {
    const base = safeName(branch.title || i18n.t('editor.export.untitledFile'));
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return {
      title: seen === 0 ? base : `${base}-${seen + 1}`,
      sheet: isolate(sheet, branch),
    };
  });
}

/** 出图依赖，注入是为了能在 node 里测「拆了几张、叫什么名字」。 */
export interface SplitDeps {
  /** 出图前最后一次加工上下文（对话框用它把图片换成 data URL）。 */
  prepare?(ctx: ExportContext): ExportContext;
  /** 把一份 SVG 字符串变成要写进 zip 的字节。 */
  encode(ctx: ExportContext, markup: string): Promise<Uint8Array>;
}

export interface SplitResult {
  /** zip 字节。 */
  bytes: Uint8Array;
  /** 实际写进去的文件名，按顺序。 */
  names: string[];
}

/**
 * 逐个分支出图并打包。
 *
 * 串行而不是 `Promise.all`：每张图都要经过一次 `canvas.toBlob`，并发十张会让
 * 峰值内存翻十倍——而这一步用户是看得见进度条慢一点的，崩掉却没法解释。
 */
export async function exportBranches(
  document: WmindDocument,
  sheetId: string | null,
  options: ExportOptions,
  extension: string,
  deps: SplitDeps,
): Promise<SplitResult> {
  const plans = planBranches(document, sheetId);
  const files: Record<string, Uint8Array> = {};
  const names: string[] = [];

  for (const plan of plans) {
    // 拆分后每张图只有一张画布、一个分支，`scope` 必须回到 `current`，
    // 否则会把整份文档的每张画布都拼进来。
    const raw = buildExportContext(
      { ...document, sheets: [plan.sheet] },
      plan.sheet.id,
      { ...options, scope: 'current' },
    );
    const ctx = deps.prepare === undefined ? raw : deps.prepare(raw);
    const markup = buildExportSvg(ctx);
    const name = `${plan.title}.${extension}`;
    files[name] = await deps.encode(ctx, markup);
    names.push(name);
  }

  return { bytes: zipSync(files, { level: 6 }), names };
}

/** SVG 的编码器：直接转字节，不需要栅格化。 */
export const svgEncoder: SplitDeps['encode'] = async (_ctx, markup) => strToU8(markup);
