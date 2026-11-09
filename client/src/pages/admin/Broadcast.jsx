import { useState } from 'react';
import { api } from '../../api.js';
import { Card, ErrorNote, Field, Loading, MemberPicker, PageHeader, Table, useFetch, useSubmit } from '../../components/ui.jsx';
import { dateTime, fullName, humanize } from '../../format.js';

export default function Broadcast() {
  const history = useFetch('/api/broadcasts');
  const [v, setV] = useState({ title: '', body: '', audience: 'ALL', sendEmail: true, sendSms: false });
  const [members, setMembers] = useState([]);
  const [sent, setSent] = useState(null);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const { busy, error, run, setError } = useSubmit(async () => {
    if (v.audience === 'SELECTED' && !members.length) return setError(new Error('Add at least one resident'));
    if (!confirm(`Send "${v.title}" to ${v.audience === 'SELECTED' ? `${members.length} resident(s)` : humanize(v.audience).toLowerCase() + ' residents'}${v.sendSms ? ' (SMS costs apply)' : ''}?`)) return;
    setSent(await api.post('/api/broadcasts', { ...v, userIds: members.map((m) => m.id) }));
    setV({ ...v, title: '', body: '' });
    setMembers([]);
    history.reload();
  });
  return (
    <>
      <PageHeader title="Broadcast" subtitle="In-app notice to every recipient, plus email and SMS if chosen." />
      <div className="grid grid-2">
        <Card title="New message">
          <form onSubmit={run}>
            <ErrorNote error={error} />
            {sent && <div className="alert alert-good">Sent to {sent.recipients} resident(s){sent.sendEmail && ` · email ${sent.emailSent} delivered, ${sent.emailFailed} failed`}{sent.sendSms && ` · SMS ${sent.smsSent} sent, ${sent.smsFailed} not sent`}.</div>}
            <Field label="Audience">
              <select value={v.audience} onChange={set('audience')}><option value="ALL">All active residents</option><option value="OWNERS">Owners</option><option value="TENANTS">Tenants</option><option value="SELECTED">Chosen residents</option></select>
            </Field>
            {v.audience === 'SELECTED' && (
              <Field label={`Residents (${members.length})`}>
                <MemberPicker value={null} onChange={(m) => m && !members.some((x) => x.id === m.id) && setMembers([...members, m])} placeholder="Search and add…" />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>{members.map((m) => <span key={m.id} className="badge badge-info">{m.firstName} {m.lastName} <button type="button" style={{ border: 0, background: 'none', color: 'inherit', cursor: 'pointer' }} onClick={() => setMembers(members.filter((x) => x.id !== m.id))}>×</button></span>)}</div>
              </Field>
            )}
            <Field label="Title"><input value={v.title} onChange={set('title')} required maxLength={150} /></Field>
            <Field label="Message" hint={v.sendSms ? `SMS carries the title and the first ${Math.max(0, 440 - v.title.length)} characters.` : ''}><textarea value={v.body} onChange={set('body')} required maxLength={5000} /></Field>
            <label className="check"><input type="checkbox" checked={v.sendEmail} onChange={set('sendEmail')} /> Also email</label>
            <label className="check"><input type="checkbox" checked={v.sendSms} onChange={set('sendSms')} /> Also SMS (Termii)</label>
            <button className="btn" disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
          </form>
        </Card>
        <Card title="Sent">
          {!history.data ? <Loading /> : (
            <Table rows={history.data.rows} empty="Nothing sent yet." columns={[
              { key: 'createdAt', label: 'When', render: (a) => dateTime(a.createdAt) },
              { key: 'title', label: 'Title', render: (a) => <><strong>{a.title}</strong><div className="muted">{humanize(a.audience)} · by {fullName(a.sentBy)}</div></> },
              { key: 'delivery', label: 'Delivery', render: (a) => <span className="muted">{a.recipients} in-app{a.sendEmail ? ` · ${a.emailSent} email` : ''}{a.sendSms ? ` · ${a.smsSent} SMS` : ''}</span> },
            ]} />
          )}
        </Card>
      </div>
    </>
  );
}
