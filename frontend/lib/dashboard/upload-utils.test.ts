import { describe, expect, it } from 'vitest';

import {
  chunkUploadBatch,
  isAllowedFile,
  MAX_FILE_SIZE_BYTES,
  partitionBySize,
  partitionByUniquePath,
  runWithConcurrency,
  sortByRelativePath,
} from './upload-utils';

describe('document upload batching', () => {
  it('keeps the client allow-list aligned with safe knowledge-base formats', () => {
    expect(isAllowedFile('guide.xlsx')).toBe(true);
    expect(isAllowedFile('slides.pptx')).toBe(false);
    expect(isAllowedFile('photo.png')).toBe(false);
    expect(isAllowedFile('active-content.svg')).toBe(false);
    expect(isAllowedFile('archive.zip')).toBe(false);
  });

  it('sorts nested paths deterministically without mutating the selection', () => {
    const files = [
      { relativePath: 'Training/z.pdf', file: {} as File },
      { relativePath: 'Camping/a.pdf', file: {} as File },
      { relativePath: 'Training/a.pdf', file: {} as File },
    ];

    expect(sortByRelativePath(files).map((item) => item.relativePath)).toEqual([
      'Camping/a.pdf',
      'Training/a.pdf',
      'Training/z.pdf',
    ]);
    expect(files[0].relativePath).toBe('Training/z.pdf');
  });

  it('splits oversized folder selections without losing order', () => {
    expect(chunkUploadBatch([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('rejects duplicate paths before selections are split into API batches', () => {
    const first = { relativePath: 'Camp/guide.pdf', file: {} as File };
    const duplicate = { relativePath: 'Camp/guide.pdf', file: {} as File };
    const other = { relativePath: 'Camp/map.pdf', file: {} as File };

    expect(partitionByUniquePath([first, duplicate, other])).toEqual({
      unique: [first, other],
      duplicates: [duplicate],
    });
  });

  it('keeps valid files while separating empty and over-50-MB files', () => {
    const valid = {
      relativePath: 'Camp/guide.pdf',
      file: { size: MAX_FILE_SIZE_BYTES } as File,
    };
    const empty = {
      relativePath: 'Camp/empty.pdf',
      file: { size: 0 } as File,
    };
    const oversized = {
      relativePath: 'Camp/large.pdf',
      file: { size: MAX_FILE_SIZE_BYTES + 1 } as File,
    };

    expect(partitionBySize([valid, empty, oversized])).toEqual({
      valid: [valid],
      empty: [empty],
      oversized: [oversized],
    });
  });

  it('never exceeds the requested transfer concurrency', async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return value * 10;
    });

    expect(maximumActive).toBe(2);
    expect(results).toEqual([10, 20, 30, 40, 50, 60]);
  });
});
