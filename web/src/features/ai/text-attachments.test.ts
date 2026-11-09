import { describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { extractAttachments } from './attachments';
import { AI_ACCEPT, AIFileError, AI_LIMITS, validateFiles } from './limits';

const extensions = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'log', 'ini', 'conf', 'toml'];
const read = (files: File[], prompt = '', signal = new AbortController().signal, onFile = () => {}) => extractAttachments(files, prompt, signal, onFile);
const textFile = (text: string, name = '素材.txt') => new File([text], name);
const bytesFile = (bytes: number[], name = '素材.txt') => new File([Uint8Array.from(bytes)], name, { type: 'application/octet-stream' });
function utf16(text: string, littleEndian: boolean): number[] {
  const bytes = littleEndian ? [0xff, 0xfe] : [0xfe, 0xff];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes.push(...(littleEndian ? [code & 255, code >>> 8] : [code >>> 8, code & 255]));
  }
  return bytes;
}

describe('AI 纯文本附件', () => {
  it.each(extensions)('%s 在选择与拖放的统一格式清单中，保留原文且不依赖 MIME', async (extension) => {
    const text = '# 标题\r\n\t- 内容 😀\n';
    const file = textFile(text, `素材.${extension.toUpperCase()}`);
    expect(AI_ACCEPT.split(',')).toContain(`.${extension}`);
    expect(() => validateFiles([file])).not.toThrow();
    expect(await read([file])).toEqual([{ name: file.name, text, images: [] }]);
  });

  it('Markdown、CSV、JSON 和 XML 的结构及潜在代码只作为字面文本保留', async () => {
    const texts = [
      '# 中心\n## 分支\n```html\n<script>literal()</script>\n```\n',
      '项目,金额\r\n"研发,测试",1200\r\n',
      '{"nested":{"raw":"\\u0000"},"list":[1,2]}',
      '<!DOCTYPE data [<!ENTITY x SYSTEM "https://example.test/private">]><data>&x;</data>',
    ];
    const files = texts.map((text, index) => textFile(text, `素材.${['md', 'csv', 'json', 'xml'][index]}`));
    const onFile = vi.fn();
    const sources = await read(files, '生成导图', undefined, onFile);
    expect(sources.map((source) => source.text)).toEqual(texts);
    expect(sources.map((source) => source.name)).toEqual(files.map((file) => file.name));
    expect(onFile.mock.calls.map(([name]) => name)).toEqual(files.map((file) => file.name));
  });

  it('识别 UTF-8 BOM、UTF-16 LE/BE BOM，并保留 emoji', async () => {
    const text = '中文 😀\r\n第二行';
    const utf8 = Array.from(new TextEncoder().encode(text));
    for (const bytes of [[0xef, 0xbb, 0xbf, ...utf8], utf16(text, true), utf16(text, false)]) {
      expect((await read([bytesFile(bytes)]))[0]!.text).toBe(text);
    }
  });

  it('严格兼容无 BOM 的 GBK 中文文本', async () => {
    const file = bytesFile([0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0x31, 0x32, 0x30, 0x30]);
    expect((await read([file]))[0]!.text).toBe('中文\n1200');
  });

  it('支持 GB18030 四字节非 BMP 字符，按一个码点保留', async () => {
    // Independent GB18030 encoding of U+1F600 (also verified with iconv).
    expect((await read([bytesFile([0x94, 0x39, 0xfc, 0x36])]))[0]!.text).toBe('😀');
  });

  it('文本与真实 DOCX/XLSX 混合提取仍保持完整顺序', async () => {
    const office = (name: string, entries: Record<string, string>) => new File([
      zipSync(Object.fromEntries(Object.entries(entries).map(([path, text]) => [path, strToU8(text)]))),
    ], name);
    const files = [
      textFile('# 总览', '开始.md'),
      office('需求.docx', { 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>研发要求</w:t></w:r></w:p></w:body></w:document>' }),
      office('预算.xlsx', {
        'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="预算" r:id="r1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1"><v>1200</v></c></row></sheetData></worksheet>',
      }),
      textFile('最后交付', '结束.txt'),
    ];
    expect(await read(files)).toEqual(files.map((file, index) => ({ name: file.name, text: ['# 总览', '研发要求', '[预算]\nA1: 1200', '最后交付'][index], images: [] })));
  });

  it.each([
    [0xff], [0xef, 0xbb, 0xbf, 0xd6, 0xd0], [0xff, 0xfe, 0x61], [0xfe, 0xff, 0xd8, 0x00],
    [0x50, 0x4b, 0x03, 0x04], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  ].map((bytes) => ({ bytes })))('拒绝损坏编码及改名为文本的二进制：$bytes', async ({ bytes }) => {
    await expect(read([bytesFile(bytes)])).rejects.toMatchObject({ code: 'parse', fileName: '素材.txt' });
  });

  it('检查完整文本而非只看文件开头，拒绝后段 NUL 和控制字符', async () => {
    for (const control of ['\u0000', '\u0007', '\u001b', '\u007f', '\u0081']) {
      await expect(read([textFile(`${'正文'.repeat(600)}${control}`)])).rejects.toMatchObject({ code: 'parse' });
    }
  });

  it('拒绝空文件及只有空白/BOM 的文件', async () => {
    for (const text of ['', ' \r\n\t', '\ufeff']) {
      await expect(read([textFile(text)])).rejects.toMatchObject({ code: 'empty', fileName: '素材.txt' });
    }
  });

  it('按 Unicode 码点计数，精确上限保留完整原文，超过一字符整批拒绝', async () => {
    const text = '😀'.repeat(AI_LIMITS.textRunes);
    expect((await read([textFile(text)]))[0]!.text).toBe(text);
    await expect(read([textFile(`${text}字`)])).rejects.toMatchObject({ code: 'textLimit' });
    await expect(read([textFile('字'.repeat(50_000), 'a.md'), textFile('字'.repeat(50_000), 'b.txt')], '字')).rejects.toMatchObject({ code: 'textLimit' });
    await expect(read([textFile('a'.repeat(4 * AI_LIMITS.textRunes + 5))])).rejects.toMatchObject({ code: 'textLimit' });
  });

  it('仍拒绝未知扩展名、旧 Office 和超大小/超数量/超总量', async () => {
    for (const name of ['素材.exe', 'README', 'old.doc', 'old.xls']) {
      expect(() => validateFiles([{ name, size: 1 }])).toThrow('unsupported');
    }
    expect(() => validateFiles([{ name: '大.txt', size: AI_LIMITS.fileBytes + 1 }])).toThrow('fileSize');
    expect(() => validateFiles(Array.from({ length: 6 }, () => ({ name: 'a.md', size: 1 })))).toThrow('fileCount');
    expect(() => validateFiles([{ name: 'a.txt', size: AI_LIMITS.fileBytes }, { name: 'b.md', size: AI_LIMITS.fileBytes }])).toThrow('totalSize');
    await expect(read([textFile('有效', 'a.txt'), textFile(' ', 'b.md')])).rejects.toBeInstanceOf(AIFileError);
  });

  it('取消发生在读取前时不再读取或处理后续文件', async () => {
    const controller = new AbortController();
    const file = textFile('正文');
    const arrayBuffer = vi.spyOn(file, 'arrayBuffer');
    const onFile = vi.fn(() => controller.abort());
    await expect(read([file, textFile('后续', '后续.md')], '', controller.signal, onFile)).rejects.toMatchObject({ name: 'AbortError' });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(onFile).toHaveBeenCalledTimes(1);
  });
});
