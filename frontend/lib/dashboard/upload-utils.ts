/**
 * Upload utilities for the admin dashboard document manager.
 *
 * Handles drag-and-drop folder traversal (mirroring the dropped structure),
 * the directory picker (`webkitdirectory`), allowed-type validation, and
 * content-type resolution. The relative path of each file is preserved so the
 * backend can mirror the exact folder layout under `uploads/` in S3.
 */

export interface CollectedFile {
  /** The browser File object (the actual bytes to upload). */
  file: File;
  /** Path relative to the drop root, e.g. "folderA/sub/report.pdf" or "report.pdf". */
  relativePath: string;
}

export interface ValidationResult {
  valid: CollectedFile[];
  /** Files rejected because their extension is not in the allowed set. */
  invalid: CollectedFile[];
}

/** Extensions the document manager accepts (matches the backend allow-list). */
export const ALLOWED_EXTENSIONS = [
  'csv',
  'pdf',
  'txt',
  'docx',
  'pptx',
  'svg',
  'png',
  'jpeg',
  'jpg',
] as const;

/** Maps an extension to the Content-Type the backend expects/whitelists. */
export const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  csv: 'text/csv',
  pdf: 'application/pdf',
  txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
};

/** Value for the file input `accept` attribute. */
export const ACCEPT_ATTR = '.csv,.pdf,.txt,.docx,.pptx,.svg,.png,.jpeg,.jpg';

export function getExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

export function isAllowedFile(name: string): boolean {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(getExtension(name));
}

/** Resolve the Content-Type to send, preferring our extension map. */
export function contentTypeFor(file: File): string {
  const ext = getExtension(file.name);
  return EXTENSION_CONTENT_TYPES[ext] || file.type || 'application/octet-stream';
}

/** Split collected files into allowed vs. unsupported by extension. */
export function partitionByType(files: CollectedFile[]): ValidationResult {
  const valid: CollectedFile[] = [];
  const invalid: CollectedFile[] = [];
  for (const f of files) {
    if (isAllowedFile(f.file.name)) valid.push(f);
    else invalid.push(f);
  }
  return { valid, invalid };
}

// ── Drag-and-drop folder traversal ──────────────────────────────────────────

/**
 * Recursively walk a FileSystemEntry, collecting files with their relative
 * paths. Directory readers return entries in batches (max ~100), so we drain
 * `readEntries` until it yields an empty batch.
 */
function traverseEntry(
  entry: FileSystemEntry,
  parentPath: string,
  out: CollectedFile[],
): Promise<void> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file(
        (file) => {
          const relativePath = parentPath ? `${parentPath}/${file.name}` : file.name;
          out.push({ file, relativePath });
          resolve();
        },
        () => resolve(),
      );
      return;
    }

    if (entry.isDirectory) {
      const dirPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children: FileSystemEntry[] = [];

      const readBatch = () => {
        reader.readEntries(
          (batch) => {
            if (batch.length === 0) {
              Promise.all(children.map((c) => traverseEntry(c, dirPath, out))).then(() =>
                resolve(),
              );
            } else {
              children.push(...batch);
              readBatch();
            }
          },
          () => resolve(),
        );
      };
      readBatch();
      return;
    }

    resolve();
  });
}

/**
 * Collect files (with relative paths) from a drop event's DataTransferItemList,
 * descending into any dropped folders. Falls back to a flat file list when the
 * browser doesn't support the entries API.
 */
export async function collectFilesFromDataTransfer(
  dataTransfer: DataTransfer,
): Promise<CollectedFile[]> {
  const items = dataTransfer.items;
  const entries: FileSystemEntry[] = [];

  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const entry = item.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
  }

  if (entries.length === 0) {
    // Fallback: no entries API — treat as flat files.
    return Array.from(dataTransfer.files).map((file) => ({ file, relativePath: file.name }));
  }

  const out: CollectedFile[] = [];
  await Promise.all(entries.map((entry) => traverseEntry(entry, '', out)));
  return out;
}

/**
 * Collect files from a file/directory input. When `webkitdirectory` is used,
 * `webkitRelativePath` carries the folder structure; otherwise we use the name.
 */
export function collectFilesFromInput(fileList: FileList): CollectedFile[] {
  return Array.from(fileList).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    return { file, relativePath: rel && rel.length > 0 ? rel : file.name };
  });
}
