import { useId, type SVGProps } from 'react';
import { cn } from '@/lib/utils';

// 按 public/wmind-logo.jpg 的四段折带轮廓描绘，去掉橙色背景，保留折面。
const RIBBONS = [
  'M197 383C190 381 186 387 189 399C215 505 268 662 313 762C322 784 328 797 336 806C371 782 414 703 468 615C448 568 425 491 392 453C369 425 318 411 197 383Z',
  'M1050 323C1058 319 1063 326 1060 343C1061 412 1039 492 1014 586C992 677 967 775 942 819C892 801 841 719 800 649L847 466C858 418 866 412 895 391C944 358 1007 338 1050 323Z',
  'M719 503C738 526 769 593 800 649C839 723 893 804 942 819C909 862 850 904 818 909C766 928 723 882 700 848L613 689L649 628C684 569 700 530 719 503Z',
  'M336 806C373 783 438 659 512 548C546 491 574 465 620 462C661 458 697 475 719 503C694 533 680 572 649 628L513 866C503 883 489 892 474 889C407 883 360 854 336 806Z',
] as const;

/** 装饰性加载标志；加载状态的可访问文字由调用方提供。 */
export function LoadingMark({ size = 'default', tone = 'default', className, ...props }: SVGProps<SVGSVGElement> & {
  size?: 'default' | 'small' | 'inline';
  tone?: 'default' | 'soft';
}) {
  const id = useId();
  const clip = `${id}-clip`;
  const left = `${id}-left`;
  const right = `${id}-right`;
  const front = `${id}-front`;
  const shine = `${id}-shine`;

  return (
    <svg {...props} className={cn('wmind-loading-mark', size !== 'default' && `wmind-loading-mark--${size}`, tone === 'soft' && 'wmind-loading-mark--soft', className)} width="72" height="50" viewBox="180 314 888 606" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={clip}>
          {RIBBONS.map((d) => <path key={d} d={d} />)}
        </clipPath>
        <linearGradient id={left} x1="240" y1="400" x2="440" y2="720" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--loading-mark-edge)" />
          <stop offset="1" stopColor="var(--loading-mark-fold)" />
        </linearGradient>
        <linearGradient id={right} x1="1000" y1="360" x2="850" y2="810" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--loading-mark-edge)" />
          <stop offset="1" stopColor="var(--loading-mark-fold)" />
        </linearGradient>
        <linearGradient id={front} x1="650" y1="500" x2="790" y2="870" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--loading-mark-fold)" />
          <stop offset="0.7" stopColor="var(--loading-mark-face)" />
        </linearGradient>
        <linearGradient id={shine}>
          <stop stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.85" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={RIBBONS[0]} fill={`url(#${left})`} />
      <path d={RIBBONS[1]} fill={`url(#${right})`} />
      <path d={RIBBONS[2]} fill={`url(#${front})`} />
      <path d={RIBBONS[3]} fill="var(--loading-mark-face)" />
      <g clipPath={`url(#${clip})`}>
        <g className="wmind-loading-mark__shine">
          <rect x="-110" width="240" height="1254" transform="skewX(-16)" fill={`url(#${shine})`} />
        </g>
      </g>
    </svg>
  );
}
