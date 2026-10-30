// App chrome for everyone (signed in or not): top bar from the Library board, offline banner, session-expired dialog.
import { profileComplete } from '@acm/core/schemas';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Location, Link, matchPath, Navigate, Outlet, useLocation, useNavigate, useRoutes } from 'react-router';
import { ApiError, onSessionExpired } from '../api/client.ts';
import { useMe } from '../data/session.ts';
import { toggleTheme, useTheme } from '../lib/theme.ts';
import { Lightbox } from '../screens/Lightbox.tsx';
import { OfflineBanner, ServerError, SessionExpiredDialog, ShellSkeleton } from '../screens/States.tsx';
import { VideoPlayer } from '../ui/Player.tsx';
import { screenRoutes } from './screens.tsx';
import { Icon } from '../ui/Icon.tsx';
import { SearchBox } from '../ui/SearchBox.tsx';
import { useTabIndicator } from '../ui/useTabIndicator.ts';
import { useMyUploads } from '../data/uploads.ts';
import { readyAt } from '../i18n/format.ts';

export const initials = (name: string, email: string) => {
  const parts = (name || email.split('@')[0] || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase();
};

/** Admin screens share one key: the admin layout stays put and animates only its own content (see AdminLayout). */
const pageKey = (path: string) => (path.startsWith('/admin') ? '/admin' : path);

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
  const navBar = useTabIndicator<HTMLElement>('line-bottom', loc.pathname);
  const tabBar = useTabIndicator<HTMLElement>('line-top', loc.pathname);
  useEffect(() => onSessionExpired(() => setExpired(true)), []);

  if (me.isPending) return <ShellSkeleton />;
  if (me.isError) return <ServerError reference={me.error instanceof ApiError ? me.error.body.reference : undefined} onRetry={() => void me.refetch()} />;
  const user = me.data;
  // Signed-in people finish their profile (name, gender) before anything else; visitors are unaffected.
  if (user && !profileComplete(user) && loc.pathname !== '/welcome') return <Navigate to={`/welcome?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  const isCore = user?.role === 'core';
  const signIn = `/login?next=${encodeURIComponent(loc.pathname + loc.search)}`;
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
        <nav ref={navBar} className="nav hide-sm" aria-label={t('nav.main')}>
          <Link to="/" aria-current={section === 'library' ? 'page' : undefined}>
            {t('nav.library')}
          </Link>
          {isCore && (
            <Link to="/uploads" aria-current={section === 'uploads' ? 'page' : undefined}>
              {t('nav.myUploads')}
            </Link>
          )}
          {user?.isAdmin && (
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
        {user ? (
          <Link to="/account" className="avatar hide-sm" aria-label={t('nav.account', { name: user.name || user.email })} style={{ textDecoration: 'none' }}>
            {initials(user.name, user.email)}
          </Link>
        ) : (
          <Link className="btn btn-s btn-sm hide-sm" to={signIn}>
            {t('nav.signIn')}
          </Link>
        )}
      </header>
      <OfflineBanner />
      {/* One route tree for both cases, so opening the lightbox over a grid doesn't remount (or rescroll) it. */}
      {/* Keyed on the screen underneath (one key for a direct /p/ visit), so only a real page change replays the entrance. */}
      <div className="page" key={pageKey(viewing ? (background?.pathname ?? '/p') : loc.pathname)}>{screens ?? <Outlet />}</div>
      {background && viewing && <Lightbox assetId={viewing} background={background} onClose={() => navigate(-1)} player={(a) => <VideoPlayer asset={a} />} />}
      <nav ref={tabBar} className="tabbar show-sm" aria-label={t('nav.main')} style={{ gridTemplateColumns: `repeat(${isCore ? 4 : 2}, minmax(0, 1fr))` }}>
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
        <Link to={user ? '/account' : signIn} aria-current={loc.pathname === '/account' ? 'page' : undefined}>
          <Icon name="person" />
          {user ? t('nav.accountTab') : t('nav.signIn')}
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
  const etas = items.flatMap((i) => (i.readyInS == null ? [] : [i.readyInS]));
  return (
    <Link to="/uploads" className="st st-p hide-sm" style={{ textDecoration: 'none' }} title={t('myUploads.processingTitle')}>
      <Icon name="refresh" className="spin" />
      <span className="tnum">{etas.length ? t('myUploads.processingChip', { n: items.length, time: readyAt(Math.max(...etas)) }) : t('myUploads.processingChipWaiting', { n: items.length })}</span>
    </Link>
  );
}
