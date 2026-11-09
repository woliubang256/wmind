/**
 * 缩略图的尺寸与刷新时机。
 *
 * 这里只有纯计算，没有 DOM，也没有对导出模块的 import——两件事都必须这样：
 *
 * 1. **纯计算**是为了能测。`planThumbnail` 的边界（0 尺寸、极扁的图、1px 高）
 *    全是「肉眼看不出来、但会得到一张空白图」的坑，靠手点验不出来。
 * 2. **不 import 导出模块**是为了不把 `react-dom/server`（gzip 约 65KB）拖进
 *    编辑器首屏。真正的渲染在 `thumbnail-render.ts`，由编辑器按需动态加载。
 */

/** 缩略图的最大边长。卡片按 4:3 左右的框裁切显示，640 宽已经够 2 倍屏用。 */
export const THUMBNAIL_MAX_WIDTH = 640;
export const THUMBNAIL_MAX_HEIGHT = 400;

/**
 * 同一会话内两次生成之间的最短间隔。
 *
 * 缩略图每次生成都要上传一张 PNG，而自动保存每几秒就成功一次。没有这个
 * 间隔，一次编辑会往磁盘里灌几十张几乎一样的图，而列表页只会用到最后一张。
 * 三分钟是「用户刚改完，回到列表能看到新样子」与「别把上传当成心跳」之间的
 * 折中。
 */
export const THUMBNAIL_MIN_INTERVAL_MS = 3 * 60 * 1000;

export interface ThumbnailPlan {
  /** 相对导出画布的倍率。 */
  scale: number;
  /** 最终像素宽高。为 0 表示这张图不该生成缩略图。 */
  width: number;
  height: number;
}

/**
 * 把导出画布的尺寸压进缩略图框。
 *
 * **只缩小、不放大**：小图放大只会更糊，而卡片本来就按 `object-contain`
 * 摆放，留白由 CSS 负责，不需要靠放大去填满。
 *
 * 尺寸算不出来（NaN / 0 / 负数）时返回 0×0 而不是抛异常：调用方在「文档刚
 * 打开、布局还没算完」的瞬间真的会拿到这种值，那不是错误，是时机未到。
 */
export function planThumbnail(
  width: number,
  height: number,
  maxWidth = THUMBNAIL_MAX_WIDTH,
  maxHeight = THUMBNAIL_MAX_HEIGHT,
): ThumbnailPlan {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { scale: 1, width: 0, height: 0 };
  }
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    scale,
    // 至少 1px：一张 4000×20 的图按比例算出来的高是 3.2px，四舍五入没问题，
    // 但 4000×2 的极端长条会算出 0——canvas 拿到 0 高就是一张空图。
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface ThumbnailDecision {
  /** 这张图现在有没有缩略图（服务端 `thumbnailUrl` 非空）。 */
  hasThumbnail: boolean;
  /** 本会话上一次生成的时间戳；`null` 表示本会话还没生成过。 */
  lastGeneratedAt: number | null;
  /** 本会话内是否至少保存成功过一次。 */
  savedSinceGenerated: boolean;
  now: number;
}

/**
 * 判断这一刻要不要重新生成缩略图。
 *
 * 四种情况分开处理，因为它们的动机完全不同：
 *
 * - **没有缩略图** → 一定要生成。这是新建的图、或者在本功能上线前就存在的图，
 *   列表页上它们是一块空白占位。
 * - **本会话没保存过** → 不生成。只是打开看了一眼就退出，不该产生任何写入。
 * - **保存过但本会话还没生成** → 生成。用户改了内容，缩略图该跟着变。
 * - **保存过、也生成过，但还在间隔内** → 不生成。这就是那条限频。
 */
export function shouldRefreshThumbnail(input: ThumbnailDecision): boolean {
  if (!input.hasThumbnail) return true;
  if (!input.savedSinceGenerated) return false;
  if (input.lastGeneratedAt === null) return true;
  return input.now - input.lastGeneratedAt >= THUMBNAIL_MIN_INTERVAL_MS;
}
