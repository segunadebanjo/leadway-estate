import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Card, ErrorNote, Empty, Loading, PageHeader, useFetch } from '../components/ui.jsx';
import { dateTime } from '../format.js';

export default function Notifications() {
  const { data, error, reload } = useFetch('/api/me/notifications');
  const read = async (n) => {
    if (!n.readAt) {
      await api.post(`/api/me/notifications/${n.id}/read`);
      reload();
    }
  };
  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Announcements from the executives, payment confirmations and updates on your requests."
        actions={data?.unread > 0 && <button className="btn btn-ghost" onClick={async () => { await api.post('/api/me/notifications/read-all'); reload(); }}>Mark all read</button>}
      />
      <ErrorNote error={error} />
      {!data ? (
        <Loading />
      ) : (
        <Card>
          {data.rows.length === 0 ? (
            <Empty>No notifications yet.</Empty>
          ) : (
            <ul className="list-plain">
              {data.rows.map((n) => (
                <li key={n.id} className={n.readAt ? '' : 'unread'} onClick={() => read(n)} style={{ cursor: n.readAt ? 'default' : 'pointer' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <strong>{n.title}</strong>
                    <span className="muted" style={{ fontSize: '.82rem', whiteSpace: 'nowrap' }}>{dateTime(n.createdAt)}</span>
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                  {n.link && n.link !== '/notifications' && <Link to={n.link}>Open →</Link>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
