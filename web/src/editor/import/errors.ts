/**
 * 导入失败的错误类型。
 *
 * 为什么不是直接 `throw new Error('文件太大')`：
 *
 * - 界面要把错误翻成当前语言，硬编码中文在 en-US 下就是漏网；
 * - 不同错误要配不同的后续动作（「文件太大」只能换文件，「解析失败」可以
 *   让用户重试或反馈），调用方必须能按类型分支；
 * - 单测要断言「失败在 200MB 而不是 201MB」，只能比 code，不能比文案。
 *
 * 因此错误只带**机器可读的 code + 参数**，文案由 `import.*` 命名空间提供。
 */

/**
 * 失败原因。与警告码一样写成运行时数组：单测要逐条核对两种语言的文案是否
 * 都在，光有类型联合是查不出来的。
 */
export const IMPORT_ERROR_CODES = [
  /** 文件本身超过 `maxInputBytes`。 */
  'FILE_TOO_LARGE',
  /** 不是 zip，或者 zip 结构损坏到连中央目录都读不出来。 */
  'NOT_A_ZIP',
  /** 扩展名 / magic / 内部结构都对不上任何已注册的适配器。 */
  'UNKNOWN_FORMAT',
  /** 解压累计字节数超过 `maxTotalUncompressedBytes`。 */
  'UNZIP_LIMIT_EXCEEDED',
  /** 单个条目超过 `maxEntryBytes`。 */
  'ENTRY_TOO_LARGE',
  /** 中央目录条目数超过 `maxEntries`。 */
  'TOO_MANY_ENTRIES',
  /** 节点数超过 `maxTopics`。 */
  'TOO_MANY_TOPICS',
  /** 适配器内部失败：结构对得上但内容读不出来。 */
  'PARSE_FAILED',
  /** 文件带密码。 */
  'ENCRYPTED',
  /** 解析出来一个节点都没有——空文档不该被当成成功。 */
  'EMPTY_DOCUMENT',
] as const;

export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

export type ImportErrorParams = Record<string, string | number>;

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly params: ImportErrorParams;

  constructor(code: ImportErrorCode, params: ImportErrorParams = {}, cause?: unknown) {
    // message 只给日志和 devtools 看，界面永远走 code + params。
    super(`导入失败：${code}`, cause === undefined ? undefined : { cause });
    this.name = 'ImportError';
    this.code = code;
    this.params = params;
  }
}

export function isImportError(value: unknown): value is ImportError {
  return value instanceof ImportError;
}

/**
 * 把任意异常收口成 `ImportError`。
 *
 * fflate 与 JSON.parse 抛的都是普通 `Error`（甚至字符串），直接往上抛会让
 * 界面拿不到 code。已经是 `ImportError` 的原样透传，不包第二层——否则
 * 「200MB 中止」会被包成「解析失败」，测试和用户提示都会失真。
 */
export function toImportError(
  value: unknown,
  fallback: ImportErrorCode = 'PARSE_FAILED',
  params: ImportErrorParams = {},
): ImportError {
  if (isImportError(value)) return value;
  return new ImportError(fallback, params, value);
}
