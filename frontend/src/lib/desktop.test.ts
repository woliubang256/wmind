import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapSource } from './desktop';

/**
 * 桌面能力探测与来源标识。
 *
 * 这两件事决定了「Web 与桌面共用一套页面」是否成立：探测错一次，Web 上就会
 * 冒出桌面专属入口；来源标识错一次，用户会以为本地图已经同步到云端了。
 *
 * 能力开关是**模块加载时**算出来的常量（它决定渲染哪些入口，不该每帧重算），
 * 所以每个用例都要先摆好 `window.__WMIND__` 再重新加载模块。
 */

async function loadModule(runtime?: Record<string, unknown>) {
  vi.resetModules();
  if (runtime) {
    vi.stubGlobal('window', { __WMIND__: runtime });
  } else {
    vi.stubGlobal('window', undefined);
  }
  return await import('./desktop');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function source(overrides: Partial<MapSource>): MapSource {
  return { mapUid: 'm1', state: 'synced', deleted: false, ...overrides };
}

describe('desktop runtime', () => {
  it('Web 形态下不认为自己运行在桌面壳里', async () => {
    const desktop = await loadModule();
    expect(desktop.desktopRuntime()).toBeUndefined();
    expect(desktop.isDesktop()).toBe(false);
    expect(desktop.desktopCapabilities.shareLinks).toBe(true);
    expect(desktop.desktopCapabilities.signOut).toBe(true);
  });

  it('桌面形态下关闭只有服务器才有的能力', async () => {
    const desktop = await loadModule({ mode: 'local', version: '1.0.0', apiBase: '/api/v1' });
    expect(desktop.isDesktop()).toBe(true);
    expect(desktop.desktopCapabilities).toMatchObject({
      shareLinks: false,
      signOut: false,
      userManagement: false,
      siteSettings: false,
      registration: false,
    });
  });
});

describe('来源标识', () => {
  it('没有同步记录就是本地图', async () => {
    const { sourceLabelKey } = await loadModule();
    expect(sourceLabelKey(undefined)).toBe('local');
  });

  it('按同步状态映射', async () => {
    const { sourceLabelKey } = await loadModule();
    expect(sourceLabelKey(source({ state: 'local-only' }))).toBe('local');
    expect(sourceLabelKey(source({ state: 'synced' }))).toBe('synced');
    expect(sourceLabelKey(source({ state: 'local-dirty' }))).toBe('dirty');
    expect(sourceLabelKey(source({ state: 'conflict' }))).toBe('conflict');
    expect(sourceLabelKey(source({ state: 'offline' }))).toBe('offline');
  });

  it('同步之后又改过就显示「有本地修改」', async () => {
    const { sourceLabelKey } = await loadModule();
    const syncedAt = '2026-11-08T10:00:00Z';
    // 保存时间晚于上次同步（差 1 秒以上）。
    expect(sourceLabelKey(source({ state: 'synced', lastSyncedAt: syncedAt }), '2026-11-08T10:05:00Z')).toBe('dirty');
    // 保存时间不晚于上次同步：仍然算已同步。
    expect(sourceLabelKey(source({ state: 'synced', lastSyncedAt: syncedAt }), '2026-11-08T09:59:00Z')).toBe('synced');
    // 没有同步时间（从未成功过）：保持原状态。
    expect(sourceLabelKey(source({ state: 'synced' }), '2026-11-08T10:05:00Z')).toBe('synced');
  });

  it('冲突与离线优先于「又改过」的判断', async () => {
    const { sourceLabelKey } = await loadModule();
    const syncedAt = '2026-11-08T10:00:00Z';
    expect(sourceLabelKey(source({ state: 'conflict', lastSyncedAt: syncedAt }), '2026-11-08T11:00:00Z')).toBe('conflict');
    expect(sourceLabelKey(source({ state: 'offline', lastSyncedAt: syncedAt }), '2026-11-08T11:00:00Z')).toBe('offline');
  });
});
