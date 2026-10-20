/**
 * 文件上传接口。
 *
 * 后端按**解码结果**判定类型，不看 `Content-Type`，也不看文件名——所以这里
 * 的 `mime` 与 `fileName` 只是礼貌（便于日志与服务端排查），传错了不会让
 * 一张 PNG 被当成别的东西存下来，反过来也不会被放行。
 *
 * 请求体用 `FormData` 而不是 base64 JSON：base64 会把 8MB 的图变成 11MB 的
 * 字符串，还要在浏览器里先拼一次、服务端再解一次，纯属两头加负担。
 */

import { api } from './client';

export interface UploadedFile {
  uid: string;
  url: string;
  width: number;
  height: number;
  /** 解码出来的真实格式：`png` / `jpeg` / `gif` / `webp`。 */
  format: string;
  bytes: number;
}

export interface UploadInput {
  bytes: Uint8Array;
  /** 原始条目名，可能带路径（`resources/a.png`）；只取最后一段当文件名。 */
  fileName: string;
  mime: string;
}

/**
 * 只留文件名，去掉路径。
 *
 * multipart 头里的 `filename` 是纯文本，带 `/` 不会真的穿越目录（服务端自己
 * 生成存储名），但一个写着 `../../etc/passwd` 的字段值会让所有看日志的人
 * 分不清是攻击还是脏数据。上传路径的唯一权威是服务端，这里不该出现路径。
 */
function baseName(path: string): string {
  const cut = path.split(/[\\/]/).pop() ?? '';
  return cut === '' ? 'image' : cut;
}

export const fileApi = {
  /** 单文件上传。限流 120 次/分钟/用户，导入时的张数上限见 `IMPORT_LIMITS.maxAssets`。 */
  upload(input: UploadInput) {
    const body = new FormData();
    // Blob 构造时会拷贝一份字节，所以这里不需要自己 slice；传视图也行，
    // 只会取视图覆盖的那一段。
    body.append('file', new Blob([input.bytes], { type: input.mime }), baseName(input.fileName));
    return api.post<UploadedFile>('/files', body);
  },
};
