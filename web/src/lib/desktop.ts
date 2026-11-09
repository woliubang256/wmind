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

/** 快捷键展示用的平台：mac 用 ⌘，pc 用 Ctrl。 */
export type ShortcutPlatform = 'mac' | 'pc';

declare global {
  interface Window {
    /** mygo 注入的运行时（桌面壳才有）。 */
    mygo?: { platform?: string };
  }
}

/**
 * 判断该用 ⌘ 还是 Ctrl。
 *
 * 桌面壳里以 mygo 上报的真实平台为准（darwin → mac，windows/linux → pc），
 * 这是唯一可靠来源——WebView 的 userAgent 在 macOS 上也会带 Macintosh。
 * Web 端读不到系统，按 Windows 展示（产品约定）。
 */
export function shortcutPlatform(): ShortcutPlatform {
  if (!isDesktop()) return 'pc';
  const platform = typeof window === 'undefined' ? undefined : window.mygo?.platform;
  return platform === 'darwin' ? 'mac' : 'pc';
}

export interface DesktopRuntime {
  mode?: 'local' | 'cloud';
  version?: string;
  apiBase?: string;
  authToken?: string;
  /** mygo 解析出的界面语言（跟随系统），如 "zh-Hans"。 */
  locale?: string;
  /** 系统偏好语言列表，最优先在前，逗号分隔，如 "zh-Hans-CN,en"。 */
  preferredLanguages?: string;
}

/** 桌面端的系统偏好语言列表；非桌面环境返回 undefined。 */
export function desktopPreferredLanguages(): string[] | undefined {
  const runtime = desktopRuntime();
  if (!runtime?.preferredLanguages) return undefined;
  const list = runtime.preferredLanguages.split(',').map((tag) => tag.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
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
  /** 云端账号角色：只有 admin 才看得到「网站设置」。 */
  role?: 'admin' | 'user' | string;
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

/** 用系统浏览器打开项目主页。 */
export function openProjectPage(): Promise<{ opened: boolean }> {
  return desktopRequest('/desktop/about/open-project', { method: 'POST' });
}

/** 用系统浏览器打开部署说明。 */
export function openDeployGuide(): Promise<{ opened: boolean }> {
  return desktopRequest('/desktop/about/open-docs', { method: 'POST' });
}

/** 用系统浏览器打开远程服务器的管理后台（与 Web 端同一个页面）。 */
export function openSiteSettings(): Promise<{ opened: boolean }> {
  return desktopRequest('/desktop/cloud/open-site', { method: 'POST' });
}

export function fetchDesktopStatus(): Promise<DesktopStatus> {
  return desktopRequest<DesktopStatus>('/desktop/status');
}

export interface CloudConnectResult {
  serverUrl: string;
  email?: string;
  sync?: SyncResult;
  syncError?: string;
  /** 账号开了两步验证：此时还没登录，需要接着提交动态码。 */
  twoFactorRequired?: boolean;
}

export function connectCloud(input: { serverUrl: string; identifier: string; password: string }): Promise<CloudConnectResult> {
  return desktopRequest('/desktop/cloud/connect', { method: 'POST', body: JSON.stringify(input) });
}

/** 提交两步验证的动态码（或恢复码）完成登录。 */
export function verifyCloudTwoFactor(code: string): Promise<CloudConnectResult> {
  return desktopRequest('/desktop/cloud/verify-2fa', { method: 'POST', body: JSON.stringify({ code }) });
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

// ── 应用更新 ────────────────────────────────────────────────────────────────

export interface UpdateCheck {
  /** 这个构建能不能自我更新（开发构建、未配置更新源时为 false）。 */
  enabled: boolean;
  /** 是否有比当前更新的版本。 */
  available: boolean;
  /** 当前版本。 */
  version: string;
  /** 新版本号（available 为 true 时才有）。 */
  newVersion?: string;
  /** 新版本的发布说明（Markdown）。 */
  notes?: string;
  /** 新版本的构建时间。 */
  date?: string;
}

export interface UpdateProgress {
  phase: 'idle' | 'downloading' | 'ready' | 'error';
  downloaded: number;
  total: number;
  error?: string;
}

export function checkForUpdates(): Promise<UpdateCheck> {
  return desktopRequest<UpdateCheck>('/desktop/updates/check');
}

export function installUpdate(): Promise<{ started: boolean }> {
  return desktopRequest('/desktop/updates/install', { method: 'POST' });
}

export function fetchUpdateProgress(): Promise<UpdateProgress> {
  return desktopRequest<UpdateProgress>('/desktop/updates/progress');
}

/** 重启应用以完成更新（调用后进程会结束，所以不等待后续请求）。 */
export function relaunchApp(): Promise<{ relaunching: boolean }> {
  return desktopRequest('/desktop/updates/relaunch', { method: 'POST' });
}
