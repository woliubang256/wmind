/**
 * 首屏字体等待。
 *
 * 布局引擎用 Canvas 测量文本，缓存键里**没有**「字体是否已加载」这一维（见
 * `layout/measure.ts`）——用回退字体量出来的宽度会被永久缓存，之后即使 webfont
 * 到达也不会重算。所以「先量后等字体」不是「画面跳一下」这么轻的问题，而是
 * **宽度永久错误**。唯一正确的做法是等字体就绪再进布局（ADR-016 第 6 条）。
 *
 * 等待有上限（`FONT_LOAD_TIMEOUT_MS`）：弱网下宁可先用回退字体渲染，也不能让
 * 编辑器永远停在骨架屏上。超时后 `timedOut` 为 true，调用方可以提示一句。
 */

import { useEffect, useMemo, useState } from 'react';
import type { FontFamily, WmindDocument } from '@/editor/model/types';
import { walkSheet } from '@/editor/model/traverse';
import { clearMeasureCache } from '@/editor/layout/measure';
import { FONT_DEFINITIONS } from '@/editor/theme/fonts';
import { collectDocumentText, ensureFonts } from '@/editor/theme/font-load';

export interface FontsReadyState {
  /** 可以开始布局了。超时也会置为 true——那是「带降级地就绪」。 */
  ready: boolean;
  /** 等待超时，当前用的是回退字体。 */
  timedOut: boolean;
  /**
   * 第几轮「字体就绪」。首轮从 0 涨到 1；之后文档换了字体族还会再涨。
   *
   * 调用方要把它放进布局的依赖里：换族之后分片才到齐，而布局可能已经用回退
   * 字体量过一轮了（测量缓存键里没有「字体到没到」这一维），必须重算一次。
   */
  generation: number;
}

interface DocumentFonts {
  /** 这份文档会渲染到的所有字体族。 */
  families: FontFamily[];
  /** 文档里所有节点的标题拼成的字符串，决定拉哪几个分片。 */
  text: string;
}

/**
 * 扫一遍文档，收集「会用到哪些字体族」与「要渲染哪些字」。
 *
 * 为什么要看每个节点的 `style.fontFamily`：`@font-face` 是**按族按需注入**的
 * （每族一份 CSS，见 `font-load.ts`）。某个节点单独设成宋体、而宋体的样式表
 * 从没注入过，那个节点就会静默退到系统宋体——用户以为「换字体没生效」。
 * 所以这里必须把节点级覆盖也算进来。
 *
 * 一次遍历同时取字体与文本：两者都只依赖文档内容，分开走两遍纯属浪费。
 * 成本与 `layoutMindmap` 同阶（一次全树 DFS），后者每次输入都要跑，所以这里
 * 的遍历不构成瓶颈。
 *
 * 导出是为了单测：它是纯函数，而「节点级字体覆盖有没有被算进来」正是这套按需
 * 注入最容易回归的地方。
 */
export function scanDocument(doc: WmindDocument): DocumentFonts {
  const families = new Set<FontFamily>([doc.theme.global.fontFamily]);
  for (const role of [doc.theme.centralTopic, doc.theme.mainTopic, doc.theme.subTopic]) {
    if (role?.fontFamily) families.add(role.fontFamily);
  }

  const titles: string[] = [];
  for (const sheet of doc.sheets) {
    walkSheet(sheet, (topic) => {
      if (topic.style?.fontFamily) families.add(topic.style.fontFamily);
      if (topic.title !== '') titles.push(topic.title);
      titles.push(...topic.labels);
      if (topic.content?.task?.assignee) titles.push(topic.content.task.assignee);
      for (const file of topic.content?.attachments ?? []) titles.push(file.name);
      if (topic.content?.localLink) titles.push(topic.content.localLink.name);
    });
  }

  return { families: [...families], text: collectDocumentText(titles) };
}

export function useFontsReady(doc: WmindDocument): FontsReadyState {
  const [state, setState] = useState<FontsReadyState>({ ready: false, timedOut: false, generation: 0 });

  const scan = useMemo(() => scanDocument(doc), [doc]);
  // 只按「用到哪些族」重跑：逐字输入不会改字体，effect 不该跟着重跑。
  const signature = scan.families.join(',');

  useEffect(() => {
    let cancelled = false;

    Promise.all(
      scan.families.map((family) =>
        ensureFonts(family, FONT_DEFINITIONS[family].weights, scan.text),
      ),
    ).then((results) => {
      if (cancelled) return;
      const timedOut = results.some((result) => result.timedOut);
      if (timedOut) {
        console.warn('字体分片加载超时，先用回退字体渲染；节点宽度可能与最终字体不一致。');
      }
      // 换族后这里会再跑一次：把用回退字体量出来的宽度作废，交给布局重算。
      clearMeasureCache();
      setState((previous) => ({ ready: true, timedOut, generation: previous.generation + 1 }));
    });

    return () => {
      cancelled = true;
    };
    // scan 由 signature 唯一决定（families 相同则只关心首次就绪），依赖签名即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return state;
}
