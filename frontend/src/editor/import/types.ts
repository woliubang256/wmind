/**
 * 导入框架的公共类型。
 *
 * 设计约束：**这一层不出现任何人类可读文案**。警告与错误只带 `code` +
 * 参数，翻译在 `import.*` 命名空间里做。理由有三条：
 *
 * 1. 适配器是纯逻辑，塞中文进去就再也测不出「英文界面下有没有漏翻」；
 * 2. 同一个 code 可能被多个格式触发（`palette-fallback` 在 XMind 8 与
 *    现代格式都会出现），文案只能有一份；
 * 3. 单测可以断言 `code`，不用跟着文案改动改断言。
 */

import type { WmindDocument } from '../model/types';
import type { ImportLimits } from './limits';
import type { ZipArchive } from './zip';

export type ImportFormatId = 'xmind' | 'markdown' | 'opml';

/**
 * 降级警告：导入**成功了**，但有些东西没还原到位。
 *
 * 与 `UnsupportedFeature` 的区别：警告是「还原了，但打了折扣」（字体名归一、
 * 渐变拍平），不支持项是「整类特性丢了」（贴纸、录音）。界面上前者进
 * 「提示」，后者进「未能还原」清单并计数。
 *
 * 写成 `as const` 数组而不是纯类型联合：这份清单要当**运行时**数据用——
 * 单测逐条核对 `zh-CN` / `en-US` 有没有对应文案，漏翻就会红，而不是在界面上
 * 露出 `import.warning.palette-fallback` 这种原始 key。
 */
export const IMPORT_WARNING_CODES = [
  /** 主题调色板对不上 10 套内置配色，回退到默认。 */
  'palette-fallback',
  /** 原始字体名归一成了 `sans` / `serif` / `mono`。 */
  'font-normalized',
  /** 渐变填充取起始色。 */
  'gradient-flattened',
  /** 结构类型不认识，回退到思维导图。 */
  'structure-fallback',
  /** 表格降级成「标题 + 行」的子树。 */
  'table-degraded',
  /** 图片没能读出来或没上传成功。 */
  'image-skipped',
  /** 附件 / 音频只留了一行备注。 */
  'attachment-noted',
  /** 样式定义读不出来，退回默认主题。 */
  'styles-ignored',
  /** 标记 id 不在已知集合里。 */
  'marker-unknown',
  /** 标题超长被截断。 */
  'title-truncated',
  /** 归一化阶段修补了适配器产出的字段。 */
  'document-normalized',
] as const;

export type ImportWarningCode = (typeof IMPORT_WARNING_CODES)[number];

export interface ImportWarning {
  code: ImportWarningCode;
  params?: Record<string, string | number>;
}

/** 整类丢掉的特性，按次数累计。 */
export const UNSUPPORTED_FEATURES = [
  'sticker',
  'attachment',
  'audio',
  'recording',
  'custom-marker',
  'gantt',
  'wallpaper',
] as const;

export type UnsupportedFeature = (typeof UNSUPPORTED_FEATURES)[number];

export type UnsupportedSummary = Partial<Record<UnsupportedFeature, number>>;

/** 成功还原的能力项。摘要对话框逐项打勾用。 */
export const IMPORTED_FEATURES = [
  'structure',
  'style',
  'notes',
  'labels',
  'markers',
  'href',
  'image',
  'relationships',
  'boundaries',
  'summaries',
  'collapsed',
] as const;

export type ImportedFeature = (typeof IMPORTED_FEATURES)[number];

export interface ImportSummary {
  sheets: number;
  /** 含中心主题与自由主题。 */
  topics: number;
  /** 含根节点的层数：单节点文档为 1。 */
  maxDepth: number;
  restored: ImportedFeature[];
}

/**
 * 一次导入的输入。
 *
 * `zip()` / `text()` 都是**惰性**的：50MB 的文件不该为了探测格式就整份解压
 * 或解码。注册表在探测阶段只会调用 `zip()` 拿条目清单。
 */
export interface ImportInput {
  readonly fileName: string;
  readonly size: number;
  readonly bytes: Uint8Array;
  /** 不是 zip 时返回 null（不抛错——探测阶段本来就要处理「不是 zip」）。 */
  zip(): ZipArchive | null;
  /** 按 UTF-8 解码整份文件。仅非 zip 格式使用。 */
  text(): string;
}

export interface ImportIdFactory {
  document(): string;
  sheet(): string;
  topic(): string;
  relationship(): string;
  boundary(): string;
  summary(): string;
}

/**
 * 适配器在解析过程中用到的受控环境。
 *
 * 所有「需要留痕」「需要设上限」的动作都必须走这里，而不是适配器自己
 * 维护计数器——否则换一个适配器就漏一次，20 万节点的炸弹总有办法进来。
 */
export interface ImportContext {
  readonly fileName: string;
  readonly ids: ImportIdFactory;
  warn(code: ImportWarningCode, params?: Record<string, string | number>): void;
  unsupported(feature: UnsupportedFeature, count?: number): void;
  /** 登记一个节点。超过 `maxTopics` 抛 `TOO_MANY_TOPICS`。 */
  topic(): void;
  /** 按 `maxTitleLength` 截断并清洗控制字符。 */
  title(value: string): string;
  /**
   * 登记一份待上传的图片，并在文档里留下占位符 `ref`。
   *
   * 走 context 而不是让 `parse` 返回第二个值：适配器已经有 `warn` /
   * `unsupported` 这类「顺手记一笔」的通道，图片是同一种东西，再加一个返回
   * 形状只会让三个适配器的签名一起改。
   *
   * **返回 false 表示这张图没被接受**（超过 `maxAssets`）。适配器必须据此
   * 放弃这张图并计入 `image-skipped`——不能把占位符写进文档，否则上传阶段
   * 没人认领它，数据库里就留下一张指向 `xap:resources/...` 的破图。
   * 已登记过的 `ref` 返回 true（字节已经在队列里，调用方照常用）。
   */
  asset(asset: ImportAsset): boolean;
}

export interface ImportAdapter {
  readonly id: ImportFormatId;
  /** 小写、不含点。用于文件选择框的 `accept` 与拖拽时的初判。 */
  readonly extensions: readonly string[];
  /** 0 = 不认识，1 = 确定。注册表取最高分。 */
  detect(input: ImportInput): number;
  /** 解析成文档。可以抛 `ImportError`。 */
  parse(input: ImportInput, ctx: ImportContext): WmindDocument;
}

export interface ImportRequest {
  fileName: string;
  bytes: Uint8Array;
  limits?: Partial<ImportLimits>;
  /** 测试注入确定性 ID 用；生产不传。 */
  ids?: ImportIdFactory;
  /** 测试注入固定时间用；生产不传。 */
  now?: number;
}

/**
 * 一份待上传的图片。
 *
 * 解析是同步的、上传是异步的，所以解析阶段只把字节攒起来，`image.src` 先写
 * 一个占位符（XMind 里的原引用，如 `xap:resources/a.png`）。上传完成后由
 * `finalize.ts` 把占位符换成服务端 URL——**文档在这之前不要落库**，否则
 * 存进去的是一批指向不存在资源的图片。
 */
export interface ImportAsset {
  /** 占位符，等于文档里 `image.src` 暂时持有的值。 */
  ref: string;
  bytes: Uint8Array;
  /** 原始条目名（`resources/a.png`），用于错误信息与扩展名推断。 */
  fileName: string;
  mime: string;
}

export interface ImportResult {
  format: ImportFormatId;
  document: WmindDocument;
  warnings: ImportWarning[];
  unsupported: UnsupportedSummary;
  summary: ImportSummary;
  /** 需要上传的图片；为空表示这份文件不含内嵌图片。 */
  assets: ImportAsset[];
}
