import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../api.js';
import { Badge, Card, ErrorNote, Field, Loading, MemberPicker, Modal, Money, PageHeader, Table, useFetch, useSubmit } from '../../components/ui.jsx';
import { addDaysIso, date, koboToInput, naira, toKobo, todayIso } from '../../format.js';

const STATE = { PAID: ['PAID', 'Paid'], PART_PAID: ['PARTIAL', 'Part paid'], OVERDUE: ['OVERDUE', 'Overdue'], UPCOMING: ['PENDING', 'Upcoming'] };

export default function Plans() {
  const [status, setStatus] = useState('ACTIVE');
  const { data, error, reload } = useFetch(`/api/plans${qs({ status })}`);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  return (
    <>
      <PageHeader title="Payment plans" subtitle="Let a member clear what they owe in monthly instalments. Payments keep settling their oldest bills first; the plan tracks the money paid since it was agreed." actions={<button className="btn" onClick={() => setCreating(true)}>New payment plan</button>} />
      <Card>
        <div className="filters">
          <Field label="Status"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="ACTIVE">Active</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancelled</option><option value="ALL">All</option></select></Field>
        </div>
        <ErrorNote error={error} />
        {!data ? <Loading /> : (
          <PlanTable rows={data.rows} onOpen={setOpen} />
        )}
      </Card>
      {creating && <PlanForm onClose={() => setCreating(false)} onSaved={() => { setCreating(false); reload(); }} />}
      {open && <PlanModal plan={data.rows.find((p) => p.id === open)} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); reload(); }} />}
    </>
  );
}

export function PlanTable({ rows, onOpen, hideMember }) {
  return (
    <Table rows={rows} onRowClick={(p) => onOpen(p.id)} empty="No payment plans here." columns={[
      ...(hideMember ? [] : [{ key: 'member', label: 'Member', render: (p) => <><strong>{p.user.membershipId}</strong> {p.user.firstName} {p.user.lastName}</> }]),
      { key: 'total', label: 'Agreed', align: 'right', render: (p) => <Money v={p.totalAmount} /> },
      { key: 'instalments', label: 'Instalments', render: (p) => `${p.instalments} × ~${naira(Math.floor(p.totalAmount / p.instalments))}` },
      { key: 'paid', label: 'Paid', align: 'right', render: (p) => <Money v={p.paid} /> },
      { key: 'remaining', label: 'Remaining', align: 'right', render: (p) => <Money v={p.remaining} /> },
      { key: 'state', label: 'Status', render: (p) => (p.status !== 'ACTIVE' ? <Badge status={p.status} /> : p.behind > 0 ? <Badge status="OVERDUE" label={`Behind ${naira(p.behind)}`} /> : <Badge status="ACTIVE" label="On track" />) },
      { key: 'next', label: 'Next due', render: (p) => (p.status === 'ACTIVE' && p.nextInstalment ? `${date(p.nextInstalment.dueDate)}` : '—') },
    ]} />
  );
}

export function PlanForm({ member: fixedMember, onClose, onSaved }) {
  const [member, setMember] = useState(fixedMember || null);
  const [v, setV] = useState({ instalments: 3, firstDueDate: addDaysIso(todayIso(), 14), total: '', note: '', notify: true });
  const [preview, setPreview] = useState(null);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const body = () => ({ userId: member.id, instalments: Number(v.instalments), firstDueDate: v.firstDueDate, ...(v.total ? { totalAmount: toKobo(v.total) } : {}), note: v.note || null });
  useEffect(() => {
    if (!member || !v.firstDueDate || !(Number(v.instalments) >= 2) || (v.total && !toKobo(v.total))) return setPreview(null);
    const t = setTimeout(() => api.post('/api/plans/preview', body()).then(setPreview).catch(() => setPreview(null)), 250);
    return () => clearTimeout(t);
  }, [member, v.instalments, v.firstDueDate, v.total]); // eslint-disable-line react-hooks/exhaustive-deps
  const { busy, error, run } = useSubmit(async () => { await api.post('/api/plans', { ...body(), notify: v.notify }); onSaved(); });
  return (
    <Modal title="New payment plan" onClose={onClose}>
      <form onSubmit={run}>
        <ErrorNote error={error} />
        {!fixedMember && <Field label="Member"><MemberPicker value={member} onChange={setMember} autoFocus /></Field>}
        <div className="form-row">
          <Field label="Number of monthly instalments"><input type="number" min="2" max="24" value={v.instalments} onChange={set('instalments')} required /></Field>
          <Field label="First instalment due"><input type="date" min={todayIso()} value={v.firstDueDate} onChange={set('firstDueDate')} required /></Field>
        </div>
        <Field label="Amount to spread (₦)" hint={preview ? `Leave blank for everything owed now: ${naira(preview.outstanding)}` : 'Leave blank for everything the member owes now'}>
          <input inputMode="decimal" value={v.total} onChange={set('total')} placeholder={preview ? koboToInput(preview.outstanding) : ''} />
        </Field>
        <Field label="Note (optional)"><input value={v.note} onChange={set('note')} placeholder="e.g. agreed at the October meeting" /></Field>
        {preview && preview.schedule.length > 0 && (
          <div className="preview-scroll" style={{ maxHeight: 220 }}>
            <Table rows={preview.schedule} rowKey="number" columns={[{ key: 'number', label: '#' }, { key: 'dueDate', label: 'Due', render: (s) => date(s.dueDate) }, { key: 'amount', label: 'Amount', align: 'right', render: (s) => <Money v={s.amount} /> }]} />
          </div>
        )}
        {preview && preview.totalAmount <= 0 && <div className="alert alert-warn">This member owes nothing.</div>}
        <label className="check"><input type="checkbox" checked={v.notify} onChange={set('notify')} /> Tell the member (app notice and email)</label>
        <button className="btn" disabled={busy || !member || !preview?.schedule.length}>{busy ? 'Saving…' : 'Agree payment plan'}</button>
      </form>
    </Modal>
  );
}

export function PlanModal({ plan, onClose, onChanged }) {
  const [err, setErr] = useState(null);
  if (!plan) return null;
  const cancel = async () => {
    const reason = prompt('Why is the plan being cancelled?');
    if (!reason) return;
    try { await api.post(`/api/plans/${plan.id}/cancel`, { reason }); onChanged(); } catch (e) { setErr(e); }
  };
  return (
    <Modal title={`Payment plan · ${plan.user.membershipId} ${plan.user.firstName} ${plan.user.lastName}`} onClose={onClose}>
      <ErrorNote error={err} />
      <p className="muted" style={{ marginTop: 0 }}>
        {naira(plan.totalAmount)} in {plan.instalments} monthly instalments, agreed {date(plan.createdAt)}. Paid {naira(plan.paid)}, remaining {naira(plan.remaining)}.
        {plan.note && <><br />Note: {plan.note}</>}
        {plan.cancelReason && <><br />Cancelled: {plan.cancelReason}</>}
      </p>
      <Table rows={plan.schedule} rowKey="number" columns={[
        { key: 'number', label: '#' },
        { key: 'dueDate', label: 'Due', render: (s) => date(s.dueDate) },
        { key: 'amount', label: 'Amount', align: 'right', render: (s) => <Money v={s.amount} /> },
        { key: 'paidSoFar', label: 'Paid', align: 'right', render: (s) => <Money v={s.paidSoFar} /> },
        { key: 'state', label: '', render: (s) => <Badge status={STATE[s.state][0]} label={STATE[s.state][1]} /> },
      ]} />
      <div className="actions" style={{ marginTop: 12 }}>
        <Link className="btn btn-ghost" to={`/admin/residents/${plan.user.id}`}>Open member</Link>
        {plan.status === 'ACTIVE' && <button className="btn btn-danger" onClick={cancel}>Cancel plan</button>}
      </div>
    </Modal>
  );
}
