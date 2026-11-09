import { useState } from 'react';
import { Link } from 'react-router-dom';
import { qs } from '../../api.js';
import { Card, ErrorNote, Field, Loading, Money, PageHeader, Table, downloadCsv, useFetch } from '../../components/ui.jsx';
import { date, naira } from '../../format.js';

const balanceText = (b) => (b > 0 ? `${naira(b)} owed` : b < 0 ? `${naira(-b)} in credit` : 'Nil');

// Print only the statement, not the rest of the page it sits on.
function printStatement() {
  document.body.classList.add('print-statement');
  const done = () => {
    document.body.classList.remove('print-statement');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}

export function StatementView({ url, csvUrl, showMember }) {
  const { data, error } = useFetch(url);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const rows = [{ ref: 'opening', date: data.from, type: '', description: 'Opening balance', debit: 0, credit: 0, balance: data.opening }, ...data.rows];
  return (
    <Card
      className="statement-card"
      title={showMember ? `${data.user.firstName} ${data.user.lastName} (${data.user.membershipId})` : 'Statement of account'}
      actions={<>
        <button className="btn btn-ghost" onClick={printStatement}>Print / PDF</button>
        {csvUrl && <button className="btn btn-ghost" onClick={() => downloadCsv(csvUrl, 'statement.csv')}>CSV</button>}
      </>}
    >
      <div className="print-only statement-head">
        <h2>Statement of account</h2>
        <div><strong>{data.user.firstName} {data.user.lastName}</strong> ({data.user.membershipId}){data.user.plotNumber ? ` · Plot ${data.user.plotNumber}` : ''}{data.user.street ? `, ${data.user.street}` : ''}</div>
        <div className="muted">{data.from || data.to ? `${data.from ? date(data.from) : 'Start'} to ${data.to ? date(data.to) : 'today'}` : 'All dates'} · printed {date(new Date())}</div>
      </div>
      <p>Closing balance: <strong className={data.closing > 0 ? 'text-bad' : 'text-good'}>{balanceText(data.closing)}</strong></p>
      <Table rows={rows} rowKey="ref" columns={[
        { key: 'date', label: 'Date', render: (r) => date(r.date) },
        { key: 'type', label: 'Type' },
        { key: 'description', label: 'Description' },
        { key: 'ref', label: 'Reference', render: (r) => (r.ref === 'opening' ? '' : r.debitNoteId ? <Link to={`/debit-notes/${r.debitNoteId}`}>{r.ref}</Link> : r.paymentId ? <Link to={`/receipts/${r.paymentId}`}>{r.ref}</Link> : r.ref) },
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
      <PageHeader title="Statement of account" subtitle="Debit notes, bills and payments with a running balance" />
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
