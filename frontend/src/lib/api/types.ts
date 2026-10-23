/**
 * 后端响应的线上类型。
 *
 * 与 `internal/handler` 里的 DTO 一一对应。手写而不是从 OpenAPI 生成：
 * 目前只有十来个结构，生成的收益不足以抵消工具链成本；改后端时同步改这里，
 * `tsc` 会把漏改的地方指出来。
 */

export type Role = 'user' | 'admin';
export type UserStatus = 'active' | 'disabled' | 'pending';

export interface User {
  uid: string;
  username: string;
  email: string;
  nickname: string;
  avatarUrl: string;
  role: Role;
  status: UserStatus;
  mapCount: number;
  storageUsedBytes: number;
  lastLoginAt: string | null;
  createdAt: string;
}

/** GET /site/config 的响应。未登录可读。 */
export interface SiteConfig {
  siteName: string;
  /**
   * 导出图片右下角的落款文字。
   *
   * 后端已经把「空值」解析成站点名称了，所以这里拿到的永远是可以直接用的值。
   */
  brand: string;
  logoUrl: string;
  description: string;
  icp: string;
  registrationEnabled: boolean;
  passwordMinLength: number;
  importEnabled: boolean;
  exportEnabled: boolean;
  userTemplateEnabled: boolean;
  shareEnabled: boolean;
  /** 新建分享链接时的默认有效期（天）；0 表示永久。 */
  shareDefaultExpireDays: number;
  /** 新建分享链接时「允许下载」的默认值。 */
  shareDefaultAllowDownload: boolean;
  version: string;
}

/** 列表响应的分页信息，由 `apiRequest` 的 `page` 变体返回。 */
export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paged<T> {
  items: T[];
  pagination: Pagination;
}

export type SettingsValue = string | number | boolean;
export type SettingsMap = Record<string, SettingsValue>;

export interface AuditLog {
  id: number;
  actorId: number | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  ip: string;
  createdAt: string;
}

export interface AdminStats {
  userCount: number;
  activeUserCount: number;
  mapCount: number;
  mapCountToday: number;
  storageUsedBytes: number;
  trend: { date: string; newUsers: number; newMaps: number }[];
}

export interface ResetPasswordResult {
  password: string;
  generated: boolean;
}
