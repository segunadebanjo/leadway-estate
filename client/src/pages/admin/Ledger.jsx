import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../api.js';
import { Badge, Card, ErrorNote, Field, Loading, MemberPicker, Modal, Money, PageHeader, Pager, SearchField, Table, useDebounced, Tabs, useFetch, useSubmit } from '../../components/ui.jsx';
import { CorrectPaymentModal, ReverseBillModal } from '../../components/Corrections.jsx';
import { METHOD, addDaysIso, date, dateTime, fullName, humanize, koboToInput, naira, toKobo, todayIso } from '../../format.js';

export default function Ledger() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'invoices';
  return (
    <>
      <PageHeader title="Ledger" subtitle="Invoices, payments and fee types" actions={<Link className="btn" to="/admin/receive-payment">Receive payment</Link>} />
      <Tabs active={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ key: 'invoices', label: 'Invoices' }, { key: 'payments', label: 'Payments' }, { key: 'assign', label: 'Assign a fee' }, { key: 'fees', label: 'Fee types' }]} />
      {tab === 'invoices' && <Invoices />}
      {tab === 'payments' && <Payments />}
      {tab === 'assign' && <AssignFee />}
      {tab === 'fees' && <FeeTypes />}
    </>
  );
}

function Invoices() {
  const [f, setF] = useState({ q: '', status: 'OPEN', overdue: '', feeTypeId: '', page: 1 });
  const fees = useFetch('/api/ledger/fee-types');
  const { data, error, reload } = useFetch(`/api/ledger/invoices${qs({ ...f, q: useDebounced(f.q), pageSize: 50 })}`);
  const [fixBill, setFixBill] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value, page: 1 });
  return (
    <Card>
      <div className="filters">
        <SearchField label="Member" placeholder="Name, LWE-ID, plot" value={f.q} onChange={(v) => setF({ ...f, q: v, page: 1 })} />
        <Field label="Status"><select value={f.status} onChange={set('status')}><option value="">All</option><option value="OPEN">Open (unpaid + part-paid)</option><option value="UNPAID">Unpaid</option><option value="PARTIAL">Part-paid</option><option value="PAID">Paid</option><option value="VOID">Void</option></select></Field>
        <Field label="Fee"><select value={f.feeTypeId} onChange={set('feeTypeId')}><option value="">All</option>{fees.data?.rows.map((ft) => <option key={ft.id} value={ft.id}>{ft.name}</option>)}</select></Field>
        <Field label="Overdue"><select value={f.overdue} onChange={set('overdue')}><option value="">Any</option><option value="true">Overdue only</option></select></Field>
      </div>
      <ErrorNote error={error} />
      {!data ? <Loading /> : (
        <>
          <Table rows={data.rows} empty="No invoices match." columns={[
            { key: 'member', label: 'Member', render: (i) => <Link to={`/admin/residents/${i.user.id}`}>{fullName(i.user)}</Link> },
            { key: 'id', label: 'ID', render: (i) => i.user.membershipId },
            { key: 'description', label: 'Description', render: (i) => <>{i.description}{i.debitNote && <> · <Link to={`/debit-notes/${i.debitNote.id}`}>{i.debitNote.noteNo}</Link></>}</> },
            { key: 'dueDate', label: 'Due', render: (i) => date(i.dueDate) },
            { key: 'status', label: 'Status', render: (i) => <Badge status={i.status} /> },
            { key: 'amount', label: 'Amount', align: 'right', render: (i) => <Money v={i.amount} /> },
            { key: 'balance', label: 'Balance', align: 'right', render: (i) => (i.status === 'VOID' ? '—' : <Money v={i.amount - i.amountPaid} />) },
            { key: 'act', label: '', align: 'right', render: (i) => i.status !== 'VOID' && <button className="btn btn-ghost btn-small" onClick={() => setFixBill(i)}>Reverse / lower</button> },
          ]}
          footer={<tr><td colSpan={5}>Total ({data.total} invoices)</td><td className="right"><Money v={data.totals.amount} /></td><td className="right"><Money v={data.totals.amount - data.totals.paid} /></td><td /></tr>} />
          {fixBill && <ReverseBillModal bill={fixBill} onClose={() => setFixBill(null)} onDone={() => { setFixBill(null); reload(); }} />}
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setF({ ...f, page })} />
        </>
      )}
    </Card>
  );
}

function Payments() {
  const [f, setF] = useState({ q: '', method: '', status: '', from: '', to: '', page: 1 });
  const { data, error, reload } = useFetch(`/api/payments${qs({ ...f, q: useDebounced(f.q), pageSize: 50 })}`);
  const [fixPayment, setFixPayment] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value, page: 1 });
  return (
    <Card>
      <div className="filters">
        <SearchField placeholder="Receipt, reference, member" value={f.q} onChange={(v) => setF({ ...f, q: v, page: 1 })} />
        <Field label="Method"><select value={f.method} onChange={set('method')}><option value="">All</option>{Object.entries(METHOD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Status"><select value={f.status} onChange={set('status')}><option value="">All</option><option value="COMPLETED">Completed</option><option value="REVERSED">Reversed</option></select></Field>
        <Field label="From"><input type="date" value={f.from} onChange={set('from')} /></Field>
        <Field label="To"><input type="date" value={f.to} onChange={set('to')} /></Field>
      </div>
      <ErrorNote error={error} />
      {!data ? <Loading /> : (
        <>
          <p className="muted">Cash received in this view (excluding credit applications and reversals): <strong>{naira(data.totals.received)}</strong></p>
          <Table rows={data.rows} empty="No payments match." columns={[
            { key: 'paidAt', label: 'Date', render: (p) => dateTime(p.paidAt) },
            { key: 'receiptNo', label: 'Receipt', render: (p) => <Link to={`/receipts/${p.id}`}>{p.receiptNo}</Link> },
            { key: 'member', label: 'Member', render: (p) => <Link to={`/admin/residents/${p.user.id}`}>{fullName(p.user)} ({p.user.membershipId})</Link> },
            { key: 'method', label: 'Method', render: (p) => METHOD[p.method] },
            { key: 'reference', label: 'Reference' },
            { key: 'status', label: 'Status', render: (p) => <Badge status={p.status} /> },
            { key: 'amount', label: 'Amount', align: 'right', render: (p) => <Money v={p.amount} /> },
            { key: 'act', label: '', align: 'right', render: (p) => p.status === 'COMPLETED' && <button className="btn btn-ghost btn-small" onClick={() => setFixPayment(p.id)}>Correct</button> },
          ]} />
          {fixPayment && <CorrectPaymentModal paymentId={fixPayment} onClose={() => setFixPayment(null)} onDone={() => { setFixPayment(null); reload(); }} />}
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setF({ ...f, page })} />
        </>
      )}
    </Card>
  );
}

function AssignFee() {
  const fees = useFetch('/api/ledger/fee-types');
  const [v, setV] = useState({ feeTypeId: '', amount: '', description: '', dueDate: addDaysIso(todayIso(), 14), period: '', allActive: false });
  const [members, setMembers] = useState([]);
  const [result, setResult] = useState(null);
  const active = fees.data?.rows.filter((f) => f.isActive) || [];
  const ft = active.find((f) => String(f.id) === v.feeTypeId);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const { busy, error, run, setError } = useSubmit(async () => {
    const amount = v.amount ? toKobo(v.amount) : undefined;
    if (v.amount && !amount) return setError(new Error('Enter a valid amount'));
    if (!v.allActive && !members.length) return setError(new Error('Add at least one resident'));
    const n = v.allActive ? 'every active resident' : `${members.length} resident(s)`;
    if (!confirm(`Bill ${n} ${naira(amount ?? ft.amount)} for "${v.description || ft.name}"?`)) return;
    setResult(await api.post('/api/ledger/invoices/assign', { feeTypeId: Number(v.feeTypeId), amount, description: v.description || null, dueDate: v.dueDate, period: v.period || null, allActive: v.allActive, userIds: members.map((m) => m.id) }));
    setMembers([]);
  });
  return (
    <Card title="Assign a one-off fee" className="narrow">
      <p className="muted">For ad-hoc charges such as an Electricity Connection Fee: create the fee type first (Fee types tab), then bill it to chosen residents. Any account credit they hold is applied straight away.</p>
      <form onSubmit={run} style={{ maxWidth: 640 }}>
        <ErrorNote error={error} />
        {result && <div className="alert alert-good">{result.created} invoice(s) created{result.duplicates ? `, ${result.duplicates} skipped (already billed for this label)` : ''}.</div>}
        <Field label="Fee type"><select value={v.feeTypeId} onChange={(e) => setV({ ...v, feeTypeId: e.target.value, amount: '' })} required><option value="">Choose…</option>{active.map((f) => <option key={f.id} value={f.id}>{f.name} ({naira(f.amount)}, {humanize(f.frequency)})</option>)}</select></Field>
        <div className="form-row">
          <Field label="Amount (₦)" hint={ft ? `Leave blank for the standard ${naira(ft.amount)}` : ''}><input inputMode="decimal" value={v.amount} onChange={set('amount')} placeholder={ft ? koboToInput(ft.amount) : ''} /></Field>
          <Field label="Due date"><input type="date" value={v.dueDate} onChange={set('dueDate')} required /></Field>
        </div>
        <div className="form-row">
          <Field label="Description on the bill"><input value={v.description} onChange={set('description')} placeholder={ft?.name || ''} /></Field>
          <Field label="Label (optional)" hint="e.g. 2026-Q4. With a label, the same fee can't be billed twice to one member."><input value={v.period} onChange={set('period')} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={v.allActive} onChange={set('allActive')} /> Bill every active resident</label>
        {!v.allActive && (
          <Field label={`Residents (${members.length})`}>
            <MemberPicker value={null} onChange={(m) => m && !members.some((x) => x.id === m.id) && setMembers([...members, m])} placeholder="Search and add residents…" />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {members.map((m) => <span key={m.id} className="badge badge-info">{m.firstName} {m.lastName} ({m.membershipId}) <button type="button" style={{ border: 0, background: 'none', cursor: 'pointer', color: 'inherit' }} onClick={() => setMembers(members.filter((x) => x.id !== m.id))}>×</button></span>)}
            </div>
          </Field>
        )}
        <button className="btn" disabled={busy || !ft}>{busy ? 'Billing…' : 'Create invoices'}</button>
      </form>
    </Card>
  );
}

function FeeTypes() {
  const { data, error, reload } = useFetch('/api/ledger/fee-types');
  const [editing, setEditing] = useState(null);
  return (
    <Card title="Fee types" actions={<button className="btn" onClick={() => setEditing({})}>New fee type</button>}>
      <p className="muted">Monthly fees are billed to every active resident on the 1st; annual fees each January. Changing an amount affects future invoices only.</p>
      <ErrorNote error={error} />
      {!data ? <Loading /> : (
        <Table rows={data.rows} onRowClick={setEditing} columns={[
          { key: 'name', label: 'Name', render: (f) => <strong>{f.name}</strong> },
          { key: 'code', label: 'Code' },
          { key: 'frequency', label: 'Billing', render: (f) => humanize(f.frequency) },
          { key: 'isActive', label: 'Status', render: (f) => (f.isActive ? <Badge status="ACTIVE" /> : <Badge status="INACTIVE" label="Inactive" />) },
          { key: 'amount', label: 'Amount', align: 'right', render: (f) => <Money v={f.amount} /> },
        ]} />
      )}
      {editing && <FeeTypeForm fee={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </Card>
  );
}

function FeeTypeForm({ fee, onClose, onSaved }) {
  const isNew = !fee.id;
  const [v, setV] = useState({ name: fee.name || '', amount: fee.amount ? koboToInput(fee.amount) : '', frequency: fee.frequency || 'ONE_OFF', description: fee.description || '', isActive: fee.isActive ?? true });
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const { busy, error, run, setError } = useSubmit(async () => {
    const amount = toKobo(v.amount);
    if (!amount) return setError(new Error('Enter a valid amount'));
    const body = { name: v.name, amount, description: v.description || null, isActive: v.isActive };
    if (isNew) await api.post('/api/ledger/fee-types', { ...body, frequency: v.frequency });
    else await api.patch(`/api/ledger/fee-types/${fee.id}`, body);
    onSaved();
  });
  return (
    <Modal title={isNew ? 'New fee type' : `Edit ${fee.name}`} onClose={onClose}>
      <form onSubmit={run}>
        <ErrorNote error={error} />
        <Field label="Name"><input value={v.name} onChange={set('name')} required /></Field>
        <div className="form-row">
          <Field label="Amount (₦)"><input inputMode="decimal" value={v.amount} onChange={set('amount')} required /></Field>
          <Field label="Billing" hint={isNew ? '' : 'Cannot be changed after creation'}>
            <select value={v.frequency} onChange={set('frequency')} disabled={!isNew}><option value="ONE_OFF">One-off (assigned by hand)</option><option value="MONTHLY">Monthly (automatic)</option><option value="ANNUAL">Annual (automatic)</option></select>
          </Field>
        </div>
        <Field label="Description"><input value={v.description} onChange={set('description')} /></Field>
        <label className="check"><input type="checkbox" checked={v.isActive} onChange={set('isActive')} /> Active</label>
        <button className="btn" disabled={busy}>Save</button>
      </form>
    </Modal>
  );
}
