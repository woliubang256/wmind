/**
 * 导入的收尾：把解析阶段攒下的图片传到服务端，再把文档里的占位符换成真实 URL。
 *
 * 为什么要拆成两段而不是在适配器里直接上传：解析是**同步**的（`registry.run`
 * 一行到底，测试可以纯粹断言产出），上传是异步的。把 `await` 塞进解析会让
 * 每个适配器都变成 async，而它们里面全是纯字符串处理，为了几张图片付这个
 * 代价不划算，也会让「50MB 文件不卡死」的推理变复杂。
 *
 * 三条硬性约束：
 *
 * 1. **文档在这之前不能落库**。占位符是 `xap:resources/a.png`，存进去就是
 *    一张永远加载不出来的破图，而且界面上没有任何报错。
 * 2. **一张失败不能拖垮整份导入**。图片是附属信息，正文（节点、备注、联系）
 *    已经解析好了；丢一张图就少一张图，不要因此让用户重来一遍。
 * 3. **撞限流就停手**。继续传只会继续拿 429，把对话框卡在「正在上传」上；
 *    停下来、把剩下的都记成「未能还原」是唯一诚实的处理。
 */

import type { Topic, WmindDocument } from '../model/types';
import type { ImportAsset, ImportResult, ImportSummary, ImportWarning } from './types';

/** 上传一张图片，返回可公开访问的 URL。测试注入假实现。 */
export type AssetUploader = (asset: ImportAsset) => Promise<{ url: string }>;

export interface FinalizeOptions {
  upload: AssetUploader;
  /** 每处理完一张（成功或失败）回调一次，用来更新进度文案。 */
  onProgress?: (done: number, total: number) => void;
}

export interface FinalizeOutcome {
  /**
   * 收尾后的结果：`document` 里的图片已换成真实 URL（或已被摘掉），
   * `warnings` / `summary` 已按实际结果修订，`assets` 清空。
   */
  result: ImportResult;
  uploaded: number;
  /** 上传失败被摘掉的图片数，已计入 `image-skipped`。 */
  skipped: number;
}

/** 限流与「服务端不认」都不必重试；前者更要立刻停手。 */
function isRateLimited(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'RATE_LIMITED';
}

/**
 * 遍历所有节点（含自由主题与 `detached` 子树）。
 *
 * 不用 `model/traverse.ts` 的 `walkSheet`，两个原因：它不下钻 `children.detached`
 * （那里的图片会留着死链），而且它是递归的——节点上限允许 2 万个，退化成一条
 * 链时递归深度就等于节点数。这里用显式栈，两件事一起解决。
 */
function eachTopic(document: WmindDocument, visit: (topic: Topic) => void): void {
  const stack: Topic[] = [];
  for (const sheet of document.sheets) {
    stack.push(sheet.rootTopic);
    for (const floating of sheet.floatingTopics) stack.push(floating);
  }
  while (stack.length > 0) {
    const topic = stack.pop();
    if (topic === undefined) continue;
    visit(topic);
    // 逐个 push 而不是展开：`stack.push(...arr)` 在数组很长时会撞参数个数上限。
    for (const child of topic.children.attached) stack.push(child);
    for (const child of topic.children.detached) stack.push(child);
  }
}

/**
 * 把新的「未能还原」张数并进已有警告。
 *
 * 不能直接再 push 一条 `image-skipped`：解析阶段可能已经有一条（扩展名不支持、
 * 条目不在包里），界面上就会同一条提示出现两次。`ctx.warn` 是按 code+参数
 * 去重的，这里必须自己合并计数。
 */
function mergeImageSkipped(warnings: readonly ImportWarning[], extra: number): ImportWarning[] {
  const out = warnings.slice();
  if (extra <= 0) return out;
  const index = out.findIndex((warning) => warning.code === 'image-skipped');
  if (index < 0) {
    out.push({ code: 'image-skipped', params: { count: extra } });
    return out;
  }
  const current = Number(out[index]?.params?.count ?? 0);
  out[index] = { code: 'image-skipped', params: { count: (Number.isFinite(current) ? current : 0) + extra } };
  return out;
}

export async function finalizeImport(result: ImportResult, options: FinalizeOptions): Promise<FinalizeOutcome> {
  const { document } = result;

  if (result.assets.length === 0) {
    return { result, uploaded: 0, skipped: 0 };
  }

  const urls = new Map<string, string>();
  const total = result.assets.length;
  let uploaded = 0;
  let skipped = 0;
  let stopped = false;

  // 串行而不是 `Promise.all`：限流是按次数算的，并发只会让一批请求同时撞上
  // 429，然后一起失败；串行至少能把额度用满。顺带内存也更平——同时只持有
  // 一份正在上传的字节。
  for (const asset of result.assets) {
    if (stopped) {
      skipped += 1;
      options.onProgress?.(uploaded + skipped, total);
      continue;
    }
    try {
      const stored = await options.upload(asset);
      urls.set(asset.ref, stored.url);
      uploaded += 1;
    } catch (error) {
      skipped += 1;
      if (isRateLimited(error)) stopped = true;
    }
    options.onProgress?.(uploaded + skipped, total);
  }

  // 占位符集合：只有这些 `src` 才是「等着被换掉的」。外链（`https://...`）与
  // 已经是服务端 URL 的都不在里面，不能因为查不到映射就把它们摘掉。
  const placeholders = new Set(result.assets.map((asset) => asset.ref));
  let hasImage = false;

  eachTopic(document, (topic) => {
    const image = topic.image;
    if (image === null) return;
    if (!placeholders.has(image.src)) {
      // 外链图片：本来就不用上传，照旧算「已还原」。
      hasImage = true;
      return;
    }
    const url = urls.get(image.src);
    if (url === undefined) {
      // 上传失败：摘掉整张图，而不是留一个指向包内条目的死链。
      topic.image = null;
      return;
    }
    image.src = url;
    hasImage = true;
  });

  // 摘要要跟着改：所有图片都没上传成功时还打勾「已还原 图片」就是在撒谎。
  const summary: ImportSummary = hasImage
    ? result.summary
    : { ...result.summary, restored: result.summary.restored.filter((feature) => feature !== 'image') };

  return {
    result: {
      ...result,
      // 原地改的是 `document`（解析器刚产出、只属于这一次导入），但结果对象
      // 换新的：调用方可能还持有旧引用做对比，就地改会让人看不出发生了什么。
      document,
      warnings: mergeImageSkipped(result.warnings, skipped),
      summary,
      // 字节已经传完，留着只是继续占内存（可能上百 MB）。
      assets: [],
    },
    uploaded,
    skipped,
  };
}
