import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../../api.js';
import { Badge, Card, ErrorNote, Field, Loading, Modal, PageHeader, Pager, SearchField, Table, useDebounced, useFetch, useSubmit } from '../../components/ui.jsx';
import { dateTime, fullName } from '../../format.js';

export default function Requests() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState('ACTIVE');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const { data, error, reload } = useFetch(`/api/admin/requests${qs({ status, q, page, pageSize: 50 })}`);
  const [open, setOpen] = useState(params.get('open') ? Number(params.get('open')) : null);
  const current = data?.rows.find((r) => r.id === open);
  return (
    <>
      <PageHeader title="Requests & complaints" subtitle="Raised by residents from their portal" />
      <Card>
        <div className="filters">
          <SearchField placeholder="Title, resident, LWE-ID, plot" value={search} onChange={(v) => { setSearch(v); setPage(1); }} />
          <Field label="Status"><select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="ACTIVE">Open + in progress</option><option value="OPEN">Open</option><option value="IN_PROGRESS">In progress</option><option value="RESOLVED">Resolved</option><option value="CLOSED">Closed</option><option value="">All</option></select></Field>
        </div>
        <ErrorNote error={error} />
        {!data ? <Loading /> : (
          <>
            <Table rows={data.rows} onRowClick={(r) => setOpen(r.id)} empty="No requests here." columns={[
              { key: 'createdAt', label: 'Raised', render: (r) => dateTime(r.createdAt) },
              { key: 'member', label: 'Resident', render: (r) => `${fullName(r.user)} (${r.user.membershipId})` },
              { key: 'where', label: 'Plot', render: (r) => r.user.plotNumber },
              { key: 'category', label: 'Category' },
              { key: 'title', label: 'Title', render: (r) => <strong>{r.title}</strong> },
              { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
            ]} />
            <Pager page={page} pageSize={50} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      {current && <RequestModal r={current} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); reload(); }} />}
    </>
  );
}

function RequestModal({ r, onClose, onSaved }) {
  const [status, setStatus] = useState(r.status === 'OPEN' ? 'IN_PROGRESS' : r.status);
  const [note, setNote] = useState(r.adminNote || '');
  const { busy, error, run } = useSubmit(async () => {
    await api.patch(`/api/admin/requests/${r.id}`, { status, adminNote: note || null });
    onSaved();
  });
  return (
    <Modal title={r.title} onClose={onClose}>
      <p className="muted">{r.category} · {fullName(r.user)} ({r.user.membershipId}) · Plot {r.user.plotNumber || '—'}, {r.user.street || ''} · {r.user.phone || 'no phone'} · {dateTime(r.createdAt)}</p>
      <p style={{ whiteSpace: 'pre-wrap' }}>{r.description}</p>
      <form onSubmit={run}>
        <ErrorNote error={error} />
        <Field label="Status"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="OPEN">Open</option><option value="IN_PROGRESS">In progress</option><option value="RESOLVED">Resolved</option><option value="CLOSED">Closed</option></select></Field>
        <Field label="Note to the resident" hint="The resident is notified of the update (and emailed when resolved)."><textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <button className="btn" disabled={busy}>Update</button>
      </form>
    </Modal>
  );
}
