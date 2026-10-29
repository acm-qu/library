import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation } from 'react-router';
import { useMe } from '../../data/session.ts';
import { NotFound } from '../States.tsx';

/** Admin area: side navigation from the admin boards. Non-admins see the ordinary not-found page. */
export function AdminLayout() {
  const { t } = useTranslation();
  const me = useMe().data;
  const loc = useLocation();
  if (!me?.isAdmin) return <NotFound />;
  const link = (to: string, label: string) => (
    <Link to={to} aria-current={loc.pathname.startsWith(to) ? 'page' : undefined}>
      {label}
    </Link>
  );
  return (
    <div className="wrap row" style={{ alignItems: 'flex-start', gap: 32, paddingTop: 32, paddingBottom: 64, flexWrap: 'wrap' }}>
      <nav className="sidenav" aria-label={t('admin.nav')}>
        <span className="t-over" style={{ padding: '0 12px 8px' }}>
          {t('admin.nav')}
        </span>
        {link('/admin/members', t('admin.members'))}
        {link('/admin/queue', t('admin.queue'))}
        {link('/admin/storage', t('admin.storage'))}
      </nav>
      <main id="main" className="main stack" style={{ gap: 24 }}>
        <Outlet />
      </main>
    </div>
  );
}
