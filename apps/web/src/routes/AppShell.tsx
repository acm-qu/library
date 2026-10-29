// Signed-in chrome: top bar from the Library board, offline banner, session-expired dialog.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Location, Link, matchPath, Navigate, Outlet, useLocation, useNavigate, useRoutes } from 'react-router';
import { ApiError, onSessionExpired } from '../api/client.ts';
import { useMe } from '../data/session.ts';
import { toggleTheme, useTheme } from '../lib/theme.ts';
import { Lightbox } from '../screens/Lightbox.tsx';
import { OfflineBanner, ServerError, SessionExpiredDialog } from '../screens/States.tsx';
import { VideoPlayer } from '../ui/Player.tsx';
import { screenRoutes } from './screens.tsx';
import { Icon } from '../ui/Icon.tsx';
import { SearchBox } from '../ui/SearchBox.tsx';
import { useMyUploads } from '../data/uploads.ts';
import { readyAt } from '../i18n/format.ts';

export const initials = (name: string, email: string) => {
  const parts = (name || email.split('@')[0] || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase();
};

export function AppShell() {
  const { t } = useTranslation();
  const me = useMe();
  const loc = useLocation();
  const { resolved } = useTheme();
  const navigate = useNavigate();
  const background = (loc.state as { background?: Location } | null)?.background;
  const viewing = matchPath('/p/:assetId', loc.pathname)?.params.assetId;
  const screens = useRoutes(screenRoutes, background && viewing ? background : loc);
  const [expired, setExpired] = useState(false);
  useEffect(() => onSessionExpired(() => setExpired(true)), []);

  if (me.isPending) return <div className="center-page" aria-busy="true" aria-label={t('states.loading')} />;
  if (me.isError) return <ServerError reference={me.error instanceof ApiError ? me.error.body.reference : undefined} onRetry={() => void me.refetch()} />;
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  const user = me.data;
  const isCore = user.role === 'core';
  const section = /^\/uploads/.test(loc.pathname) ? 'uploads' : /^\/admin/.test(loc.pathname) ? 'admin' : /^\/(account|upload)\b/.test(loc.pathname) ? null : 'library';

  return (
    <>
      <a className="btn btn-p btn-sm skip" href="#main">
        {t('skipToContent')}
      </a>
      <header className="topbar">
        <Link className="brand" to="/">
          {t('brand')}
        </Link>
        <nav className="nav hide-sm" aria-label={t('nav.main')}>
          <Link to="/" aria-current={section === 'library' ? 'page' : undefined}>
            {t('nav.library')}
          </Link>
          {isCore && (
            <Link to="/uploads" aria-current={section === 'uploads' ? 'page' : undefined}>
              {t('nav.myUploads')}
            </Link>
          )}
          {user.isAdmin && (
            <Link to="/admin" aria-current={section === 'admin' ? 'page' : undefined}>
              {t('nav.admin')}
            </Link>
          )}
        </nav>
        <span className="grow" />
        <div className="hide-sm">
          <SearchBox />
        </div>
        {isCore && <ProcessingChip />}
        {isCore && (
          <Link className="btn btn-p btn-sm hide-sm" to="/upload">
            <Icon name="upload" />
            {t('nav.upload')}
          </Link>
        )}
        <button className="btn btn-g btn-sm btn-ic" aria-label={t('theme.switch')} onClick={toggleTheme}>
          <Icon name={resolved === 'dark' ? 'sun' : 'moon'} />
        </button>
        <Link to="/account" className="avatar hide-sm" aria-label={t('nav.account', { name: user.name || user.email })} style={{ textDecoration: 'none' }}>
          {initials(user.name, user.email)}
        </Link>
      </header>
      <OfflineBanner />
      {/* One route tree for both cases, so opening the lightbox over a grid doesn't remount (or rescroll) it. */}
      {screens ?? <Outlet />}
      {background && viewing && <Lightbox assetId={viewing} background={background} onClose={() => navigate(-1)} player={(a) => <VideoPlayer asset={a} />} />}
      <nav className="tabbar show-sm" aria-label={t('nav.main')} style={{ gridTemplateColumns: `repeat(${isCore ? 4 : 2}, minmax(0, 1fr))` }}>
        <Link to="/" aria-current={section === 'library' ? 'page' : undefined}>
          <Icon name="grid" />
          {t('nav.library')}
        </Link>
        {isCore && (
          <Link to="/upload" aria-current={loc.pathname === '/upload' ? 'page' : undefined}>
            <Icon name="upload" />
            {t('nav.upload')}
          </Link>
        )}
        {isCore && (
          <Link to="/uploads" aria-current={section === 'uploads' ? 'page' : undefined}>
            <Icon name="clock" />
            {t('nav.myUploads')}
          </Link>
        )}
        <Link to="/account" aria-current={loc.pathname === '/account' ? 'page' : undefined}>
          <Icon name="person" />
          {t('nav.accountTab')}
        </Link>
      </nav>
      {expired && <SessionExpiredDialog />}
    </>
  );
}

/** "3 processing · ready by 17:05" for the signed-in core member's own unfinished uploads. */
function ProcessingChip() {
  const { t } = useTranslation();
  const q = useMyUploads('active');
  const items = q.data?.pages.flatMap((p) => p.items).filter((i) => i.status !== 'uploading') ?? [];
  if (!items.length) return null;
  const eta = Math.max(0, ...items.map((i) => i.readyInS ?? 0));
  return (
    <Link to="/uploads" className="st st-p hide-sm" style={{ textDecoration: 'none' }} title={t('myUploads.processingTitle')}>
      <Icon name="refresh" className="spin" />
      <span className="tnum">{t('myUploads.processingChip', { n: items.length, time: readyAt(eta) })}</span>
    </Link>
  );
}
