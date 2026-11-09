import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { Card, ErrorNote, Field, MemberPicker, Money, PageHeader, Table, useSubmit } from '../../components/ui.jsx';
import { ImportDialog } from '../../components/ImportDialog.jsx';
import { METHOD } from '../../format.js';
import { date, naira, toKobo, todayIso } from '../../format.js';

// Pick a member, enter the amount: the server credits it to the member,
// settles their bills oldest-first (or a chosen one first) and keeps any excess as credit.
export default function ReceivePayment() {
  const [params] = useSearchParams();
  const [member, setMember] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [v, setV] = useState({ amount: '', method: 'CASH', paidAt: todayIso(), reference: '', note: '', invoiceId: '' });
  const [preview, setPreview] = useState(null);
  const [done, setDone] = useState(null);
  const [importing, setImporting] = useState(false);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const kobo = toKobo(v.amount);

  useEffect(() => {
    const id = params.get('member');
    if (id && !member) api.get(`/api/residents/${id}`).then((r) => setMember({ ...r.user, outstanding: r.balance.outstanding })).catch(() => {});
  }, [params, member]);

  useEffect(() => {
    setInvoices([]);
    setV((x) => ({ ...x, invoiceId: '' }));
    if (!member) return;
    api.get(`/api/ledger/invoices?userId=${member.id}&status=OPEN&pageSize=200`).then((r) => setInvoices(r.rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate)))).catch(() => {});
  }, [member]);

  useEffect(() => {
    setPreview(null);
    if (!member || !kobo) return;
    const t = setTimeout(() => {
      api.post('/api/payments/preview', { userId: member.id, amount: kobo, ...target(v.invoiceId) }).then(setPreview).catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(t);
  }, [member, kobo, v.invoiceId]);

  // "dn:12" settles every bill on debit note 12 first; a number settles that one bill first.
  const target = (val) => {
    if (!val) return { invoiceId: null };
    if (String(val).startsWith('dn:')) return { invoiceIds: invoices.filter((i) => i.debitNote?.id === Number(val.slice(3))).map((i) => i.id) };
    return { invoiceId: Number(val) };
  };
  const noteOptions = [...new Map(invoices.filter((i) => i.debitNote).map((i) => [i.debitNote.id, i.debitNote])).values()].map((n) => ({
    ...n,
    balance: invoices.filter((i) => i.debitNote?.id === n.id).reduce((t, i) => t + i.amount - i.amountPaid, 0),
  }));
  const owed = invoices.reduce((s, i) => s + i.amount - i.amountPaid, 0);
  const { busy, error, run, setError } = useSubmit(async () => {
    if (!kobo) return setError(new Error('Enter a valid amount, e.g. 5000 or 5,000.00'));
    const r = await api.post('/api/payments/receive', {
      userId: member.id, amount: kobo, method: v.method, paidAt: v.paidAt, reference: v.reference || null, note: v.note || null, ...target(v.invoiceId),
    });
    setDone(r);
    setMember(null);
    setV({ amount: '', method: 'CASH', paidAt: todayIso(), reference: '', note: '', invoiceId: '' });
  });

  return (
    <>
      <PageHeader title="Receive payment" subtitle="Record cash, bank transfer or POS payments. The payment is credited to the member and settles their oldest bills first." actions={<button className="btn btn-ghost" onClick={() => setImporting(true)}>Upload bank statement</button>} />
      {importing && (
        <ImportDialog
          title="Upload bank statement"
          noun={['payment', 'payments']}
          templateUrl="/api/payments/import/template"
          templateName="payments_upload_template.xlsx"
          uploadUrl="/api/payments/import"
          intro="Download the estate account statement from your internet banking as Excel or CSV and upload it as it is. Each payment in is matched to a member by the LWE number in a Membership ID column or in the narration (e.g. “LWE 12”), else by phone number, else by name. Each is received exactly as on this page: oldest bills first, a receipt, and a notice to the member."
          summary={(p) => `${p.ready.length ? ` (${naira(p.amount)} in total)` : ''}${p.notMoneyIn ? `, ${p.notMoneyIn} debit line(s) ignored` : ''}`}
          columns={[
            { key: 'date', label: 'Date', render: (r) => date(r.date) },
            { key: 'member', label: 'Member', render: (r) => <><strong>{r.membershipId}</strong> {r.name}{r.inactive && <span className="muted"> (inactive)</span>}</> },
            { key: 'matchedBy', label: 'Matched by' },
            { key: 'method', label: 'Method', render: (r) => METHOD[r.method] },
            { key: 'reference', label: 'Reference' },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => <Money v={r.amount} /> },
          ]}
          renderDone={(r) => r.created.length > 0 && (
            <div className="preview-scroll"><Table rows={r.created} rowKey="row" columns={[
              { key: 'receiptNo', label: 'Receipt', render: (x) => <Link to={`/receipts/${x.paymentId}`}>{x.receiptNo}</Link> },
              { key: 'member', label: 'Member', render: (x) => `${x.membershipId} ${x.name}` },
              { key: 'amount', label: 'Amount', align: 'right', render: (x) => <Money v={x.amount} /> },
              { key: 'credit', label: 'Kept as credit', align: 'right', render: (x) => (x.credit ? <Money v={x.credit} /> : '—') },
            ]} /></div>
          )}
          onClose={() => setImporting(false)}
        />
      )}
      {done && (
        <div className="alert alert-good">
          Recorded {naira(done.payment.amount)} from {done.payment.user.firstName} {done.payment.user.lastName} — receipt <Link to={`/receipts/${done.payment.id}`}><strong>{done.payment.receiptNo}</strong></Link>
          {done.credit > 0 && <> · {naira(done.credit)} kept as account credit</>}. The e-receipt has been emailed.
        </div>
      )}
      <div className="grid grid-2">
        <Card title="Payment">
          <form onSubmit={run}>
            <ErrorNote error={error} />
            <Field label="Member"><MemberPicker value={member} onChange={(m) => { setMember(m); setDone(null); }} autoFocus /></Field>
            <div className="form-row">
              <Field label="Amount (₦)" hint={member && owed > 0 ? <button type="button" className="btn btn-ghost btn-small" onClick={() => setV({ ...v, amount: String(owed / 100) })}>Fill total owed: {naira(owed)}</button> : null}>
                <input inputMode="decimal" value={v.amount} onChange={set('amount')} placeholder="5,000.00" required />
              </Field>
              <Field label="Method"><select value={v.method} onChange={set('method')}><option value="CASH">Cash</option><option value="BANK_TRANSFER">Bank transfer</option><option value="POS">POS</option></select></Field>
            </div>
            <div className="form-row">
              <Field label="Date received"><input type="date" max={todayIso()} value={v.paidAt} onChange={set('paidAt')} required /></Field>
              <Field label="Reference" hint="Bank / POS reference; each can be used once."><input value={v.reference} onChange={set('reference')} /></Field>
            </div>
            <Field label="Pay this first (optional)" hint="e.g. a payment meant for this year's debit note while older bills are still open.">
              <select value={v.invoiceId} onChange={set('invoiceId')} disabled={!invoices.length}>
                <option value="">Oldest first (recommended)</option>
                {noteOptions.map((n) => <option key={`dn${n.id}`} value={`dn:${n.id}`}>Debit note {n.noteNo} — {naira(n.balance)} still owed</option>)}
                {invoices.map((i) => <option key={i.id} value={i.id}>{i.description} — {naira(i.amount - i.amountPaid)} due {date(i.dueDate)}</option>)}
              </select>
            </Field>
            <Field label="Note (optional)"><input value={v.note} onChange={set('note')} /></Field>
            <button className="btn" disabled={busy || !member}>{busy ? 'Recording…' : `Record ${kobo ? naira(kobo) : 'payment'}`}</button>
          </form>
        </Card>
        <Card title="How it will be applied">
          {!member ? <p className="muted">Choose a member to see their open bills.</p> : (
            <>
              <p>Owes <strong className={owed ? 'text-bad' : ''}>{naira(owed)}</strong> on {invoices.length} open invoice(s){member.creditBalance > 0 && <> · holds {naira(member.creditBalance)} credit</>}.</p>
              {preview ? (
                <Table
                  rows={[...preview.lines, ...(preview.credit > 0 ? [{ invoiceId: 'credit', description: 'Kept as account credit', amount: preview.credit, balance: null }] : [])]}
                  rowKey="invoiceId"
                  columns={[
                    { key: 'description', label: 'Applied to' },
                    { key: 'after', label: 'Result', render: (l) => l.balance == null ? 'Applied to future bills' : l.settles ? 'Settled' : `${naira(l.balance - l.amount)} left` },
                    { key: 'amount', label: 'Amount', align: 'right', render: (l) => <Money v={l.amount} /> },
                  ]}
                />
              ) : <p className="muted">Enter an amount to preview the allocation.</p>}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
