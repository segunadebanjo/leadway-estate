import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { Badge, Card, ErrorNote, Field, Loading, Modal, Money, PageHeader, Stat, Table, Tabs, useFetch, useSubmit } from '../../components/ui.jsx';
import { METHOD, date, dateTime, humanize, naira, toKobo } from '../../format.js';
import { CredentialsNote, MemberForm } from './Residents.jsx';
import { StatementView } from '../resident/Statement.jsx';
import { HouseholdPanel } from '../Household.jsx';
import { PlanForm, PlanModal, PlanTable } from './Plans.jsx';
import { IssueDebitNotes, NoteStatus } from '../DebitNotes.jsx';

export default function ResidentDetail() {
  const { id } = useParams();
  const { data, error, reload } = useFetch(`/api/residents/${id}`);
  const nav = useNavigate();
  const [tab, setTab] = useState('invoices');
  const [editing, setEditing] = useState(false);
  const [creds, setCreds] = useState(null);
  const [adjusting, setAdjusting] = useState(false);
  const [msg, setMsg] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [openPlan, setOpenPlan] = useState(null);
  const plans = useFetch(`/api/plans?status=ALL&userId=${id}`);
  const notes = useFetch(`/api/debit-notes?userId=${id}`);
  const [issuing, setIssuing] = useState(false);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const { user: u, balance: b } = data;

  const act = async (fn) => {
    setMsg(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setMsg(err);
    }
  };
  const resetPw = () => act(async () => {
    const sendEmail = confirm(`Email the new temporary password to ${u.email}?\n\nOK = email it, Cancel = just show it to me.`);
    setCreds(await api.post(`/api/residents/${u.id}/reset-password`, { sendEmail }));
  });
  const toggleActive = () => act(async () => {
    if (u.isActive && !confirm(`Deactivate ${u.firstName}? They will be signed out and no longer billed. Their history is kept.`)) return;
    await api.post(`/api/residents/${u.id}/${u.isActive ? 'deactivate' : 'reactivate'}`);
  });

  return (
    <>
      <PageHeader
        title={`${u.firstName} ${u.lastName}`}
        subtitle={<>{u.membershipId} · {humanize(u.role)}{u.role === 'RESIDENT' && ` · ${humanize(u.occupancyType)}`} · {[u.plotNumber && `Plot ${u.plotNumber}`, u.street].filter(Boolean).join(', ')} {!u.isActive && <Badge status="INACTIVE" label="Inactive" />}</>}
        actions={
          <>
            {u.role === 'RESIDENT' && u.isActive && <Link className="btn" to={`/admin/receive-payment?member=${u.id}`}>Receive payment</Link>}
            <button className="btn btn-ghost" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn btn-ghost" onClick={resetPw}>Reset password</button>
            {u.role === 'RESIDENT' && u.isActive && <button className="btn btn-ghost" onClick={() => setIssuing(true)}>Issue debit note</button>}
            {u.role === 'RESIDENT' && <button className="btn btn-ghost" onClick={() => setAdjusting(true)}>Adjust credit</button>}
            {u.role === 'RESIDENT' && b.outstanding > 0 && !plans.data?.rows.some((p) => p.status === 'ACTIVE') && <button className="btn btn-ghost" onClick={() => setPlanning(true)}>Payment plan</button>}
            <button className={`btn ${u.isActive ? 'btn-danger' : ''}`} onClick={toggleActive}>{u.isActive ? 'Deactivate' : 'Reactivate'}</button>
          </>
        }
      />
      <ErrorNote error={msg} />
      {creds && <CredentialsNote data={creds} onClose={() => setCreds(null)} />}
      <div className="stats">
        <Stat label="Outstanding" value={naira(b.outstanding)} tone={b.outstanding ? 'bad' : 'good'} hint={`${b.openInvoices} open invoice(s)`} />
        <Stat label="Overdue" value={naira(b.overdue)} tone={b.overdue ? 'bad' : undefined} hint={`${b.overdueInvoices} invoice(s) past due`} />
        <Stat label="Account credit" value={naira(b.credit)} tone={b.credit ? 'good' : undefined} hint="Applied automatically to new bills" />
        <Stat label="Total paid" value={naira(b.paid)} hint={`of ${naira(b.billed)} billed`} />
      </div>
      <Card>
        <dl className="kv" style={{ marginBottom: 8 }}>
          <dt>Email</dt><dd>{u.email}</dd>
          <dt>Phone</dt><dd>{u.phone || '—'}</dd>
          <dt>Moved in</dt><dd>{date(u.moveInDate) || '—'}</dd>
          <dt>Member since</dt><dd>{date(u.createdAt)}</dd>
          {u.mustChangePassword && (<><dt>Sign-in</dt><dd><Badge status="PENDING" label="Has not set a password yet" /></dd></>)}
        </dl>
      </Card>
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'invoices', label: `Invoices (${data.invoices.length})` }, { key: 'payments', label: `Payments (${data.payments.length})` }, ...(u.role === 'RESIDENT' ? [{ key: 'notes', label: `Debit notes (${notes.data?.rows.length ?? 0})` }] : []), { key: 'statement', label: 'Statement of account' }, { key: 'credit', label: 'Credit history' }, ...(u.role === 'RESIDENT' ? [{ key: 'plans', label: `Payment plans (${plans.data?.rows.length ?? 0})` }, { key: 'household', label: 'Household & vehicles' }] : [])]} />
      {tab === 'plans' && <Card>{!plans.data ? <Loading /> : <PlanTable rows={plans.data.rows} hideMember onOpen={setOpenPlan} />}</Card>}
      {tab === 'household' && <HouseholdPanel userId={u.id} />}
      {tab === 'notes' && (
        <Card>
          {!notes.data ? <Loading /> : (
            <Table rows={notes.data.rows} onRowClick={(n) => nav(`/debit-notes/${n.id}`)} empty="No debit notes yet. Use “Issue debit note” to bill this member for the year." columns={[
              { key: 'noteNo', label: 'Debit note', render: (n) => <Link to={`/debit-notes/${n.id}`}>{n.noteNo}</Link> },
              { key: 'year', label: 'Year' },
              { key: 'dueDate', label: 'Pay by', render: (n) => date(n.dueDate) },
              { key: 'status', label: 'Status', render: (n) => <NoteStatus n={n} /> },
              { key: 'amount', label: 'Amount', align: 'right', render: (n) => <Money v={n.amount} /> },
              { key: 'balance', label: 'Balance', align: 'right', render: (n) => (n.status === 'VOID' ? '—' : <Money v={n.balance} />) },
            ]} />
          )}
        </Card>
      )}
      {issuing && <IssueDebitNotes member={u} onClose={() => setIssuing(false)} onDone={() => { setIssuing(false); setTab('notes'); notes.reload(); reload(); }} />}
      {planning && <PlanForm member={u} onClose={() => setPlanning(false)} onSaved={() => { setPlanning(false); setTab('plans'); plans.reload(); reload(); }} />}
      {openPlan && <PlanModal plan={plans.data?.rows.find((p) => p.id === openPlan)} onClose={() => setOpenPlan(null)} onChanged={() => { setOpenPlan(null); plans.reload(); }} />}
      {tab === 'invoices' && (
        <Card>
          <Table rows={data.invoices} empty="No invoices." columns={[
            { key: 'description', label: 'Description' },
            { key: 'dueDate', label: 'Due', render: (i) => date(i.dueDate) },
            { key: 'status', label: 'Status', render: (i) => <Badge status={i.status} /> },
            { key: 'amount', label: 'Amount', align: 'right', render: (i) => <Money v={i.amount} /> },
            { key: 'paid', label: 'Paid', align: 'right', render: (i) => <Money v={i.amountPaid} /> },
            { key: 'balance', label: 'Balance', align: 'right', render: (i) => i.status === 'VOID' ? '—' : <Money v={i.amount - i.amountPaid} /> },
            { key: 'act', label: '', align: 'right', render: (i) => i.status === 'UNPAID' && i.amountPaid === 0 && (
              <button className="btn btn-ghost btn-small" onClick={() => act(async () => { const reason = prompt('Reason for voiding this invoice?'); if (reason) await api.post(`/api/ledger/invoices/${i.id}/void`, { reason }); })}>Void</button>
            ) },
          ]} />
        </Card>
      )}
      {tab === 'payments' && (
        <Card>
          <Table rows={data.payments} empty="No payments." columns={[
            { key: 'paidAt', label: 'Date', render: (p) => dateTime(p.paidAt) },
            { key: 'receiptNo', label: 'Receipt', render: (p) => <Link to={`/receipts/${p.id}`}>{p.receiptNo}</Link> },
            { key: 'method', label: 'Method', render: (p) => METHOD[p.method] },
            { key: 'reference', label: 'Reference' },
            { key: 'status', label: 'Status', render: (p) => <Badge status={p.status} /> },
            { key: 'amount', label: 'Amount', align: 'right', render: (p) => <Money v={p.amount} /> },
            { key: 'act', label: '', align: 'right', render: (p) => p.status === 'COMPLETED' && p.method !== 'PAYSTACK' && (
              <button className="btn btn-ghost btn-small" onClick={() => act(async () => { const reason = prompt(`Reverse receipt ${p.receiptNo} (${naira(p.amount)})? Give a reason:`); if (reason) await api.post(`/api/payments/${p.id}/reverse`, { reason }); })}>Reverse</button>
            ) },
          ]} />
        </Card>
      )}
      {tab === 'statement' && <StatementView url={`/api/reports/statement?userId=${u.id}`} csvUrl={`/api/reports/statement?userId=${u.id}&format=csv`} />}
      {tab === 'credit' && (
        <Card>
          <Table rows={data.credits} empty="No credit movements." columns={[
            { key: 'createdAt', label: 'Date', render: (c) => dateTime(c.createdAt) },
            { key: 'kind', label: 'Type', render: (c) => humanize(c.kind) },
            { key: 'note', label: 'Note' },
            { key: 'amount', label: 'Amount', align: 'right', render: (c) => <Money v={c.amount} className={c.amount < 0 ? 'text-bad' : 'text-good'} /> },
          ]} />
        </Card>
      )}
      {editing && <MemberForm member={u} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
      {adjusting && <CreditModal user={u} onClose={() => setAdjusting(false)} onDone={() => { setAdjusting(false); reload(); }} />}
    </>
  );
}

function CreditModal({ user, onClose, onDone }) {
  const [direction, setDirection] = useState('add');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const { busy, error, run, setError } = useSubmit(async () => {
    const k = toKobo(amount);
    if (!k) return setError(new Error('Enter a valid amount'));
    await api.post(`/api/residents/${user.id}/credit-adjustment`, { amount: direction === 'add' ? k : -k, note });
    onDone();
  });
  return (
    <Modal title="Adjust account credit" onClose={onClose}>
      <form onSubmit={run}>
        <ErrorNote error={error} />
        <p className="muted">Current credit: <strong>{naira(user.creditBalance)}</strong>. Added credit is applied to open bills at once. Use this for goodwill credits or to record a refund paid out (remove).</p>
        <Field label="Adjustment"><select value={direction} onChange={(e) => setDirection(e.target.value)}><option value="add">Add credit</option><option value="remove">Remove credit (refund paid out)</option></select></Field>
        <Field label="Amount (₦)"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
        <Field label="Reason"><input value={note} onChange={(e) => setNote(e.target.value)} required /></Field>
        <button className="btn" disabled={busy}>Save adjustment</button>
      </form>
    </Modal>
  );
}
