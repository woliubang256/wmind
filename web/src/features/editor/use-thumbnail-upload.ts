/**
 * 缩略图上传。
 *
 * 时机判定在 `thumbnail-plan.ts`（纯函数，有单测），这里只负责「按判定结果
 * 干活」：渲染 → 上传 → 回写地址 → 刷列表缓存。
 *
 * 三条硬规则：
 *
 * 1. **串行**：一次只跑一个。渲染要过 canvas，并发两次就是两份位图同时在内存里。
 * 2. **失败静默**：缩略图是锦上添花。它挂了不该弹错、不该拦住保存、不该让
 *    `beforeunload` 卡住——用户根本不知道有这回事。
 * 3. **字体就绪后再截**：字体没到时布局还没算（见 `PENDING_LAYOUT`），这时候
 *    渲染出来是一张空图。
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WmindDocument } from '@/editor/model/types';
import { fileApi } from '@/lib/api/files';
import { mapApi } from '@/lib/api/maps';
import { mapKeys } from '@/features/maps/queries';
import { shouldRefreshThumbnail } from '@/features/maps/thumbnail-plan';

export interface UseThumbnailUploadOptions {
  uid: string;
  /** 本地演示/压测文档没有服务端记录，不传缩略图。 */
  enabled: boolean;
  document: WmindDocument;
  sheetId: string;
  /** 打开时服务端的缩略图地址，空串表示还没有。 */
  initialThumbnailUrl: string;
  /** 乐观锁版本号：它涨了就说明成功保存过。 */
  version: number;
  /** 布局是否就绪（字体已到齐）。 */
  ready: boolean;
}

export function useThumbnailUpload({
  uid,
  enabled,
  document,
  sheetId,
  initialThumbnailUrl,
  version,
  ready,
}: UseThumbnailUploadOptions) {
  const queryClient = useQueryClient();
  const hasThumbnail = useRef(initialThumbnailUrl !== '');
  const generatedAt = useRef<number | null>(null);
  const running = useRef(false);
  /** 首次渲染时的版本号。之后只要版本号涨了，就说明这张图被改过。 */
  const openedAtVersion = useRef<number | null>(null);
  if (openedAtVersion.current === null) openedAtVersion.current = version;

  const savedSinceGenerated = openedAtVersion.current !== null && version > openedAtVersion.current;

  useEffect(() => {
    if (!enabled || !ready || running.current) return;

    const should = shouldRefreshThumbnail({
      hasThumbnail: hasThumbnail.current,
      lastGeneratedAt: generatedAt.current,
      savedSinceGenerated,
      now: Date.now(),
    });
    if (!should) return;

    running.current = true;
    let cancelled = false;

    void (async () => {
      try {
        // 动态 import：`thumbnail-render` 把 `react-dom/server` 带进依赖图，
        // 静态引会让编辑器首屏多下载六十多 KB，而大多数会话根本不生成缩略图
        // （有图且没改动）。
        const { renderThumbnailPng } = await import('@/features/maps/thumbnail-render');
        const blob = await renderThumbnailPng(document, sheetId);
        if (blob === null || cancelled) return;

        const uploaded = await fileApi.upload({
          bytes: new Uint8Array(await blob.arrayBuffer()),
          fileName: 'thumbnail.png',
          mime: 'image/png',
        });
        if (cancelled) return;

        await mapApi.setThumbnail(uid, uploaded.url);
        generatedAt.current = Date.now();
        hasThumbnail.current = true;
        void queryClient.invalidateQueries({ queryKey: mapKeys.lists() });
      } catch {
        // 静默失败：缩略图失败不该让用户看到任何东西。下次保存成功时还会再试。
      } finally {
        running.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, ready, savedSinceGenerated, version, document, sheetId, uid, queryClient]);
}
