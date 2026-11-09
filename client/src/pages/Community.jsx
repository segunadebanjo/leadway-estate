import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Badge, Card, ErrorNote, Field, Loading, Modal, PageHeader, SearchField, Table, Tabs, downloadCsv, useFetch, useSubmit } from '../components/ui.jsx';
import { addDaysIso, date, dateTime, todayIso } from '../format.js';

const AUDIENCE = { ALL: 'All residents', OWNERS: 'Owners only', TENANTS: 'Tenants only' };

export default function Community() {
  const { user } = useAuth();
  const isAdmin = user.role === 'ADMIN';
  const [tab, setTab] = useState('polls');
  const [creating, setCreating] = useState(null);
  const polls = useFetch('/api/community/polls');
  const meetings = useFetch('/api/community/meetings');
  return (
    <>
      <PageHeader
        title={isAdmin ? 'Meetings & polls' : 'Polls & meetings'}
        subtitle={isAdmin ? 'Ask residents to vote, call meetings and keep the attendance register' : 'Vote on estate decisions and see upcoming meetings'}
        actions={isAdmin && (
          <>
            <button className="btn btn-ghost" onClick={() => setCreating('meeting')}>New meeting</button>
            <button className="btn" onClick={() => setCreating('poll')}>New poll</button>
          </>
        )}
      />
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'polls', label: 'Polls' }, { key: 'meetings', label: 'Meetings' }]} />
      {tab === 'polls' && <Polls state={polls} isAdmin={isAdmin} />}
      {tab === 'meetings' && <Meetings state={meetings} isAdmin={isAdmin} />}
      {creating === 'poll' && <PollForm onClose={() => setCreating(null)} onSaved={() => { setCreating(null); setTab('polls'); polls.reload(); }} />}
      {creating === 'meeting' && <MeetingForm onClose={() => setCreating(null)} onSaved={() => { setCreating(null); setTab('meetings'); meetings.reload(); }} />}
    </>
  );
}

function Polls({ state, isAdmin }) {
  const { data, error, reload } = state;
  if (!data) return <><ErrorNote error={error} /><Loading /></>;
  if (!data.rows.length) return <Card><p className="muted">No polls yet.</p></Card>;
  return data.rows.map((p) => <PollCard key={p.id} p={p} isAdmin={isAdmin} onChange={reload} />);
}

function PollCard({ p, isAdmin, onChange }) {
  const [choice, setChoice] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const vote = async () => {
    if (!confirm('Submit your vote? It cannot be changed afterwards.')) return;
    setBusy(true); setErr(null);
    try { await api.post(`/api/community/polls/${p.id}/vote`, { optionId: choice }); onChange(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const close = async () => {
    if (!confirm('Close voting now? Everyone will be able to see the results.')) return;
    try { await api.post(`/api/community/polls/${p.id}/close`); onChange(); } catch (e) { setErr(e); }
  };
  const max = Math.max(1, ...p.options.map((o) => o.votes || 0));
  return (
    <Card title={<>{p.title} {p.open ? <Badge status="ACTIVE" label="Open" /> : <Badge status="CLOSED" label="Closed" />}</>} actions={isAdmin && p.open && <button className="btn btn-ghost btn-small" onClick={close}>Close voting</button>}>
      {p.description && <p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{p.description}</p>}
      <p className="muted" style={{ fontSize: '.85rem' }}>{AUDIENCE[p.audience]} · {p.open ? `voting closes ${dateTime(p.closesAt)}` : `closed ${dateTime(p.closedAt || p.closesAt)}`}{p.votes !== null && ` · ${p.votes} of ${p.electorate} voted`}</p>
      <ErrorNote error={err} />
      {p.canVote ? (
        <>
          {p.options.map((o) => (
            <label key={o.id} className="check poll-option"><input type="radio" name={`poll-${p.id}`} checked={choice === o.id} onChange={() => setChoice(o.id)} /> {o.label}</label>
          ))}
          <button className="btn" disabled={!choice || busy} onClick={vote}>{busy ? 'Voting…' : 'Vote'}</button>
        </>
      ) : (
        <div className="poll-results">
          {p.options.map((o) => (
            <div key={o.id} className="poll-row">
              <div className="poll-label">{o.label}{p.myOptionId === o.id && <Badge status="ACTIVE" label="Your vote" />}</div>
              {o.votes !== null ? (
                <div className="poll-bar-wrap"><div className="poll-bar" style={{ width: `${(o.votes / max) * 100}%` }} /><span className="num">{o.votes}{p.votes ? ` (${Math.round((o.votes / p.votes) * 100)}%)` : ''}</span></div>
              ) : null}
            </div>
          ))}
          {p.votes === null && <p className="muted">{p.myOptionId ? 'Thank you for voting. ' : ''}Results are shown when voting closes.</p>}
        </div>
      )}
    </Card>
  );
}

function PollForm({ onClose, onSaved }) {
  const [v, setV] = useState({ title: '', description: '', audience: 'ALL', closesOn: addDaysIso(todayIso(), 7), options: ['Yes', 'No'], email: false });
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const setOpt = (i, val) => setV({ ...v, options: v.options.map((o, j) => (j === i ? val : o)) });
  const { busy, error, run } = useSubmit(async () => { await api.post('/api/community/polls', { ...v, description: v.description || null, options: v.options.map((o) => o.trim()).filter(Boolean) }); onSaved(); });
  return (
    <Modal title="New poll" onClose={onClose}>
      <form onSubmit={run}>
        <ErrorNote error={error} />
        <Field label="Question"><input value={v.title} onChange={set('title')} required maxLength={200} placeholder="e.g. Should monthly dues rise to ₦7,500 from January?" /></Field>
        <Field label="Details (optional)"><textarea value={v.description} onChange={set('description')} /></Field>
        <Field label="Choices">
          {v.options.map((o, i) => (
            <div key={i} className="upload-row" style={{ marginBottom: 6 }}>
              <input value={o} onChange={(e) => setOpt(i, e.target.value)} style={{ flex: 1, width: 'auto' }} />
              {v.options.length > 2 && <button type="button" className="btn btn-ghost btn-small" onClick={() => setV({ ...v, options: v.options.filter((_, j) => j !== i) })}>Remove</button>}
            </div>
          ))}
          {v.options.length < 10 && <button type="button" className="btn btn-ghost btn-small" onClick={() => setV({ ...v, options: [...v.options, ''] })}>Add a choice</button>}
        </Field>
        <div className="form-row">
          <Field label="Who can vote"><select value={v.audience} onChange={set('audience')}>{Object.entries(AUDIENCE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Voting closes (end of day)"><input type="date" min={todayIso()} value={v.closesOn} onChange={set('closesOn')} required /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={v.email} onChange={set('email')} /> Also email residents (they always get an app notice)</label>
        <p className="muted" style={{ fontSize: '.85rem' }}>One vote per member, which cannot be changed. Residents see the results when voting closes; executives see them as votes come in.</p>
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Start poll'}</button>
      </form>
    </Modal>
  );
}

function Meetings({ state, isAdmin }) {
  const { data, error, reload } = state;
  const [open, setOpen] = useState(null);
  if (!data) return <><ErrorNote error={error} /><Loading /></>;
  const now = new Date().toISOString();
  return (
    <Card>
      <Table rows={data.rows} onRowClick={isAdmin ? (m) => setOpen(m.id) : undefined} empty="No meetings yet." columns={[
        { key: 'startsAt', label: 'When', render: (m) => <>{dateTime(m.startsAt)} {m.startsAt > now && <Badge status="ACTIVE" label="Upcoming" />}</> },
        { key: 'title', label: 'Meeting', render: (m) => <><strong>{m.title}</strong>{m.agenda && <div className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: '.85rem' }}>{m.agenda}</div>}</> },
        { key: 'location', label: 'Where' },
        isAdmin ? { key: 'attended', label: 'Attendance', render: (m) => `${m.attended} present` } : { key: 'me', label: 'You', render: (m) => (m.iAttended ? <Badge status="PAID" label="Attended" /> : m.startsAt < now ? '—' : '') },
      ]} />
      {isAdmin && <p className="muted" style={{ fontSize: '.85rem' }}>Click a meeting to mark attendance.</p>}
      {open && <Register id={open} onClose={() => { setOpen(null); reload(); }} />}
    </Card>
  );
}

function MeetingForm({ onClose, onSaved }) {
  const [v, setV] = useState({ title: '', startsAt: `${addDaysIso(todayIso(), 14)}T10:00`, location: '', agenda: '', notify: true, email: false });
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const { busy, error, run } = useSubmit(async () => { await api.post('/api/community/meetings', { ...v, location: v.location || null, agenda: v.agenda || null }); onSaved(); });
  return (
    <Modal title="New meeting" onClose={onClose}>
      <form onSubmit={run}>
        <ErrorNote error={error} />
        <Field label="Title"><input value={v.title} onChange={set('title')} required placeholder="e.g. Annual General Meeting 2026" /></Field>
        <div className="form-row">
          <Field label="Date and time"><input type="datetime-local" value={v.startsAt} onChange={set('startsAt')} required /></Field>
          <Field label="Where"><input value={v.location} onChange={set('location')} placeholder="Estate hall" /></Field>
        </div>
        <Field label="Agenda (optional)"><textarea value={v.agenda} onChange={set('agenda')} rows={5} /></Field>
        <label className="check"><input type="checkbox" checked={v.notify} onChange={set('notify')} /> Notify all residents in the app</label>
        {v.notify && <label className="check"><input type="checkbox" checked={v.email} onChange={set('email')} /> Also email them</label>}
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Create meeting'}</button>
      </form>
    </Modal>
  );
}

function Register({ id, onClose }) {
  const { data, error, reload } = useFetch(`/api/community/meetings/${id}`);
  const [q, setQ] = useState('');
  const [onlyPresent, setOnlyPresent] = useState(false);
  const [err, setErr] = useState(null);
  const mark = async (u, present, proxyName = null) => {
    try { await api.post(`/api/community/meetings/${id}/attendance`, { userId: u.id, present, proxyName }); reload(); } catch (e) { setErr(e); }
  };
  const proxy = (u) => {
    const name = prompt(`Who attended on behalf of ${u.firstName} ${u.lastName}?`, u.proxyName || '');
    if (name) mark(u, true, name);
  };
  const term = q.trim().toLowerCase();
  const rows = data?.rows.filter((u) => (!onlyPresent || u.present) && (!term || `${u.membershipId} ${u.firstName} ${u.lastName} ${u.plotNumber || ''}`.toLowerCase().includes(term))) || [];
  return (
    <Modal title={data ? `${data.meeting.title} · ${date(data.meeting.startsAt)}` : 'Attendance'} onClose={onClose} wide>
      <ErrorNote error={error || err} />
      {!data ? <Loading /> : (
        <>
          <div className="alert alert-info"><strong>{data.present} of {data.eligible}</strong> active residents present ({data.turnout}%).</div>
          <div className="filters">
            <SearchField placeholder="Name, LWE-ID or plot" value={q} onChange={setQ} />
            <label className="check" style={{ alignSelf: 'center' }}><input type="checkbox" checked={onlyPresent} onChange={(e) => setOnlyPresent(e.target.checked)} /> Present only</label>
            <button type="button" className="btn btn-ghost" style={{ alignSelf: 'end' }} onClick={() => downloadCsv(`/api/community/meetings/${id}/register.csv`, 'attendance.csv').catch(setErr)}>Download register</button>
          </div>
          <div className="preview-scroll" style={{ maxHeight: 420 }}>
            <Table rows={rows} empty="Nobody matches." columns={[
              { key: 'present', label: 'Present', render: (u) => <input type="checkbox" checked={u.present} onChange={(e) => mark(u, e.target.checked)} aria-label={`${u.membershipId} present`} /> },
              { key: 'member', label: 'Member', render: (u) => <><strong>{u.membershipId}</strong> {u.firstName} {u.lastName}</> },
              { key: 'plot', label: 'Plot', render: (u) => [u.plotNumber, u.street].filter(Boolean).join(', ') },
              { key: 'proxy', label: 'Proxy', render: (u) => <>{u.proxyName || ''} <button type="button" className="link-button" onClick={() => proxy(u)}>{u.proxyName ? 'change' : 'by proxy'}</button></> },
            ]} />
          </div>
        </>
      )}
    </Modal>
  );
}
