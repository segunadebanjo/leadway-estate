import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Card, ErrorNote, Field, PageHeader, useSubmit } from '../components/ui.jsx';
import { ChangePasswordForm } from './Auth.jsx';
import { humanize } from '../format.js';

export default function Account() {
  const { user, refresh } = useAuth();
  const [phone, setPhone] = useState(user.phone || '');
  const [saved, setSaved] = useState(false);
  const [pwDone, setPwDone] = useState(false);
  const { busy, error, run } = useSubmit(async () => {
    await api.patch('/api/me/profile', { phone: phone || null });
    await refresh();
    setSaved(true);
  });
  return (
    <>
      <PageHeader title="My account" />
      <div className="grid grid-2">
        <Card title="Details">
          <dl className="kv">
            <dt>Name</dt><dd>{user.firstName} {user.lastName}</dd>
            <dt>Membership ID</dt><dd><strong>{user.membershipId}</strong></dd>
            <dt>Email</dt><dd>{user.email}</dd>
            <dt>Role</dt><dd>{humanize(user.role)}</dd>
            {user.role === 'RESIDENT' && (<><dt>Occupancy</dt><dd>{humanize(user.occupancyType)}</dd><dt>Address</dt><dd>{[user.plotNumber && `Plot ${user.plotNumber}`, user.street].filter(Boolean).join(', ') || '—'}</dd></>)}
          </dl>
          <form onSubmit={run} style={{ marginTop: 18 }}>
            <ErrorNote error={error} />
            {saved && <div className="alert alert-good">Phone number saved.</div>}
            <Field label="Phone (for SMS notices)" hint="Nigerian mobile number, e.g. 0803 123 4567">
              <input value={phone} onChange={(e) => { setPhone(e.target.value); setSaved(false); }} />
            </Field>
            <button className="btn" disabled={busy}>Save</button>
          </form>
          <p className="muted" style={{ fontSize: '.85rem' }}>To change your name, email or address, contact the estate office.</p>
        </Card>
        <Card title="Change password">
          {pwDone && <div className="alert alert-good">Password changed. Other devices have been signed out.</div>}
          <ChangePasswordForm compact onDone={() => setPwDone(true)} />
        </Card>
      </div>
    </>
  );
}
