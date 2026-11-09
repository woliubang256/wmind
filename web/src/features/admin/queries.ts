import type { AdminUserQuery, AuditLogQuery } from '@/lib/api/endpoints';

/**
 * 管理后台的 query key。
 *
 * `users` / `audit` 把筛选条件并进 key：翻页、改筛选都是一次新的查询，
 * 不会把上一页的数据当成这一页的缓存。`usersRoot` 用于「改完用户后
 * 让所有用户列表失效」——只失效当前那一条会让别的筛选组合显示旧数据。
 */
export const adminKeys = {
  root: ['admin'] as const,
  usersRoot: ['admin', 'users'] as const,
  users: (query: AdminUserQuery = {}) => ['admin', 'users', query] as const,
  settings: ['admin', 'settings'] as const,
  stats: ['admin', 'stats'] as const,
  audit: (query: AuditLogQuery = {}) => ['admin', 'audit', query] as const,
};
