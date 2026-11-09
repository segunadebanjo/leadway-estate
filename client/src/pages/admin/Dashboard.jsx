import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Card, ErrorNote, Flash, Loading, Money, PageHeader, Stat, Table, useFetch, useSubmit } from '../../components/ui.jsx';
import { METHOD, dateTime, fullName, naira } from '../../format.js';

export default function Dashboard() {
  const { data: d, error, reload } = useFetch('/api/admin/dashboard');
  const [flash, setFlash] = useState(null);
  const billing = useSubmit(async () => {
    const r = await api.post('/api/ledger/billing/run');
    setFlash(r.created ? `Billing run: ${r.created} new invoice(s) created.` : 'Billing run: everyone is already billed for this period.');
    reload();
  });
  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Leadway Estate at a glance"
        actions={
          <>
            <Link className="btn" to="/admin/receive-payment">Receive payment</Link>
            <button className="btn btn-ghost" onClick={billing.run} disabled={billing.busy} title="Creates this period's invoices for anyone not yet billed. Safe to run any time.">
              {billing.busy ? 'Running…' : 'Run billing now'}
            </button>
          </>
        }
      />
      <ErrorNote error={error || billing.error} />
      {!d ? (
        <Loading />
      ) : (
        <>
          <div className="stats">
            <Stat label="Collected this month" value={naira(d.month.collected)} tone="good" hint={`${d.month.payments} payment(s) · ${naira(d.yearCollected)} this year`} />
            <Stat label="Billed this month" value={naira(d.month.billed)} />
            <Stat label="Outstanding" value={naira(d.outstanding.amount)} hint={`${d.outstanding.invoices} open invoice(s)`} />
            <Stat label="Overdue" value={naira(d.overdue.amount)} tone={d.overdue.amount ? 'bad' : undefined} hint={`${d.overdue.members} member(s) in arrears`} />
            <Stat label="Spent this month" value={naira(d.month.expenses)} hint="Recorded expenses" />
            <Stat label="Credit held for members" value={naira(d.creditHeld)} hint="Advance payments" />
          </div>
          <div className="stats">
            <Stat label="Active residents" value={d.residents.active} hint={`${d.residents.owners} owners · ${d.residents.tenants} tenants · ${d.residents.inactive} inactive`} />
            <Stat label="Open requests" value={d.openRequests} tone={d.openRequests ? 'warn' : undefined} hint={<Link to="/admin/requests">View requests</Link>} />
            <Stat label="Visitors on site" value={d.visitorsOnSite} hint={<Link to="/gate">Gate log</Link>} />
            <Stat label="Low-stock items" value={d.lowStock} tone={d.lowStock ? 'warn' : undefined} hint={<Link to="/admin/assets">Assets</Link>} />
          </div>
          <Card title="Latest payments" actions={<Link to="/admin/ledger?tab=payments">All payments →</Link>}>
            <Table
              rows={d.recentPayments}
              empty="No payments yet."
              columns={[
                { key: 'when', label: 'When', render: (p) => dateTime(p.createdAt) },
                { key: 'member', label: 'Member', render: (p) => `${fullName(p.user)} (${p.user.membershipId})` },
                { key: 'method', label: 'Method', render: (p) => METHOD[p.method] },
                { key: 'receipt', label: 'Receipt', render: (p) => <Link to={`/receipts/${p.id}`}>{p.receiptNo}</Link> },
                { key: 'amount', label: 'Amount', align: 'right', render: (p) => <Money v={p.amount} /> },
              ]}
            />
          </Card>
        </>
      )}
      <Flash message={flash} onDone={() => setFlash(null)} />
    </>
  );
}
