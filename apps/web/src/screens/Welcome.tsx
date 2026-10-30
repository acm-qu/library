// First sign-in: name and gender are required before any other signed-in screen (the shell sends people here).
import { profileComplete } from '@acm/core/schemas';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useSearchParams } from 'react-router';
import { useMe, usePatchMe } from '../data/session.ts';
import { safeNext } from '../lib/safeNext.ts';
import { GenderRadio } from '../ui/GenderRadio.tsx';
import { Icon } from '../ui/Icon.tsx';

export function WelcomeScreen() {
  const { t } = useTranslation();
  const me = useMe().data!;
  const [params] = useSearchParams();
  const [name, setName] = useState(me.name);
  const [isFemale, setIsFemale] = useState(me.isFemale);
  const [tried, setTried] = useState(false);
  const patch = usePatchMe();
  useEffect(() => {
    document.title = `${t('welcome.title')} · ${t('brand')}`;
  }, [t]);

  // Saving updates the cached profile, which lands here and moves on.
  if (profileComplete(me)) return <Navigate to={safeNext(params.get('next'))} replace />;
  const nameMissing = name.trim() === '';

  return (
    <main id="main" className="wrap" style={{ maxWidth: 520, paddingTop: 40, paddingBottom: 64, display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div className="stack" style={{ gap: 10 }}>
        <h1 className="t-display login-title">{t('welcome.title')}</h1>
        <p className="t-body muted">{t('welcome.intro')}</p>
      </div>
      <form
        noValidate
        className="panel stack"
        style={{ gap: 20 }}
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!nameMissing && isFemale !== null) patch.mutate({ name: name.trim(), isFemale });
        }}
      >
        <div className="field">
          <label className="label" htmlFor="wn">
            {t('account.name')}
          </label>
          <input className="input" id="wn" value={name} maxLength={120} autoComplete="name" onChange={(e) => setName(e.target.value)} aria-invalid={(tried && nameMissing) || undefined} />
          <span className="help">{t('account.nameHelp')}</span>
        </div>
        <GenderRadio id="wg" value={isFemale} onChange={setIsFemale} invalid={tried && isFemale === null} />
        {tried && (nameMissing || isFemale === null) && (
          <span className="err" role="alert">
            <Icon name="alert" size="sm" style={{ marginTop: 3 }} />
            {t('welcome.required')}
          </span>
        )}
        {patch.isError && (
          <span className="err" role="alert">
            <Icon name="alert" size="sm" style={{ marginTop: 3 }} />
            {t('errors.internal')}
          </span>
        )}
        <button className="btn btn-p btn-block" type="submit" disabled={patch.isPending}>
          {patch.isPending && <Icon name="spinner" className="spin" />}
          {t('welcome.continue')}
        </button>
      </form>
    </main>
  );
}
