import { api } from '@/lib/api/client';

export interface BackupConfiguration {
  enabled: boolean;
  retainCount: number;
  skipUnchanged: boolean;
  cron: string;
  timezone: string;
  target: 'webdav' | 's3';
  webdav: { url: string; username: string; password?: string; passwordSet?: boolean };
  s3: {
    endpoint: string; region: string; bucket: string; prefix: string; pathStyle: boolean;
    accessKey?: string; secretKey?: string; sessionToken?: string;
    accessKeySet?: boolean; secretKeySet?: boolean; sessionTokenSet?: boolean; clearSessionToken?: boolean;
  };
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
export const backupApi = {
  get: () => api.get<BackupState>('/admin/backups'),
  save: (configuration: BackupConfiguration) => api.put<BackupState>('/admin/backups/config', configuration),
  test: (configuration: BackupConfiguration) => api.post<{ success: boolean }>('/admin/backups/test', configuration),
  run: () => api.post<BackupJob>('/admin/backups/run'),
  schedule: (cron: string, timezone: string) => api.post<{ nextRuns: string[] }>('/admin/backups/schedule', { cron, timezone }),
  inspect: (file: File) => api.post<RestorePreview>('/admin/backups/restore/preview', file, { headers: { 'Content-Type': 'application/zip' }, retryAuth: false }),
  restore: (id: string) => api.post<BackupJob>('/admin/backups/restore', { id, confirm: true }, { retryAuth: false }),
};
