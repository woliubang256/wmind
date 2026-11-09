import { useEffect, useRef, useState, type ImgHTMLAttributes, type CSSProperties, type SVGProps } from 'react';
import { cn } from '@/lib/utils';
import { LoadingMark } from './loading-mark';

type ImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  containerClassName?: string;
  containerStyle?: CSSProperties;
  /**
   * 加载失败时的提示文字（调用方传 i18n 文案）。
   *
   * 失败时必须**藏起 <img>**：留着它浏览器会画一个破图图标（那个「?」），
   * 既难看也不说明问题。这里换成品牌标识 + 可选提示。
   */
  errorText?: string;
};

/** 按地址重建状态，旧图片的 load/error 不会覆盖新图片；不额外预取，保留 lazy。 */
export function LoadingImage(props: ImageProps) {
  return <ImageSource key={props.src} {...props} />;
}

function ImageSource({ containerClassName, containerStyle, className, errorText, onLoad, onError, ...props }: ImageProps) {
  const ref = useRef<HTMLImageElement>(null);
  const [pending, setPending] = useState(Boolean(props.src || props.srcSet));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // 缓存命中可能早于 effect；complete 也包含失败，二者都必须结束等待。
    if (ref.current?.complete) setPending(false);
  }, []);
  return <span className={cn('relative inline-grid max-w-full align-middle', containerClassName)} style={containerStyle} aria-busy={pending || undefined}>
    <img
      {...props}
      ref={ref}
      className={cn(className, (pending || failed) && 'opacity-0')}
      onLoad={(event) => { setPending(false); setFailed(false); onLoad?.(event); }}
      onError={(event) => { setPending(false); setFailed(true); onError?.(event); }}
    />
    {pending ? <span aria-hidden="true" className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden"><LoadingMark size="small" tone="soft" style={{ maxWidth: '60%', maxHeight: '60%' }} /></span> : null}
    {failed && !pending ? (
      <span
        role="img"
        aria-label={errorText || props.alt || ''}
        className="pointer-events-none absolute inset-0 grid place-items-center gap-1 overflow-hidden p-2 text-center"
      >
        <LoadingMark size="small" tone="soft" style={{ maxWidth: '40%', maxHeight: '40%' }} />
        {errorText ? <span className="text-[11px] leading-4 text-muted-foreground">{errorText}</span> : null}
      </span>
    ) : null}
  </span>;
}

type SvgImageProps = SVGProps<SVGImageElement> & { x: number; y: number; width: number; height: number; loading?: boolean };

/** 静态导出不启用 loading，保持原始 image，绝不把等待图形印进成品。 */
export function LoadingSvgImage({ loading = false, ...props }: SvgImageProps) {
  return loading ? <SvgImageSource key={props.href} {...props} /> : <image {...props} />;
}

function SvgImageSource({ onLoad, onError, ...props }: Omit<SvgImageProps, 'loading'>) {
  const [pending, setPending] = useState(Boolean(props.href));
  const markWidth = Math.max(0, Math.min(40, props.width * 0.6, props.height * 0.6 * 888 / 606));
  const markHeight = markWidth * 606 / 888;
  return <g>
    <image {...props} opacity={pending ? 0 : props.opacity} onLoad={(event) => { setPending(false); onLoad?.(event); }} onError={(event) => { setPending(false); onError?.(event); }} />
    {pending ? <LoadingMark tone="soft" x={props.x + (props.width - markWidth) / 2} y={props.y + (props.height - markHeight) / 2} width={markWidth} height={markHeight} style={{ width: markWidth, height: markHeight }} pointerEvents="none" /> : null}
  </g>;
}
