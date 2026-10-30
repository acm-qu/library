// Account board: profile name and gender, display preferences, sign out / sign out everywhere.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useLogout, useMe, usePatchMe } from '../data/session.ts';
import { applyLocale, LOCALES } from '../i18n/index.ts';
import { setTheme, type ThemePref, useTheme } from '../lib/theme.ts';
import { GenderRadio } from '../ui/GenderRadio.tsx';
import { Icon } from '../ui/Icon.tsx';

export function AccountScreen() {
  const { t, i18n } = useTranslation();
  const me = useMe().data!;
  const [name, setName] = useState(me.name);
  const [isFemale, setIsFemale] = useState(me.isFemale);
  const unchanged = name.trim() === me.name && isFemale === me.isFemale;
  const patch = usePatchMe();
  const logout = useLogout(false);
  const logoutAll = useLogout(true);
  const navigate = useNavigate();
  const { pref } = useTheme();
  useEffect(() => {
    document.title = `${t('account.title')} · ${t('brand')}`;
  }, [t]);

  const out = async (m: typeof logout) => {
    await m.mutateAsync();
    navigate('/login', { replace: true });
  };

  return (
    <main id="main" className="wrap" style={{ maxWidth: 760, paddingTop: 40, paddingBottom: 64, display: 'flex', flexDirection: 'column', gap: 32 }}>
      <h1 className="t-display login-title">{t('account.title')}</h1>

      <section className="panel stack" aria-labelledby="h-profile" style={{ gap: 20 }}>
        <h2 className="t-h2" id="h-profile">
          {t('account.profile')}
        </h2>
        <form
          className="stack"
          style={{ gap: 20 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && isFemale !== null) patch.mutate({ name: name.trim(), isFemale });
          }}
        >
          <div className="field">
            <label className="label" htmlFor="nm">
              {t('account.name')}
            </label>
            <input className="input" id="nm" value={name} maxLength={120} autoComplete="name" onChange={(e) => setName(e.target.value)} aria-invalid={!name.trim() || undefined} />
            <span className="help">{t('account.nameHelp')}</span>
          </div>
          <GenderRadio id="gd" value={isFemale} onChange={setIsFemale} />
          <button className="btn btn-s" type="submit" style={{ alignSelf: 'flex-start' }} disabled={patch.isPending || unchanged || !name.trim() || isFemale === null}>
            {patch.isSuccess && unchanged ? (
              <>
                <Icon name="ok" />
                {t('account.saved')}
              </>
            ) : (
              t('account.save')
            )}
          </button>
        </form>
        <div className="field">
          <span className="label">{t('account.email')}</span>
          <span className="t-body tnum" dir="ltr" style={{ alignSelf: 'flex-start' }}>
            {me.email}
          </span>
          <span className="help">{t('account.emailHelp')}</span>
        </div>
        <div className="field">
          <span className="label">{t('account.role')}</span>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {/* Only core accounts sign in; admin adds platform management. */}
            <span className="tier">
              <Icon name="shield" />
              {t(me.isSuperadmin ? 'account.superadmin' : me.isAdmin ? 'account.admin' : 'account.coreMember')}
            </span>
            <span className="t-sm muted">{t(me.isSuperadmin ? 'account.superadminHelp' : me.isAdmin ? 'account.adminHelp' : 'account.coreHelp')}</span>
          </div>
        </div>
      </section>

      <section className="panel stack" aria-labelledby="h-prefs" style={{ gap: 20 }}>
        <h2 className="t-h2" id="h-prefs">
          {t('account.display')}
        </h2>
        {LOCALES.length > 1 && (
          <div className="field">
            <span className="label" id="lang-l">
              {t('account.language')}
            </span>
            <div role="radiogroup" aria-labelledby="lang-l" className="row" style={{ gap: 8 }}>
              {LOCALES.map((l) => (
                <button key={l.code} className="chip" role="radio" lang={l.code} aria-checked={i18n.language === l.code} aria-pressed={i18n.language === l.code} onClick={() => void applyLocale(l.code)}>
                  {l.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="field">
          <span className="label" id="theme-l">
            {t('account.theme')}
          </span>
          <div role="radiogroup" aria-labelledby="theme-l" className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {(['system', 'light', 'dark'] as ThemePref[]).map((p) => (
              <button key={p} className="chip" role="radio" aria-checked={pref === p} aria-pressed={pref === p} onClick={() => setTheme(p)}>
                {t(`theme.${p}`)}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="panel stack" aria-labelledby="h-sess" style={{ gap: 16 }}>
        <h2 className="t-h2" id="h-sess">
          {t('account.signOut')}
        </h2>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-s" onClick={() => void out(logout)} disabled={logout.isPending}>
            {t('account.signOut')}
          </button>
          <button className="btn btn-d" onClick={() => void out(logoutAll)} disabled={logoutAll.isPending}>
            {t('account.signOutAll')}
          </button>
        </div>
        <span className="help">{t('account.signOutAllHelp')}</span>
      </section>
    </main>
  );
}
