import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { Card, ErrorNote, Field, MemberPicker, Money, PageHeader, Table, useSubmit } from '../../components/ui.jsx';
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
      api.post('/api/payments/preview', { userId: member.id, amount: kobo, invoiceId: v.invoiceId ? Number(v.invoiceId) : null }).then(setPreview).catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(t);
  }, [member, kobo, v.invoiceId]);

  const owed = invoices.reduce((s, i) => s + i.amount - i.amountPaid, 0);
  const { busy, error, run, setError } = useSubmit(async () => {
    if (!kobo) return setError(new Error('Enter a valid amount, e.g. 5000 or 5,000.00'));
    const r = await api.post('/api/payments/receive', {
      userId: member.id, amount: kobo, method: v.method, paidAt: v.paidAt, reference: v.reference || null, note: v.note || null, invoiceId: v.invoiceId ? Number(v.invoiceId) : null,
    });
    setDone(r);
    setMember(null);
    setV({ amount: '', method: 'CASH', paidAt: todayIso(), reference: '', note: '', invoiceId: '' });
  });

  return (
    <>
      <PageHeader title="Receive payment" subtitle="Record cash, bank transfer or POS payments. The payment is credited to the member and settles their oldest bills first." />
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
            <Field label="Settle this invoice first (optional)">
              <select value={v.invoiceId} onChange={set('invoiceId')} disabled={!invoices.length}>
                <option value="">Oldest first (recommended)</option>
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
