import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Card, ErrorNote, Loading, PageHeader } from '../../components/ui.jsx';
import { verifyWithRetry } from './pay.js';

// Landing page after Paystack's hosted checkout (used when the popup can't open).
export default function PayCallback() {
  const [params] = useSearchParams();
  const reference = params.get('reference') || params.get('trxref');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (reference) verifyWithRetry(reference).then(setResult).catch(setError);
  }, [reference]);
  return (
    <>
      <PageHeader title="Payment" />
      <Card>
        <ErrorNote error={error} />
        {!reference ? <p>No payment reference was found.</p> : !result && !error ? <Loading what="Confirming your payment" /> : result?.status === 'success' ? (
          <div className="alert alert-good">Payment received – thank you! {result.paymentId && <Link to={`/receipts/${result.paymentId}`}>View your receipt</Link>}</div>
        ) : result?.status === 'pending' ? (
          <div className="alert alert-warn">Your payment is still being confirmed. It will appear on your account shortly.</div>
        ) : result && <div className="alert alert-bad">The payment was not successful.</div>}
        <Link className="btn btn-ghost" to="/">Back to my account</Link>
      </Card>
    </>
  );
}
