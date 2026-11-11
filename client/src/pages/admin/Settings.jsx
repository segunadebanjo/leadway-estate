import { useState } from 'react';
import { useAuth } from '../../auth.jsx';
import { api } from '../../api.js';
import { Badge, Card, ErrorNote, Loading, PageHeader, useFetch, useSubmit } from '../../components/ui.jsx';

export default function Settings() {
  const { data, error, reload } = useFetch('/api/admin/settings/status');
  return (
    <>
      <PageHeader title="Settings" subtitle="Email, SMS and online payments" />
      <ErrorNote error={error} />
      {!data ? <Loading /> : (
        <>
          <EmailCard s={data.email} reload={reload} />
          <div className="grid grid-2">
            <Card title={<>SMS {data.sms.configured ? <Badge status="ACTIVE" label="Set up" /> : <Badge status="INACTIVE" label="Not set up" />}</>}>
              <p>Text messages for reminders, broadcasts and visitor codes are sent through <strong>Termii</strong> (termii.com, paid per SMS).</p>
              {!data.sms.configured && <p className="muted">To switch on: create a Termii account, register a sender ID, then add <code>TERMII_API_KEY</code> in Render → leadway-estate → Environment.</p>}
              {data.sms.configured && <p className="muted">Sender ID: {data.sms.senderId}</p>}
            </Card>
            <Card title={<>Online payments {data.paystack.configured ? <Badge status={data.paystack.testMode ? 'PENDING' : 'ACTIVE'} label={data.paystack.testMode ? 'Test mode' : 'Live'} /> : <Badge status="INACTIVE" label="Not set up" />}</>}>
              <p>Residents pay online by card, transfer or USSD through <strong>Paystack</strong>.</p>
              {!data.paystack.configured && <p className="muted">To switch on: create a Paystack business account, then add <code>PAYSTACK_SECRET_KEY</code> and <code>PAYSTACK_PUBLIC_KEY</code> in Render → Environment.</p>}
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function EmailCard({ s, reload }) {
  const { user } = useAuth();
  const [to, setTo] = useState(user.email);
  const [sent, setSent] = useState(false);
  const test = useSubmit(async () => { setSent(false); await api.post('/api/admin/settings/test-email', { to }); setSent(true); reload(); });
  return (
    <Card title={<>Email {s.configured ? <Badge status="ACTIVE" label={`Set up (${s.provider === 'brevo' ? 'Brevo' : 'SMTP'})`} /> : <Badge status="INACTIVE" label="Not set up" />}</>}>
      <p>Email carries sign-in details for new members, password resets ("Forgot password"), e-receipts, payment reminders, payment plans and broadcasts.</p>
      {s.configured ? (
        <>
          <p className="muted">Emails are sent from <strong>{s.from}</strong>.</p>
          {s.lastError && <div className="alert alert-bad">The last email failed: {s.lastError}</div>}
          <form onSubmit={test.run} className="upload-row">
            <ErrorNote error={test.error} />
            <input type="email" value={to} onChange={(e) => setTo(e.target.value)} required style={{ flex: '1 1 240px', width: 'auto' }} />
            <button className="btn" disabled={test.busy}>{test.busy ? 'Sending…' : 'Send a test email'}</button>
          </form>
          {sent && <div className="alert alert-good">Sent. Check the inbox (and the spam folder) of {to}.</div>}
          <details style={{ marginTop: '.75rem' }}>
            <summary>Change the sending address or fix a key error</summary>
            <ol className="steps">
              <li>In Brevo (logged in as the account that owns the key) → <strong>Senders, Domains &amp; Dedicated IPs</strong> → <strong>Senders</strong> → <strong>Add a sender</strong>, enter the new address and click the link Brevo emails to it.</li>
              <li>If the key error shows ("Key not found" / 401): Brevo → <strong>SMTP &amp; API</strong> → <strong>API Keys</strong> → <strong>Generate a new API key</strong>. Copy the whole key (it starts <code>xkeysib-</code>, not <code>xsmtpsib-</code>).</li>
              <li>In <strong>dashboard.render.com</strong> → <strong>leadway-estate</strong> → <strong>Environment</strong>, set <code>EMAIL_FROM</code> = <code>Leadway Estate &lt;new address&gt;</code> and, if needed, paste the new key into <code>BREVO_API_KEY</code>. Click <strong>Save, rebuild, and deploy</strong>, then send a test email here.</li>
            </ol>
          </details>
        </>
      ) : (
        <>
          <div className="alert alert-warn">Email is not set up, so nothing is emailed yet. Members still see everything in their app notifications.</div>
          <h3 className="section-title">Set it up (free, about 10 minutes)</h3>
          <ol className="steps">
            <li>Go to <strong>brevo.com</strong> and sign up for a free account (300 emails a day) with the email address the estate should send from.</li>
            <li>In Brevo, click your name (top right) → <strong>SMTP &amp; API</strong> → <strong>API Keys</strong> → <strong>Generate a new API key</strong>. Name it "Leadway Estate" and copy the key.</li>
            <li>Go to <strong>dashboard.render.com</strong> → <strong>leadway-estate</strong> → <strong>Environment</strong> → <strong>Add Environment Variable</strong>, and add two:
              <ul>
                <li><code>BREVO_API_KEY</code> = the key you copied</li>
                <li><code>EMAIL_FROM</code> = <code>Leadway Estate &lt;the email you signed up to Brevo with&gt;</code></li>
              </ul>
            </li>
            <li>Click <strong>Save, rebuild, and deploy</strong>. After a few minutes, come back to this page and send a test email.</li>
          </ol>
          <p className="muted" style={{ fontSize: '.85rem' }}>Render's free plan blocks ordinary SMTP email, which is why Brevo is used. On your own server you can use any SMTP account instead (SMTP_HOST, SMTP_USER, SMTP_PASS).</p>
        </>
      )}
    </Card>
  );
}
