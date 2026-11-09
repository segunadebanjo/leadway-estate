import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { homeFor, useAuth } from '../auth.jsx';
import { ErrorNote, Field, Loading, useSubmit } from '../components/ui.jsx';

function AuthCard({ title, subtitle, children }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand-line">⌂ Leadway Estate</div>
        <h1>{title}</h1>
        {subtitle && <p className="muted" style={{ marginTop: 4 }}>{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

export function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit(async () => {
    const u = await login(email, password);
    navigate(u.mustChangePassword ? '/change-password' : location.state?.from || homeFor(u), { replace: true });
  });
  if (user === undefined) return <Loading />;
  if (user && !user.mustChangePassword) return <Navigate to={homeFor(user)} replace />;
  return (
    <AuthCard title="Sign in" subtitle="Residents' portal and executive dashboard">
      <form onSubmit={run} style={{ marginTop: 18 }}>
        <ErrorNote error={error} />
        <Field label="Email">
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <button className="btn btn-block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p style={{ textAlign: 'center', marginBottom: 0 }}>
          <Link to="/forgot-password">Forgot your password?</Link>
        </p>
      </form>
    </AuthCard>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(null);
  const { busy, error, run } = useSubmit(async () => setDone((await api.post('/api/auth/forgot-password', { email })).message));
  return (
    <AuthCard title="Reset your password" subtitle="We'll email you a link to choose a new one.">
      {done ? (
        <div className="alert alert-good" style={{ marginTop: 18 }}>
          {done}
        </div>
      ) : (
        <form onSubmit={run} style={{ marginTop: 18 }}>
          <ErrorNote error={error} />
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <button className="btn btn-block" disabled={busy}>
            {busy ? 'Sending…' : 'Email me a reset link'}
          </button>
        </form>
      )}
      <p style={{ textAlign: 'center', marginBottom: 0 }}>
        <Link to="/login">Back to sign in</Link>
      </p>
    </AuthCard>
  );
}

const PASSWORD_HINT = 'At least 8 characters, with letters and numbers.';

export function ResetPassword() {
  const [params] = useSearchParams();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run, setError } = useSubmit(async () => {
    if (pw !== pw2) return setError(new Error('The two passwords do not match'));
    await api.post('/api/auth/reset-password', { token: params.get('token') || '', newPassword: pw });
    setDone(true);
  });
  return (
    <AuthCard title="Choose a new password">
      {done ? (
        <>
          <div className="alert alert-good" style={{ marginTop: 18 }}>
            Your password has been changed. You can now sign in.
          </div>
          <Link className="btn btn-block" to="/login">
            Sign in
          </Link>
        </>
      ) : (
        <form onSubmit={run} style={{ marginTop: 18 }}>
          <ErrorNote error={error} />
          <Field label="New password" hint={PASSWORD_HINT}>
            <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
          </Field>
          <Field label="Repeat new password">
            <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
          </Field>
          <button className="btn btn-block" disabled={busy}>
            Save password
          </button>
        </form>
      )}
    </AuthCard>
  );
}

export function ChangePasswordForm({ onDone, compact }) {
  const { setUser } = useAuth();
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const { busy, error, run, setError } = useSubmit(async () => {
    if (pw !== pw2) return setError(new Error('The two new passwords do not match'));
    const { user } = await api.post('/api/auth/change-password', { currentPassword: current, newPassword: pw });
    setUser(user);
    setCurrent('');
    setPw('');
    setPw2('');
    onDone?.(user);
  });
  return (
    <form onSubmit={run} style={{ marginTop: compact ? 0 : 18 }}>
      <ErrorNote error={error} />
      <Field label="Current (or temporary) password">
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <Field label="New password" hint={PASSWORD_HINT}>
        <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
      </Field>
      <Field label="Repeat new password">
        <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
      </Field>
      <button className={`btn ${compact ? '' : 'btn-block'}`} disabled={busy}>
        {busy ? 'Saving…' : 'Change password'}
      </button>
    </form>
  );
}

export function ChangePassword() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (user === undefined) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <AuthCard title="Choose your password" subtitle={`Welcome, ${user.firstName}. Please replace your temporary password before continuing.`}>
      <ChangePasswordForm onDone={(u) => navigate(homeFor(u), { replace: true })} />
      <p style={{ textAlign: 'center', marginBottom: 0 }}>
        <button className="btn btn-ghost btn-small" onClick={logout}>
          Sign out
        </button>
      </p>
    </AuthCard>
  );
}
