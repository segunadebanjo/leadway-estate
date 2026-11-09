import { useState } from 'react';
import { api, qs } from '../../api.js';
import { Badge, Card, ErrorNote, Field, Loading, PageHeader, SearchField, Table, Tabs, useFetch, useSubmit } from '../../components/ui.jsx';
import { dateTime, fullName } from '../../format.js';

export default function Gate() {
  const [code, setCode] = useState('');
  const [pass, setPass] = useState(null);
  const [scope, setScope] = useState('today');
  const [q, setQ] = useState('');
  const log = useFetch(`/api/visitors${qs({ scope, q })}`);
  const verify = useSubmit(async () => {
    setPass(null);
    setPass(await api.post('/api/visitors/verify', { code }));
  });
  const [actError, setActError] = useState(null);
  const act = async (p, kind) => {
    setActError(null);
    try {
      const r = await api.post(`/api/visitors/${p.id}/${kind}`);
      if (pass?.id === p.id) setPass(r);
      if (kind === 'check-in') setCode('');
      log.reload();
    } catch (err) {
      setActError(err);
    }
  };
  return (
    <>
      <PageHeader title="Gate" subtitle="Verify visitor codes, check visitors in and out" />
      <div className="grid grid-2">
        <Card title="Verify a code">
          <form onSubmit={verify.run}>
            <ErrorNote error={verify.error || actError} />
            <Field label="6-digit code"><input className="code-input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus /></Field>
            <button className="btn" disabled={verify.busy || code.length !== 6}>Verify</button>
          </form>
          {pass && <PassCard p={pass} onAct={act} />}
        </Card>
        <Card title="Visitors">
          <Tabs active={scope} onChange={setScope} tabs={[{ key: 'today', label: 'Expected & on site' }, { key: 'onsite', label: 'On site' }, { key: 'all', label: 'Log' }]} />
          <div className="filters"><SearchField value={q} onChange={setQ} placeholder="Name, code or plate" /></div>
          {!log.data ? <Loading /> : (
            <Table rows={log.data.rows} empty="No visitors." columns={[
              { key: 'v', label: 'Visitor', render: (p) => <><strong>{p.visitorName}</strong>{p.vehiclePlate && <span className="muted"> · {p.vehiclePlate}</span>}<div className="muted">to {fullName(p.host)}, Plot {p.host.plotNumber || '—'}</div></> },
              { key: 'when', label: 'When', render: (p) => dateTime(p.checkedInAt || p.validFrom) },
              { key: 'state', label: 'Status', render: (p) => <Badge status={p.state} /> },
              { key: 'act', label: '', align: 'right', render: (p) => p.state === 'ACTIVE' ? <button className="btn btn-small" onClick={() => act(p, 'check-in')}>Check in</button> : p.state === 'CHECKED_IN' ? <button className="btn btn-ghost btn-small" onClick={() => act(p, 'check-out')}>Check out</button> : null },
            ]} />
          )}
        </Card>
      </div>
    </>
  );
}

function PassCard({ p, onAct }) {
  const ok = p.state === 'ACTIVE';
  return (
    <div className={`alert ${ok ? 'alert-good' : p.state === 'CHECKED_IN' ? 'alert-info' : 'alert-bad'}`} style={{ marginTop: 16 }}>
      <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{p.visitorName}</div>
      <div>Visiting <strong>{fullName(p.host)}</strong> ({p.host.membershipId}) · Plot {p.host.plotNumber || '—'}{p.host.street ? `, ${p.host.street}` : ''}</div>
      {p.purpose && <div>Purpose: {p.purpose}</div>}
      {p.vehiclePlate && <div>Vehicle: {p.vehiclePlate}</div>}
      <div>Valid {dateTime(p.validFrom)} – {dateTime(p.validUntil)}</div>
      <div style={{ margin: '8px 0' }}><Badge status={p.state} /></div>
      {ok && <button className="btn" onClick={() => onAct(p, 'check-in')}>Admit (check in)</button>}
      {p.state === 'CHECKED_IN' && <button className="btn btn-ghost" onClick={() => onAct(p, 'check-out')}>Check out</button>}
      {p.state === 'EXPIRED' && <div>This code has expired. Call the resident{p.host.phone ? ` on ${p.host.phone}` : ''}.</div>}
      {p.state === 'NOT_YET_VALID' && <div>This code is not valid yet.</div>}
    </div>
  );
}
