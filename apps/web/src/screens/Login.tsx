// Login · email and code (desktop board "Login · email and code", phone board "Login"), plus "Request access".
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useRequestAccess, useRequestCode, useVerify } from '../data/session.ts';
import type { LoginMosaic } from '@acm/core/schemas';
import { useLoginMosaic } from '../data/library.ts';
import { safeNext } from '../lib/safeNext.ts';
import { fadeIn } from '../ui/Skeleton.tsx';
import { toggleTheme, useTheme } from '../lib/theme.ts';
import { mmss, useCountdown } from '../lib/useCountdown.ts';
import { GenderRadio } from '../ui/GenderRadio.tsx';
import { Icon } from '../ui/Icon.tsx';
import { OtpInput } from '../ui/OtpInput.tsx';
import { Rich } from '../ui/Rich.tsx';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const RESEND_SECONDS = 60;
type CodeError = { kind: 'wrong'; left: number } | { kind: 'expired' } | { kind: 'locked' } | { kind: 'network' } | null;

export function LoginScreen() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const [step, setStep] = useState<'email' | 'code' | 'done' | 'request'>('email');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<'invalid' | 'network' | null>(null);
  const [rateUntil, setRateUntil] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<CodeError>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const request = useRequestCode();
  const verify = useVerify();
  const codeRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const rateLeft = useCountdown(rateUntil);
  const resendLeft = useCountdown(resendAt);

  useEffect(() => {
    document.title = `${t('login.title')} · ${t('brand')}`;
  }, [t]);
  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
    if (step === 'email') emailRef.current?.focus();
  }, [step]);
  useEffect(() => {
    if (step !== 'done') return;
    const timer = setTimeout(() => navigate(next, { replace: true }), 700);
    return () => clearTimeout(timer);
  }, [step, next, navigate]);

  async function send() {
    const v = email.trim().toLowerCase();
    if (!EMAIL_RE.test(v)) return setEmailError('invalid');
    setEmailError(null);
    try {
      await request.mutateAsync(v);
      setEmail(v);
      setCode('');
      setCodeError(null);
      setResendAt(Date.now() + RESEND_SECONDS * 1000);
      setStep('code');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'rate_limited') setRateUntil(Date.now() + (e.body.retry_after ?? 60) * 1000);
      else if (e instanceof ApiError && e.code === 'bad_request') setEmailError('invalid');
      else setEmailError('network');
    }
  }

  async function submitCode(c: string) {
    setCodeError(null);
    try {
      await verify.mutateAsync({ email, code: c });
      setStep('done');
    } catch (e) {
      const ec = e instanceof ApiError ? e.code : 'network';
      if (ec === 'wrong_code') setCodeError({ kind: 'wrong', left: e instanceof ApiError ? (e.body.attemptsLeft ?? 0) : 0 });
      else if (ec === 'expired_code') setCodeError({ kind: 'expired' });
      else if (ec === 'too_many_attempts' || ec === 'rate_limited') setCodeError({ kind: 'locked' });
      else setCodeError({ kind: 'network' });
      if (ec === 'wrong_code' || ec === 'network') {
        setCode('');
        requestAnimationFrame(() => codeRef.current?.focus());
      }
    }
  }

  const photos = useLoginMosaic().data?.images ?? [];
  const needNew = codeError?.kind === 'expired' || codeError?.kind === 'locked';
  const sending = request.isPending;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexWrap: 'wrap' }}>
      <div className="hide-sm" aria-hidden="true" style={{ flex: '1 1 560px', minHeight: '100vh', display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gridTemplateRows: 'repeat(3, minmax(0, 1fr))', gap: 4, background: 'var(--bg)' }}>
        <Tile i={0} photos={photos} bg="linear-gradient(160deg, #8B7B6D, #4C4742)" style={{ gridColumn: 'span 2', gridRow: 'span 2' }} />
        <Tile i={1} photos={photos} bg="linear-gradient(200deg, #5F6B74, #2F353A)" />
        <Tile i={2} photos={photos} bg="linear-gradient(200deg, #6E7C70, #343B35)" />
        <Tile i={3} photos={photos} bg="linear-gradient(200deg, #A39384, #5A5048)" />
        <Tile i={4} photos={photos} bg="linear-gradient(200deg, #7D7086, #3D3842)" />
        <Tile i={5} photos={photos} bg="linear-gradient(200deg, #9A8C74, #544B3C)" />
      </div>

      <main id="main" style={{ flex: '1 1 480px', minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--surface)' }}>
        <div className="show-sm" aria-hidden="true" style={{ height: 200, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 3 }}>
          <Tile i={0} photos={photos} bg="linear-gradient(160deg, #8B7B6D, #4C4742)" style={{ gridColumn: 'span 2' }} />
          <div style={{ display: 'grid', gap: 3 }}>
            <Tile i={1} photos={photos} bg="linear-gradient(200deg, #5F6B74, #2F353A)" />
            <Tile i={2} photos={photos} bg="linear-gradient(200deg, #6E7C70, #343B35)" />
          </div>
        </div>
        <LoginTopRow />

        <div className="login-body" style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '24px var(--login-pad) 64px' }}>
          <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 28 }}>
            {step === 'email' && (
              <>
                <div className="stack" style={{ gap: 10 }}>
                  <h1 className="t-display login-title">{t('login.title')}</h1>
                  <p className="t-body muted">{t('login.intro')}</p>
                </div>
                {rateLeft > 0 && (
                  <div className="st st-w" role="alert" style={{ height: 'auto', padding: '12px 14px', alignItems: 'flex-start', fontWeight: 500, fontSize: 14, lineHeight: '20px' }}>
                    <Icon name="clock" />
                    {t('login.rateLimited', { minutes: Math.max(1, Math.ceil(rateLeft / 60)) })}
                  </div>
                )}
                <form
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!sending && rateLeft === 0) void send();
                  }}
                  className="stack"
                  style={{ gap: 18 }}
                >
                  <div className="field">
                    <label className="label" htmlFor="email">
                      {t('login.email')}
                    </label>
                    <input
                      ref={emailRef}
                      className="input"
                      id="email"
                      type="email"
                      dir="ltr"
                      autoComplete="email"
                      spellCheck={false}
                      placeholder={t('login.emailPlaceholder')}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      aria-invalid={emailError === 'invalid' || undefined}
                      aria-describedby={emailError ? 'email-msg' : undefined}
                    />
                    {emailError && (
                      <span className="err" id="email-msg" role="alert">
                        <Icon name="alert" size="sm" style={{ marginTop: 3 }} />
                        {t(emailError === 'invalid' ? 'login.invalidEmail' : 'login.network')}
                      </span>
                    )}
                  </div>
                  {sending ? (
                    <button className="btn btn-p btn-block" type="button" aria-disabled="true" aria-live="polite">
                      <Icon name="spinner" className="spin" />
                      {t('login.sending')}
                    </button>
                  ) : (
                    <button className="btn btn-p btn-block" type="submit" aria-disabled={rateLeft > 0 || undefined}>
                      {t('login.send')}
                    </button>
                  )}
                </form>
                <p className="t-sm subtle" style={{ margin: 0 }}>
                  {t('login.noAccount')}{' '}
                  <a
                    href="#request"
                    onClick={(e) => {
                      e.preventDefault();
                      setStep('request');
                    }}
                  >
                    {t('login.requestAccess')}
                  </a>
                </p>
              </>
            )}

            {step === 'code' && (
              <>
                <div className="stack" style={{ gap: 10 }}>
                  <h1 className="t-display login-title">{t('login.inbox')}</h1>
                  <p className="t-body muted">
                    <Rich k="login.sent" values={{ email }} />
                  </p>
                  <a
                    href="#email"
                    className="t-sm"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={(e) => {
                      e.preventDefault();
                      setStep('email');
                    }}
                  >
                    {t('login.differentEmail')}
                  </a>
                </div>
                <div className="field">
                  <label className="label" htmlFor="code">
                    {t('login.code')}
                  </label>
                  <OtpInput
                    ref={codeRef}
                    id="code"
                    value={code}
                    onChange={(v) => {
                      setCode(v);
                      if (codeError?.kind === 'wrong' || codeError?.kind === 'network') setCodeError(null);
                    }}
                    onComplete={(c) => void submitCode(c)}
                    invalid={codeError?.kind === 'wrong'}
                    disabled={needNew || verify.isPending}
                    describedBy="code-msg"
                  />
                  <CodeMessage error={codeError} verifying={verify.isPending} />
                </div>
                {needNew ? (
                  <button className="btn btn-p btn-block" onClick={() => void send()} disabled={sending}>
                    {t('login.sendNew')}
                  </button>
                ) : (
                  <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-s btn-sm tnum"
                      aria-disabled={resendLeft > 0 || sending || undefined}
                      onClick={() => resendLeft === 0 && !sending && void send()}
                    >
                      {resendLeft > 0 ? t('login.resendIn', { time: mmss(resendLeft) }) : t('login.resend')}
                    </button>
                    <span className="t-sm subtle">{t('login.checkSpam')}</span>
                  </div>
                )}
              </>
            )}

            {step === 'request' && <RequestAccess initialEmail={email} onBack={() => setStep('email')} />}

            {step === 'done' && (
              <div className="stack" style={{ gap: 18 }} aria-live="polite">
                <span className="st st-ok" style={{ alignSelf: 'flex-start' }}>
                  <Icon name="check" />
                  {t('login.signedIn')}
                </span>
                <h1 className="t-display login-title">{t('login.welcome')}</h1>
                <p className="t-body muted">{t('login.redirecting')}</p>
                <Link className="btn btn-p btn-block" to={next} replace>
                  {t('login.continue')}
                </Link>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/** Email, name and gender; the answer is the same whether or not the address already has an account or a request. */
function RequestAccess({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ email: initialEmail, name: '' });
  const [isFemale, setIsFemale] = useState<boolean | null>(null);
  const [error, setError] = useState<'invalid' | 'required' | 'rate' | 'network' | null>(null);
  const [sent, setSent] = useState(false);
  const req = useRequestAccess();
  const back = (
    <a
      href="#email"
      className="t-sm"
      style={{ alignSelf: 'flex-start' }}
      onClick={(e) => {
        e.preventDefault();
        onBack();
      }}
    >
      {t('login.backToSignIn')}
    </a>
  );

  async function submit() {
    const email = f.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return setError('invalid');
    if (!f.name.trim() || isFemale === null) return setError('required');
    setError(null);
    try {
      await req.mutateAsync({ email, name: f.name.trim(), isFemale });
      setSent(true);
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'rate_limited' ? 'rate' : e instanceof ApiError && e.code === 'bad_request' ? 'invalid' : 'network');
    }
  }

  if (sent)
    return (
      <div className="stack" style={{ gap: 18 }} aria-live="polite">
        <span className="st st-ok" style={{ alignSelf: 'flex-start' }}>
          <Icon name="check" />
          {t('login.requestSent')}
        </span>
        <h1 className="t-display login-title">{t('login.requestThanks')}</h1>
        <p className="t-body muted">{t('login.requestReview')}</p>
        {back}
      </div>
    );

  const msg = { invalid: 'login.invalidEmail', required: 'login.requestRequired', rate: 'errors.rate_limited', network: 'login.network' } as const;
  return (
    <>
      <div className="stack" style={{ gap: 10 }}>
        <h1 className="t-display login-title">{t('login.requestTitle')}</h1>
        <p className="t-body muted">{t('login.requestIntro')}</p>
        {back}
      </div>
      <form
        noValidate
        className="stack"
        style={{ gap: 18 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!req.isPending) void submit();
        }}
      >
        <div className="field">
          <label className="label" htmlFor="ra-e">
            {t('login.email')}
          </label>
          <input className="input" id="ra-e" type="email" dir="ltr" autoComplete="email" spellCheck={false} placeholder={t('login.emailPlaceholder')} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-invalid={error === 'invalid' || undefined} />
        </div>
        <div className="field">
          <label className="label" htmlFor="ra-n">
            {t('account.name')}
          </label>
          <input className="input" id="ra-n" autoComplete="name" maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-invalid={(error === 'required' && !f.name.trim()) || undefined} />
        </div>
        <GenderRadio id="ra-g" value={isFemale} onChange={setIsFemale} invalid={error === 'required' && isFemale === null} />
        {error && (
          <span className="err" role="alert">
            <Icon name="alert" size="sm" style={{ marginTop: 3 }} />
            {t(msg[error])}
          </span>
        )}
        <button className="btn btn-p btn-block" type="submit" aria-disabled={req.isPending || undefined}>
          {req.isPending && <Icon name="spinner" className="spin" />}
          {t('login.requestSend')}
        </button>
      </form>
    </>
  );
}

function CodeMessage({ error, verifying }: { error: CodeError; verifying: boolean }) {
  const { t } = useTranslation();
  if (verifying)
    return (
      <span className="help" id="code-msg" aria-live="polite">
        {t('login.verifying')}
      </span>
    );
  if (!error)
    return (
      <span className="help" id="code-msg">
        {t('login.codeHint')}
      </span>
    );
  const text =
    error.kind === 'wrong'
      ? t('login.wrongCode', { left: error.left })
      : error.kind === 'expired'
        ? t('login.expired')
        : error.kind === 'locked'
          ? t('login.locked')
          : t('login.network');
  return (
    <span className="err" id="code-msg" role="alert">
      <Icon name={error.kind === 'expired' ? 'clock' : 'alert'} size="sm" style={{ marginTop: 3 }} />
      {text}
    </span>
  );
}

function LoginTopRow() {
  const { t } = useTranslation();
  const { resolved } = useTheme();
  return (
    <div className="row" style={{ justifyContent: 'space-between', gap: 16, padding: '24px var(--login-pad)' }}>
      <Link className="brand" to="/">
        {t('brand')}
      </Link>
      <div className="row" style={{ gap: 4 }}>
        <button className="btn btn-g btn-sm btn-ic" aria-label={t('theme.switch')} onClick={toggleTheme}>
          <Icon name={resolved === 'dark' ? 'sun' : 'moon'} />
        </button>
      </div>
    </div>
  );
}

/** One mosaic square: a public photo (all of them come in one request) over its gradient, which shows while it loads or when there are none. */
function Tile({ i, photos, bg, style }: { i: number; photos: LoginMosaic['images']; bg: string; style?: React.CSSProperties }) {
  const photo = photos.length ? photos[i % photos.length] : undefined;
  return (
    <div style={{ background: bg, overflow: 'hidden', ...style }}>
      {photo && <img {...fadeIn} src={photo.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
    </div>
  );
}
