import type { SVGProps } from 'react';

const COLORS: Record<string, string> = { red: '#E74646', orange: '#F29932', yellow: '#E6B72D', green: '#39A46A', blue: '#3984D7', purple: '#9062CC', gray: '#8A93A3' };

/** 显式 SVG 图形保证面板、画布及离线导出的图标一致，不依赖系统 emoji。 */
export function MarkerIcon({ markerId, backdrop = false, ...props }: SVGProps<SVGSVGElement> & { markerId: string; backdrop?: boolean }) {
  const [group, value] = markerId.split('-');
  const color = COLORS[value] ?? '#3984D7';
  const circle = <circle cx="10" cy="10" r="9" fill={color} />;
  const letter = (text: string, fill = '#FFFFFF') => <text x="10" y="10.5" textAnchor="middle" dominantBaseline="central" fill={fill} fontFamily="Arial, sans-serif" fontSize="13" fontWeight="700">{text}</text>;
  let glyph;
  if (group === 'priority') glyph = <><rect x="1" y="1" width="18" height="18" rx="5" fill={Number(value) <= 3 ? '#E74646' : Number(value) <= 6 ? '#E99A2E' : '#3984D7'} />{letter(value)}</>;
  else if (group === 'flag') glyph = <><path d="M 4 18 V 2" stroke={color} strokeWidth="2" strokeLinecap="round" /><path d="M 5 2 H 17 L 14 6 L 17 10 H 5 Z" fill={color} /></>;
  else if (group === 'star') glyph = <polygon points="10,1 12.8,6.8 19,7.7 14.5,12.1 15.6,18.4 10,15.4 4.4,18.4 5.5,12.1 1,7.7 7.2,6.8" fill={color} />;
  else if (group === 'task') {
    const fraction = value === 'quarter' ? 0.25 : value === 'half' ? 0.5 : value === 'three' ? 0.75 : 0;
    glyph = <><circle cx="10" cy="10" r="8" fill="#FFFFFF" stroke="#39A46A" strokeWidth="1.7" />
      {fraction > 0 ? <circle cx="10" cy="10" r="4" fill="none" stroke="#39A46A" strokeWidth="8" strokeDasharray={`${fraction * Math.PI * 8} ${Math.PI * 8}`} transform="rotate(-90 10 10)" /> : null}
      {value === 'done' ? <><circle cx="10" cy="10" r="8" fill="#39A46A" /><path d="m 5.5 10 3 3 6-6" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></> : null}
      {value === 'pause' ? <path d="M 7.5 6 V 14 M 12.5 6 V 14" stroke="#E99A2E" strokeWidth="2.5" /> : null}
      {value === 'cancel' ? <path d="m 6 6 8 8 M 14 6 6 14" stroke="#E74646" strokeWidth="2" /> : null}</>;
  } else if (group === 'people') {
    const fill = ['#3984D7', '#39A46A', '#E99A2E', '#9062CC', '#E74646'][Number(value) - 1] ?? color;
    glyph = <><circle cx="9" cy="5.5" r="4" fill={fill} /><path d="M 1 18 C 1 8 17 8 17 18 Z" fill={fill} /><circle cx="15" cy="15" r="5" fill="#FFFFFF" /><text x="15" y="15.5" dominantBaseline="central" textAnchor="middle" fontFamily="Arial, sans-serif" fontSize="8" fontWeight="700" fill={fill}>{value}</text></>;
  } else if (group === 'symbol' && ['smile', 'cry'].includes(value)) glyph = <><circle cx="10" cy="10" r="9" fill="#F5C84C" /><circle cx="7" cy="8" r="1" fill="#68511D" /><circle cx="13" cy="8" r="1" fill="#68511D" /><path d={value === 'smile' ? 'M 6 12 Q 10 17 14 12' : 'M 6 15 Q 10 10 14 15'} fill="none" stroke="#68511D" strokeWidth="1.5" strokeLinecap="round" />{value === 'cry' ? <path d="M 15 9 Q 19 14 15 14 Q 12 14 15 9" fill="#3984D7" /> : null}</>;
  else if (group === 'symbol' && value === 'warning') glyph = <><path d="M 10 1 L 19 18 H 1 Z" fill="#F5C84C" stroke="#C6921B" strokeWidth="1" /><text x="10" y="12" textAnchor="middle" dominantBaseline="central" fontSize="12" fontWeight="700" fill="#5B4414">!</text></>;
  else glyph = <>{circle}{letter(({ plus: '+', minus: '−', question: '?', exclamation: '!', info: 'i' } as Record<string, string>)[value] ?? '?')}</>;
  return <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" data-marker-id={markerId} {...props}>
    {backdrop ? <rect data-marker-background="" x="0" y="0" width="20" height="20" rx="4" fill="#FFFFFF" /> : null}
    {glyph}
  </svg>;
}
