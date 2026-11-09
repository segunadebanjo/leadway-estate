import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, Field, Loading, Modal, Money, Table, useFetch, useSubmit } from './ui.jsx';
import { date, koboToInput, naira, toKobo } from '../format.js';

/** Reverse a bill raised in error, or lower it. */
export function ReverseBillModal({ bill, onClose, onDone }) {
  const [mode, setMode] = useState('reverse');
  const [amount, setAmount] = useState(koboToInput(bill.amount));
  const [reason, setReason] = useState('');
  const newAmount = mode === 'reverse' ? 0 : toKobo(amount);
  const freed = Math.max(0, bill.amountPaid - (newAmount ?? bill.amountPaid));
  const { busy, error, run, setError } = useSubmit(async () => {
    if (mode === 'reduce' && (newAmount === null || newAmount >= bill.amount)) return setError(new Error(`Enter an amount below ${naira(bill.amount)}`));
    onDone(await api.post(`/api/ledger/invoices/${bill.id}/reverse`, { newAmount, reason }));
  });
  return (
    <Modal title={`Correct bill: ${bill.description}`} onClose={onClose}>
      <form onSubmit={run}>
        <ErrorNote error={error} />
        <p>Billed <strong>{naira(bill.amount)}</strong>, paid so far <strong>{naira(bill.amountPaid)}</strong>.</p>
        <label className="check"><input type="radio" checked={mode === 'reverse'} onChange={() => setMode('reverse')} /> Reverse the whole bill (raised in error)</label>
        <label className="check"><input type="radio" checked={mode === 'reduce'} onChange={() => setMode('reduce')} /> Lower the bill to a smaller amount</label>
        {mode === 'reduce' && <Field label="Correct amount (₦)"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>}
        <Field label="Reason (shown on the statement)"><input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} placeholder="e.g. Billed twice" /></Field>
        <p className="muted">
          The statement keeps the original charge and shows this {mode === 'reverse' ? 'reversal' : 'reduction'} as a credit.
          {freed > 0 && <> The {naira(freed)} already paid on it is kept as the member's credit and used straight away on their other unpaid bills, oldest first.</>}
        </p>
        <button className="btn btn-danger" disabled={busy}>{mode === 'reverse' ? 'Reverse bill' : 'Lower bill'}</button>
      </form>
    </Modal>
  );
}

/**
 * Correct a payment: reverse it (recorded in error / the money never came), or
 * move it to the bills it was meant for (e.g. this year's debit note).
 */
export function CorrectPaymentModal({ paymentId, onClose, onDone }) {
  const { data, error } = useFetch(`/api/payments/${paymentId}/move-options`);
  const [mode, setMode] = useState('move');
  const [picked, setPicked] = useState([]);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState(null);

  const notes = useMemo(() => {
    const m = new Map();
    for (const b of data?.bills || []) if (b.debitNote) m.set(b.debitNote.id, b.debitNote);
    return [...m.values()];
  }, [data]);
  const toggle = (bid) => { setPreview(null); setPicked((p) => (p.includes(bid) ? p.filter((x) => x !== bid) : [...p, bid])); };
  const pickNote = (nid) => { setPreview(null); setPicked(nid ? data.bills.filter((b) => b.debitNote?.id === Number(nid)).map((b) => b.id) : []); };
  const ordered = () => data.bills.filter((b) => picked.includes(b.id)).map((b) => b.id); // due date order

  const check = useSubmit(async () => setPreview(await api.post(`/api/payments/${paymentId}/move`, { invoiceIds: ordered(), dryRun: true })));
  const move = useSubmit(async () => onDone(await api.post(`/api/payments/${paymentId}/move`, { invoiceIds: ordered(), reason: reason || null }), 'moved'));
  const reverse = useSubmit(async () => onDone(await api.post(`/api/payments/${paymentId}/reverse`, { reason }), 'reversed'));

  if (error) return <Modal title="Correct payment" onClose={onClose}><ErrorNote error={error} /></Modal>;
  if (!data) return <Modal title="Correct payment" onClose={onClose}><Loading /></Modal>;
  const p = data.payment;
  const canReverse = p.method !== 'PAYSTACK';
  return (
    <Modal title={`Correct payment ${p.receiptNo} (${naira(p.amount)})`} onClose={onClose} wide>
      <label className="check"><input type="radio" checked={mode === 'move'} onChange={() => setMode('move')} /> <strong>Move it to other bills</strong>&nbsp;– e.g. it was meant for this year's debit note, not last year's</label>
      <label className="check"><input type="radio" checked={mode === 'reverse'} onChange={() => setMode('reverse')} disabled={!canReverse} /> <strong>Reverse it</strong>&nbsp;– recorded in error, or the money never arrived{!canReverse && ' (online payments are refunded from Paystack)'}</label>

      {mode === 'reverse' && (
        <form onSubmit={reverse.run}>
          <ErrorNote error={reverse.error} />
          <p className="muted">The bills this payment settled will owe again. If part of it was kept as credit and has since been used on other bills, those are undone too, so nothing is paid with money that never came. The receipt stays on record, marked REVERSED.</p>
          <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} placeholder="e.g. Transfer was reversed by the bank" /></Field>
          <button className="btn btn-danger" disabled={reverse.busy}>Reverse payment</button>
        </form>
      )}

      {mode === 'move' && (
        <>
          <ErrorNote error={check.error || move.error} />
          <p className="muted">Tick the bills this payment should pay. It pays them first, in due-date order; anything left over pays the oldest bills as usual, or stays as credit. The bills it pays now will owe again.</p>
          {notes.length > 0 && (
            <Field label="Quick pick: every bill on a debit note">
              <select onChange={(e) => pickNote(e.target.value)} defaultValue="">
                <option value="">— Choose a debit note —</option>
                {notes.map((n) => <option key={n.id} value={n.id}>{n.noteNo} ({n.year})</option>)}
              </select>
            </Field>
          )}
          <div className="preview-scroll">
            <Table rows={data.bills} empty="This member has no other bills." columns={[
              { key: 'pick', label: '', render: (b) => <input type="checkbox" aria-label={`Pay ${b.description}`} checked={picked.includes(b.id)} onChange={() => toggle(b.id)} /> },
              { key: 'description', label: 'Bill', render: (b) => <>{b.description}{b.debitNote && <span className="muted"> · {b.debitNote.noteNo}</span>}</> },
              { key: 'dueDate', label: 'Due', render: (b) => date(b.dueDate) },
              { key: 'balance', label: 'Still owed', align: 'right', render: (b) => <Money v={b.amount - b.amountPaid} /> },
              { key: 'from', label: 'Paid by this receipt now', align: 'right', render: (b) => (b.fromThisPayment ? <Money v={b.fromThisPayment} /> : '') },
            ]} />
          </div>
          {!preview ? (
            <button className="btn" disabled={!picked.length || check.busy} onClick={check.run}>{check.busy ? 'Checking…' : `Check the move (${picked.length} bill${picked.length === 1 ? '' : 's'})`}</button>
          ) : (
            <>
              <h3 className="section-title">After the move, {p.receiptNo} pays:</h3>
              <Table rows={preview.after} rowKey="invoiceId" columns={[
                { key: 'description', label: 'Bill' },
                { key: 'amount', label: 'Amount', align: 'right', render: (l) => <Money v={l.amount} /> },
              ]} footer={preview.credit > 0 && <tr><td>Kept as account credit</td><td className="right"><Money v={preview.credit} /></td></tr>} />
              <p className="muted">Taken off: {preview.before.map((b) => `${b.description} (${naira(b.amount)})`).join('; ')}</p>
              <Field label="Note (optional, kept in the audit log)"><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Member said this was for 2027" /></Field>
              <div className="actions">
                <button className="btn" disabled={move.busy} onClick={move.run}>Move payment</button>
                <button className="btn btn-ghost" onClick={() => setPreview(null)}>Change</button>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
