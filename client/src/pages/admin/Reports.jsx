import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { qs } from '../../api.js';
import { Badge, Card, ErrorNote, Field, Loading, MemberPicker, Money, PageHeader, Stat, Table, Tabs, downloadCsv, useFetch } from '../../components/ui.jsx';
import { date, humanize, naira, todayIso } from '../../format.js';
import { StatementView } from '../resident/Statement.jsx';

const TABS = [
  { key: 'collections', label: 'Collections' },
  { key: 'outstanding', label: 'Outstanding & ageing' },
  { key: 'billing', label: 'Billing vs collection' },
  { key: 'income', label: 'Income & expenditure' },
  { key: 'statement', label: 'Member statement' },
  { key: 'assets', label: 'Assets register' },
  { key: 'members', label: 'Member register' },
];

export default function Reports() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'collections';
  return (
    <>
      <PageHeader title="Reports" subtitle={`${TABS.find((t) => t.key === tab)?.label} · printed ${date(new Date())}`} />
      <Tabs active={tab} onChange={(t) => setParams({ tab: t })} tabs={TABS} />
      {tab === 'collections' && <Collections />}
      {tab === 'outstanding' && <Outstanding />}
      {tab === 'billing' && <BillingVsCollection />}
      {tab === 'income' && <IncomeExpenditure />}
      {tab === 'statement' && <MemberStatement />}
      {tab === 'assets' && <AssetsRegister />}
      {tab === 'members' && <MemberRegister />}
    </>
  );
}

function ReportActions({ csv, name }) {
  const [err, setErr] = useState(null);
  return (
    <div className="actions no-print">
      <button className="btn btn-ghost" onClick={() => window.print()}>Print / PDF</button>
      <button className="btn btn-ghost" onClick={() => downloadCsv(csv, name).catch(setErr)}>Download CSV (Excel)</button>
      {err && <span className="text-bad">{err.message}</span>}
    </div>
  );
}

function useRange() {
  const [r, setR] = useState({ from: `${todayIso().slice(0, 4)}-01-01`, to: todayIso() });
  const filters = (
    <div className="filters">
      <Field label="From"><input type="date" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} /></Field>
      <Field label="To"><input type="date" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} /></Field>
      <Field label="Quick">
        <select value="" onChange={(e) => {
          const t = todayIso();
          const m = { month: [`${t.slice(0, 7)}-01`, t], year: [`${t.slice(0, 4)}-01-01`, t], last: (() => { const d = new Date(`${t.slice(0, 7)}-01T00:00:00Z`); d.setUTCDate(0); const end = d.toISOString().slice(0, 10); return [`${end.slice(0, 7)}-01`, end]; })() }[e.target.value];
          if (m) setR({ from: m[0], to: m[1] });
        }}>
          <option value="">Choose…</option><option value="month">This month</option><option value="last">Last month</option><option value="year">This year</option>
        </select>
      </Field>
    </div>
  );
  return [r, filters];
}

function Bars({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.amount));
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.label}>
          <span>{r.label}</span>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${(r.amount / max) * 100}%` }} /></div>
          <span className="num right">{naira(r.amount)}</span>
        </div>
      ))}
    </div>
  );
}

function Collections() {
  const [r, filters] = useRange();
  const url = `/api/reports/collections${qs(r)}`;
  const { data, error } = useFetch(url);
  return (
    <>
      <Card actions={<ReportActions csv={`${url}&format=csv`} name="collections.csv" />} title="Cash actually received">{filters}<ErrorNote error={error} />
        {data && <div className="stats"><Stat label="Total collected" value={naira(data.total)} tone="good" hint={`${data.count} payment(s), ${date(data.from)} – ${date(data.to)}`} /></div>}
      </Card>
      {!data ? <Loading /> : (
        <>
          <div className="grid grid-3">
            <Card title="By method"><Bars rows={data.byMethod} /></Card>
            <Card title="By fee"><Bars rows={data.byFee} /></Card>
            <Card title="By month"><Bars rows={data.byMonth} /></Card>
          </div>
          <Card title="Payments">
            <Table rows={data.rows} rowKey="receiptNo" empty="No payments in this period." columns={[
              { key: 'date', label: 'Date', render: (x) => date(x.date) },
              { key: 'receiptNo', label: 'Receipt' },
              { key: 'member', label: 'Member', render: (x) => `${x.member} (${x.membershipId})` },
              { key: 'method', label: 'Method' },
              { key: 'reference', label: 'Reference' },
              { key: 'recordedBy', label: 'Recorded by' },
              { key: 'amount', label: 'Amount', align: 'right', render: (x) => <Money v={x.amount} /> },
            ]} footer={<tr><td colSpan={6}>Total</td><td className="right"><Money v={data.total} /></td></tr>} />
          </Card>
        </>
      )}
    </>
  );
}

function Outstanding() {
  const { data, error } = useFetch('/api/reports/outstanding');
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  return (
    <Card title={`Outstanding as at ${date(data.asOf)}`} actions={<ReportActions csv="/api/reports/outstanding?format=csv" name="outstanding.csv" />}>
      <div className="stats">
        {data.buckets.map((b) => <Stat key={b.key} label={b.label} value={naira(data.totals[b.key])} tone={b.key === 'd90plus' && data.totals[b.key] ? 'bad' : undefined} />)}
        <Stat label="Total outstanding" value={naira(data.totals.total)} tone={data.totals.total ? 'bad' : 'good'} hint={`${data.rows.length} member(s)`} />
      </div>
      <Table rows={data.rows} rowKey="userId" empty="Nobody owes anything. 🎉" columns={[
        { key: 'member', label: 'Member', render: (x) => <Link to={`/admin/residents/${x.userId}`}>{x.member}</Link> },
        { key: 'membershipId', label: 'ID', className: 'num' },
        { key: 'plot', label: 'Plot' },
        { key: 'phone', label: 'Phone' },
        ...data.buckets.map((b) => ({ key: b.key, label: b.label, align: 'right', render: (x) => (x[b.key] ? <Money v={x[b.key]} /> : '—') })),
        { key: 'total', label: 'Total', align: 'right', render: (x) => <strong><Money v={x.total} /></strong> },
      ]} footer={<tr><td colSpan={4}>Total</td>{data.buckets.map((b) => <td key={b.key} className="right"><Money v={data.totals[b.key]} /></td>)}<td className="right"><Money v={data.totals.total} /></td></tr>} />
    </Card>
  );
}

function BillingVsCollection() {
  const [year, setYear] = useState(Number(todayIso().slice(0, 4)));
  const url = `/api/reports/billing-vs-collection?year=${year}`;
  const { data, error } = useFetch(url);
  const max = Math.max(1, ...(data?.rows || []).flatMap((r) => [r.billed, r.collected]));
  return (
    <Card title={`Billing vs collection, ${year}`} actions={<ReportActions csv={`${url}&format=csv`} name="billing_vs_collection.csv" />}>
      <div className="filters"><Field label="Year"><select value={year} onChange={(e) => setYear(Number(e.target.value))}>{[0, 1, 2, 3].map((d) => <option key={d}>{Number(todayIso().slice(0, 4)) - d}</option>)}</select></Field></div>
      <ErrorNote error={error} />
      {!data ? <Loading /> : (
        <>
          <div className="stats">
            <Stat label="Billed" value={naira(data.totals.billed)} />
            <Stat label="Of which settled" value={naira(data.totals.settled)} hint={data.totals.rate != null ? `${data.totals.rate}% of billing` : ''} tone="good" />
            <Stat label="Cash collected" value={naira(data.totals.collected)} />
          </div>
          <div className="chart-months">{data.rows.map((r) => <div className="chart-col" key={r.month} title={`${r.label}: billed ${naira(r.billed)}, collected ${naira(r.collected)}`}><div style={{ height: `${(r.billed / max) * 100}%`, background: 'var(--border)' }} /><div style={{ height: `${(r.collected / max) * 100}%`, background: 'var(--brand)' }} /></div>)}</div>
          <div className="chart-labels">{data.rows.map((r) => <span key={r.month}>{r.label.slice(0, 3)}</span>)}</div>
          <div className="legend"><span><i style={{ background: 'var(--border)' }} />Billed (by due month)</span><span><i style={{ background: 'var(--brand)' }} />Collected (by payment date)</span></div>
          <div style={{ marginTop: 16 }}>
            <Table rows={data.rows} rowKey="month" columns={[
              { key: 'label', label: 'Month' },
              { key: 'billed', label: 'Billed', align: 'right', render: (r) => <Money v={r.billed} /> },
              { key: 'settled', label: 'Settled', align: 'right', render: (r) => <Money v={r.settled} /> },
              { key: 'rate', label: 'Settled %', align: 'right', render: (r) => (r.rate == null ? '—' : `${r.rate}%`) },
              { key: 'collected', label: 'Collected', align: 'right', render: (r) => <Money v={r.collected} /> },
            ]} />
          </div>
        </>
      )}
    </Card>
  );
}

function IncomeExpenditure() {
  const [r, filters] = useRange();
  const url = `/api/reports/income-expenditure${qs(r)}`;
  const { data, error } = useFetch(url);
  return (
    <Card title="Income & expenditure" actions={<ReportActions csv={`${url}&format=csv`} name="income_expenditure.csv" />}>
      {filters}
      <ErrorNote error={error} />
      {!data ? <Loading /> : (
        <>
          <div className="stats">
            <Stat label="Income (cash received)" value={naira(data.totalIncome)} tone="good" />
            <Stat label="Expenditure" value={naira(data.totalExpenditure)} />
            <Stat label={data.surplus >= 0 ? 'Surplus' : 'Deficit'} value={naira(Math.abs(data.surplus))} tone={data.surplus >= 0 ? 'good' : 'bad'} />
          </div>
          <div className="grid grid-2">
            <div><h2 style={{ marginBottom: 8 }}>Income</h2><Table rows={data.income} rowKey="label" empty="No income." columns={[{ key: 'label', label: 'Source' }, { key: 'amount', label: 'Amount', align: 'right', render: (x) => <Money v={x.amount} /> }]} footer={<tr><td>Total</td><td className="right"><Money v={data.totalIncome} /></td></tr>} /></div>
            <div><h2 style={{ marginBottom: 8 }}>Expenditure</h2><Table rows={data.expenditure} rowKey="label" empty="No expenses recorded." columns={[{ key: 'label', label: 'Category' }, { key: 'amount', label: 'Amount', align: 'right', render: (x) => <Money v={x.amount} /> }]} footer={<tr><td>Total</td><td className="right"><Money v={data.totalExpenditure} /></td></tr>} /></div>
          </div>
        </>
      )}
    </Card>
  );
}

function MemberStatement() {
  const [member, setMember] = useState(null);
  const [r, setR] = useState({ from: '', to: '' });
  return (
    <>
      <Card title="Member statement">
        <div className="filters">
          <div className="grow"><Field label="Member"><MemberPicker value={member} onChange={setMember} /></Field></div>
          <Field label="From"><input type="date" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} /></Field>
          <Field label="To"><input type="date" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} /></Field>
        </div>
      </Card>
      {member && <StatementView url={`/api/reports/statement${qs({ userId: member.id, ...r })}`} csvUrl={`/api/reports/statement${qs({ userId: member.id, ...r, format: 'csv' })}`} showMember />}
    </>
  );
}

function AssetsRegister() {
  const { data, error } = useFetch('/api/reports/assets');
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  return (
    <Card title="Assets & materials register" actions={<ReportActions csv="/api/reports/assets?format=csv" name="assets.csv" />}>
      <Table rows={data.rows} rowKey="name" columns={[
        { key: 'name', label: 'Item' },
        { key: 'category', label: 'Category' },
        { key: 'qty', label: 'Quantity', render: (a) => <span className="num">{a.quantity} {a.unit} {a.lowStock && <Badge status="OVERDUE" label="Low" />}</span> },
        { key: 'location', label: 'Location' },
        { key: 'purchaseDate', label: 'Bought', render: (a) => date(a.purchaseDate) },
        { key: 'purchaseCost', label: 'Cost', align: 'right', render: (a) => (a.purchaseCost == null ? '—' : <Money v={a.purchaseCost} />) },
        { key: 'maintenanceCost', label: 'Maintenance', align: 'right', render: (a) => <Money v={a.maintenanceCost} /> },
        { key: 'lastMaintenance', label: 'Last serviced', render: (a) => date(a.lastMaintenance) || '—' },
      ]} />
    </Card>
  );
}

function MemberRegister() {
  const [status, setStatus] = useState('active');
  const { data, error } = useFetch(`/api/reports/members?status=${status}`);
  return (
    <Card title="Member register" actions={<ReportActions csv={`/api/reports/members?status=${status}&format=csv`} name="members.csv" />}>
      <div className="filters"><Field label="Members"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">Active</option><option value="all">All (incl. inactive)</option></select></Field></div>
      <ErrorNote error={error} />
      {!data ? <Loading /> : (
        <Table rows={data.rows} columns={[
          { key: 'membershipId', label: 'ID', className: 'num' },
          { key: 'name', label: 'Name', render: (m) => <Link to={`/admin/residents/${m.id}`}>{m.name}</Link> },
          { key: 'occupancyType', label: 'Occupancy', render: (m) => humanize(m.occupancyType) },
          { key: 'addr', label: 'Plot / street', render: (m) => [m.plotNumber, m.street].filter(Boolean).join(', ') },
          { key: 'phone', label: 'Phone' },
          { key: 'email', label: 'Email' },
          { key: 'status', label: 'Status', render: (m) => (m.isActive ? 'Active' : 'Inactive') },
          { key: 'outstanding', label: 'Outstanding', align: 'right', render: (m) => <Money v={m.outstanding} /> },
        ]} />
      )}
    </Card>
  );
}
