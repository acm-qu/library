// System states board: session expired, not found (also for missing access), offline, server error.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { Icon } from '../ui/Icon.tsx';
import { Rich } from '../ui/Rich.tsx';
import { Skeleton } from '../ui/Skeleton.tsx';

export function NotFound() {
  const { t } = useTranslation();
  useEffect(() => {
    document.title = `${t('states.notFoundTitle')} · ${t('brand')}`;
  }, [t]);
  return (
    <div className="center-page">
      <div className="center-col">
        <span className="t-display tnum" style={{ fontSize: 64, lineHeight: '64px', color: 'var(--text-3)' }}>
          404
        </span>
        <h1 className="t-h1">{t('states.notFoundTitle')}</h1>
        <p className="t-body muted">{t('states.notFoundBody')}</p>
        <Link className="btn btn-s" to="/">
          {t('states.goLibrary')}
        </Link>
      </div>
    </div>
  );
}

export function ServerError({ reference, onRetry }: { reference?: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="center-page">
      <div className="center-col" role="alert">
        <Icon name="alert" style={{ width: 32, height: 32, color: 'var(--danger)' }} />
        <h1 className="t-h1">{t('states.errorTitle')}</h1>
        <p className="t-body muted">{t('states.errorBody')}</p>
        <button className="btn btn-p" onClick={onRetry}>
          {t('states.tryAgain')}
        </button>
        {reference && <span className="t-xs subtle tnum">{t('states.reference', { ref: reference })}</span>}
      </div>
    </div>
  );
}

/** Modal shown on any 401 while signed in. Returns to the same page after the new sign-in. */
export function SessionExpiredDialog() {
  const { t } = useTranslation();
  const loc = useLocation();
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const place = document.title.split(' · ')[0];
  const next = encodeURIComponent(loc.pathname + loc.search);
  return (
    <div className="overlay">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="se-t" aria-describedby="se-b" style={{ width: '100%', maxWidth: 420, padding: 28, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 className="t-h2" id="se-t">
          {t('states.sessionTitle')}
        </h2>
        <p className="t-body muted" id="se-b">
          {place && place !== t('brand') ? <Rich k="states.sessionBody" values={{ place }} /> : t('states.sessionBodyPlain')}
        </p>
        <a ref={ref} className="btn btn-p btn-block" href={`/login?next=${next}`}>
          {t('states.signInAgain')}
        </a>
      </div>
    </div>
  );
}

const subscribeOnline = (f: () => void) => {
  addEventListener('online', f);
  addEventListener('offline', f);
  return () => {
    removeEventListener('online', f);
    removeEventListener('offline', f);
  };
};
export const useOnline = () => useSyncExternalStore(subscribeOnline, () => navigator.onLine);

export function OfflineBanner() {
  const { t } = useTranslation();
  if (useOnline()) return null;
  return (
    <div className="banner" role="status" style={{ background: 'var(--text)', color: 'var(--bg)' }}>
      <Icon name="offline" />
      <span className="grow">{t('states.offline')}</span>
    </div>
  );
}

/** While the session loads: the top bar's frame (brand, then the account slot) and a page heading with cover rows. */
export function ShellSkeleton() {
  const { t } = useTranslation();
  return (
    <>
      <div className="topbar" aria-hidden="true">
        <span className="brand">{t('brand')}</span>
        <span className="grow" />
        <span className="hide-sm">
          <Skeleton h={40} w={300} />
        </span>
        <Skeleton h={36} w={36} round />
      </div>
      <main className="wrap" aria-busy="true" aria-label={t('states.loading')} style={{ flex: 1, paddingTop: 32, paddingBottom: 64, display: 'flex', flexDirection: 'column', gap: 28 }}>
        <Skeleton h={44} w={104} />
        <div className="covers" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="stack" style={{ gap: 10 }}>
              <div className="cover skel" />
              <Skeleton h={24} w={`${70 - i * 6}%`} />
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
