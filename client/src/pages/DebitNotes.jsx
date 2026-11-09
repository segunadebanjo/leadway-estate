import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Badge, Card, ErrorNote, Field, Flash, Loading, Modal, Money, PageHeader, SearchField, Table, downloadCsv, useDebounced, useFetch, useSubmit } from '../components/ui.jsx';
import { METHOD, date, dateTime, fullName, koboToInput, naira, toKobo, todayIso } from '../format.js';
import { PayModal } from './resident/Home.jsx';
import { CorrectPaymentModal, ReverseBillModal } from '../components/Corrections.jsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const STATUS_LABEL = { UNPAID: 'Unpaid', PARTIAL: 'Part-paid', PAID: 'Paid', VOID: 'Reversed' };
const thisYear = () => Number(todayIso().slice(0, 4));
// From October on, the next year's notes are the ones being prepared.
const billingYear = () => (Number(todayIso().slice(5, 7)) >= 10 ? thisYear() + 1 : thisYear());

export const NoteStatus = ({ n }) => (
  <>
    <Badge status={n.status} label={STATUS_LABEL[n.status]} /> {n.status !== 'VOID' && n.overdue > 0 && <Badge status="OVERDUE" label="Overdue" />}
  </>
);

/** Executive page: every member's debit notes for a year. */
export function DebitNotesAdmin() {
  const [f, setF] = useState({ year: String(billingYear()), q: '', status: '' });
  const [issuing, setIssuing] = useState(false);
  const [flash, setFlash] = useState(null);
  const query = { ...f, q: useDebounced(f.q) };
  const { data, error, reload } = useFetch(`/api/debit-notes${qs(query)}`);
  const nav = useNavigate();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const years = [thisYear() - 2, thisYear() - 1, thisYear(), thisYear() + 1];
  return (
    <>
      <PageHeader
        title="Debit notes"
        subtitle="Once a year, bill every member the annual due and the security fee for January to December. Each payment is taken off the note automatically."
        actions={<>
          <button className="btn" onClick={() => setIssuing(true)}>Issue debit notes</button>
          <button className="btn btn-ghost" onClick={() => downloadCsv(`/api/debit-notes${qs({ ...query, format: 'csv' })}`, 'debit_notes.csv')}>Download list</button>
        </>}
      />
      <Flash message={flash} onDone={() => setFlash(null)} />
      <Card>
        <div className="filters">
          <Field label="Year"><select value={f.year} onChange={set('year')}>{years.map((y) => <option key={y}>{y}</option>)}</select></Field>
          <SearchField label="Member or note" placeholder="Name, LWE-ID, plot, DN-…" value={f.q} onChange={(v) => setF({ ...f, q: v })} />
          <Field label="Status">
            <select value={f.status} onChange={set('status')}>
              <option value="">All</option>
              <option value="OPEN">Not fully paid</option>
              <option value="OVERDUE">Overdue</option>
              <option value="UNPAID">Unpaid</option>
              <option value="PARTIAL">Part-paid</option>
              <option value="PAID">Paid</option>
              <option value="VOID">Reversed</option>
            </select>
          </Field>
        </div>
        <ErrorNote error={error} />
        {!data ? <Loading /> : (
          <Table rows={data.rows} onRowClick={(n) => nav(`/debit-notes/${n.id}`)} empty={`No debit notes for ${f.year} yet. Use “Issue debit notes” to bill every member for the year.`} columns={[
            { key: 'noteNo', label: 'Debit note', render: (n) => <Link style={{ whiteSpace: 'nowrap' }} to={`/debit-notes/${n.id}`} onClick={(e) => e.stopPropagation()}>{n.noteNo}</Link> },
            { key: 'member', label: 'Member', render: (n) => <>{fullName(n.user)} <span className="muted">({n.user.membershipId})</span></> },
            { key: 'plot', label: 'Plot', render: (n) => n.user.plotNumber || '—' },
            { key: 'dueDate', label: 'Due', render: (n) => date(n.dueDate) },
            { key: 'status', label: 'Status', render: (n) => <NoteStatus n={n} /> },
            { key: 'amount', label: 'Amount', align: 'right', render: (n) => <Money v={n.amount} /> },
            { key: 'paid', label: 'Paid', align: 'right', render: (n) => <Money v={n.paid} /> },
            { key: 'balance', label: 'Balance', align: 'right', render: (n) => (n.status === 'VOID' ? '—' : <Money v={n.balance} className={n.balance ? 'text-bad' : 'text-good'} />) },
          ]} footer={data.rows.length > 0 && <tr><td colSpan={5}>Total ({data.rows.filter((n) => n.status !== 'VOID').length} notes, reversed ones excluded)</td><td className="right"><Money v={data.totals.amount} /></td><td className="right"><Money v={data.totals.paid} /></td><td className="right"><Money v={data.totals.balance} /></td></tr>} />
        )}
      </Card>
      {issuing && <IssueDebitNotes onClose={() => setIssuing(false)} onDone={(r, year) => { setIssuing(false); setF({ ...f, year: String(year) }); setFlash(`${r.issued} debit note(s) issued for ${naira(r.total)}${r.skipped.length ? `; ${r.skipped.length} member(s) skipped (already billed)` : ''}.`); reload(); }} />}
    </>
  );
}

/** Issue notes to every active resident, or to one member (`member`). */
export function IssueDebitNotes({ member, onClose, onDone }) {
  const fees = useFetch('/api/ledger/fee-types');
  const saved = useFetch('/api/debit-notes/settings');
  const year = billingYear();
  const [v, setV] = useState(null);
  const [preview, setPreview] = useState(null);

  // Start from what was used last time, else the first annual and monthly fee types.
  useEffect(() => {
    if (v || !fees.data || !saved.data) return;
    const active = fees.data.rows.filter((ft) => ft.isActive);
    const pick = (savedId, freq) => active.find((ft) => ft.id === savedId) || active.find((ft) => ft.frequency === freq && /secur/i.test(ft.name)) || active.find((ft) => ft.frequency === freq);
    const annual = pick(saved.data.annualFeeTypeId, 'ANNUAL');
    const monthly = pick(saved.data.monthlyFeeTypeId, 'MONTHLY');
    const startMonth = member && Number(todayIso().slice(0, 4)) === year ? Number(todayIso().slice(5, 7)) : 1;
    setV({
      year: String(year),
      annualFeeTypeId: annual ? String(annual.id) : '',
      annualAmount: annual ? koboToInput(annual.amount) : '',
      monthlyFeeTypeId: monthly ? String(monthly.id) : '',
      monthlyAmount: monthly ? koboToInput(monthly.amount) : '',
      fromMonth: String(startMonth),
      toMonth: '12',
      monthlyDue: saved.data.monthlyDue || 'UPFRONT',
      issueDate: member ? todayIso() : `${year}-01-01`,
      dueDate: member ? todayIso() : `${year}-01-31`,
      message: saved.data.message || '',
      notify: true,
    });
  }, [fees.data, saved.data, v, member, year]);

  const feeById = (fid) => fees.data?.rows.find((ft) => String(ft.id) === String(fid));
  const set = (k) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    const next = { ...v, [k]: value };
    if (k === 'annualFeeTypeId') next.annualAmount = feeById(value) ? koboToInput(feeById(value).amount) : '';
    if (k === 'monthlyFeeTypeId') next.monthlyAmount = feeById(value) ? koboToInput(feeById(value).amount) : '';
    if (k === 'year') {
      next.issueDate = `${value}-01-01`;
      next.dueDate = `${value}-01-31`;
    }
    setV(next);
    setPreview(null);
  };

  const payload = () => {
    const out = {
      year: Number(v.year),
      annualFeeTypeId: v.annualFeeTypeId ? Number(v.annualFeeTypeId) : null,
      monthlyFeeTypeId: v.monthlyFeeTypeId ? Number(v.monthlyFeeTypeId) : null,
      fromMonth: Number(v.fromMonth),
      toMonth: Number(v.toMonth),
      monthlyDue: v.monthlyDue,
      issueDate: v.issueDate,
      dueDate: v.dueDate,
      message: v.message,
      notify: v.notify,
      ...(member ? { userIds: [member.id] } : {}),
    };
    if (v.annualFeeTypeId) {
      out.annualAmount = toKobo(v.annualAmount);
      if (!out.annualAmount) throw new Error('Enter the annual due amount');
    }
    if (v.monthlyFeeTypeId) {
      out.monthlyAmount = toKobo(v.monthlyAmount);
      if (!out.monthlyAmount) throw new Error('Enter the monthly security fee amount');
    }
    return out;
  };
  const check = useSubmit(async () => setPreview(await api.post('/api/debit-notes/preview', payload())));
  const issue = useSubmit(async () => {
    const b = payload();
    onDone(await api.post('/api/debit-notes', b), b.year);
  });

  if (fees.error || saved.error) return <Modal title="Issue debit notes" onClose={onClose}><ErrorNote error={fees.error || saved.error} /></Modal>;
  if (!v) return <Modal title="Issue debit notes" onClose={onClose}><Loading /></Modal>;
  const active = fees.data.rows.filter((ft) => ft.isActive);
  const months = Math.max(0, Number(v.toMonth) - Number(v.fromMonth) + 1);
  const each = (v.annualFeeTypeId ? toKobo(v.annualAmount) || 0 : 0) + (v.monthlyFeeTypeId ? (toKobo(v.monthlyAmount) || 0) * months : 0);
  const years = [thisYear() - 1, thisYear(), thisYear() + 1];

  return (
    <Modal title={member ? `Issue a debit note to ${fullName(member)}` : 'Issue debit notes for the year'} onClose={onClose} wide>
      <form onSubmit={check.run}>
        <ErrorNote error={check.error || issue.error} />
        <p className="muted">
          {member ? 'One debit note for this member.' : 'One debit note for every active resident.'} Members who already have these bills for the year are skipped, so
          running this twice never bills anyone twice. Bills the monthly billing has already raised this year (e.g. January) are put on the note rather than charged again.
          {active.length < 2 && <> Add the security fee under <Link to="/admin/ledger?tab=fees">Ledger → Fee types</Link> first.</>}
        </p>
        <div className="form-row">
          <Field label="Year"><select value={v.year} onChange={set('year')}>{years.map((y) => <option key={y}>{y}</option>)}</select></Field>
          <Field label="Date on the note"><input type="date" value={v.issueDate} onChange={set('issueDate')} required /></Field>
          <Field label="Pay by"><input type="date" value={v.dueDate} onChange={set('dueDate')} required /></Field>
        </div>
        <h3 className="section-title">Annual due (once a year)</h3>
        <div className="form-row">
          <Field label="Fee"><select value={v.annualFeeTypeId} onChange={set('annualFeeTypeId')}><option value="">— Not on this note —</option>{active.map((ft) => <option key={ft.id} value={ft.id}>{ft.name}</option>)}</select></Field>
          <Field label="Amount (₦)"><input inputMode="decimal" value={v.annualAmount} onChange={set('annualAmount')} disabled={!v.annualFeeTypeId} /></Field>
        </div>
        <h3 className="section-title">Security fee (per month)</h3>
        <div className="form-row">
          <Field label="Fee"><select value={v.monthlyFeeTypeId} onChange={set('monthlyFeeTypeId')}><option value="">— Not on this note —</option>{active.map((ft) => <option key={ft.id} value={ft.id}>{ft.name}</option>)}</select></Field>
          <Field label="Amount per month (₦)"><input inputMode="decimal" value={v.monthlyAmount} onChange={set('monthlyAmount')} disabled={!v.monthlyFeeTypeId} /></Field>
        </div>
        {v.monthlyFeeTypeId && (
          <div className="form-row">
            <Field label="From"><select value={v.fromMonth} onChange={set('fromMonth')}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Field>
            <Field label="To"><select value={v.toMonth} onChange={set('toMonth')}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Field>
            <Field label="Security fee is due" hint={v.monthlyDue === 'MONTHLY' ? 'Each month falls due on the same day of that month.' : undefined}>
              <select value={v.monthlyDue} onChange={set('monthlyDue')}>
                <option value="UPFRONT">All by the “Pay by” date</option>
                <option value="MONTHLY">Month by month</option>
              </select>
            </Field>
          </div>
        )}
        <Field label="Payment instructions printed on the note" hint="e.g. the estate account name, bank and number. Remembered for next time.">
          <textarea rows={2} value={v.message} onChange={set('message')} maxLength={1000} />
        </Field>
        <label className="check"><input type="checkbox" checked={v.notify} onChange={set('notify')} /> Notify each member in the app and by email</label>
        <p>Each member: <strong>{naira(each)}</strong>{v.monthlyFeeTypeId ? ` (security fee ${months} month${months === 1 ? '' : 's'})` : ''}</p>
        {!preview && <button className="btn" disabled={check.busy}>{check.busy ? 'Checking…' : 'Check before issuing'}</button>}
      </form>
      {preview && (
        <>
          <h3 className="section-title">{preview.ready.length} debit note(s) ready, {naira(preview.total)} in total</h3>
          <div className="preview-scroll">
            <Table rows={preview.ready} empty="Nobody left to bill for this year." columns={[
              { key: 'membershipId', label: 'ID' },
              { key: 'name', label: 'Member', render: (m) => fullName(m) },
              { key: 'lines', label: 'Lines', render: (m) => `${m.newLines + m.existingLines}${m.existingLines ? ` (${m.existingLines} already billed)` : ''}` },
              { key: 'leftOut', label: 'Left out', render: (m) => m.leftOut.map((x) => `${x.description} (${x.reason})`).join('; ') },
              { key: 'total', label: 'Amount', align: 'right', render: (m) => <Money v={m.total} /> },
            ]} />
          </div>
          {preview.skipped.length > 0 && <p className="muted">Skipped: {preview.skipped.map((s) => `${fullName(s)} (${s.reason})`).join('; ')}</p>}
          <div className="actions">
            {preview.ready.length > 0 && <button className="btn" disabled={issue.busy} onClick={issue.run}>{issue.busy ? 'Issuing…' : `Issue ${preview.ready.length} debit note(s)`}</button>}
            <button className="btn btn-ghost" onClick={() => setPreview(null)}>Change</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** A member's own debit notes. */
export function MyDebitNotes() {
  const { data, error } = useFetch('/api/debit-notes');
  const nav = useNavigate();
  return (
    <>
      <PageHeader title="Debit notes" subtitle="Your yearly bills. Every payment you make is taken off the balance." />
      <ErrorNote error={error} />
      <Card>
        {!data ? <Loading /> : (
          <Table rows={data.rows} onRowClick={(n) => nav(`/debit-notes/${n.id}`)} empty="No debit notes yet." columns={[
            { key: 'noteNo', label: 'Debit note', render: (n) => <Link to={`/debit-notes/${n.id}`}>{n.noteNo}</Link> },
            { key: 'year', label: 'Year' },
            { key: 'dueDate', label: 'Pay by', render: (n) => date(n.dueDate) },
            { key: 'status', label: 'Status', render: (n) => <NoteStatus n={n} /> },
            { key: 'amount', label: 'Amount', align: 'right', render: (n) => <Money v={n.amount} /> },
            { key: 'balance', label: 'Balance', align: 'right', render: (n) => (n.status === 'VOID' ? '—' : <Money v={n.balance} />) },
          ]} />
        )}
      </Card>
    </>
  );
}

/** The printable debit note, for executives and for the member it belongs to. */
export function DebitNoteView() {
  const { id } = useParams();
  const { user } = useAuth();
  const admin = user.role === 'ADMIN';
  const { data: n, error, reload } = useFetch(`/api/debit-notes/${id}`);
  const summary = useFetch(admin ? null : '/api/me/summary');
  const [paying, setPaying] = useState(null);
  const [flash, setFlash] = useState(null);
  const [err, setErr] = useState(null);
  const [fixBill, setFixBill] = useState(null);
  const [fixPayment, setFixPayment] = useState(null);
  if (error) return <ErrorNote error={error} />;
  if (!n) return <Loading />;
  const voided = n.status === 'VOID';
  const outstanding = summary.data?.balance.outstanding || 0;
  const cancel = async () => {
    const paidNote = n.paid > 0 ? `\n\n${naira(n.paid)} has been paid on it: that money will be kept as the member's credit and used on their other unpaid bills.` : '';
    const reason = prompt(`Reverse ${n.noteNo}? All its bills are reversed, and you can issue a corrected note afterwards.${paidNote}\n\nReason (shown on the statement):`);
    if (!reason) return;
    try {
      await api.post(`/api/debit-notes/${n.id}/void`, { reason });
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  const lines = n.invoices;
  return (
    <>
      <div className="actions no-print" style={{ marginBottom: 14 }}>
        <button className="btn" onClick={() => window.print()}>Print / save as PDF</button>
        {!admin && !voided && n.balance > 0 && outstanding > 0 && (
          <button className="btn" onClick={() => setPaying({ max: outstanding, amount: Math.min(n.balance, outstanding) })}>Pay {naira(Math.min(n.balance, outstanding))} online</button>
        )}
        {admin && !voided && n.balance > 0 && <Link className="btn btn-ghost" to={`/admin/receive-payment?member=${n.user.id}`}>Receive payment</Link>}
        {admin ? <Link className="btn btn-ghost" to={`/admin/residents/${n.user.id}`}>Member page &amp; statement</Link> : <Link className="btn btn-ghost" to="/statement">My statement</Link>}
        {admin && !voided && <button className="btn btn-ghost" onClick={cancel}>Reverse note</button>}
        <Link className="btn btn-ghost" to={admin ? '/admin/debit-notes' : '/debit-notes'}>Back</Link>
      </div>
      <ErrorNote error={err} />
      <Flash message={flash} onDone={() => setFlash(null)} />
      <article className="receipt">
        <div className="receipt-head">
          <div>
            <h2>{n.estate.name} Residents' Association</h2>
            <div className="muted">{n.estate.address}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="muted">Debit note / Invoice</div>
            <div style={{ fontWeight: 800, fontSize: '1.1rem', whiteSpace: 'nowrap' }}>{n.noteNo}</div>
          </div>
        </div>
        <dl>
          <dt>Billed to</dt>
          <dd>{fullName(n.user)} ({n.user.membershipId})</dd>
          <dt>Address</dt>
          <dd>{[n.user.plotNumber && `Plot ${n.user.plotNumber}`, n.user.street].filter(Boolean).join(', ') || '—'}</dd>
          <dt>Date</dt>
          <dd>{date(n.issueDate)}</dd>
          <dt>Pay by</dt>
          <dd>{date(n.dueDate)}</dd>
          <dt>Year</dt>
          <dd>{n.year}</dd>
        </dl>
        <table className="table">
          <thead>
            <tr><th>Description</th><th>Due</th><th className="right">Amount</th><th className="right">Paid</th><th className="right">Balance</th></tr>
          </thead>
          <tbody>
            {lines.map((i) => (
              <tr key={i.id} className={i.status === 'VOID' ? 'muted' : ''}>
                <td data-label="Description"><strong>{i.description}</strong>{i.status === 'VOID' && !voided && ' (reversed)'}{admin && !voided && i.status !== 'VOID' && <> <button className="link-button no-print" style={{ fontSize: '.8rem' }} onClick={() => setFixBill(i)}>reverse / lower</button></>}</td>
                <td data-label="Due">{date(i.dueDate)}</td>
                <td data-label="Amount" className="right"><Money v={i.amount} /></td>
                <td data-label="Paid" className="right">{i.status === 'VOID' ? '—' : <Money v={i.amountPaid} />}</td>
                <td data-label="Balance" className="right">{i.status === 'VOID' ? '—' : <Money v={i.amount - i.amountPaid} />}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={2}>Total</td><td data-label="Amount" className="right"><Money v={n.amount} /></td><td data-label="Paid" className="right"><Money v={n.paid} /></td><td data-label="Balance" className="right"><Money v={n.balance} /></td></tr>
          </tfoot>
        </table>
        {n.receipts.length > 0 && (
          <>
            <h3 className="section-title">Payments taken off this note</h3>
            <table className="table">
              <tbody>
                {n.receipts.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Date">{dateTime(r.paidAt)}</td>
                    <td data-label="Receipt"><Link to={`/receipts/${r.id}`}>{r.receiptNo}</Link></td>
                    <td data-label="Method">{METHOD[r.method]}{admin && <> <button className="link-button no-print" style={{ fontSize: '.8rem' }} onClick={() => setFixPayment(r.id)}>correct</button></>}</td>
                    <td data-label="Amount" className="right"><Money v={r.amount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, marginTop: 24 }}>
          <div style={{ fontSize: '.9rem' }}>
            {n.message && <div style={{ whiteSpace: 'pre-line', marginBottom: 6 }}><strong>How to pay:</strong> {n.message}</div>}
            <div className="muted">Quote your membership ID {n.user.membershipId} with every payment. You can also pay online after signing in.</div>
            {voided && <div className="text-bad">Reversed: {n.voidReason}</div>}
          </div>
          <span className={`stamp ${n.status === 'PAID' ? '' : 'void'}`}>
            {voided ? 'REVERSED' : n.status === 'PAID' ? 'PAID' : `DUE ${naira(n.balance)}`}
          </span>
        </div>
      </article>
      {fixBill && <ReverseBillModal bill={fixBill} onClose={() => setFixBill(null)} onDone={() => { setFixBill(null); reload(); }} />}
      {fixPayment && <CorrectPaymentModal paymentId={fixPayment} onClose={() => setFixPayment(null)} onDone={() => { setFixPayment(null); reload(); }} />}
      {paying && <PayModal {...paying} onClose={() => setPaying(null)} onDone={(msg) => { setPaying(null); setFlash(msg); reload(); summary.reload(); }} />}
    </>
  );
}
