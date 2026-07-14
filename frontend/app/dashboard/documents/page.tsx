'use client';

import { useEffect, useState, useRef } from 'react';
import { getDocuments, getDocumentDownloadUrl, deleteDocument, getUploadUrl, DocumentItem } from '@/lib/dashboard/api';
import { Search, Paperclip, Upload, FolderUp, Pencil, Trash2, Download, FileText, ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import {
  ACCEPT_ATTR,
  CollectedFile,
  collectFilesFromDataTransfer,
  collectFilesFromInput,
  contentTypeFor,
  partitionByType,
} from '@/lib/dashboard/upload-utils';

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const ITEMS_PER_PAGE = 10;

  useEffect(() => {
    loadDocuments();
  }, []);

  async function loadDocuments() {
    setLoading(true);
    try {
      const data = await getDocuments();
      setDocuments(data.documents);
    } catch (err) {
      setError('Failed to load documents.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleDownload(key: string) {
    try {
      const { url } = await getDocumentDownloadUrl(key);
      window.open(url, '_blank');
    } catch (err) {
      toast.error('Download failed');
      console.error(err);
    }
  }

  async function handleDelete(key: string) {
    if (!confirm(`Delete ${key.replace('uploads/', '')}?`)) return;
    try {
      await deleteDocument(key);
      await loadDocuments();
      setSelectedKeys(prev => { const n = new Set(prev); n.delete(key); return n; });
    } catch (err) {
      toast.error('Delete failed');
      console.error(err);
    }
  }

  async function handleBulkDownload() {
    for (const key of selectedKeys) {
      await handleDownload(key);
    }
  }

  async function handleBulkDelete() {
    if (!confirm(`Delete ${selectedKeys.size} selected documents?`)) return;
    for (const key of selectedKeys) {
      try { await deleteDocument(key); } catch {}
    }
    setSelectedKeys(new Set());
    await loadDocuments();
  }

  // Upload a single collected file to S3 via a presigned URL, preserving its
  // relative folder path so the S3 layout mirrors what was dropped.
  async function uploadOne(item: CollectedFile) {
    const ct = contentTypeFor(item.file);
    const { url } = await getUploadUrl(item.relativePath, ct);
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': ct },
      body: item.file,
    });
    if (!res.ok) {
      throw new Error(`PUT failed (${res.status}) for ${item.relativePath}`);
    }
  }

  // Validate a batch, surface unsupported files as a bottom-right error toast,
  // then upload the valid ones (mirroring folder structure).
  async function handleFiles(collected: CollectedFile[]) {
    if (collected.length === 0) return;

    const { valid, invalid } = partitionByType(collected);

    if (invalid.length > 0) {
      const names = invalid.map((f) => f.relativePath).join(', ');
      toast.error(
        `${invalid.length} file${invalid.length > 1 ? 's' : ''} skipped (unsupported type)`,
        { description: names },
      );
    }

    if (valid.length === 0) return;

    setUploading(true);
    const failed: string[] = [];
    let succeeded = 0;
    for (const item of valid) {
      try {
        await uploadOne(item);
        succeeded += 1;
      } catch (err) {
        console.error(err);
        failed.push(item.relativePath);
      }
    }
    setUploading(false);

    if (succeeded > 0) {
      toast.success(`Uploaded ${succeeded} file${succeeded > 1 ? 's' : ''}`);
    }
    if (failed.length > 0) {
      toast.error(
        `${failed.length} file${failed.length > 1 ? 's' : ''} failed to upload`,
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

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const filteredDocs = documents.filter(d =>
    d.fileName.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const totalPages = Math.ceil(filteredDocs.length / ITEMS_PER_PAGE);
  const paginatedDocs = filteredDocs.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);

  return (
    <div className="documents-page">
      <div className="breadcrumb">
        <span className="breadcrumb-arrow">‹</span>
        <span className="breadcrumb-text">Manage documents</span>
      </div>

      {/* Search + Attachment */}
      <div className="doc-filters">
        <div className="search-box">
          <Search size={18} className="search-icon" />
          <input
            type="text"
            placeholder="Search for documents.."
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
            className="search-input"
          />
        </div>
        <button className="btn-attachment" onClick={() => fileInputRef.current?.click()}>
          <Paperclip size={14} />
          <span>Files</span>
        </button>
        <button className="btn-attachment" onClick={() => folderInputRef.current?.click()}>
          <FolderUp size={14} />
          <span>Folder</span>
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
        <p className="upload-text">Drop files or folders here, or click to browse</p>
        <p className="upload-hint">CSV, PDF, TXT, DOCX, SVG, PNG, JPEG — folders keep their structure</p>
        {uploading && <p className="upload-progress">Uploading...</p>}
      </div>

      {/* Bulk Actions */}
      {selectedKeys.size > 0 && (
        <div className="bulk-actions">
          <span>{selectedKeys.size} selected</span>
          <button className="bulk-btn" onClick={handleBulkDownload}><Download size={14} /> Download</button>
          <button className="bulk-btn danger" onClick={handleBulkDelete}><Trash2 size={14} /> Delete</button>
        </div>
      )}

      {/* Documents Table */}
      <div className="doc-table">
        <div className="doc-table-header">
          <span className="doc-th doc-col-check">
            <input type="checkbox" className="checkbox" checked={selectedKeys.size === paginatedDocs.length && paginatedDocs.length > 0} onChange={toggleSelectAll} />
          </span>
          <span className="doc-th doc-col-name">Document Name</span>
          <span className="doc-th doc-col-date">Document Date</span>
          <span className="doc-th doc-col-ops">Operation Selected</span>
        </div>
        {loading ? (
          <div className="empty-state">Loading documents from S3...</div>
        ) : paginatedDocs.length > 0 ? (
          paginatedDocs.map((doc) => (
            <div key={doc.key} className="doc-row">
              <span className="doc-td doc-col-check">
                <input type="checkbox" className="checkbox" checked={selectedKeys.has(doc.key)} onChange={() => toggleSelect(doc.key)} />
              </span>
              <span className="doc-td doc-col-name">
                <FileText size={20} className="file-icon" />
                <span>{doc.fileName}</span>
              </span>
              <span className="doc-td doc-col-date">
                {new Date(doc.lastModified).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
              <span className="doc-td doc-col-ops">
                <button className="op-btn" title="Edit"><Pencil size={13.5} /></button>
                <button className="op-btn" title="Delete" onClick={() => handleDelete(doc.key)}><Trash2 size={13} /></button>
                <button className="op-btn" title="Download" onClick={() => handleDownload(doc.key)}><Download size={12} /></button>
              </span>
            </div>
          ))
        ) : (
          <div className="empty-state">No documents found</div>
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
    </div>
  );
}
