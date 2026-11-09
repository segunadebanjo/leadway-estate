import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { Badge, Card, ErrorNote, Field, Flash, Loading, Modal, Money, PageHeader, Stat, Table, useFetch, useSubmit } from '../../components/ui.jsx';
import { date, koboToInput, naira, toKobo, todayIso } from '../../format.js';
import { payOnline } from './pay.js';

export default function Home() {
  const { user } = useAuth();
  const summary = useFetch('/api/me/summary');
  const invoices = useFetch('/api/me/invoices');
  const [paying, setPaying] = useState(null); // { invoice? , max }
  const [flash, setFlash] = useState(null);
  const b = summary.data?.balance;
  const open = invoices.data?.rows.filter((i) => ['UNPAID', 'PARTIAL'].includes(i.status)) || [];
  const reload = () => {
    summary.reload();
    invoices.reload();
  };
  return (
    <>
      <PageHeader
        title={`Welcome, ${user.firstName}`}
        subtitle={`${user.membershipId}${user.plotNumber ? ` · Plot ${user.plotNumber}` : ''}${user.street ? `, ${user.street}` : ''}`}
        actions={b?.outstanding > 0 && <button className="btn" onClick={() => setPaying({ max: b.outstanding })}>Pay {naira(b.outstanding)} now</button>}
      />
      <ErrorNote error={summary.error || invoices.error} />
      {!b ? <Loading /> : (
        <div className="stats">
          <Stat label="Outstanding" value={naira(b.outstanding)} tone={b.outstanding ? 'bad' : 'good'} hint={b.outstanding ? `${b.openInvoices} unpaid bill(s)` : 'All paid up – thank you!'} />
          <Stat label="Overdue" value={naira(b.overdue)} tone={b.overdue ? 'bad' : undefined} hint={b.overdue ? `${b.overdueInvoices} bill(s) past due date` : 'Nothing overdue'} />
          <Stat label="Total paid" value={naira(b.paid)} tone="good" hint={<Link to="/payments">Receipts</Link>} />
          {b.credit > 0 && <Stat label="Account credit" value={naira(b.credit)} tone="good" hint="Used automatically on your next bills" />}
        </div>
      )}
      {summary.data?.plan && <MyPlan plan={summary.data.plan} onPay={(amount) => b?.outstanding > 0 && setPaying({ max: b.outstanding, amount })} />}
      <Card title="Your bills" actions={<Link to="/statement">Full statement →</Link>}>
        {!invoices.data ? <Loading /> : (
          <Table rows={invoices.data.rows} empty="No bills yet." columns={[
            { key: 'description', label: 'Bill', render: (i) => <strong>{i.description}</strong> },
            { key: 'dueDate', label: 'Due', render: (i) => <>{date(i.dueDate)} {['UNPAID', 'PARTIAL'].includes(i.status) && i.dueDate.slice(0, 10) < todayIso() && <Badge status="OVERDUE" label="Overdue" />}</> },
            { key: 'status', label: 'Status', render: (i) => <Badge status={i.status} label={i.status === 'PARTIAL' ? 'Part-paid' : undefined} /> },
            { key: 'amount', label: 'Amount', align: 'right', render: (i) => <Money v={i.amount} /> },
            { key: 'balance', label: 'Balance', align: 'right', render: (i) => <Money v={i.amount - i.amountPaid} /> },
            { key: 'pay', label: '', align: 'right', render: (i) => ['UNPAID', 'PARTIAL'].includes(i.status) ? <button className="btn btn-small" onClick={() => setPaying({ invoice: i, max: i.amount - i.amountPaid })}>Pay now</button> : i.allocations?.[0] && <Link to={`/receipts/${i.allocations[0].payment.id}`}>Receipt</Link> },
          ]} />
        )}
      </Card>
      {open.length === 0 && invoices.data && <p className="muted">You can also pay at the estate office by cash, transfer or POS; the payment will appear here with an e-receipt.</p>}
      {paying && <PayModal {...paying} onClose={() => setPaying(null)} onDone={(msg) => { setPaying(null); setFlash(msg); reload(); }} />}
      <Flash message={flash} onDone={() => setFlash(null)} />
    </>
  );
}

export function PayModal({ invoice, max, amount: suggested, onClose, onDone }) {
  const [amount, setAmount] = useState(koboToInput(Math.min(suggested || max, max)));
  const { busy, error, run, setError } = useSubmit(async () => {
    const k = toKobo(amount);
    if (!k) return setError(new Error('Enter a valid amount'));
    if (k > max) return setError(new Error(`You can pay at most ${naira(max)}`));
    const r = await payOnline({ invoiceId: invoice?.id ?? null, amount: k === max ? undefined : k });
    if (r.status === 'success') onDone(`Payment received – thank you! Your e-receipt has been emailed.`);
    else if (r.status === 'cancelled') onClose();
    else if (r.status === 'pending') onDone('Your payment is being confirmed. It will appear here shortly.');
    else setError(new Error('The payment was not successful. No money has been taken from your bill.'));
  });
  return (
    <Modal title={invoice ? `Pay: ${invoice.description}` : 'Pay outstanding balance'} onClose={onClose}>
      <form onSubmit={run}>
        <ErrorNote error={error} />
        <p>Amount due: <strong>{naira(max)}</strong></p>
        <Field label="Amount to pay (₦)" hint="You can pay part now (minimum ₦100); the rest stays on your account.">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <p className="muted" style={{ fontSize: '.85rem' }}>You'll pay securely with Paystack by card, bank transfer, USSD or bank app. {invoice ? 'This bill is settled first; anything left over goes to your oldest bills.' : 'Your oldest bills are settled first.'}</p>
        <button className="btn" disabled={busy}>{busy ? 'Opening Paystack…' : 'Continue to payment'}</button>
      </form>
    </Modal>
  );
}

const PLAN_STATE = { PAID: ['PAID', 'Paid'], PART_PAID: ['PARTIAL', 'Part paid'], OVERDUE: ['OVERDUE', 'Overdue'], UPCOMING: ['PENDING', 'Upcoming'] };

function MyPlan({ plan, onPay }) {
  const next = plan.nextInstalment;
  const due = plan.behind > 0 ? plan.behind : next ? next.amount - next.paidSoFar : 0;
  return (
    <Card title="Your payment plan" actions={due > 0 && <button className="btn" onClick={() => onPay(due)}>Pay {naira(due)}</button>}>
      <p style={{ marginTop: 0 }}>
        {naira(plan.totalAmount)} in {plan.instalments} monthly instalments. Paid so far {naira(plan.paid)}; {naira(plan.remaining)} to go.
        {plan.behind > 0 ? <strong className="text-bad"> You are behind by {naira(plan.behind)}.</strong> : next && <> Next: {naira(next.amount - next.paidSoFar)} by {date(next.dueDate)}.</>}
      </p>
      <Table rows={plan.schedule} rowKey="number" columns={[
        { key: 'number', label: '#' },
        { key: 'dueDate', label: 'Due', render: (s) => date(s.dueDate) },
        { key: 'amount', label: 'Amount', align: 'right', render: (s) => <Money v={s.amount} /> },
        { key: 'state', label: '', render: (s) => <Badge status={PLAN_STATE[s.state][0]} label={PLAN_STATE[s.state][1]} /> },
      ]} />
    </Card>
  );
}
