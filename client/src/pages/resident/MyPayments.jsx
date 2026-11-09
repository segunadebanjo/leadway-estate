import { Link } from 'react-router-dom';
import { Badge, Card, ErrorNote, Loading, Money, PageHeader, Table, useFetch } from '../../components/ui.jsx';
import { METHOD, dateTime } from '../../format.js';

export default function MyPayments() {
  const { data, error } = useFetch('/api/me/payments');
  return (
    <>
      <PageHeader title="Payments & receipts" subtitle="Every payment, with a printable e-receipt" />
      <ErrorNote error={error} />
      <Card>
        {!data ? <Loading /> : (
          <Table rows={data.rows} empty="No payments yet." columns={[
            { key: 'paidAt', label: 'Date', render: (p) => dateTime(p.paidAt) },
            { key: 'receiptNo', label: 'Receipt', render: (p) => <Link to={`/receipts/${p.id}`}>{p.receiptNo}</Link> },
            { key: 'method', label: 'Method', render: (p) => METHOD[p.method] },
            { key: 'for', label: 'Applied to', render: (p) => p.allocations.map((a) => a.invoice.description).join(', ') || 'Account credit' },
            { key: 'status', label: 'Status', render: (p) => p.status === 'REVERSED' ? <Badge status="REVERSED" /> : null },
            { key: 'amount', label: 'Amount', align: 'right', render: (p) => <Money v={p.amount} /> },
          ]} />
        )}
      </Card>
    </>
  );
}
