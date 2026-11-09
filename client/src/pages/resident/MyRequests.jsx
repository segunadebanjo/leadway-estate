import { useState } from 'react';
import { api } from '../../api.js';
import { Badge, Card, ErrorNote, Field, Loading, PageHeader, Table, useFetch, useSubmit } from '../../components/ui.jsx';
import { dateTime } from '../../format.js';

export default function MyRequests() {
  const { data, error, reload } = useFetch('/api/me/requests');
  const [v, setV] = useState({ category: '', title: '', description: '' });
  const [sent, setSent] = useState(false);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const { busy, error: err, run } = useSubmit(async () => {
    await api.post('/api/me/requests', { ...v, category: v.category || data.categories[0] });
    setV({ category: '', title: '', description: '' });
    setSent(true);
    reload();
  });
  return (
    <>
      <PageHeader title="Requests & complaints" subtitle="Report a fault or raise a concern with the executives" />
      <div className="grid grid-2">
        <Card title="New request">
          {!data ? <Loading /> : (
            <form onSubmit={run}>
              <ErrorNote error={err} />
              {sent && <div className="alert alert-good">Sent. You'll be notified when the office updates it.</div>}
              <Field label="Category"><select value={v.category || data.categories[0]} onChange={set('category')}>{data.categories.map((c) => <option key={c}>{c}</option>)}</select></Field>
              <Field label="Title"><input value={v.title} onChange={(e) => { set('title')(e); setSent(false); }} required maxLength={120} placeholder="e.g. Street light out on Palm Close" /></Field>
              <Field label="Details"><textarea value={v.description} onChange={set('description')} required maxLength={2000} /></Field>
              <button className="btn" disabled={busy}>Send request</button>
            </form>
          )}
        </Card>
        <Card title="My requests">
          <ErrorNote error={error} />
          {!data ? <Loading /> : (
            <Table rows={data.rows} empty="You haven't raised any requests." columns={[
              { key: 'title', label: 'Request', render: (r) => <><strong>{r.title}</strong><div className="muted">{r.category} · {dateTime(r.createdAt)}</div>{r.adminNote && <div style={{ marginTop: 4 }}>Office: {r.adminNote}</div>}</> },
              { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
              { key: 'act', label: '', align: 'right', render: (r) => ['OPEN', 'IN_PROGRESS', 'RESOLVED'].includes(r.status) && <button className="btn btn-ghost btn-small" onClick={async () => { await api.post(`/api/me/requests/${r.id}/close`); reload(); }}>Close</button> },
            ]} />
          )}
        </Card>
      </div>
    </>
  );
}
