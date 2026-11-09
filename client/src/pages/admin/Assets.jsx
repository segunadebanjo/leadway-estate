import { useState } from 'react';
import { api, qs } from '../../api.js';
import { Badge, Card, ErrorNote, Field, Loading, Modal, Money, PageHeader, Table, Tabs, useFetch, useSubmit } from '../../components/ui.jsx';
import { date, dateTime, fullName, humanize, koboToInput, toKobo, todayIso } from '../../format.js';

export default function Assets() {
  const [f, setF] = useState({ category: '', lowStock: '' });
  const { data, error, reload } = useFetch(`/api/assets${qs(f)}`);
  const [open, setOpen] = useState(null);
  const [editing, setEditing] = useState(null);
  const low = data?.rows.filter((a) => a.lowStock) || [];
  return (
    <>
      <PageHeader title="Assets" subtitle="Equipment and consumables, stock movements and maintenance" actions={<button className="btn" onClick={() => setEditing({})}>Add item</button>} />
      {low.length > 0 && !f.lowStock && <div className="alert alert-warn">Low stock: {low.map((a) => `${a.name} (${a.quantity} ${a.unit})`).join(', ')}</div>}
      <Card>
        <div className="filters">
          <Field label="Category"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">All</option><option value="EQUIPMENT">Equipment</option><option value="CONSUMABLE">Consumables</option></select></Field>
          <Field label="Stock"><select value={f.lowStock} onChange={(e) => setF({ ...f, lowStock: e.target.value })}><option value="">All</option><option value="true">Low stock only</option></select></Field>
        </div>
        <ErrorNote error={error} />
        {!data ? <Loading /> : (
          <Table rows={data.rows} onRowClick={(a) => setOpen(a.id)} empty="No items yet." columns={[
            { key: 'name', label: 'Item', render: (a) => <strong>{a.name}</strong> },
            { key: 'category', label: 'Category', render: (a) => humanize(a.category) },
            { key: 'quantity', label: 'Quantity', render: (a) => <span className="num">{a.quantity} {a.unit} {a.lowStock && <Badge status="OVERDUE" label="Low" />}</span> },
            { key: 'location', label: 'Location' },
            { key: 'maint', label: 'Maintenance to date', align: 'right', render: (a) => <Money v={a.maintenanceCost} /> },
          ]} />
        )}
      </Card>
      {open && <AssetModal id={open} onClose={() => { setOpen(null); reload(); }} onEdit={(a) => { setOpen(null); setEditing(a); }} />}
      {editing && <AssetForm asset={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function AssetModal({ id, onClose, onEdit }) {
  const { data: a, error, reload } = useFetch(`/api/assets/${id}`);
  const [tab, setTab] = useState('move');
  return (
    <Modal title={a ? a.name : 'Item'} onClose={onClose} wide>
      <ErrorNote error={error} />
      {!a ? <Loading /> : (
        <>
          <p>
            <strong className="num" style={{ fontSize: '1.3rem' }}>{a.quantity} {a.unit}</strong> {a.lowStock && <Badge status="OVERDUE" label={`Low – re-order at ${a.minQuantity}`} />}
            <br /><span className="muted">{humanize(a.category)} · {a.location || 'no location'}{a.serialNumber ? ` · S/N ${a.serialNumber}` : ''}{a.purchaseDate ? ` · bought ${date(a.purchaseDate)}` : ''}</span>
            {' '}<button className="btn btn-ghost btn-small" onClick={() => onEdit(a)}>Edit details</button>
          </p>
          <Tabs active={tab} onChange={setTab} tabs={[{ key: 'move', label: 'Record movement' }, { key: 'log', label: `Movement log (${a.movements.length})` }, { key: 'maint', label: `Maintenance (${a.maintenance.length})` }]} />
          {tab === 'move' && <MovementForm asset={a} onDone={reload} />}
          {tab === 'log' && (
            <Table rows={a.movements} columns={[
              { key: 'createdAt', label: 'When', render: (m) => dateTime(m.createdAt) },
              { key: 'type', label: 'Type', render: (m) => humanize(m.type) },
              { key: 'quantity', label: 'Change', render: (m) => <span className="num">{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</span> },
              { key: 'where', label: 'Deployed / moved to', render: (m) => m.toLocation || '' },
              { key: 'note', label: 'Note' },
              { key: 'by', label: 'By', render: (m) => fullName(m.by) },
            ]} />
          )}
          {tab === 'maint' && <Maintenance asset={a} onDone={reload} />}
        </>
      )}
    </Modal>
  );
}

function MovementForm({ asset, onDone }) {
  const [v, setV] = useState({ type: asset.category === 'CONSUMABLE' ? 'USED' : 'RELOCATED', quantity: '', toLocation: '', note: '' });
  const [ok, setOk] = useState(null);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const { busy, error, run } = useSubmit(async () => {
    const r = await api.post(`/api/assets/${asset.id}/movements`, { type: v.type, quantity: Number(v.quantity || 0), toLocation: v.toLocation || null, note: v.note || null });
    setOk(`Saved. Now ${r.asset.quantity} ${asset.unit}${r.asset.location ? ` at ${r.asset.location}` : ''}.`);
    setV({ ...v, quantity: '', toLocation: '', note: '' });
    onDone();
  });
  const qtyLabel = { USED: 'Quantity used', RESTOCKED: 'Quantity added', ADJUSTED: 'Counted quantity (new total)' }[v.type];
  return (
    <form onSubmit={run} style={{ maxWidth: 560 }}>
      <ErrorNote error={error} />
      {ok && <div className="alert alert-good">{ok}</div>}
      <Field label="Movement">
        <select value={v.type} onChange={set('type')}><option value="USED">Used / issued out</option><option value="RESTOCKED">Restocked / received</option><option value="RELOCATED">Relocated</option><option value="ADJUSTED">Stock count adjustment</option></select>
      </Field>
      {qtyLabel && <Field label={qtyLabel}><input type="number" min="0" value={v.quantity} onChange={set('quantity')} required /></Field>}
      {(v.type === 'USED' || v.type === 'RELOCATED') && <Field label={v.type === 'USED' ? 'Where it was deployed (optional)' : 'Moved to'}><input value={v.toLocation} onChange={set('toLocation')} required={v.type === 'RELOCATED'} /></Field>}
      <Field label={v.type === 'ADJUSTED' ? 'Reason (required)' : 'Note'}><input value={v.note} onChange={set('note')} required={v.type === 'ADJUSTED'} /></Field>
      <button className="btn" disabled={busy}>Save movement</button>
    </form>
  );
}

function Maintenance({ asset, onDone }) {
  const [v, setV] = useState({ date: todayIso(), description: '', cost: '', performedBy: '' });
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const { busy, error, run, setError } = useSubmit(async () => {
    const cost = v.cost ? toKobo(v.cost) : 0;
    if (cost === null) return setError(new Error('Enter a valid cost'));
    await api.post(`/api/assets/${asset.id}/maintenance`, { ...v, cost, performedBy: v.performedBy || null });
    setV({ date: todayIso(), description: '', cost: '', performedBy: '' });
    onDone();
  });
  return (
    <>
      <Table rows={asset.maintenance} empty="No maintenance recorded." columns={[
        { key: 'date', label: 'Date', render: (m) => date(m.date) },
        { key: 'description', label: 'Work done' },
        { key: 'performedBy', label: 'By' },
        { key: 'cost', label: 'Cost', align: 'right', render: (m) => <Money v={m.cost} /> },
      ]} />
      <form onSubmit={run} style={{ marginTop: 16 }}>
        <ErrorNote error={error} />
        <div className="form-row">
          <Field label="Date"><input type="date" value={v.date} onChange={set('date')} required /></Field>
          <Field label="Cost (₦)"><input inputMode="decimal" value={v.cost} onChange={set('cost')} /></Field>
          <Field label="Done by"><input value={v.performedBy} onChange={set('performedBy')} /></Field>
        </div>
        <Field label="Work done"><input value={v.description} onChange={set('description')} required /></Field>
        <button className="btn" disabled={busy}>Add maintenance record</button>
      </form>
    </>
  );
}

function AssetForm({ asset, onClose, onSaved }) {
  const isNew = !asset.id;
  const [v, setV] = useState({ name: asset.name || '', category: asset.category || 'EQUIPMENT', unit: asset.unit || 'pcs', quantity: '', minQuantity: String(asset.minQuantity ?? 0), location: asset.location || '', serialNumber: asset.serialNumber || '', purchaseDate: asset.purchaseDate?.slice(0, 10) || '', purchaseCost: asset.purchaseCost != null ? koboToInput(asset.purchaseCost) : '', notes: asset.notes || '' });
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const { busy, error, run, setError } = useSubmit(async () => {
    const purchaseCost = v.purchaseCost ? toKobo(v.purchaseCost) : null;
    if (v.purchaseCost && purchaseCost === null) return setError(new Error('Enter a valid cost'));
    const body = { name: v.name, category: v.category, unit: v.unit, minQuantity: Number(v.minQuantity || 0), location: v.location || null, serialNumber: v.serialNumber || null, purchaseDate: v.purchaseDate || null, purchaseCost, notes: v.notes || null };
    if (isNew) await api.post('/api/assets', { ...body, quantity: Number(v.quantity || 0) });
    else await api.patch(`/api/assets/${asset.id}`, body);
    onSaved();
  });
  return (
    <Modal title={isNew ? 'Add item' : `Edit ${asset.name}`} onClose={onClose}>
      <form onSubmit={run}>
        <ErrorNote error={error} />
        <Field label="Name"><input value={v.name} onChange={set('name')} required /></Field>
        <div className="form-row">
          <Field label="Category"><select value={v.category} onChange={set('category')}><option value="EQUIPMENT">Equipment</option><option value="CONSUMABLE">Consumable</option></select></Field>
          <Field label="Unit"><input value={v.unit} onChange={set('unit')} placeholder="pcs, litres, bags" required /></Field>
        </div>
        <div className="form-row">
          {isNew && <Field label="Opening quantity"><input type="number" min="0" value={v.quantity} onChange={set('quantity')} /></Field>}
          <Field label="Re-order level" hint="Low-stock alert at or below this (consumables)"><input type="number" min="0" value={v.minQuantity} onChange={set('minQuantity')} /></Field>
        </div>
        <div className="form-row">
          <Field label="Location"><input value={v.location} onChange={set('location')} /></Field>
          <Field label="Serial no."><input value={v.serialNumber} onChange={set('serialNumber')} /></Field>
        </div>
        <div className="form-row">
          <Field label="Purchase date"><input type="date" value={v.purchaseDate} onChange={set('purchaseDate')} /></Field>
          <Field label="Purchase cost (₦)"><input inputMode="decimal" value={v.purchaseCost} onChange={set('purchaseCost')} /></Field>
        </div>
        <Field label="Notes"><input value={v.notes} onChange={set('notes')} /></Field>
        {!isNew && <p className="muted" style={{ fontSize: '.85rem' }}>Quantity changes only through the movement log.</p>}
        <button className="btn" disabled={busy}>Save</button>
      </form>
    </Modal>
  );
}
