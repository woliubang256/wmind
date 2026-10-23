import type { TopicDetails } from '../layout/topic-details';
import type { NodeBox } from '../layout/types';

export function TopicDetailsView({ details, box, y, color }: { details: TopicDetails; box: NodeBox; y: number; color: string }) {
  let mediaY = y + 8 + details.lines.length * 20;
  return <g className="topic-details" fill={color}>
    {details.lines.map((line, index) => {
      const text = <text data-topic-content-kind={line.kind} data-content-id={line.id} x={box.x + box.width / 2} y={y + 22 + index * 20}
        textAnchor="middle" fontSize={12} fontFamily="sans-serif" className="cursor-pointer" textDecoration={line.kind === 'link' ? 'underline' : undefined}>
        <title>{line.title}</title>{line.text}
      </text>;
      return line.href ? <a key={index} href={line.href} download={line.download} target={line.download ? undefined : '_blank'} rel="noopener noreferrer">{text}</a> : <g key={index}>{text}</g>;
    })}
    {details.media.map((item) => {
      const top = mediaY; mediaY += item.height + 8;
      return <image key={item.kind} data-topic-content-kind={item.kind} href={item.src} x={box.x + (box.width - item.width) / 2}
        y={top} width={item.width} height={item.height} preserveAspectRatio="xMidYMid meet" className="cursor-pointer" />;
    })}
  </g>;
}
