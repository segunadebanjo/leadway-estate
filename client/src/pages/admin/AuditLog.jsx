import { useState } from 'react';
import { qs } from '../../api.js';
import { Card, ErrorNote, Field, Loading, PageHeader, Pager, Table, useFetch } from '../../components/ui.jsx';
import { dateTime, fullName } from '../../format.js';

const ENTITIES = ['User', 'Payment', 'Invoice', 'FeeType', 'Expense', 'Asset', 'Document', 'Announcement', 'ServiceRequest', 'Billing'];

export default function AuditLog() {
  const [f, setF] = useState({ entity: '', page: 1 });
  const { data, error } = useFetch(`/api/admin/audit${qs({ ...f, pageSize: 100 })}`);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Every executive action on members, money and records" />
      <Card>
        <div className="filters"><Field label="Record type"><select value={f.entity} onChange={(e) => setF({ entity: e.target.value, page: 1 })}><option value="">All</option>{ENTITIES.map((x) => <option key={x}>{x}</option>)}</select></Field></div>
        <ErrorNote error={error} />
        {!data ? <Loading /> : (
          <>
            <Table rows={data.rows} columns={[
              { key: 'createdAt', label: 'When', render: (r) => dateTime(r.createdAt) },
              { key: 'actor', label: 'By', render: (r) => (r.actor ? `${fullName(r.actor)} (${r.actor.membershipId})` : 'System') },
              { key: 'action', label: 'Action' },
              { key: 'entity', label: 'Record', render: (r) => `${r.entity}${r.entityId ? ` #${r.entityId}` : ''}` },
              { key: 'details', label: 'Details', render: (r) => r.details && <code style={{ fontSize: '.78rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(r.details)}</code> },
            ]} />
            <Pager page={f.page} pageSize={100} total={data.total} onPage={(page) => setF({ ...f, page })} />
          </>
        )}
      </Card>
    </>
  );
}
