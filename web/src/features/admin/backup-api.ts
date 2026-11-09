import { api } from '@/lib/api/client';

export interface BackupConfiguration {
  enabled: boolean;
  retainCount: number;
  skipUnchanged: boolean;
  cron: string;
  timezone: string;
  target: 'webdav' | 's3' | 'folder';
  webdav: { url: string; username: string; password?: string; passwordSet?: boolean };
  s3: {
    endpoint: string; region: string; bucket: string; prefix: string; pathStyle: boolean;
    accessKey?: string; secretKey?: string; sessionToken?: string;
    accessKeySet?: boolean; secretKeySet?: boolean; sessionTokenSet?: boolean; clearSessionToken?: boolean;
  };
  /** 桌面端离线备份目标：本机（或外接盘 / 网盘同步目录）的一个绝对路径。 */
  folder: { dir: string };
}
export interface BackupJob {
  id: string; kind: 'backup' | 'restore'; trigger: 'manual' | 'schedule';
  status: 'running' | 'succeeded' | 'failed' | 'skipped'; stage: string;
  startedAt: string; finishedAt?: string; filename?: string; bytes?: number;
  errorCode?: string; warningCode?: string; contentVersion?: string; recoveryFile?: string;
}
export interface BackupState {
  configuration: BackupConfiguration; nextRuns: string[]; current?: BackupJob;
  history: BackupJob[]; busy: boolean; maxUploadBytes: number;
}
export interface RestorePreview {
  id: string; createdAt: string; expiresAt: string;
  database: { driver: string; schema: number }; files: number; bytes: number;
}
export const backupKeys = { state: ['admin', 'backups'] as const };
/**
 * 备份接口。
 *
 * `base` 用于桌面端「网站设置」：那些请求要打到**服务器**上（本机后端转发），
 * 而不是客户端自己的本地库。
 */
export const backupApi = {
  get: (base?: string) => api.get<BackupState>('/admin/backups', base ? { base } : undefined),
  save: (configuration: BackupConfiguration, base?: string) =>
    api.put<BackupState>('/admin/backups/config', configuration, base ? { base } : undefined),
  test: (configuration: BackupConfiguration, base?: string) =>
    api.post<{ success: boolean }>('/admin/backups/test', configuration, base ? { base } : undefined),
  run: (base?: string) => api.post<BackupJob>('/admin/backups/run', undefined, base ? { base } : undefined),
  schedule: (cron: string, timezone: string, base?: string) =>
    api.post<{ nextRuns: string[] }>('/admin/backups/schedule', { cron, timezone }, base ? { base } : undefined),
  inspect: (file: File, base?: string) =>
    api.post<RestorePreview>('/admin/backups/restore/preview', file, { headers: { 'Content-Type': 'application/zip' }, retryAuth: false, ...(base ? { base } : {}) }),
  restore: (id: string, base?: string) =>
    api.post<BackupJob>('/admin/backups/restore', { id, confirm: true }, { retryAuth: false, ...(base ? { base } : {}) }),
};
