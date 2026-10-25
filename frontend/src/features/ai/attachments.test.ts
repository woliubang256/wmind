import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { extractDocx, extractXlsx } from './office';
import { documentFromAI } from './document';
import { AIFileError, AI_LIMITS, textLength, validateFiles } from './limits';
import { validateSources } from './attachments';
import { parseDocument } from '@/editor/model/validate';
import { defaultTheme } from '@/editor/model/create';

const archive = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])));

describe('AI material extraction', () => {
  it('reads DOCX paragraphs, split runs and table cells in document order', () => {
    const bytes = archive({ 'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:r><w:t>项目</w:t></w:r><w:r><w:t>计划 &amp; 范围</w:t><w:br/><w:t>第二行</w:t></w:r><w:del><w:r><w:t>已删除内容</w:t></w:r></w:del></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>负责人</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>小王</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:t>交付</w:t></w:r></w:p></w:body></w:document>`, 'word/media/unused.png': 'unrelated' });
    expect(extractDocx(bytes)).toBe('项目计划 & 范围\n第二行\n负责人\n小王\n交付');
  });

  it('preserves workbook order, shared/inline rich strings, sparse cells and stored formula values', () => {
    const bytes = archive({
      'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="第二表" r:id="r2"/><sheet name="第一表" r:id="r1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><r><t>预算</t></r><r><t>合计</t></r></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="7"><c r="A7" t="s"><v>0</v></c><c r="D7"><f>SUM(B1:B6)</f><v>1200</v></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row><c r="C1" t="inlineStr"><is><t>标题</t></is></c><c r="F1" t="b"><v>1</v></c></row></sheetData></worksheet>',
    });
    expect(extractXlsx(bytes)).toBe('[第二表]\nC1: 标题\tF1: TRUE\n[第一表]\nA7: 预算合计\tD7: 1200');
  });

  it('rejects empty, corrupted, DTD and oversized XML without silently losing a file', () => {
    expect(() => extractDocx(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => extractDocx(archive({ 'word/document.xml': '<document><body/></document>' }))).toThrow(AIFileError);
    expect(() => extractDocx(archive({ 'word/document.xml': '<!DOCTYPE d [<!ENTITY x "a">]><document><body/></document>' }))).toThrow(AIFileError);
    expect(() => extractDocx(archive({ 'word/document.xml': ' '.repeat(8 * 1024 ** 2 + 1) }))).toThrow('zipLimit');
    expect(() => extractXlsx(archive({ 'xl/workbook.xml': '<workbook/>' }))).toThrow(AIFileError);
  });

  it('enforces pre-read file limits and shared source budgets using Unicode characters', () => {
    expect(() => validateFiles([{ name: 'old.doc', size: 12 }])).toThrow('unsupported');
    expect(() => validateFiles([{ name: 'large.pdf', size: AI_LIMITS.fileBytes + 1 }])).toThrow('fileSize');
    expect(() => validateFiles(Array.from({ length: 6 }, () => ({ name: 'a.png', size: 1 })))).toThrow('fileCount');
    expect(() => validateFiles([{ name: 'a.pdf', size: AI_LIMITS.fileBytes }, { name: 'b.pdf', size: AI_LIMITS.fileBytes }])).toThrow('totalSize');
    expect(textLength('字😀')).toBe(2);
    expect(() => validateSources('😀'.repeat(100), [{ name: 'text', text: '字'.repeat(AI_LIMITS.textRunes - 99), images: [] }])).toThrow('textLimit');
    expect(() => validateSources('', [{ name: 'images', text: '', images: Array(13).fill('data:image/png;base64,AAAA') }])).toThrow('imageLimit');
  });
});

describe('AI tree to native document', () => {
  it('keeps every hierarchy and uses the real default theme without normalization repairs', () => {
    const root = { title: '项目计划', children: [{ title: '需求', children: [{ title: '<script>字面素材</script>', children: [] }] }, { title: '发布', children: [] }] };
    const document = documentFromAI(root);
    const parsed = parseDocument(document);
    expect(parsed.warnings).toEqual([]);
    expect(document.title).toBe(root.title);
    expect(document.theme).toEqual(defaultTheme());
    expect(document.sheets[0]!.rootTopic.children.attached.map((node) => node.title)).toEqual(['需求', '发布']);
    expect(document.sheets[0]!.rootTopic.children.attached[0]!.children.attached[0]!.title).toBe('<script>字面素材</script>');
    expect(documentFromAI(root).id).not.toBe(document.id);
  });

  it('does not turn missing or excessive AI output into an empty valid map', () => {
    expect(() => documentFromAI({ title: '', children: [] })).toThrow('AI_OUTPUT_INVALID');
    expect(() => documentFromAI({ title: 'root', children: Array.from({ length: 500 }, () => ({ title: 'child', children: [] })) })).toThrow('AI_OUTPUT_INVALID');
  });
});
