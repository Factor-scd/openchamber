import { describe, expect, test } from 'bun:test';

import type { FilesAPI } from '@/lib/api/types';
import { validateContextFileOpen } from './contextFileOpenGuard';

const filesApi = (content: string): FilesAPI => ({
  listDirectory: async () => ({ path: '/', entries: [] }),
  readFile: async () => ({ content, path: '/x' }),
});

describe('validateContextFileOpen', () => {
  test('allows known binaries through without reading text', async () => {
    const files: FilesAPI = {
      listDirectory: async () => ({ path: '/', entries: [] }),
      readFile: async () => {
        throw new Error('should not read binary as text');
      },
    };

    await expect(validateContextFileOpen(files, '/repo/docs/report.pdf')).resolves.toEqual({ ok: true });
    await expect(validateContextFileOpen(files, '/repo/docs/report.docx')).resolves.toEqual({ ok: true });
    await expect(validateContextFileOpen(files, '/repo/docs/pixel.png')).resolves.toEqual({ ok: true });
    await expect(validateContextFileOpen(files, '/repo/bin/archive.zip')).resolves.toEqual({ ok: true });
  });

  test('rejects text payloads that look binary', async () => {
    await expect(validateContextFileOpen(filesApi('%PDF-1.7\nbinary'), '/repo/mystery.bin.bak')).resolves.toEqual({
      ok: false,
      reason: 'binary',
    });
  });

  test('allows ordinary text files', async () => {
    await expect(validateContextFileOpen(filesApi('hello\nworld\n'), '/repo/notes.txt')).resolves.toEqual({ ok: true });
  });
});
