import { Icon } from '@/components/ui/icon';
import { fontStack } from '../theme/fonts';
import type { TopicDetails } from '../layout/topic-details';
import type { topicContentGeometry } from '../layout/topic-content';
import type { NodeBox, Rect } from '../layout/types';

export type TopicContentLabels = Record<'todo' | 'note' | 'link' | 'more', string>;

export function TopicDetailsView({ details, box, geometry, color, interactive, readOnly, labels }: {
  details: TopicDetails; box: NodeBox; geometry: ReturnType<typeof topicContentGeometry>; color: string; interactive: boolean; readOnly: boolean; labels?: TopicContentLabels;
}) {
  const y = geometry.detailsY;
  let mediaY = y + 8 + details.lines.length * 20;
  const control = (kind: string, rect: Rect, title: string, content: React.ReactNode) => <g data-topic-content-kind={kind}
    role={interactive && !(readOnly && kind === 'todo') ? kind === 'todo' ? 'checkbox' : 'button' : undefined} tabIndex={interactive && !(readOnly && kind === 'todo') ? 0 : undefined}
    aria-checked={interactive && !readOnly && kind === 'todo' ? details.todo : undefined} aria-label={interactive ? labels?.[kind as keyof TopicContentLabels] ?? title : undefined}
    style={interactive ? { cursor: 'pointer' } : undefined} transform={`translate(${rect.x} ${rect.y})`}>
    <title>{title}</title><rect x={-3} y={-3} width={22} height={22} fill="transparent" />{content}
  </g>;
  const entry = details.entry && geometry.entryRect ? control(details.entry.kind, geometry.entryRect, details.entry.kind === 'more' ? labels?.more ?? '…' : details.entry.title,
    details.entry.kind === 'more' ? <g fill={color}>{[3, 8, 13].map((x) => <circle key={x} cx={x} cy={8} r={1.4} />)}</g>
      : <Icon name={details.entry.kind === 'note' ? 'note' : 'link'} width={16} height={16} style={{ color }} pointerEvents="none" />) : null;
  return <g className="topic-details" fill={color}>
    {geometry.todoRect ? control('todo', geometry.todoRect, details.todo ? '☑' : '☐', <g fill="none" stroke={color} strokeWidth={1.5} pointerEvents="none">
      <rect x={1} y={1} width={14} height={14} rx={3} />{details.todo ? <path d="m4 8 3 3 5-6" strokeLinecap="round" strokeLinejoin="round" /> : null}
    </g>) : null}
    {!interactive && details.entry?.href ? <a href={details.entry.href} download={details.entry.download} target={details.entry.download ? undefined : '_blank'} rel="noopener noreferrer">{entry}</a> : entry}
    {details.badges.map((badge, index) => <g key={index} data-topic-content-kind="label" data-topic-label-badge="" transform={`translate(${box.x + badge.x} ${box.y + box.height + badge.y})`} style={interactive ? { cursor: 'pointer' } : undefined}>
      <title>{badge.title}</title><rect width={badge.width} height={badge.height} rx={4} fill={color} fillOpacity={0.07} />
      <rect width={badge.width} height={badge.height} rx={4} fill="none" stroke={color} strokeOpacity={0.12} strokeWidth={0.7} />
      <text fontSize={11} fontFamily={fontStack('sans')} pointerEvents="none">{badge.lines.map((line, i) => <tspan key={i} x={6} y={13 + i * 14}>{line}</tspan>)}</text>
    </g>)}
    {details.lines.map((line, index) => {
      const text = <text data-topic-content-kind={line.kind} data-content-id={line.id} x={box.x + box.width / 2} y={y + 22 + index * 20}
        textAnchor="middle" fontSize={12} fontFamily={fontStack('sans')} style={interactive ? { cursor: 'pointer' } : undefined}>
        <title>{line.title}</title>{line.text}
      </text>;
      return line.href ? <a key={index} href={line.href} download={line.download} target={line.download ? undefined : '_blank'} rel="noopener noreferrer">{text}</a> : <g key={index}>{text}</g>;
    })}
    {details.media.map((item) => {
      const top = mediaY; mediaY += item.height + 8;
      return <image key={item.kind} data-topic-content-kind={item.kind} href={item.src} x={box.x + (box.width - item.width) / 2}
        y={top} width={item.width} height={item.height} preserveAspectRatio="xMidYMid meet" style={interactive ? { cursor: 'pointer' } : undefined} />;
    })}
  </g>;
}
