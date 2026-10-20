/**
 * PNG / JPEG 栅格化。
 *
 * 路线是「SVG 字符串 → `Blob` → `URL.createObjectURL` → `<img>` → canvas」，
 * 而不是 `canvas.drawImage(svgElement)`：后者在部分浏览器上会得到空白画布，
 * 因为 `drawImage` 不接受一个没被渲染过的 SVG DOM。
 *
 * 这个文件里能纯函数化的部分（尺寸闸门、格式参数）都单独抽了出来，因为
 * 「多大算太大」「JPEG 该填什么底色」这类判断最容易写错，而它们完全不需要
 * 浏览器就能验。真正碰 DOM 的只有 `rasterizeSvg`，它接受注入的依赖。
 */

export type RasterFormat = 'png' | 'jpeg';

/**
 * Canvas 的尺寸闸门。
 *
 * 三个数来自各浏览器的实际限制，不是拍脑袋：
 *
 * - **16384**：Chrome / Firefox 的单边硬上限。超过就是 `drawImage` 静默失败
 *   或者直接抛异常，用户拿到一张空白图。
 * - **8192**：Safari（尤其 iOS）的实际可用上限远低于 16384，而超出时不会报错，
 *   只会把图裁掉一块或者整张空白。所以 8192 以上先警告。
 * - **268M**：16384 × 16384 的总像素，内存占用按 4 字节/像素算正好 1GB。
 *   再多就会在低配机器上直接崩标签页。
 */
export const RASTER_LIMITS = {
  /** 单边超过它就允许导出但先警告。 */
  warnSide: 8192,
  /** 单边超过它就不允许在前端栅格化。 */
  maxSide: 16384,
  /** 总像素上限。 */
  maxPixels: 268_000_000,
} as const;

export type RasterVerdict =
  | { kind: 'ok' }
  | { kind: 'warn' }
  | { kind: 'too-large'; side: number; limit: number };

/**
 * 判断目标像素尺寸能不能在前端栅格化。
 *
 * 「太大」与「有点大」必须分开：前者要禁用按钮并指路（降低倍率 / 服务端导出），
 * 后者只是提示卡顿但允许继续。合成一个布尔值的话，用户要么在 9000px 时被拦住，
 * 要么在 20000px 时拿到一张空白图。
 */
export function checkRasterSize(
  width: number,
  height: number,
  limits: typeof RASTER_LIMITS = RASTER_LIMITS,
): RasterVerdict {
  const side = Math.max(width, height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    // 尺寸算不出来时按「太大」处理：宁可拦住，也不要拿一张 0×0 的图去撞 canvas。
    return { kind: 'too-large', side: 0, limit: limits.maxSide };
  }
  if (side > limits.maxSide || width * height > limits.maxPixels) {
    return { kind: 'too-large', side, limit: limits.maxSide };
  }
  if (side > limits.warnSide) return { kind: 'warn' };
  return { kind: 'ok' };
}

export interface RasterPlan {
  mime: string;
  /** `toBlob` 的质量参数；PNG 忽略。 */
  quality: number;
  /**
   * 画布底色。`null` 表示保留透明通道。
   *
   * JPEG 必须给白色：它没有 alpha 通道，透明像素会被编码成黑色，而用户看到的
   * 预览是白底——那是最典型的一种「预览与成品不一致」。
   */
  fill: string | null;
}

/** 格式参数。纯函数，便于断言「JPEG 一定不透明」。 */
export function rasterPlan(format: RasterFormat, background: string | null): RasterPlan {
  if (format === 'jpeg') {
    return { mime: 'image/jpeg', quality: 0.92, fill: background ?? '#FFFFFF' };
  }
  return { mime: 'image/png', quality: 1, fill: background };
}

export interface RasterTarget {
  width: number;
  height: number;
  format: RasterFormat;
  /** 上下文里的背景色；`null` 表示透明。 */
  background: string | null;
}

/** 便于测试注入；浏览器里用默认实现。 */
export interface RasterDeps {
  loadImage(url: string): Promise<{ width: number; height: number }>;
  createCanvas(width: number, height: number): {
    getContext(id: '2d'): {
      fillStyle: string;
      fillRect(x: number, y: number, w: number, h: number): void;
      drawImage(image: unknown, x: number, y: number, w: number, h: number): void;
    } | null;
  };
  toBlob(canvas: unknown, mime: string, quality: number): Promise<Blob | null>;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
}

function defaultDeps(): RasterDeps {
  return {
    loadImage(url) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('图片解码失败'));
        image.src = url;
      });
    },
    createCanvas(width, height) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas as unknown as ReturnType<RasterDeps['createCanvas']>;
    },
    toBlob(canvas, mime, quality) {
      return new Promise((resolve) => {
        (canvas as HTMLCanvasElement).toBlob((blob) => resolve(blob), mime, quality);
      });
    },
    createObjectUrl(blob) {
      return URL.createObjectURL(blob);
    },
    revokeObjectUrl(url) {
      URL.revokeObjectURL(url);
    },
  };
}

/**
 * 把导出的 SVG 栅格化成位图。
 *
 * 尺寸直接取自 `target`，不用 `<img>` 的自然尺寸：SVG 里的 `width` / `height`
 * 已经是「逻辑尺寸 × 倍率」，但浏览器可能对超大 SVG 做降采样，而用户要的是
 * 精确的像素数。
 */
export async function rasterizeSvg(
  markup: string,
  target: RasterTarget,
  deps: RasterDeps = defaultDeps(),
): Promise<Blob> {
  const plan = rasterPlan(target.format, target.background);
  const svgBlob = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
  const url = deps.createObjectUrl(svgBlob);

  try {
    const image = await deps.loadImage(url);
    const canvas = deps.createCanvas(target.width, target.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('无法创建 2D 画布');

    // 先铺底色再画图。PNG 透明时不铺，保留 alpha；JPEG 一定铺白。
    if (plan.fill !== null) {
      context.fillStyle = plan.fill;
      context.fillRect(0, 0, target.width, target.height);
    }
    context.drawImage(image, 0, 0, target.width, target.height);

    const blob = await deps.toBlob(canvas, plan.mime, plan.quality);
    if (blob === null) throw new Error('位图编码失败');
    return blob;
  } finally {
    // 不撤销的话 blob 会一直留在内存里；导出几张超大图就能看到内存曲线一路向上。
    deps.revokeObjectUrl(url);
  }
}
