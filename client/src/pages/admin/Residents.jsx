import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../../api.js';
import { Badge, Card, ErrorNote, Field, Loading, Modal, Money, PageHeader, Pager, Table, useFetch, useSubmit } from '../../components/ui.jsx';
import { humanize } from '../../format.js';

export default function Residents() {
  const navigate = useNavigate();
  const [f, setF] = useState({ q: '', status: 'active', occupancy: '', role: 'RESIDENT', owing: '', page: 1 });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const { data, error, reload } = useFetch(`/api/residents${qs({ ...f, pageSize: 50 })}`);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value, page: 1 });
  return (
    <>
      <PageHeader title="Residents" subtitle="Members, staff and their balances" actions={<button className="btn" onClick={() => setCreating(true)}>Add member</button>} />
      {created && <CredentialsNote data={created} onClose={() => setCreated(null)} />}
      <Card>
        <div className="filters">
          <Field label="Search"><input className="grow" placeholder="Name, LWE-ID, plot, phone, email" value={f.q} onChange={set('q')} /></Field>
          <Field label="Status"><select value={f.status} onChange={set('status')}><option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option></select></Field>
          <Field label="Occupancy"><select value={f.occupancy} onChange={set('occupancy')}><option value="">All</option><option value="OWNER">Owners</option><option value="TENANT">Tenants</option></select></Field>
          <Field label="Type"><select value={f.role} onChange={set('role')}><option value="RESIDENT">Residents</option><option value="ADMIN">Executives (admin)</option><option value="SECURITY">Security staff</option><option value="ALL">Everyone</option></select></Field>
          <Field label="Balance"><select value={f.owing} onChange={set('owing')}><option value="">All</option><option value="true">Owing only</option></select></Field>
        </div>
        <ErrorNote error={error} />
        {!data ? <Loading /> : (
          <>
            <Table
              rows={data.rows}
              onRowClick={(r) => navigate(`/admin/residents/${r.id}`)}
              empty="No members match."
              columns={[
                { key: 'membershipId', label: 'ID', render: (r) => <strong>{r.membershipId}</strong> },
                { key: 'name', label: 'Name', render: (r) => <>{r.firstName} {r.lastName}{r.role !== 'RESIDENT' && <> <Badge status="ACTIVE" label={humanize(r.role)} /></>}</> },
                { key: 'plot', label: 'Plot / street', render: (r) => [r.plotNumber, r.street].filter(Boolean).join(', ') },
                { key: 'occupancy', label: 'Occupancy', render: (r) => humanize(r.occupancyType) },
                { key: 'phone', label: 'Phone' },
                { key: 'status', label: 'Status', render: (r) => r.isActive ? <Badge status="ACTIVE" /> : <Badge status="INACTIVE" label="Inactive" /> },
                { key: 'outstanding', label: 'Outstanding', align: 'right', render: (r) => <Money v={r.outstanding} className={r.outstanding ? 'text-bad' : ''} /> },
                { key: 'credit', label: 'Credit', align: 'right', render: (r) => r.creditBalance ? <Money v={r.creditBalance} className="text-good" /> : '—' },
              ]}
            />
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setF({ ...f, page })} />
          </>
        )}
      </Card>
      {creating && <MemberForm onClose={() => setCreating(false)} onSaved={(r) => { setCreating(false); setCreated(r); reload(); }} />}
    </>
  );
}

export function CredentialsNote({ data, onClose }) {
  return (
    <div className="alert alert-info" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'start' }}>
      <div>
        {data.user && <div><strong>{data.user.firstName} {data.user.lastName}</strong> – membership ID <strong>{data.user.membershipId}</strong>{data.invoicesCreated ? ` · ${data.invoicesCreated} invoice(s) raised for the current period` : ''}.</div>}
        <div>Temporary password: <code style={{ fontSize: '1.05rem', fontWeight: 700 }}>{data.temporaryPassword}</code> {data.emailed ? '(also emailed)' : '(give it to the member; they must change it at first sign-in)'}</div>
        <div className="muted" style={{ fontSize: '.85rem' }}>This password is shown only once.</div>
      </div>
      <button className="btn btn-ghost btn-small" onClick={onClose}>Dismiss</button>
    </div>
  );
}

export function MemberForm({ member, onClose, onSaved }) {
  const editing = !!member;
  const [v, setV] = useState({
    firstName: member?.firstName || '', lastName: member?.lastName || '', email: member?.email || '', phone: member?.phone || '',
    plotNumber: member?.plotNumber || '', street: member?.street || '', occupancyType: member?.occupancyType || 'OWNER',
    role: member?.role || 'RESIDENT', moveInDate: member?.moveInDate ? member.moveInDate.slice(0, 10) : '', sendEmail: true,
  });
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const { busy, error, run } = useSubmit(async () => {
    const body = { ...v, moveInDate: v.moveInDate || null, phone: v.phone || null, plotNumber: v.plotNumber || null, street: v.street || null };
    if (editing) {
      delete body.sendEmail;
      onSaved(await api.patch(`/api/residents/${member.id}`, body));
    } else onSaved(await api.post('/api/residents', body));
  });
  return (
    <Modal title={editing ? `Edit ${member.membershipId}` : 'Add member'} onClose={onClose}>
      <form onSubmit={run}>
        <ErrorNote error={error} />
        <div className="form-row">
          <Field label="First name"><input value={v.firstName} onChange={set('firstName')} required /></Field>
          <Field label="Last name"><input value={v.lastName} onChange={set('lastName')} required /></Field>
        </div>
        <div className="form-row">
          <Field label="Email"><input type="email" value={v.email} onChange={set('email')} required /></Field>
          <Field label="Phone"><input value={v.phone} onChange={set('phone')} placeholder="0803 123 4567" /></Field>
        </div>
        <div className="form-row">
          <Field label="Plot number"><input value={v.plotNumber} onChange={set('plotNumber')} /></Field>
          <Field label="Street"><input value={v.street} onChange={set('street')} /></Field>
        </div>
        <div className="form-row">
          <Field label="Occupancy"><select value={v.occupancyType} onChange={set('occupancyType')}><option value="OWNER">Owner</option><option value="TENANT">Tenant</option></select></Field>
          <Field label="Moved in"><input type="date" value={v.moveInDate} onChange={set('moveInDate')} /></Field>
        </div>
        <Field label="Account type" hint="Residents are billed. Executives manage the app. Security staff only use the gate.">
          <select value={v.role} onChange={set('role')}><option value="RESIDENT">Resident</option><option value="ADMIN">Executive (admin)</option><option value="SECURITY">Security staff</option></select>
        </Field>
        {!editing && <label className="check"><input type="checkbox" checked={v.sendEmail} onChange={set('sendEmail')} /> Email the sign-in details to the member</label>}
        {!editing && <p className="muted" style={{ fontSize: '.85rem' }}>A membership ID (LWE-…) is assigned automatically and cannot be changed. A resident is billed for the current month straight away.</p>}
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create member'}</button>
      </form>
    </Modal>
  );
}
