import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../api.js';
import { Card, ErrorNote, Field, Loading, Money, PageHeader, Pager, Table, Tabs, useFetch } from '../../components/ui.jsx';
import { date, dateTime, fullName, koboToInput, naira, toKobo } from '../../format.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function Reminders() {
  const [tab, setTab] = useState('owing');
  return (
    <>
      <PageHeader title="Reminders" subtitle="Remind members who owe, by app notice, email and SMS. Members keeping up with a payment plan are left alone." />
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'owing', label: 'Who owes' }, { key: 'auto', label: 'Automatic reminders' }, { key: 'history', label: 'Sent' }]} />
      {tab === 'owing' && <Owing />}
      {tab === 'auto' && <AutoSettings />}
      {tab === 'history' && <History />}
    </>
  );
}

function Owing() {
  const { data, error, reload } = useFetch('/api/admin/reminders');
  const [picked, setPicked] = useState(new Set());
  const [ch, setCh] = useState({ email: true, sms: false });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (data) setPicked(new Set(data.debtors.filter((d) => !d.plan || d.plan.behind > 0).map((d) => d.id)));
    if (data) setCh({ email: data.channels.email, sms: false });
  }, [data]);
  if (!data) return <><ErrorNote error={error} /><Loading /></>;
  const toggle = (id) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const total = data.debtors.filter((d) => picked.has(d.id)).reduce((s, d) => s + (d.plan ? d.plan.behind : d.overdue), 0);
  const send = async () => {
    if (!confirm(`Send a reminder to ${picked.size} member(s)?`)) return;
    setBusy(true); setErr(null); setResult(null);
    try { setResult(await api.post('/api/admin/reminders/send', { userIds: [...picked], ...ch })); reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Card>
      <ErrorNote error={err} />
      {result && <div className="alert alert-good">Reminded {result.reminded} member(s){result.emailSent ? ` · ${result.emailSent} email(s) sent` : ''}{result.emailFailed ? ` · ${result.emailFailed} email(s) failed` : ''}{result.smsSent ? ` · ${result.smsSent} SMS sent` : ''}{result.smsFailed ? ` · ${result.smsFailed} SMS failed` : ''}.</div>}
      {!data.channels.email && <div className="alert alert-warn">Email is not set up yet, so reminders go only to the members' app notifications. <Link to="/admin/settings">Set up email</Link></div>}
      {data.debtors.length === 0 ? <p className="muted">Nobody owes anything overdue. 🎉</p> : (
        <>
          <div className="actions" style={{ marginBottom: 12 }}>
            <button className="btn btn-ghost btn-small" onClick={() => setPicked(new Set(data.debtors.map((d) => d.id)))}>Select all</button>
            <button className="btn btn-ghost btn-small" onClick={() => setPicked(new Set())}>Select none</button>
            <span className="muted">{data.debtors.length} member(s) owe; {picked.size} selected ({naira(total)})</span>
          </div>
          <Table rows={data.debtors} columns={[
            { key: 'pick', label: '', render: (d) => <input type="checkbox" checked={picked.has(d.id)} onChange={() => toggle(d.id)} aria-label={`Select ${d.membershipId}`} /> },
            { key: 'member', label: 'Member', render: (d) => <Link to={`/admin/residents/${d.id}`}><strong>{d.membershipId}</strong> {d.firstName} {d.lastName}</Link> },
            { key: 'plot', label: 'Plot', render: (d) => [d.plotNumber, d.street].filter(Boolean).join(', ') },
            { key: 'overdue', label: 'Overdue', align: 'right', render: (d) => <Money v={d.overdue} className="text-bad" /> },
            { key: 'days', label: 'Oldest', render: (d) => `${d.daysOverdue} days` },
            { key: 'plan', label: 'Plan', render: (d) => (d.plan ? (d.plan.behind > 0 ? <span className="text-bad">behind {naira(d.plan.behind)}</span> : <span className="text-good">on track</span>) : '—') },
            { key: 'contact', label: 'Can reach by', render: (d) => [d.email && 'email', d.phone && 'SMS'].filter(Boolean).join(', ') || 'app only' },
            { key: 'last', label: 'Last reminded', render: (d) => (d.lastReminded ? date(d.lastReminded) : 'never') },
          ]} />
          <div className="actions" style={{ marginTop: 14 }}>
            <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={ch.email} disabled={!data.channels.email} onChange={(e) => setCh({ ...ch, email: e.target.checked })} /> Email</label>
            <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={ch.sms} disabled={!data.channels.sms} onChange={(e) => setCh({ ...ch, sms: e.target.checked })} /> SMS{!data.channels.sms && ' (not set up)'}</label>
            <button className="btn" disabled={busy || !picked.size} onClick={send}>{busy ? 'Sending…' : `Send reminder to ${picked.size}`}</button>
          </div>
          <p className="muted" style={{ fontSize: '.85rem' }}>Every reminder also appears in the member's app notifications. Members on a plan are reminded of the instalment they are behind on, not the whole debt.</p>
        </>
      )}
    </Card>
  );
}

function AutoSettings() {
  const { data, error } = useFetch('/api/admin/reminders');
  const [v, setV] = useState(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { if (data) setV({ ...data.settings, minAmount: data.settings.minAmount ? koboToInput(data.settings.minAmount) : '' }); }, [data]);
  if (!v) return <><ErrorNote error={error} /><Loading /></>;
  const set = (k) => (e) => { setSaved(false); setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }); };
  const save = async (e) => {
    e.preventDefault();
    setErr(null);
    try {
      await api.put('/api/admin/reminders/settings', { ...v, weekday: Number(v.weekday), minDaysOverdue: Number(v.minDaysOverdue), minAmount: v.minAmount ? toKobo(v.minAmount) ?? 0 : 0 });
      setSaved(true);
    } catch (x) { setErr(x); }
  };
  const next = data.debtors.filter((d) => d.inNextAutoRun);
  return (
    <div className="grid grid-2">
      <Card title="Weekly reminders">
        <form onSubmit={save}>
          <ErrorNote error={err} />
          {saved && <div className="alert alert-good">Saved.</div>}
          <label className="check"><input type="checkbox" checked={v.auto} onChange={set('auto')} /> <strong>Send reminders automatically every week</strong></label>
          <div className="form-row">
            <Field label="On"><select value={v.weekday} onChange={set('weekday')}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></Field>
            <Field label="Bills overdue at least (days)"><input type="number" min="0" max="365" value={v.minDaysOverdue} onChange={set('minDaysOverdue')} /></Field>
          </div>
          <Field label="Ignore balances below (₦)" hint="Leave blank to remind about any amount"><input inputMode="decimal" value={v.minAmount} onChange={set('minAmount')} /></Field>
          <label className="check"><input type="checkbox" checked={v.email} onChange={set('email')} disabled={!data.channels.email} /> Email{!data.channels.email && ' (set up email first)'}</label>
          <label className="check"><input type="checkbox" checked={v.sms} onChange={set('sms')} disabled={!data.channels.sms} /> SMS{!data.channels.sms && ' (SMS not set up)'}</label>
          <p className="muted" style={{ fontSize: '.85rem' }}>Sent at about 9am. Nobody is reminded more than once a week, and members keeping up with a payment plan are skipped. On the free hosting plan the app must be awake at 9am: keep the cron-job.org ping running.</p>
          <button className="btn">Save</button>
        </form>
      </Card>
      <Card title={`Next automatic run would remind ${next.length}`}>
        <Table rows={next} empty="Nobody right now." columns={[
          { key: 'm', label: 'Member', render: (d) => `${d.membershipId} ${d.firstName} ${d.lastName}` },
          { key: 'o', label: 'Amount', align: 'right', render: (d) => <Money v={d.plan ? d.plan.behind : d.overdue} /> },
        ]} />
      </Card>
    </div>
  );
}

function History() {
  const [page, setPage] = useState(1);
  const { data, error } = useFetch(`/api/admin/reminders/history${qs({ page, pageSize: 50 })}`);
  return (
    <Card>
      <ErrorNote error={error} />
      {!data ? <Loading /> : (
        <>
          <Table rows={data.rows} empty="No reminders sent yet." columns={[
            { key: 'createdAt', label: 'When', render: (r) => dateTime(r.createdAt) },
            { key: 'm', label: 'Member', render: (r) => `${r.user.membershipId} ${fullName(r.user)}` },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => <Money v={r.amount} /> },
            { key: 'how', label: 'Sent by', render: (r) => ['app', r.emailSent && 'email', r.smsSent && 'SMS'].filter(Boolean).join(', ') },
            { key: 'automatic', label: 'Type', render: (r) => (r.automatic ? 'Automatic' : 'Manual') },
          ]} />
          <Pager page={page} pageSize={50} total={data.total} onPage={setPage} />
        </>
      )}
    </Card>
  );
}
