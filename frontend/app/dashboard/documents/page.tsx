'use client';

import { useEffect, useState, useRef } from 'react';
import {
  completeUploadBatch,
  createUploadBatch,
  deleteDocuments,
  DocumentItem,
  DocumentStatus,
  getDocumentDownloadUrl,
  getDocuments,
  PresignedDocumentUpload,
} from '@/lib/dashboard/api';
import { Search, Paperclip, Upload, FolderUp, Pencil, Trash2, Download, FileText, ChevronLeft, ChevronRight, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useLanguage } from '@/context/LanguageContext';
import { formatText, languageLocale } from '@/lib/i18n';
import {
  ACCEPT_ATTR,
  CollectedFile,
  collectFilesFromDataTransfer,
  collectFilesFromInput,
  chunkUploadBatch,
  contentTypeFor,
  partitionByType,
  partitionByUniquePath,
  runWithConcurrency,
  sortByRelativePath,
  UPLOAD_CONCURRENCY,
} from '@/lib/dashboard/upload-utils';

export default function DocumentsPage() {
  const { language, t } = useLanguage();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [dragActive, setDragActive] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; pct: number } | null>(null);
  const [deleteKeys, setDeleteKeys] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const ITEMS_PER_PAGE = 10;

  // While any document is still indexing (or waiting), poll so badges flip to
  // "Ready" on their own without a manual refresh.
  const anyIndexing = documents.some(d => d.status === 'indexing' || d.status === 'pending');
  useEffect(() => {
    if (!anyIndexing) return;
    const timer = setInterval(() => { loadDocuments(true); }, 6000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyIndexing]);

  useEffect(() => {
    loadDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadDocuments(silent = false) {
    if (!silent) setLoading(true);
    try {
      const data = await getDocuments();
      setDocuments(data.documents);
    } catch (err) {
      setError(t.documents.loadFailed);
      console.error(err);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function handleDownload(key: string) {
    try {
      const { url } = await getDocumentDownloadUrl(key);
      window.open(url, '_blank');
    } catch (err) {
      toast.error(t.documents.downloadFailed);
      console.error(err);
    }
  }

  function handleDelete(key: string) {
    setDeleteKeys([key]);
  }

  async function handleBulkDownload() {
    for (const key of selectedKeys) {
      await handleDownload(key);
    }
  }

  function handleBulkDelete() {
    setDeleteKeys(Array.from(selectedKeys));
  }

  async function confirmDelete() {
    if (deleteKeys.length === 0 || deleting) return;

    setDeleting(true);
    let failed: string[] = [];
    let deletedKeys: string[] = [];
    try {
      const result = await deleteDocuments(deleteKeys);
      failed = result.failedKeys;
      deletedKeys = result.deletedKeys;
    } catch (err) {
      failed = [...deleteKeys];
      console.error(err);
    }

    setSelectedKeys(prev => {
      const next = new Set(prev);
      deletedKeys.forEach(key => next.delete(key));
      return next;
    });
    await loadDocuments();
    setDeleting(false);
    setDeleteKeys([]);

    if (failed.length > 0) {
      toast.error(t.documents.deleteFailed, { description: failed.map(key => key.replace('uploads/', '')).join(', ') });
    }
  }

  // Upload a single collected file to S3 via a presigned URL, preserving its
  // relative folder path. Uses XHR so we get real byte-level progress events
  // (fetch can't report upload progress), reported via onProgress.
  function uploadOne(
    item: CollectedFile,
    upload: PresignedDocumentUpload,
    onProgress: (loaded: number) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (item.file.size > upload.maxSizeBytes) {
        reject(new Error(`File exceeds ${upload.maxSizeBytes} bytes: ${item.relativePath}`));
        return;
      }
      const form = new FormData();
      Object.entries(upload.fields).forEach(([name, value]) => form.append(name, value));
      form.append('file', item.file);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', upload.url);
      xhr.timeout = 300_000;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`POST failed (${xhr.status}) for ${item.relativePath}`));
      };
      xhr.onerror = () => reject(new Error(`Network error uploading ${item.relativePath}`));
      xhr.ontimeout = () => reject(new Error(`Upload timed out for ${item.relativePath}`));
      xhr.onabort = () => reject(new Error(`Upload cancelled for ${item.relativePath}`));
      xhr.send(form);
    });
  }

  // Validate a batch, surface unsupported files as a bottom-right error toast,
  // then upload the valid ones (mirroring folder structure).
  async function handleFiles(collected: CollectedFile[]) {
    if (collected.length === 0) return;

    const { valid, invalid } = partitionByType(collected);

    if (invalid.length > 0) {
      const names = invalid.map((f) => f.relativePath).join(', ');
      toast.error(
        formatText(t.documents.unsupported, { count: invalid.length }),
        { description: names },
      );
    }

    const { unique, duplicates } = partitionByUniquePath(valid);
    if (duplicates.length > 0) {
      toast.error(
        formatText(t.documents.duplicatePaths, { count: duplicates.length }),
        { description: duplicates.map((file) => file.relativePath).join(', ') },
      );
    }

    if (unique.length === 0) return;

    const orderedFiles = sortByRelativePath(unique);
    const totalBytes = orderedFiles.reduce((sum, f) => sum + (f.file.size || 0), 0) || 1;
    const loadedBytes = new Map<string, number>();
    let completedFiles = 0;

    const updateProgress = () => {
      const uploadedBytes = Array.from(loadedBytes.values()).reduce((sum, value) => sum + value, 0);
      const pct = Math.min(100, Math.round((uploadedBytes / totalBytes) * 100));
      setProgress({ done: completedFiles, total: orderedFiles.length, pct });
    };

    setUploading(true);
    setProgress({ done: 0, total: orderedFiles.length, pct: 0 });
    const failed: string[] = [];
    let succeeded = 0;

    for (const batchFiles of chunkUploadBatch(orderedFiles)) {
      try {
        const batch = await createUploadBatch(batchFiles.map((item) => ({
          relativePath: item.relativePath,
          contentType: contentTypeFor(item.file),
          size: item.file.size,
        })));
        const uploadsByPath = new Map(batch.uploads.map((upload) => [upload.relativePath, upload]));

        const results = await runWithConcurrency(batchFiles, UPLOAD_CONCURRENCY, async (item) => {
          const upload = uploadsByPath.get(item.relativePath);
          if (!upload) throw new Error(`Missing upload policy for ${item.relativePath}`);
          try {
            await uploadOne(item, upload, (loaded) => {
              loadedBytes.set(item.relativePath, loaded);
              updateProgress();
            });
            return { item, upload, succeeded: true };
          } catch (err) {
            console.error(err);
            return { item, upload, succeeded: false };
          } finally {
            loadedBytes.set(item.relativePath, item.file.size || 0);
            completedFiles += 1;
            updateProgress();
          }
        });

        const failedResults = results.filter((result) => !result.succeeded);
        await completeUploadBatch(
          batch.batchId,
          failedResults.map((result) => result.upload.key),
        );
        succeeded += results.length - failedResults.length;
        failed.push(...failedResults.map((result) => result.item.relativePath));
      } catch (err) {
        console.error(err);
        for (const item of batchFiles) {
          if (!loadedBytes.has(item.relativePath)) {
            loadedBytes.set(item.relativePath, item.file.size || 0);
            completedFiles += 1;
          }
          if (!failed.includes(item.relativePath)) failed.push(item.relativePath);
        }
        updateProgress();
      }
    }
    setUploading(false);
    setProgress(null);

    if (succeeded > 0) {
      toast.success(formatText(t.documents.uploadSuccess, { count: succeeded }));
    }
    if (failed.length > 0) {
      toast.error(
        formatText(t.documents.uploadFailed, { count: failed.length }),
        { description: failed.join(', ') },
      );
    }
    await loadDocuments();
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    const collected = await collectFilesFromDataTransfer(e.dataTransfer);
    await handleFiles(collected);
  }

  function toggleSelect(key: string) {
    setSelectedKeys(prev => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }

  function toggleSelectAll() {
    if (selectedKeys.size === paginatedDocs.length) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(paginatedDocs.map(d => d.key)));
    }
  }

  function StatusBadge({ status }: { status?: DocumentStatus }) {
    const s = status ?? 'ready';
    const label = s === 'indexing' ? t.documents.indexing
      : s === 'pending' ? t.documents.queued
      : s === 'failed' ? t.documents.failed
      : t.documents.ready;
    return <span className={`doc-status-badge ${s}`}>{label}</span>;
  }

  const filteredDocs = documents.filter(d =>
    d.fileName.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const totalPages = Math.ceil(filteredDocs.length / ITEMS_PER_PAGE);
  const paginatedDocs = filteredDocs.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);
  const isBulkDelete = deleteKeys.length > 1;
  const deleteTitle = isBulkDelete
    ? formatText(t.documents.confirmBulkDelete, { count: deleteKeys.length })
    : t.documents.confirmDelete;
  const deleteDescription = isBulkDelete
    ? formatText(t.documents.confirmBulkDeleteDescription, { count: deleteKeys.length })
    : formatText(t.documents.confirmDeleteDescription, {
        name: deleteKeys[0]?.replace('uploads/', '') || '',
      });

  return (
    <div className="documents-page">
      <div className="breadcrumb">
        <span className="breadcrumb-arrow">‹</span>
        <span className="breadcrumb-text">{t.documents.title}</span>
      </div>

      {/* Search + Attachment */}
      <div className="doc-filters">
        <div className="search-box">
          <Search size={18} className="search-icon" />
          <input
            type="text"
            placeholder={t.documents.searchPlaceholder}
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
            className="search-input"
          />
        </div>
        <button className="btn-attachment" onClick={() => fileInputRef.current?.click()}>
          <Paperclip size={14} />
          <span>{t.documents.files}</span>
        </button>
        <button className="btn-attachment" onClick={() => folderInputRef.current?.click()}>
          <FolderUp size={14} />
          <span>{t.documents.folder}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files) handleFiles(collectFilesFromInput(e.target.files)); e.target.value = ''; }}
        />
        <input
          ref={folderInputRef}
          type="file"
          // @ts-expect-error non-standard directory-picker attributes
          webkitdirectory=""
          directory=""
          multiple
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files) handleFiles(collectFilesFromInput(e.target.files)); e.target.value = ''; }}
        />
      </div>

      {/* Upload Zone */}
      <div
        className={`upload-zone${dragActive ? ' drag-active' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={e => { e.preventDefault(); setDragActive(false); }}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="upload-icon-wrapper"><Upload size={22} /></div>
        <p className="upload-text">{t.documents.dropPrompt}</p>
        <p className="upload-hint">{t.documents.dropHint}</p>
        {uploading && progress && (
          <div className="upload-progress-wrap" onClick={e => e.stopPropagation()}>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress.pct}%` }} />
            </div>
            <p className="upload-progress">
              {formatText(t.documents.uploading, { done: progress.done, total: progress.total, pct: progress.pct })}
            </p>
          </div>
        )}
      </div>

      {/* Bulk Actions */}
      {selectedKeys.size > 0 && (
        <div className="bulk-actions">
          <span>{formatText(t.documents.selected, { count: selectedKeys.size })}</span>
          <button className="bulk-btn" onClick={handleBulkDownload}><Download size={14} /> {t.documents.download}</button>
          <button className="bulk-btn danger" onClick={handleBulkDelete}><Trash2 size={14} /> {t.documents.delete}</button>
        </div>
      )}

      {/* Documents Table */}
      <div className="doc-table">
        <div className="doc-table-header">
          <span className="doc-th doc-col-check">
            <input type="checkbox" className="checkbox" checked={selectedKeys.size === paginatedDocs.length && paginatedDocs.length > 0} onChange={toggleSelectAll} />
          </span>
          <span className="doc-th doc-col-name">{t.documents.documentName}</span>
          <span className="doc-th doc-col-date">{t.documents.documentDate}</span>
          <span className="doc-th doc-col-status">{t.documents.status}</span>
          <span className="doc-th doc-col-ops">{t.documents.operations}</span>
        </div>
        {loading ? (
          <div className="empty-state">{t.documents.loading}</div>
        ) : paginatedDocs.length > 0 ? (
          paginatedDocs.map((doc) => (
            <div key={doc.key} className="doc-row">
              <span className="doc-td doc-col-check">
                <input type="checkbox" className="checkbox" checked={selectedKeys.has(doc.key)} onChange={() => toggleSelect(doc.key)} />
              </span>
              <span className="doc-td doc-col-name">
                <FileText size={20} className="file-icon" />
                <span className="doc-name-text">{doc.fileName}</span>
              </span>
              <span className="doc-td doc-col-date">
                {new Date(doc.lastModified).toLocaleDateString(languageLocale(language), { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
              <span className="doc-td doc-col-status">
                <StatusBadge status={doc.status} />
              </span>
              <span className="doc-td doc-col-ops">
                <button className="op-btn" aria-label={t.documents.edit} title={t.documents.edit}><Pencil size={13.5} /></button>
                <button className="op-btn" aria-label={t.documents.delete} title={t.documents.delete} onClick={() => handleDelete(doc.key)}><Trash2 size={13} /></button>
                <button className="op-btn" aria-label={t.documents.download} title={t.documents.download} onClick={() => handleDownload(doc.key)}><Download size={12} /></button>
              </span>
            </div>
          ))
        ) : (
          <div className="empty-state">{error || t.documents.empty}</div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="pagination">
            <button className="page-btn" disabled={page === 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={16} /></button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
              <button key={p} className={`page-btn ${p === page ? 'active' : ''}`} onClick={() => setPage(p)}>{p}</button>
            ))}
            <button className="page-btn" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight size={16} /></button>
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={deleteKeys.length > 0}
        title={deleteTitle}
        description={deleteDescription}
        confirmLabel={deleting ? t.documents.deleting : t.documents.delete}
        cancelLabel={t.common.cancel}
        closeLabel={t.common.close}
        onConfirm={confirmDelete}
        onCancel={() => { if (!deleting) setDeleteKeys([]); }}
        tone="danger"
        icon={<AlertTriangle size={21} />}
        confirmIcon={<Trash2 size={16} />}
        busy={deleting}
      />
    </div>
  );
}
