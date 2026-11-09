import { useState } from 'react';
import { api, qs } from '../api.js';
import { Card, ErrorNote, Field, Loading, PageHeader, Table, useFetch, useSubmit } from '../components/ui.jsx';

/** Resident page: the people in my household and our vehicles. */
export default function Household() {
  return (
    <>
      <PageHeader title="My household" subtitle="Who lives with you and the cars you use. The gate uses this to recognise them, so they don't need a visitor code." />
      <HouseholdPanel />
    </>
  );
}

/** Used by residents (their own) and by executives on a member's page (userId). */
export function HouseholdPanel({ userId }) {
  const { data, error, reload } = useFetch(`/api/household${qs({ userId })}`);
  const [err, setErr] = useState(null);
  if (!data) return <><ErrorNote error={error} /><Loading /></>;
  const remove = async (kind, row, label) => {
    if (!confirm(`Remove ${label}?`)) return;
    try { await api.del(`/api/household/${kind}/${row.id}${qs({ userId })}`); reload(); } catch (e) { setErr(e); }
  };
  return (
    <div className="grid grid-2">
      <Card title={`People (${data.people.length})`}>
        <ErrorNote error={err} />
        <Table rows={data.people} empty="Nobody listed yet." columns={[
          { key: 'name', label: 'Name', render: (p) => <strong>{p.name}</strong> },
          { key: 'relationship', label: 'Relationship' },
          { key: 'phone', label: 'Phone' },
          { key: 'x', label: '', render: (p) => <button className="btn btn-ghost btn-small" onClick={() => remove('people', p, p.name)}>Remove</button> },
        ]} />
        <AddPerson userId={userId} relationships={data.relationships} onSaved={reload} />
      </Card>
      <Card title={`Vehicles (${data.vehicles.length})`}>
        <Table rows={data.vehicles} empty="No vehicles listed yet." columns={[
          { key: 'plateNumber', label: 'Plate', render: (v) => <strong>{v.plateNumber}</strong> },
          { key: 'description', label: 'Make, model, colour' },
          { key: 'x', label: '', render: (v) => <button className="btn btn-ghost btn-small" onClick={() => remove('vehicles', v, v.plateNumber)}>Remove</button> },
        ]} />
        <AddVehicle userId={userId} onSaved={reload} />
      </Card>
    </div>
  );
}

function AddPerson({ userId, relationships, onSaved }) {
  const blank = { name: '', relationship: relationships[0], phone: '' };
  const [v, setV] = useState(blank);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const { busy, error, run } = useSubmit(async () => { await api.post('/api/household/people', { ...v, phone: v.phone || null, userId }); setV(blank); onSaved(); });
  return (
    <form onSubmit={run} style={{ marginTop: 14 }}>
      <ErrorNote error={error} />
      <div className="form-row">
        <Field label="Name"><input value={v.name} onChange={set('name')} required maxLength={120} /></Field>
        <Field label="Relationship"><select value={v.relationship} onChange={set('relationship')}>{relationships.map((r) => <option key={r}>{r}</option>)}</select></Field>
      </div>
      <Field label="Phone (optional)"><input value={v.phone} onChange={set('phone')} /></Field>
      <button className="btn btn-ghost" disabled={busy}>Add person</button>
    </form>
  );
}

function AddVehicle({ userId, onSaved }) {
  const [v, setV] = useState({ plateNumber: '', description: '' });
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const { busy, error, run } = useSubmit(async () => { await api.post('/api/household/vehicles', { ...v, description: v.description || null, userId }); setV({ plateNumber: '', description: '' }); onSaved(); });
  return (
    <form onSubmit={run} style={{ marginTop: 14 }}>
      <ErrorNote error={error} />
      <div className="form-row">
        <Field label="Plate number"><input value={v.plateNumber} onChange={set('plateNumber')} required placeholder="KJA 123 AB" maxLength={20} /></Field>
        <Field label="Make, model, colour"><input value={v.description} onChange={set('description')} placeholder="Black Toyota Camry" /></Field>
      </div>
      <button className="btn btn-ghost" disabled={busy}>Add vehicle</button>
    </form>
  );
}
