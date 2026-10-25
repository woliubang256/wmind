import { unzipSync, strFromU8 } from 'fflate';
import { parseXml, localName, type XmlElement } from '@/editor/import/xml';
import { isSafeEntryName } from '@/editor/import/zip';
import { AIFileError, AI_LIMITS, textLength } from './limits';

type Archive = Record<string, Uint8Array>;

function openOffice(bytes: Uint8Array): Archive {
  let used = 0;
  let entries = 0;
  return unzipSync(bytes, { filter(entry) {
    entries += 1;
    if (entries > 4096) throw new AIFileError('zipLimit');
    const name = entry.name;
    const accepted = name === 'word/document.xml' || name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels'
      || name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(name);
    if (!accepted) return false;
    if (!isSafeEntryName(name)) throw new AIFileError('parse');
    used += entry.originalSize;
    if (entry.originalSize > 8 * 1024 ** 2 || used > 16 * 1024 ** 2) throw new AIFileError('zipLimit');
    return true;
  } });
}

function xml(archive: Archive, name: string): XmlElement {
  const raw = archive[name];
  if (!raw) throw new AIFileError('parse');
  const text = strFromU8(raw);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new AIFileError('parse');
  return parseXml(text, { maxDepth: 128, maxNodes: 150_000 });
}
function children(node: XmlElement, name: string): XmlElement[] {
  return node.children.filter((item) => localName(item.name) === name);
}
function first(node: XmlElement, name: string): XmlElement | undefined { return children(node, name)[0]; }
function descendants(node: XmlElement, name: string): XmlElement[] {
  if (localName(node.name) === name) return [node];
  return node.children.flatMap((child) => descendants(child, name));
}
function runText(node: XmlElement): string {
  const name = localName(node.name);
  if (name === 't') return node.text;
  if (name === 'tab') return '\t';
  if (name === 'br' || name === 'cr') return '\n';
  if (name === 'del' || name === 'instrText') return '';
  return node.children.map(runText).join('');
}

function bounded(lines: string[]): string {
  const text = lines.join('\n').trim();
  if (textLength(text) > AI_LIMITS.textRunes) throw new AIFileError('textLimit');
  if (!text) throw new AIFileError('empty');
  return text;
}

export function extractDocx(bytes: Uint8Array): string {
  const document = xml(openOffice(bytes), 'word/document.xml');
  const body = first(document, 'body');
  if (!body) throw new AIFileError('parse');
  // Paragraph order includes table cells without concatenating unrelated rows.
  return bounded(descendants(body, 'p').map(runText));
}

export function extractXlsx(bytes: Uint8Array): string {
  const archive = openOffice(bytes);
  const workbook = xml(archive, 'xl/workbook.xml');
  const rels = xml(archive, 'xl/_rels/workbook.xml.rels');
  const shared = archive['xl/sharedStrings.xml']
    ? children(xml(archive, 'xl/sharedStrings.xml'), 'si').map(runText) : [];
  const sheets = first(workbook, 'sheets');
  if (!sheets) throw new AIFileError('parse');
  const lines: string[] = [];
  for (const sheet of children(sheets, 'sheet')) {
    const relationId = Object.entries(sheet.attrs).find(([key]) => localName(key) === 'id')?.[1];
    const relation = children(rels, 'Relationship').find((item) => item.attrs.Id === relationId);
    if (!relation || relation.attrs.TargetMode === 'External') throw new AIFileError('parse');
    const path = new URL(relation.attrs.Target ?? '', 'https://office.invalid/xl/').pathname.slice(1);
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path) || !isSafeEntryName(path)) throw new AIFileError('parse');
    const table = xml(archive, path);
    const rows = first(table, 'sheetData');
    if (!rows) throw new AIFileError('parse');
    const sheetLines: string[] = [];
    for (const row of children(rows, 'row')) {
      const cells: string[] = [];
      for (const cell of children(row, 'c')) {
        const raw = first(cell, 'v')?.text ?? '';
        let value = raw;
        if (cell.attrs.t === 's') {
          const index = Number(raw);
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(index) || shared[index] === undefined) throw new AIFileError('parse');
          value = shared[index]!;
        } else if (cell.attrs.t === 'inlineStr') {
          value = runText(first(cell, 'is') ?? cell);
        } else if (cell.attrs.t === 'b') {
          value = raw === '1' ? 'TRUE' : 'FALSE';
        } else if (!raw && first(cell, 'f')) {
          value = `=${first(cell, 'f')!.text}`;
        }
        if (value) cells.push(`${cell.attrs.r ?? ''}: ${value}`);
      }
      if (cells.length) sheetLines.push(cells.join('\t'));
    }
    if (sheetLines.length) lines.push(`[${sheet.attrs.name ?? ''}]`, ...sheetLines);
  }
  return bounded(lines);
}
