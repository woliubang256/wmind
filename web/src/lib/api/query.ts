/**
 * 把查询参数拼成 query string，跳过空值。
 *
 * 单独一个文件是因为「列表接口带筛选」这件事跨越了多个 API 模块
 * （管理后台、导图、回收站），而每个模块各抄一份的结果是某一天其中一份
 * 忘了 `encodeURIComponent`。
 */
export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}
