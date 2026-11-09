import { useCallback, useEffect, useRef, useState } from 'react';
import { api, qs } from '../api.js';
import { naira, humanize } from '../format.js';

/** Load `url` and keep { data, error, loading, reload }. A null url loads nothing. */
export function useFetch(url) {
  const [state, setState] = useState({ data: null, error: null, loading: !!url });
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!url) return;
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api.get(url);
      if (n === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (n === seq.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, [url]);
  useEffect(() => {
    load();
  }, [load]);
  return { ...state, reload: load };
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="actions no-print">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="actions no-print">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone, hint }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export const Money = ({ v, className = '' }) => <span className={`num ${className}`}>{naira(v)}</span>;

const BADGE = {
  PAID: 'good', COMPLETED: 'good', RESOLVED: 'good', CHECKED_OUT: 'muted', SUCCESS: 'good', ACTIVE: 'good',
  PARTIAL: 'warn', IN_PROGRESS: 'warn', CHECKED_IN: 'info', NOT_YET_VALID: 'info', PENDING: 'warn',
  UNPAID: 'bad', OPEN: 'bad', OVERDUE: 'bad', FAILED: 'bad', EXPIRED: 'muted',
  VOID: 'muted', REVERSED: 'muted', CLOSED: 'muted', CANCELLED: 'muted', INACTIVE: 'muted',
};
export const Badge = ({ status, label }) => <span className={`badge badge-${BADGE[status] || 'muted'}`}>{label || humanize(status)}</span>;

export function ErrorNote({ error }) {
  if (!error) return null;
  return <div className="alert alert-bad">{error.message || String(error)}</div>;
}

export function Loading({ what = 'Loading' }) {
  return <div className="loading">{what}…</div>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

/** Simple table. columns: [{ key, label, render?, className?, align? }] */
export function Table({ columns, rows, rowKey = 'id', onRowClick, empty = 'Nothing to show yet.', footer }) {
  if (!rows?.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align === 'right' ? 'right' : ''}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r[rowKey] ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={onRowClick ? 'clickable' : ''}>
              {columns.map((c) => (
                <td key={c.key} data-label={c.label} className={`${c.align === 'right' ? 'right' : ''} ${c.className || ''}`}>
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil((total || 0) / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="pager no-print">
      <button className="btn btn-ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Previous
      </button>
      <span className="muted">
        Page {page} of {pages} · {total} records
      </span>
      <button className="btn btn-ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next →
      </button>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children, error }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

/**
 * Form helper: runs `submit`, shows the server's error, disables the button
 * while busy (so a double click never records twice).
 */
export function useSubmit(submit) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await submit();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs no-print" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={active === t.key} className={`tab ${active === t.key ? 'active' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Search-as-you-type picker for residents (name, ID, plot, phone). */
export function MemberPicker({ value, onChange, placeholder = 'Search name, LWE-ID, plot or phone…', autoFocus }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (value) return;
    const t = setTimeout(async () => {
      try {
        setRows((await api.get(`/api/residents/lookup${qs({ q })}`)).rows);
      } catch {
        setRows([]);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, value]);
  if (value) {
    return (
      <div className="picked">
        <div>
          <strong>
            {value.firstName} {value.lastName}
          </strong>{' '}
          <span className="muted">
            {value.membershipId}
            {value.plotNumber ? ` · Plot ${value.plotNumber}` : ''}
          </span>
          {!value.isActive && <Badge status="INACTIVE" label="Inactive" />}
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => onChange(null)}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div className="picker">
      <input value={q} autoFocus={autoFocus} onChange={(e) => setQ(e.target.value)} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder={placeholder} />
      {open && rows.length > 0 && (
        <ul className="picker-list">
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" onMouseDown={() => onChange(r)}>
                <span>
                  <strong>
                    {r.firstName} {r.lastName}
                  </strong>{' '}
                  <span className="muted">
                    {r.membershipId}
                    {r.plotNumber ? ` · Plot ${r.plotNumber}` : ''}
                  </span>
                </span>
                <span className={r.outstanding > 0 ? 'text-bad num' : 'muted num'}>{r.outstanding > 0 ? `owes ${naira(r.outstanding)}` : 'nothing owed'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Download a CSV report through the authenticated session. */
export async function downloadCsv(url, fallbackName) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function Flash({ message, onDone }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, 5000);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  return (
    <div className="flash" role="status">
      {message}
    </div>
  );
}
