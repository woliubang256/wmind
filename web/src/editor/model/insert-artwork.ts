/** 内置矢量素材，自包含，可随 SVG/PNG 导出。 */
const shapes: Record<string, string> = {
  star: '<path d="m32 5 8 17 19 3-14 14 3 19-16-9-17 9 3-19L4 25l20-3Z"/>',
  heart: '<path d="M32 55 8 32C-7 9 21-2 32 15 43-2 71 9 56 32Z"/>',
  check: '<circle cx="32" cy="32" r="27"/><path d="m17 32 10 10 21-23" fill="none" stroke="white" stroke-width="6"/>',
  flag: '<path d="M16 58V7m2 2c15-9 19 11 36 2v27c-17 9-21-11-36-2" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/>',
  bolt: '<path d="M36 3 10 36h19l-3 25L55 25H36Z"/>',
  bulb: '<path d="M22 45C2 28 15 4 32 5c20 0 30 24 10 40l-2 9H24Z"/><path d="M24 59h16M23 46h18" stroke="white" stroke-width="4"/>',
  target: '<circle cx="32" cy="32" r="28"/><circle cx="32" cy="32" r="18" fill="white"/><circle cx="32" cy="32" r="9"/>',
  rocket: '<path d="m18 39 5-21C31 7 43 3 58 5c1 16-3 29-14 37l-21 4Z"/><circle cx="42" cy="20" r="7" fill="white"/><path d="m18 42-8 13 15-7m-9-12L5 33l14-11m12 23 1 14 13-14"/>',
  trophy: '<path d="M18 7h28v20c0 21-28 21-28 0Zm10 34h8v13h12v6H16v-6h12Z"/><path d="M17 13H5v10q0 15 15 15m27-25h12v10q0 15-15 15" fill="none" stroke="currentColor" stroke-width="5"/>',
  flower: '<circle cx="32" cy="18" r="13"/><circle cx="46" cy="30" r="13"/><circle cx="40" cy="46" r="13"/><circle cx="22" cy="46" r="13"/><circle cx="17" cy="29" r="13"/><circle cx="32" cy="32" r="10" fill="#FFE28A"/>',
  smile: '<circle cx="32" cy="32" r="28"/><path d="M18 36q14 22 28 0" fill="none" stroke="white" stroke-width="4"/><circle cx="22" cy="24" r="3" fill="white"/><circle cx="42" cy="24" r="3" fill="white"/>',
  bookmark: '<path d="M15 5h34v55L32 48 15 60Z"/>',
};
export const STICKERS = Object.keys(shapes);
export const ILLUSTRATIONS = ['idea', 'launch', 'growth', 'achievement', 'focus', 'collaboration'];
const colors = ['#F6B840', '#EA6F85', '#54AD86', '#6D8BD4', '#E99448', '#C594D1'];

export function artwork(kind: 'sticker' | 'illustration', id: string): { src: string; width: number; height: number } | null {
  const index = (kind === 'sticker' ? STICKERS : ILLUSTRATIONS).indexOf(id);
  if (index < 0) return null;
  const color = colors[index % colors.length];
  const shape = kind === 'sticker' ? shapes[id] : shapes[['bulb', 'rocket', 'bolt', 'trophy', 'target', 'flower'][index]];
  const body = kind === 'sticker' ? shape : `<rect x="0" y="0" width="160" height="100" rx="18" fill="#F2F5F8"/><circle cx="119" cy="25" r="12" fill="${color}" opacity=".22"/><path d="M12 87h137" stroke="#CFD8E3" stroke-width="2"/><path d="M18 80V64h15V48h15V32h15" fill="none" stroke="${color}" stroke-width="5" opacity=".45"/><g transform="translate(70 14) scale(.95)">${shape}</g>`;
  const width = kind === 'sticker' ? 56 : 160, height = kind === 'sticker' ? 56 : 100;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${kind === 'sticker' ? '64 64' : '160 100'}" fill="${color}" color="${color}">${body}</svg>`;
  return { src: `data:image/svg+xml,${encodeURIComponent(svg)}`, width, height };
}
