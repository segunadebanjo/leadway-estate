import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { homeFor, useAuth } from './auth.jsx';
import { api } from './api.js';
import { Loading } from './components/ui.jsx';
import { Login, ForgotPassword, ResetPassword, ChangePassword } from './pages/Auth.jsx';
import Receipt from './pages/Receipt.jsx';
import Notifications from './pages/Notifications.jsx';
import Documents from './pages/Documents.jsx';
import Account from './pages/Account.jsx';
import Dashboard from './pages/admin/Dashboard.jsx';
import Residents from './pages/admin/Residents.jsx';
import ResidentDetail from './pages/admin/ResidentDetail.jsx';
import ReceivePayment from './pages/admin/ReceivePayment.jsx';
import Ledger from './pages/admin/Ledger.jsx';
import Expenses from './pages/admin/Expenses.jsx';
import Assets from './pages/admin/Assets.jsx';
import Reports from './pages/admin/Reports.jsx';
import Broadcast from './pages/admin/Broadcast.jsx';
import Requests from './pages/admin/Requests.jsx';
import AuditLog from './pages/admin/AuditLog.jsx';
import Home from './pages/resident/Home.jsx';
import MyPayments from './pages/resident/MyPayments.jsx';
import Statement from './pages/resident/Statement.jsx';
import MyRequests from './pages/resident/MyRequests.jsx';
import MyVisitors from './pages/resident/MyVisitors.jsx';
import PayCallback from './pages/resident/PayCallback.jsx';
import Gate from './pages/security/Gate.jsx';

const NAV = {
  ADMIN: [
    { section: 'Overview' },
    { to: '/admin', label: 'Dashboard', end: true },
    { section: 'Members & money' },
    { to: '/admin/residents', label: 'Residents' },
    { to: '/admin/receive-payment', label: 'Receive Payment' },
    { to: '/admin/ledger', label: 'Ledger' },
    { to: '/admin/expenses', label: 'Expenses' },
    { to: '/admin/reports', label: 'Reports' },
    { section: 'Estate' },
    { to: '/admin/requests', label: 'Requests', count: 'requests' },
    { to: '/gate', label: 'Gate & Visitors' },
    { to: '/admin/assets', label: 'Assets' },
    { to: '/documents', label: 'Documents' },
    { to: '/admin/broadcast', label: 'Broadcast' },
    { to: '/admin/audit', label: 'Audit log' },
    { section: 'Me' },
    { to: '/notifications', label: 'Notifications', count: 'notifications' },
    { to: '/account', label: 'My account' },
  ],
  RESIDENT: [
    { to: '/', label: 'My account summary', end: true },
    { to: '/payments', label: 'Payments & receipts' },
    { to: '/statement', label: 'Statement' },
    { to: '/visitors', label: 'Visitor passes' },
    { to: '/requests', label: 'Requests' },
    { to: '/documents', label: 'Documents' },
    { to: '/notifications', label: 'Notifications', count: 'notifications' },
    { to: '/account', label: 'Account' },
  ],
  SECURITY: [
    { to: '/gate', label: 'Gate' },
    { to: '/notifications', label: 'Notifications', count: 'notifications' },
    { to: '/account', label: 'Account' },
  ],
};

function useCounts(user) {
  const location = useLocation();
  const [counts, setCounts] = useState({});
  useEffect(() => {
    if (!user) return;
    let live = true;
    (async () => {
      const next = {};
      try {
        next.notifications = (await api.get('/api/me/notifications')).unread;
        if (user.role === 'ADMIN') next.requests = (await api.get('/api/admin/requests?status=ACTIVE&pageSize=1')).total;
      } catch {
        /* counts are best-effort */
      }
      if (live) setCounts(next);
    })();
    return () => {
      live = false;
    };
  }, [user, location.pathname]);
  return counts;
}

function Shell() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const counts = useCounts(user);
  useEffect(() => setOpen(false), [location.pathname]);
  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <header className="topbar">
        <button onClick={() => setOpen((o) => !o)} aria-label="Menu">
          ☰
        </button>
        <strong>Leadway Estate</strong>
      </header>
      <aside className="sidebar" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
        <div className="brand">
          <div className="brand-mark">⌂</div>
          <div>
            Leadway Estate
            <small>Mowe, Ogun State</small>
          </div>
        </div>
        <nav className="nav">
          {NAV[user.role].map((item, i) =>
            item.section ? (
              <div className="nav-section" key={i}>
                {item.section}
              </div>
            ) : (
              <NavLink key={item.to} to={item.to} end={item.end}>
                {item.label}
                {item.count && counts[item.count] > 0 && <span className="nav-count">{counts[item.count]}</span>}
              </NavLink>
            ),
          )}
        </nav>
        <div className="sidebar-foot">
          <div>
            {user.firstName} {user.lastName}
          </div>
          <div style={{ opacity: 0.7 }}>{user.membershipId}</div>
          <button className="btn btn-ghost btn-small" style={{ color: '#fff', borderColor: 'rgba(255,255,255,.3)' }} onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

function RequireAuth({ roles }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user === undefined) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user)} replace />;
  return <Outlet />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/change-password" element={<ChangePassword />} />

      <Route element={<RequireAuth />}>
        <Route element={<Shell />}>
          <Route path="/receipts/:id" element={<Receipt />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/account" element={<Account />} />

          <Route element={<RequireAuth roles={['RESIDENT']} />}>
            <Route path="/" element={<Home />} />
            <Route path="/payments" element={<MyPayments />} />
            <Route path="/statement" element={<Statement />} />
            <Route path="/requests" element={<MyRequests />} />
            <Route path="/visitors" element={<MyVisitors />} />
            <Route path="/pay/callback" element={<PayCallback />} />
          </Route>

          <Route element={<RequireAuth roles={['SECURITY', 'ADMIN']} />}>
            <Route path="/gate" element={<Gate />} />
          </Route>

          <Route element={<RequireAuth roles={['ADMIN']} />}>
            <Route path="/admin" element={<Dashboard />} />
            <Route path="/admin/residents" element={<Residents />} />
            <Route path="/admin/residents/:id" element={<ResidentDetail />} />
            <Route path="/admin/receive-payment" element={<ReceivePayment />} />
            <Route path="/admin/ledger" element={<Ledger />} />
            <Route path="/admin/expenses" element={<Expenses />} />
            <Route path="/admin/assets" element={<Assets />} />
            <Route path="/admin/reports" element={<Reports />} />
            <Route path="/admin/broadcast" element={<Broadcast />} />
            <Route path="/admin/requests" element={<Requests />} />
            <Route path="/admin/audit" element={<AuditLog />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<HomeRedirect />} />
    </Routes>
  );
}

function HomeRedirect() {
  const { user } = useAuth();
  if (user === undefined) return <Loading />;
  return <Navigate to={user ? homeFor(user) : '/login'} replace />;
}
