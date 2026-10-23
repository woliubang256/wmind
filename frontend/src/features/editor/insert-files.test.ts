import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { bytesToBase64, embedFiles, MAX_EMBEDDED_BYTES } from './insert-files';

describe('便携附件与文件夹', () => {
  it('保留原文件字节和名称，支持中文及零字节文件', async () => {
    const [file, empty] = await embedFiles([new File(['中文'], '中文.txt'), new File([], 'empty')]);
    expect(file!.name).toBe('中文.txt'); expect(file!.data).toBe(bytesToBase64(new TextEncoder().encode('中文')));
    expect(empty!.bytes).toBe(0);
  });
  it('文件夹 ZIP 保留相对路径与字节', async () => {
    const file = new File(['abc'], 'a.txt'); Object.defineProperty(file, 'webkitRelativePath', { value: '目录/子目录/a.txt' });
    const [folder] = await embedFiles([file], true);
    expect(folder!.name).toBe('目录.zip');
    const entries = unzipSync(Uint8Array.from(atob(folder!.data), (char) => char.charCodeAt(0)));
    expect(new TextDecoder().decode(entries['目录/子目录/a.txt'])).toBe('abc');
  });
  it('超限与路径穿越在读取或写文档前拒绝', async () => {
    await expect(embedFiles([new File([new Uint8Array(MAX_EMBEDDED_BYTES + 1)], 'large')])).rejects.toThrow('file-too-large');
    const file = new File(['abc'], 'a.txt'); Object.defineProperty(file, 'webkitRelativePath', { value: '../a.txt' });
    await expect(embedFiles([file], true)).rejects.toThrow('invalid-file');
  });
});
