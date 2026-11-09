import { useState } from 'react';
import { api } from '../../api.js';
import { Badge, Card, ErrorNote, Field, Loading, PageHeader, Table, useFetch, useSubmit } from '../../components/ui.jsx';
import { dateTime } from '../../format.js';

export default function MyVisitors() {
  const { data, error, reload } = useFetch('/api/visitors/mine');
  const [v, setV] = useState({ visitorName: '', visitorPhone: '', purpose: '', vehiclePlate: '', hours: '12', when: '', smsVisitor: true });
  const [issued, setIssued] = useState(null);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const { busy, error: err, run } = useSubmit(async () => {
    const body = { visitorName: v.visitorName, visitorPhone: v.visitorPhone || null, purpose: v.purpose || null, vehiclePlate: v.vehiclePlate || null, hours: Number(v.hours), smsVisitor: v.smsVisitor && !!v.visitorPhone };
    if (v.when) body.validFrom = new Date(v.when).toISOString();
    setIssued(await api.post('/api/visitors', body));
    setV({ ...v, visitorName: '', visitorPhone: '', purpose: '', vehiclePlate: '', when: '' });
    reload();
  });
  return (
    <>
      <PageHeader title="Visitor passes" subtitle="Give your visitor a one-time code to show at the gate" />
      <div className="grid grid-2">
        <Card title="Issue a pass">
          {issued && (
            <div className="alert alert-good">
              Code for {issued.visitorName}: <div className="pass-code">{issued.code}</div>
              Valid {dateTime(issued.validFrom)} – {dateTime(issued.validUntil)}. {issued.smsSent ? 'Sent to your visitor by SMS.' : 'Share it with your visitor.'}
            </div>
          )}
          <form onSubmit={run}>
            <ErrorNote error={err} />
            <Field label="Visitor's name"><input value={v.visitorName} onChange={set('visitorName')} required /></Field>
            <div className="form-row">
              <Field label="Visitor's phone"><input value={v.visitorPhone} onChange={set('visitorPhone')} /></Field>
              <Field label="Vehicle plate"><input value={v.vehiclePlate} onChange={set('vehiclePlate')} /></Field>
            </div>
            <Field label="Purpose"><input value={v.purpose} onChange={set('purpose')} placeholder="Family visit, delivery, artisan…" /></Field>
            <div className="form-row">
              <Field label="Arriving" hint="Leave blank for now"><input type="datetime-local" value={v.when} onChange={set('when')} /></Field>
              <Field label="Valid for"><select value={v.hours} onChange={set('hours')}>{[2, 4, 8, 12, 24, 48, 72].map((h) => <option key={h} value={h}>{h} hours</option>)}</select></Field>
            </div>
            {v.visitorPhone && <label className="check"><input type="checkbox" checked={v.smsVisitor} onChange={set('smsVisitor')} /> Text the code to my visitor</label>}
            <button className="btn" disabled={busy}>Issue code</button>
          </form>
        </Card>
        <Card title="My passes">
          <ErrorNote error={error} />
          {!data ? <Loading /> : (
            <Table rows={data.rows} empty="No passes yet." columns={[
              { key: 'visitor', label: 'Visitor', render: (p) => <><strong>{p.visitorName}</strong><div className="muted">{dateTime(p.validFrom)}</div></> },
              { key: 'code', label: 'Code', render: (p) => <span className="num" style={{ fontWeight: 700, letterSpacing: '.15em' }}>{p.code}</span> },
              { key: 'state', label: 'Status', render: (p) => <><Badge status={p.state} />{p.checkedInAt && <div className="muted" style={{ fontSize: '.8rem' }}>in {dateTime(p.checkedInAt)}</div>}</> },
              { key: 'act', label: '', align: 'right', render: (p) => p.state === 'ACTIVE' || p.state === 'NOT_YET_VALID' ? <button className="btn btn-ghost btn-small" onClick={async () => { await api.post(`/api/visitors/${p.id}/cancel`); reload(); }}>Cancel</button> : null },
            ]} />
          )}
        </Card>
      </div>
    </>
  );
}
