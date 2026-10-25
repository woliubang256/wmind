/**
 * 分享链接接口。
 *
 * 与后端 `handler/shares.go` 的 DTO 一一对应。三处刻意的设计：
 *
 * 1. **公开接口带 `auth: false`**。请求层遇到 401 会尝试静默刷新登录令牌，
 *    而分享页的 401 是「需要访问密码」——去刷新登录态既没有意义，还会把
 *    一个匿名访客的浏览器卷进一条注定失败的刷新链。
 * 2. **`url` 可能是相对路径**。站点没配 `site.base_url` 时后端只回 `/s/<token>`，
 *    由前端用当前 origin 补全（见 `resolveShareUrl`）：服务端在反向代理后面
 *    看到的 Host 常常不是用户访问的那个域名，猜出来的绝对地址是错的。
 * 3. **`password: null` 与「字段缺失」不同**。前者表示清除密码，后者表示不改。
 *    所以更新入参里 password 的类型是 `string | null | undefined`。
 */

import type { WmindDocument } from '@/editor/model/types';
import { api } from './client';
import { query } from './query';
import type { Paged } from './types';

/** 一条分享链接（属主视角）。 */
export interface ShareLink {
  uid: string;
  token: string;
  /** 完整链接或站内相对路径，见 `resolveShareUrl`。 */
  url: string;
  mapUid: string;
  mapTitle: string;
  hasPassword: boolean;
  /** Owner-only; null for no password, legacy hashes or unavailable ciphertext. */
  password: string | null;
  allowDownload: boolean;
  showNotes: boolean;
  expiresAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  /** 非空表示已撤销。撤销后的链接仍留在列表里，以便保留访问统计。 */
  revokedAt: string | null;
  createdAt: string;
}

export interface CreateShareInput {
  /** 省略或空串表示不设密码。 */
  password?: string;
  /** 0 或省略表示永久有效。 */
  expiresInDays?: number;
  allowDownload?: boolean;
  showNotes?: boolean;
}

export interface UpdateShareInput {
  /** `null` 表示清除密码，`undefined` 表示不改。 */
  password?: string | null;
  expiresInDays?: number;
  allowDownload?: boolean;
  showNotes?: boolean;
}

/** 公开访问拿到的渲染数据。**不含**属主的 uid 与邮箱。 */
export interface PublicShare {
  title: string;
  document: WmindDocument;
  allowDownload: boolean;
  showNotes: boolean;
  siteName: string;
  logoUrl: string;
  ownerNickname: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface ShareAccess {
  accessToken: string;
  expiresIn: number;
}

export interface ShareListQuery {
  page?: number;
  pageSize?: number;
  mapUid?: string;
}

const enc = encodeURIComponent;

export const shareApi = {
  create: (mapUid: string, input: CreateShareInput = {}): Promise<ShareLink> =>
    api.post<ShareLink>(`/maps/${enc(mapUid)}/shares`, input),

  /** 某张导图的全部链接（含已撤销的）。上限由站点设置约束，因此不分页。 */
  listByMap: (mapUid: string): Promise<ShareLink[]> =>
    api.get<ShareLink[]>(`/maps/${enc(mapUid)}/shares`),

  listMine: ({ page, pageSize, mapUid }: ShareListQuery = {}): Promise<Paged<ShareLink>> =>
    api.list<ShareLink>(`/shares${query({ page, page_size: pageSize, map_uid: mapUid })}`),

  update: (uid: string, input: UpdateShareInput): Promise<ShareLink> =>
    api.patch<ShareLink>(`/shares/${enc(uid)}`, input),

  revoke: (uid: string): Promise<void> => api.delete<void>(`/shares/${enc(uid)}`),

  /**
   * 公开读取。
   *
   * accessToken 来自 `verify`，存在 sessionStorage 里，随请求放在
   * `X-Share-Access` 头。没有密码的分享不需要它。
   */
  publicGet: (token: string, accessToken?: string): Promise<PublicShare> =>
    api.get<PublicShare>(`/public/shares/${enc(token)}`, {
      auth: false,
      headers: accessToken ? { 'X-Share-Access': accessToken } : undefined,
    }),

  publicVerify: (token: string, password: string): Promise<ShareAccess> =>
    api.post<ShareAccess>(`/public/shares/${enc(token)}/verify`, { password }, { auth: false }),
};

/**
 * 把后端给的 `url` 补成可以直接复制/打开的绝对地址。
 *
 * 只处理站内相对路径：以 `/` 开头的拼到当前 origin 后面，其余原样返回。
 * 不用 `new URL()` 是因为它会把 `javascript:` 之类的伪协议也「解析成功」，
 * 而这个值最终会进输入框与剪贴板——拼字符串虽然朴素，但没有第二种解释。
 */
export function resolveShareUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const path = url.startsWith('/') ? url : `/${url}`;
  return `${window.location.origin}${path}`;
}

/** A password-bearing link sends both credentials together. Never attach to non-HTTP URLs. */
export function shareUrlForCopy(link: Pick<ShareLink, 'url' | 'hasPassword' | 'password'>): string {
  const resolved = resolveShareUrl(link.url);
  try {
    const url = new URL(resolved);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return resolved;
    url.searchParams.delete('psw');
    if (link.hasPassword && link.password) url.searchParams.set('psw', link.password);
    return url.toString();
  } catch {
    return resolved;
  }
}

/** Pure parsing: callers keep the hint in memory and replace the URL, never auto-verify. */
export function readSharePasswordQuery(search: string): { password: string; search: string; present: boolean } {
  const params = new URLSearchParams(search);
  const present = params.has('psw');
  const value = params.get('psw') ?? '';
  const password = Array.from(value).length <= 64 && new TextEncoder().encode(value).length <= 72 ? value : '';
  params.delete('psw');
  const remaining = params.toString();
  return { password, search: remaining ? `?${remaining}` : '', present };
}

/** 分享页访问凭证在 sessionStorage 里的键。按令牌分开，避免多标签页互相覆盖。 */
export function shareAccessStorageKey(token: string): string {
  return `wmind:share-access:${token}`;
}

/** 读回已保存的访问凭证；隐私模式下 sessionStorage 可能直接抛错。 */
export function readShareAccess(token: string): string {
  try {
    return window.sessionStorage.getItem(shareAccessStorageKey(token)) ?? '';
  } catch {
    return '';
  }
}

export function writeShareAccess(token: string, accessToken: string): void {
  try {
    window.sessionStorage.setItem(shareAccessStorageKey(token), accessToken);
  } catch {
    // 存不进去就只影响「刷新后要重新输密码」，不值得打断访问。
  }
}

export function clearShareAccess(token: string): void {
  try {
    window.sessionStorage.removeItem(shareAccessStorageKey(token));
  } catch {
    // 同上。
  }
}
