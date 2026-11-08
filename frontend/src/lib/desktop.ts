/**
 * 桌面壳（mygo）的运行时能力。
 *
 * Web 形态下 `window.__WMIND__` 不存在，这里的所有能力探测都返回 false，
 * 页面行为与以前完全一致；桌面形态下壳在首屏 HTML 里注入这个对象（见
 * backend/desktop/internal/localserver），前端据此：
 *
 * - 隐藏只有服务器才有的入口（分享链接、用户管理、站点设置、退出登录）；
 * - 通过 `/desktop/*` 接口连接云端、触发同步、上传单张导图；
 * - 在列表里显示「本地 / 云端 / 有本地修改 / 冲突」的来源标识。
 *
 * 为什么不做成「桌面端一套路由」：需求是「和 Web 一样的功能体验」，两套
 * 路由意味着两套回归。这里只做能力开关，页面本身共用。
 */

export interface DesktopRuntime {
  mode?: 'local' | 'cloud';
  version?: string;
  apiBase?: string;
  authToken?: string;
}

export function desktopRuntime(): DesktopRuntime | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.__WMIND__;
}

/** 是否运行在桌面壳里。 */
export function isDesktop(): boolean {
  return desktopRuntime() !== undefined;
}

/**
 * 桌面端专有能力开关。
 *
 * 本地模式没有服务器：分享链接、多用户、站点设置都不存在，展示出来只会
 * 让用户点进一个报错页面。
 */
export const desktopCapabilities = {
  shareLinks: !isDesktop(),
  signOut: !isDesktop(),
  userManagement: !isDesktop(),
  siteSettings: !isDesktop(),
  registration: !isDesktop(),
};

// ── 桌面接口 ────────────────────────────────────────────────────────────────

export interface CloudStatus {
  connected: boolean;
  serverUrl?: string;
  email?: string;
  lastSyncedAt?: string;
}

export interface DesktopStatus {
  mode: string;
  version: string;
  cloud: CloudStatus;
  localMaps: number;
  syncedMaps: number;
  pendingMaps: number;
  conflictMaps: string[];
}

export interface SyncResult {
  Pulled: number;
  Pushed: number;
  Deleted: number;
  Conflicts: string[] | null;
  Failed: string[] | null;
}

export interface MapSource {
  mapUid: string;
  remoteUid?: string;
  serverUrl?: string;
  state: 'local-only' | 'synced' | 'local-dirty' | 'remote-dirty' | 'conflict' | 'offline';
  lastSyncedAt?: string;
  deleted: boolean;
}

async function desktopRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    credentials: 'include',
  });
  let body: { data?: T; error?: string } = {};
  try {
    body = (await response.json()) as { data?: T; error?: string };
  } catch {
    // 空响应（204）或非 JSON：交给下面的状态码判断。
  }
  if (!response.ok) {
    throw new Error(body.error || `桌面接口失败（${response.status}）`);
  }
  return body.data as T;
}

export function fetchDesktopStatus(): Promise<DesktopStatus> {
  return desktopRequest<DesktopStatus>('/desktop/status');
}

export function connectCloud(input: { serverUrl: string; identifier: string; password: string }): Promise<{
  serverUrl: string;
  email?: string;
  sync?: SyncResult;
  syncError?: string;
}> {
  return desktopRequest('/desktop/cloud/connect', { method: 'POST', body: JSON.stringify(input) });
}

export function disconnectCloud(): Promise<{ connected: boolean }> {
  return desktopRequest('/desktop/cloud/disconnect', { method: 'POST' });
}

export function syncNow(): Promise<SyncResult> {
  return desktopRequest<SyncResult>('/desktop/sync', { method: 'POST' });
}

export function uploadMapToCloud(mapUid: string): Promise<{ mapUid: string; remoteUid: string; state: string }> {
  return desktopRequest(`/desktop/maps/${encodeURIComponent(mapUid)}/upload`, { method: 'POST' });
}

export function resolveMapConflict(mapUid: string, keepLocal: boolean): Promise<{ resolved: boolean }> {
  return desktopRequest(`/desktop/maps/${encodeURIComponent(mapUid)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ keepLocal }),
  });
}

/** 本地保存成功后调用，把这张图标成「有本地改动」。 */
export function touchMapSyncState(mapUid: string): Promise<unknown> {
  return desktopRequest(`/desktop/maps/${encodeURIComponent(mapUid)}/touch`, { method: 'POST' });
}

export async function fetchMapSources(): Promise<Map<string, MapSource>> {
  const items = await desktopRequest<MapSource[]>('/desktop/maps/sources');
  const map = new Map<string, MapSource>();
  for (const item of items ?? []) map.set(item.mapUid, item);
  return map;
}

/** 来源标识的取值（同时是 i18n 键后缀）。 */
export type SourceLabel = 'local' | 'synced' | 'dirty' | 'conflict' | 'offline';

/** 来源标识的展示文案 key（i18n）。 */
export function sourceLabelKey(source: MapSource | undefined, mapUpdatedAt?: string): SourceLabel {
  if (!source) return 'local';
  if (source.state === 'conflict') return 'conflict';
  if (source.state === 'offline') return 'offline';
  if (source.state === 'local-only') return 'local';
  if (source.state === 'local-dirty') return 'dirty';
  // 已同步过，但本地在那之后又改过（保存时间晚于上次同步）。
  if (mapUpdatedAt && source.lastSyncedAt && Date.parse(mapUpdatedAt) > Date.parse(source.lastSyncedAt) + 1000) {
    return 'dirty';
  }
  return 'synced';
}
