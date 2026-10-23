import { isRecord, read, type Properties } from './properties';

/** Only identified pre-fix wmind exports use the reversed property convention. */
export function isLegacyWmindMetadata(text: string | null): boolean {
  if (text === null) return false;
  try {
    const metadata: unknown = JSON.parse(text);
    return isRecord(metadata) && isRecord(metadata.creator)
      && metadata.creator.name === 'wmind' && metadata.wmindStyleVersion === undefined;
  } catch { return false; }
}

const OLD_GEOMETRY: Record<string, string> = {
  solid: 'straight', straight: 'straight', curve: 'curve', dash: 'elbow', dot: 'elbow', elbow: 'elbow', none: 'none',
};

function convertStyle(node: unknown, relationship = false): void {
  if (!isRecord(node) || !isRecord(node.style) || !isRecord(node.style.properties)) return;
  const properties = node.style.properties;
  const old: Properties = { ...properties };
  for (const suffix of ['color', 'width']) {
    delete properties[`line-${suffix}`];
    delete properties[`border-line-${suffix}`];
    if (old[`border-line-${suffix}`] !== undefined) properties[`line-${suffix}`] = old[`border-line-${suffix}`];
    if (!relationship && old[`line-${suffix}`] !== undefined) properties[`border-line-${suffix}`] = old[`line-${suffix}`];
  }
  const geometry = OLD_GEOMETRY[read(old, 'border-line-pattern') ?? ''];
  delete properties['border-line-pattern'];
  if (!relationship) {
    if (old['line-pattern'] !== undefined) properties['border-line-pattern'] = old['line-pattern'];
    properties['line-pattern'] = 'solid';
  }
  if (geometry !== undefined) {
    properties[relationship ? 'shape-class' : 'line-class'] = relationship
      ? `org.xmind.relationshipShape.${geometry === 'curve' ? 'curved' : geometry}`
      : `org.xmind.branchConnection.${geometry}`;
  }
}

/** Mutates the exclusively owned parsed JSON, without copying file contents. */
export function restoreLegacyWmindStyles(parsed: unknown): void {
  const sheets = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.content ?? parsed.sheets : [];
  if (!Array.isArray(sheets)) return;
  for (const sheet of sheets) {
    if (!isRecord(sheet)) continue;
    if (Array.isArray(sheet.relationships)) for (const relationship of sheet.relationships) convertStyle(relationship, true);
    const stack: unknown[] = [sheet.rootTopic];
    while (stack.length > 0) {
      const topic = stack.pop();
      if (!isRecord(topic)) continue;
      convertStyle(topic);
      if (isRecord(topic.children)) for (const key of ['attached', 'detached']) {
        const children = topic.children[key];
        if (Array.isArray(children)) for (const child of children) stack.push(child);
      }
    }
  }
}
