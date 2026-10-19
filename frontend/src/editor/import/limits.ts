/**
 * 导入的硬性上限。
 *
 * 数值直接对应 docs/06 §2.1.2 的「安全防护」表。**不要**因为「某个文件导不
 * 进来」就调大这些值——它们防的是 zip 炸弹与节点爆炸，调大等于把防线后移。
 * 真需要放宽时，走 `ImportLimits` 的显式覆盖（`runImport({ limits })`），
 * 让调用点留下痕迹。
 *
 * 上限一律做成可注入的参数，而不是模块级常量直接读：测试要在几十字节的样本
 * 上验证 200MB 的中止逻辑，不可能真造一个 200MB 的炸弹。
 */
export interface ImportLimits {
  /** 压缩包 / 文件本身的大小。 */
  maxInputBytes: number;
  /** 一次导入里所有**实际解压**条目累计的字节数。 */
  maxTotalUncompressedBytes: number;
  /** 单个条目的解压后大小（`content.json` 就是靠这条卡住的）。 */
  maxEntryBytes: number;
  /** zip 中央目录里的条目数，防止「一百万个小文件」把条目名表撑爆。 */
  maxEntries: number;
  /** 全文档节点数。 */
  maxTopics: number;
  /** 单个标题的字符数。XMind 允许超长标题，不截断会变成内存与布局的炸弹。 */
  maxTitleLength: number;
}

export const IMPORT_LIMITS: ImportLimits = {
  maxInputBytes: 50 * 1024 * 1024,
  maxTotalUncompressedBytes: 200 * 1024 * 1024,
  maxEntryBytes: 50 * 1024 * 1024,
  maxEntries: 4096,
  maxTopics: 20_000,
  maxTitleLength: 2000,
};

/** 合并调用方覆盖项。只覆盖传进来的键，其余保持默认。 */
export function resolveLimits(overrides?: Partial<ImportLimits>): ImportLimits {
  if (!overrides) return IMPORT_LIMITS;
  const out: ImportLimits = { ...IMPORT_LIMITS };
  for (const key of Object.keys(overrides) as (keyof ImportLimits)[]) {
    const value = overrides[key];
    // 显式传 undefined 时保持默认，避免 `{ maxTopics: undefined }` 把上限变成 NaN。
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}
