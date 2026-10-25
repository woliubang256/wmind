import { api, type AuthSession } from './client';
import { query } from './query';
import type { AdminStats, AuditLog, Paged, ResetPasswordResult, SettingsMap, User } from './types';

/** 「我的」相关接口。 */
export const userApi = {
  updateProfile: (input: { nickname?: string; email?: string }) => api.patch<User>('/users/me', input),
  changePassword: (input: { oldPassword: string; newPassword: string }) =>
    api.post<AuthSession>('/users/me/password', input, { retryAuth: false }),
  /** 头像走 multipart：后端按解码结果判定类型，所以文件名不重要。 */
  uploadAvatar: (file: File) => {
    const body = new FormData();
    body.append('file', file);
    return api.post<User>('/users/me/avatar', body);
  },
};

export interface AdminUserQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  role?: string;
  status?: string;
}

export interface AuditLogQuery {
  page?: number;
  pageSize?: number;
  action?: string;
  actorUid?: string;
  from?: string;
  to?: string;
}

/** 管理后台接口。 */
export const adminApi = {
  listUsers: ({ page, pageSize, keyword, role, status }: AdminUserQuery = {}) =>
    api.list<User>(`/admin/users${query({ page, page_size: pageSize, q: keyword, role, status })}`),

  createUser: (input: { username: string; email: string; password: string; nickname?: string; role?: string }) =>
    api.post<User>('/admin/users', input),

  updateUser: (uid: string, input: { nickname?: string; email?: string; role?: string; status?: string }) =>
    api.patch<User>(`/admin/users/${encodeURIComponent(uid)}`, input),

  deleteUser: (uid: string, mapStrategy: 'delete' | 'keep' = 'delete') =>
    api.delete<void>(`/admin/users/${encodeURIComponent(uid)}${query({ map_strategy: mapStrategy })}`),

  /** 不传密码时后端随机生成；返回的明文只此一次。 */
  resetPassword: (uid: string, password?: string) =>
    api.post<ResetPasswordResult>(`/admin/users/${encodeURIComponent(uid)}/reset-password`, password ? { password } : undefined),

  stats: () => api.get<AdminStats>('/admin/stats'),

  auditLogs: ({ page, pageSize, action, actorUid, from, to }: AuditLogQuery = {}) =>
    api.list<AuditLog>(`/admin/audit-logs${query({ page, page_size: pageSize, action, actor_uid: actorUid, from, to })}`),

  getSettings: () => api.get<SettingsMap>('/admin/settings'),

  /** 部分更新：只传要改的键。 */
  updateSettings: (patch: SettingsMap) => api.put<SettingsMap>('/admin/settings', patch),
};

export type AdminUsersPage = Paged<User>;
