import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { ErrorNote, Loading, Money, useFetch } from '../components/ui.jsx';
import { METHOD, dateTime, fullName, naira } from '../format.js';

export default function Receipt() {
  const { id } = useParams();
  const { user } = useAuth();
  const { data: p, error } = useFetch(`/api/payments/${id}`);
  if (error) return <ErrorNote error={error} />;
  if (!p) return <Loading />;
  const credit = p.creditEntries.filter((c) => c.kind === 'OVERPAYMENT').reduce((s, c) => s + c.amount, 0);
  const reversed = p.status === 'REVERSED';
  return (
    <>
      <div className="actions no-print" style={{ marginBottom: 14 }}>
        <button className="btn" onClick={() => window.print()}>
          Print / save as PDF
        </button>
        <Link className="btn btn-ghost" to={user.role === 'ADMIN' ? `/admin/residents/${p.user.id}` : '/payments'}>
          Back
        </Link>
      </div>
      <article className="receipt">
        <div className="receipt-head">
          <div>
            <h2>Leadway Estate Residents' Association</h2>
            <div className="muted">Mowe, Ogun State</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="muted">{p.method === 'ACCOUNT_CREDIT' ? 'Credit application' : 'Official e-Receipt'}</div>
            <div style={{ fontWeight: 800, fontSize: '1.1rem' }}>{p.receiptNo}</div>
          </div>
        </div>
        <dl>
          <dt>Received from</dt>
          <dd>
            {fullName(p.user)} ({p.user.membershipId})
          </dd>
          <dt>Address</dt>
          <dd>{[p.user.plotNumber && `Plot ${p.user.plotNumber}`, p.user.street].filter(Boolean).join(', ') || '—'}</dd>
          <dt>Date</dt>
          <dd>{dateTime(p.paidAt)}</dd>
          <dt>Method</dt>
          <dd>{METHOD[p.method]}</dd>
          {p.reference && (
            <>
              <dt>Reference</dt>
              <dd>{p.reference}</dd>
            </>
          )}
          <dt>Amount</dt>
          <dd style={{ fontSize: '1.2rem' }}>{naira(p.amount)}</dd>
        </dl>
        <table className="table">
          <thead>
            <tr>
              <th>Applied to</th>
              <th className="right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {p.allocations.map((a) => (
              <tr key={a.id}>
                <td>{a.invoice.description}</td>
                <td className="right">
                  <Money v={a.amount} />
                </td>
              </tr>
            ))}
            {credit > 0 && (
              <tr>
                <td>Kept as account credit (applied to future bills)</td>
                <td className="right">
                  <Money v={credit} />
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="right">
                <Money v={p.amount} />
              </td>
            </tr>
          </tfoot>
        </table>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 }}>
          <div className="muted" style={{ fontSize: '.85rem' }}>
            {p.recordedBy ? `Received by ${fullName(p.recordedBy)}` : p.method === 'PAYSTACK' ? 'Paid online via Paystack' : ''}
            {p.note && <div>Note: {p.note}</div>}
            {reversed && <div className="text-bad">Reversed: {p.reverseReason}</div>}
          </div>
          <span className={`stamp ${reversed ? 'void' : ''}`}>{reversed ? 'REVERSED' : 'PAID'}</span>
        </div>
      </article>
    </>
  );
}
