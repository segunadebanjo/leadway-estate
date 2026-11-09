import { useState } from 'react';
import { api, qs } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Card, ErrorNote, Field, Loading, Modal, PageHeader, SearchField, Table, useDebounced, useFetch, useSubmit } from '../components/ui.jsx';
import { date } from '../format.js';

const size = (b) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);

export default function Documents() {
  const { user } = useAuth();
  const isAdmin = user.role === 'ADMIN';
  const [category, setCategory] = useState('');
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const { data, error, reload } = useFetch(`/api/documents${qs({ category, q })}`);
  const remove = async (d) => {
    if (!confirm(`Delete "${d.title}"? This cannot be undone.`)) return;
    await api.del(`/api/documents/${d.id}`);
    reload();
  };
  return (
    <>
      <PageHeader title="Document centre" subtitle="Constitution, minutes, financial reports, circulars and forms." actions={isAdmin && <button className="btn" onClick={() => setUploading(true)}>Upload document</button>} />
      <ErrorNote error={error} />
      {!data ? (
        <Loading />
      ) : (
        <Card>
          <div className="filters">
            <SearchField placeholder="Title or file name" value={search} onChange={setSearch} />
            <Field label="Category">
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All</option>
                {data.categories.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
          </div>
          <Table
            rows={data.rows}
            empty="No documents yet."
            columns={[
              { key: 'title', label: 'Title', render: (d) => <strong>{d.title}</strong> },
              { key: 'category', label: 'Category' },
              { key: 'createdAt', label: 'Added', render: (d) => date(d.createdAt) },
              { key: 'size', label: 'Size', render: (d) => `${d.mimeType === 'application/pdf' ? 'PDF' : 'Word'} · ${size(d.sizeBytes)}` },
              {
                key: 'actions',
                label: '',
                align: 'right',
                render: (d) => (
                  <span className="actions" style={{ justifyContent: 'flex-end' }}>
                    <a className="btn btn-small" href={`/api/documents/${d.id}/download`}>Download</a>
                    {isAdmin && <button className="btn btn-small btn-ghost" onClick={() => remove(d)}>Delete</button>}
                  </span>
                ),
              },
            ]}
          />
        </Card>
      )}
      {uploading && data && <UploadModal categories={data.categories} onClose={() => setUploading(false)} onDone={() => { setUploading(false); reload(); }} />}
    </>
  );
}

function UploadModal({ categories, onClose, onDone }) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState(categories[0]);
  const [file, setFile] = useState(null);
  const { busy, error, run } = useSubmit(async () => {
    const fd = new FormData();
    fd.append('title', title);
    fd.append('category', category);
    fd.append('file', file);
    await api.upload('/api/documents', fd);
    onDone();
  });
  return (
    <Modal title="Upload document" onClose={onClose}>
      <form onSubmit={run}>
        <ErrorNote error={error} />
        <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
        <Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((c) => <option key={c}>{c}</option>)}</select>
        </Field>
        <Field label="File" hint="PDF or Word (.pdf, .doc, .docx), up to 10 MB. The file's content is checked.">
          <input type="file" accept=".pdf,.doc,.docx" onChange={(e) => setFile(e.target.files[0])} required />
        </Field>
        <button className="btn" disabled={busy || !file}>{busy ? 'Uploading…' : 'Upload'}</button>
      </form>
    </Modal>
  );
}
