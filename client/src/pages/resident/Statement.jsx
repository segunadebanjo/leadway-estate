import { useState } from 'react';
import { qs } from '../../api.js';
import { Card, ErrorNote, Field, Loading, Money, PageHeader, Table, downloadCsv, useFetch } from '../../components/ui.jsx';
import { date, naira } from '../../format.js';

const balanceText = (b) => (b > 0 ? `${naira(b)} owed` : b < 0 ? `${naira(-b)} in credit` : 'Nil');

export function StatementView({ url, csvUrl, showMember }) {
  const { data, error } = useFetch(url);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const rows = [{ ref: 'opening', date: data.from, type: '', description: 'Opening balance', debit: 0, credit: 0, balance: data.opening }, ...data.rows];
  return (
    <Card
      title={showMember ? `${data.user.firstName} ${data.user.lastName} (${data.user.membershipId})` : 'Statement of account'}
      actions={<>
        <button className="btn btn-ghost" onClick={() => window.print()}>Print / PDF</button>
        {csvUrl && <button className="btn btn-ghost" onClick={() => downloadCsv(csvUrl, 'statement.csv')}>CSV</button>}
      </>}
    >
      <p>Closing balance: <strong className={data.closing > 0 ? 'text-bad' : 'text-good'}>{balanceText(data.closing)}</strong></p>
      <Table rows={rows} rowKey="ref" columns={[
        { key: 'date', label: 'Date', render: (r) => date(r.date) },
        { key: 'type', label: 'Type' },
        { key: 'description', label: 'Description' },
        { key: 'ref', label: 'Reference', render: (r) => (r.ref === 'opening' ? '' : r.ref) },
        { key: 'debit', label: 'Charges', align: 'right', render: (r) => (r.debit ? <Money v={r.debit} /> : '') },
        { key: 'credit', label: 'Payments', align: 'right', render: (r) => (r.credit ? <Money v={r.credit} /> : '') },
        { key: 'balance', label: 'Balance', align: 'right', render: (r) => <span className="num">{balanceText(r.balance)}</span> },
      ]} footer={<tr><td colSpan={4}>Totals for the period</td><td className="right"><Money v={data.totals.debit} /></td><td className="right"><Money v={data.totals.credit} /></td><td /></tr>} />
    </Card>
  );
}

export default function Statement() {
  const [r, setR] = useState({ from: '', to: '' });
  return (
    <>
      <PageHeader title="Statement" subtitle="Bills and payments with a running balance" />
      <Card>
        <div className="filters">
          <Field label="From"><input type="date" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} /></Field>
          <Field label="To"><input type="date" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} /></Field>
        </div>
      </Card>
      <StatementView url={`/api/me/statement${qs(r)}`} />
    </>
  );
}
