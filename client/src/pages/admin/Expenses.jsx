import { useState } from 'react';
import { api, qs } from '../../api.js';
import { Card, ErrorNote, Field, Loading, Modal, Money, PageHeader, Pager, Table, useFetch, useSubmit } from '../../components/ui.jsx';
import { date, fullName, koboToInput, toKobo, todayIso } from '../../format.js';

export default function Expenses() {
  const [f, setF] = useState({ from: `${todayIso().slice(0, 7)}-01`, to: todayIso(), category: '', page: 1 });
  const { data, error, reload } = useFetch(`/api/admin/expenses${qs({ ...f, pageSize: 50 })}`);
  const [editing, setEditing] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value, page: 1 });
  return (
    <>
      <PageHeader title="Expenses" subtitle="What the association spends. Feeds the Income & Expenditure report." actions={<button className="btn" onClick={() => setEditing({})}>Record expense</button>} />
      <Card>
        <div className="filters">
          <Field label="From"><input type="date" value={f.from} onChange={set('from')} /></Field>
          <Field label="To"><input type="date" value={f.to} onChange={set('to')} /></Field>
          <Field label="Category"><select value={f.category} onChange={set('category')}><option value="">All</option>{data?.categories.map((c) => <option key={c}>{c}</option>)}</select></Field>
        </div>
        <ErrorNote error={error} />
        {!data ? <Loading /> : (
          <>
            <Table rows={data.rows} onRowClick={setEditing} empty="No expenses in this period." columns={[
              { key: 'date', label: 'Date', render: (e) => date(e.date) },
              { key: 'category', label: 'Category' },
              { key: 'description', label: 'Description' },
              { key: 'payee', label: 'Payee' },
              { key: 'reference', label: 'Reference' },
              { key: 'by', label: 'Recorded by', render: (e) => fullName(e.recordedBy) },
              { key: 'amount', label: 'Amount', align: 'right', render: (e) => <Money v={e.amount} /> },
            ]} footer={<tr><td colSpan={6}>Total</td><td className="right"><Money v={data.totals.amount} /></td></tr>} />
            <Pager page={f.page} pageSize={50} total={data.total} onPage={(page) => setF({ ...f, page })} />
          </>
        )}
      </Card>
      {editing && data && <ExpenseForm expense={editing} categories={data.categories} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function ExpenseForm({ expense, categories, onClose, onSaved }) {
  const isNew = !expense.id;
  const [v, setV] = useState({ date: expense.date?.slice(0, 10) || todayIso(), category: expense.category || categories[0], description: expense.description || '', payee: expense.payee || '', amount: expense.amount ? koboToInput(expense.amount) : '', reference: expense.reference || '' });
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const { busy, error, run, setError } = useSubmit(async () => {
    const amount = toKobo(v.amount);
    if (!amount) return setError(new Error('Enter a valid amount'));
    const body = { ...v, amount, payee: v.payee || null, reference: v.reference || null };
    if (isNew) await api.post('/api/admin/expenses', body);
    else await api.patch(`/api/admin/expenses/${expense.id}`, body);
    onSaved();
  });
  const remove = async () => {
    if (!confirm('Delete this expense?')) return;
    await api.del(`/api/admin/expenses/${expense.id}`);
    onSaved();
  };
  return (
    <Modal title={isNew ? 'Record expense' : 'Edit expense'} onClose={onClose}>
      <form onSubmit={run}>
        <ErrorNote error={error} />
        <div className="form-row">
          <Field label="Date"><input type="date" value={v.date} onChange={set('date')} required /></Field>
          <Field label="Category"><select value={v.category} onChange={set('category')}>{categories.map((c) => <option key={c}>{c}</option>)}</select></Field>
        </div>
        <Field label="Description"><input value={v.description} onChange={set('description')} required /></Field>
        <div className="form-row">
          <Field label="Payee"><input value={v.payee} onChange={set('payee')} /></Field>
          <Field label="Amount (₦)"><input inputMode="decimal" value={v.amount} onChange={set('amount')} required /></Field>
        </div>
        <Field label="Reference / voucher no."><input value={v.reference} onChange={set('reference')} /></Field>
        <div className="actions">
          <button className="btn" disabled={busy}>Save</button>
          {!isNew && <button type="button" className="btn btn-ghost" onClick={remove}>Delete</button>}
        </div>
      </form>
    </Modal>
  );
}
