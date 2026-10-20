/**
 * 触发下载。
 *
 * 走 `Blob` + `URL.createObjectURL` + 临时 `<a download>`：
 *
 * - 不用 `data:` URL 直接给 `href`：Chrome 对超长的 `data:` 导航有限制，
 *   一张大导图的 SVG 很容易超过它，表现为「点了没反应」；
 * - 必须 `revokeObjectURL`：不撤销的话 blob 会一直留在内存里，连续导出几张
 *   大图就能看到内存曲线一路向上。
 */

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  // 必须挂进文档：Firefox 对游离节点上的 click() 不触发下载。
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立刻撤销会让部分浏览器来不及开始下载，推迟一个宏任务。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadSvg(markup: string, fileName: string): void {
  downloadBlob(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), fileName);
}
