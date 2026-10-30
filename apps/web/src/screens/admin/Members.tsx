// Admin · Members: list with search and filters, add one, paste a list, role/admin/status with confirmations.
import type { AdminUser } from '@acm/core/schemas';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as api from '../../api/admin.ts';
import { ApiError } from '../../api/client.ts';
import { useAdminMutation, useUsers } from '../../data/admin.ts';
import { useMe } from '../../data/session.ts';
import { fmtDateTime } from '../../i18n/format.ts';
import { initials } from '../../routes/AppShell.tsx';
import { Confirm } from '../../ui/Confirm.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { Rich } from '../../ui/Rich.tsx';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton.tsx';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
type Pending = { kind: 'member' | 'disable'; user: AdminUser } | null;

export function MembersScreen() {
  const { t } = useTranslation();
  const me = useMe().data!;
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [role, setRole] = useState<'all' | 'member' | 'core' | 'admin'>('all');
  const [disabledOnly, setDisabledOnly] = useState(false);
  const [panel, setPanel] = useState<'none' | 'single' | 'bulk'>('none');
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    document.title = `${t('admin.members')} · ${t('brand')}`;
  }, [t]);
  const users = useUsers({ q: debounced || undefined, role: role === 'member' || role === 'core' ? role : undefined, status: disabledOnly ? 'disabled' : undefined });
  const all = useMemo(() => (users.data?.pages.flatMap((p) => p.items) ?? []).filter((u) => role !== 'admin' || u.isAdmin), [users.data, role]);
  const counts = users.data?.pages[0]?.counts;
  const patch = useAdminMutation((id: string, b: Parameters<typeof api.patchUser>[1]) => api.patchUser(id, b));
  const change = async (u: AdminUser, b: Parameters<typeof api.patchUser>[1]) => {
    setError(null);
    try {
      await patch.mutateAsync([u.id, b]);
      setPending(null);
    } catch (e) {
      setPending(null);
      setError(e instanceof ApiError && e.code === 'not_allowed' ? t('admin.m_lastAdmin') : t('errors.internal'));
    }
  };

  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <div className="stack grow" style={{ gap: 4 }}>
          <h1 className="t-h1">{t('admin.members')}</h1>
          {counts ? <span className="t-sm muted tnum">{t('admin.m_summary', counts)}</span> : users.isPending && <Skeleton h={20} w={240} />}
        </div>
        <button className="btn btn-s" onClick={() => setPanel(panel === 'bulk' ? 'none' : 'bulk')}>
          {t('admin.m_paste')}
        </button>
        <button className="btn btn-p" onClick={() => setPanel(panel === 'single' ? 'none' : 'single')}>
          <Icon name="plus" />
          {t('admin.m_add')}
        </button>
      </div>

      {panel === 'single' && <AddOne onClose={() => setPanel('none')} />}
      {panel === 'bulk' && <AddMany onClose={() => setPanel('none')} />}

      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label className="search" style={{ flex: '1 1 260px', height: 40 }}>
          <Icon name="search" />
          <input type="search" placeholder={t('admin.m_search')} aria-label={t('admin.m_search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        {(['all', 'member', 'core', 'admin'] as const).map((r) => (
          <button key={r} className="chip" aria-pressed={role === r} onClick={() => setRole(r)}>
            {t(r === 'all' ? 'admin.m_allRoles' : r === 'member' ? 'admin.m_members' : r === 'core' ? 'admin.m_core' : 'admin.m_admins')}
          </button>
        ))}
        <span className="grow" />
        <button className="chip" aria-pressed={disabledOnly} onClick={() => setDisabledOnly((v) => !v)}>
          {t('admin.m_disabled')}
        </button>
      </div>

      {pending?.kind === 'member' && (
        <Confirm title={t('admin.m_confirmMemberTitle', { name: pending.user.name || pending.user.email })} confirm={t('admin.m_makeMember')} cancel={t('admin.m_cancel')} onCancel={() => setPending(null)} onConfirm={() => void change(pending.user, { role: 'member' })} busy={patch.isPending}>
          {t('admin.m_confirmMemberBody')}
        </Confirm>
      )}
      {pending?.kind === 'disable' && (
        <Confirm danger title={t('admin.m_confirmDisableTitle', { name: pending.user.name || pending.user.email })} confirm={t('admin.m_disableAndSignOut')} cancel={t('admin.m_cancel')} onCancel={() => setPending(null)} onConfirm={() => void change(pending.user, { status: 'disabled' })} busy={patch.isPending}>
          <Rich k="admin.m_confirmDisableBody" values={{}} />
        </Confirm>
      )}
      {error && (
        <div className="st st-w" role="alert" style={{ height: 'auto', padding: '12px 14px', fontWeight: 500 }}>
          <Icon name="alert" />
          {error}
        </div>
      )}

      <div className="card scroll-x" aria-busy={users.isPending || undefined} aria-label={users.isPending ? t('states.loading') : undefined}>
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('admin.m_colName')}</th>
              <th>{t('admin.m_colRole')}</th>
              <th>{t('admin.m_colAdmin')}</th>
              <th>{t('admin.m_colStatus')}</th>
              <th>{t('admin.m_colLast')}</th>
              <th>
                <span className="vh">{t('admin.m_colActions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.isPending && <SkeletonRows rows={6} cols={6} />}
            {all.map((u) => (
              <tr key={u.id}>
                <td>
                  <div className="row" style={{ gap: 12 }}>
                    <span className="avatar">{initials(u.name, u.email)}</span>
                    <div className="stack" style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 600 }}>{u.name || u.email.split('@')[0]}</span>
                      <bdi className="t-sm muted">{u.email}</bdi>
                    </div>
                  </div>
                </td>
                <td>
                  {u.role === 'core' ? (
                    <span className="tier">
                      <Icon name="shield" />
                      {t('admin.m_core')}
                    </span>
                  ) : (
                    <span className="tier" style={{ color: 'var(--text-2)' }}>
                      {t('admin.m_roleMember')}
                    </span>
                  )}
                </td>
                <td>
                  <button
                    role="switch"
                    aria-checked={u.isAdmin}
                    aria-label={t('admin.m_adminFor', { name: u.name || u.email })}
                    className={`switch${u.isAdmin ? ' on' : ''}`}
                    style={{ border: 0, cursor: u.role === 'core' ? 'pointer' : 'not-allowed', opacity: u.role === 'core' ? 1 : 0.4 }}
                    disabled={u.role !== 'core' || patch.isPending}
                    onClick={() => void change(u, { isAdmin: !u.isAdmin })}
                  />
                </td>
                <td>{u.status === 'active' ? <span className="st st-ok">{t('admin.m_active')}</span> : <span className="st st-q">{t('admin.m_isDisabled')}</span>}</td>
                <td className="tnum t-sm muted">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : t('admin.m_never')}</td>
                <td>
                  <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                    {u.role === 'member' ? (
                      <button className="btn btn-g btn-sm" onClick={() => void change(u, { role: 'core' })}>
                        {t('admin.m_makeCore')}
                      </button>
                    ) : (
                      u.id !== me.id && (
                        <button className="btn btn-g btn-sm" onClick={() => setPending({ kind: 'member', user: u })}>
                          {t('admin.m_makeMember')}
                        </button>
                      )
                    )}
                    {u.status === 'active' ? (
                      u.id !== me.id && (
                        <button className="btn btn-g btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setPending({ kind: 'disable', user: u })}>
                          {t('admin.m_disable')}
                        </button>
                      )
                    ) : (
                      <button className="btn btn-g btn-sm" onClick={() => void change(u, { status: 'active' })}>
                        {t('admin.m_enable')}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {users.hasNextPage && (
        <button className="btn btn-s" style={{ alignSelf: 'center' }} onClick={() => void users.fetchNextPage()}>
          {t('admin.m_more')}
        </button>
      )}
    </>
  );
}

function AddOne({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ email: '', name: '', role: 'member' as 'member' | 'core' });
  const [err, setErr] = useState<string | null>(null);
  const add = useAdminMutation((b: typeof f) => api.createUser(b));
  const submit = async () => {
    if (!EMAIL.test(f.email.trim())) return setErr(t('admin.m_invalidEmail'));
    try {
      await add.mutateAsync([{ ...f, email: f.email.trim() }]);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError && e.code === 'conflict' ? t('admin.m_exists') : t('errors.internal'));
    }
  };
  return (
    <section className="panel stack" aria-labelledby="h-add" style={{ gap: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 className="t-h2" id="h-add">
          {t('admin.m_addTitle')}
        </h2>
        <button className="btn btn-g btn-sm btn-ic" aria-label={t('admin.m_close')} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div className="field" style={{ flex: '2 1 240px' }}>
          <label className="label" htmlFor="ae">
            {t('admin.m_email')}
          </label>
          <input className="input" id="ae" type="email" dir="ltr" placeholder="name@qu.edu.qa" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-invalid={!!err || undefined} />
        </div>
        <div className="field" style={{ flex: '2 1 200px' }}>
          <label className="label" htmlFor="an">
            {t('admin.m_name')}
          </label>
          <input className="input" id="an" placeholder={t('admin.m_namePh')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <div className="field" style={{ flex: '1 1 140px' }}>
          <label className="label" htmlFor="ar">
            {t('admin.m_role')}
          </label>
          <select className="input" id="ar" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as 'member' | 'core' })}>
            <option value="member">{t('admin.m_roleMember')}</option>
            <option value="core">{t('admin.m_roleCore')}</option>
          </select>
        </div>
      </div>
      {err && (
        <span className="err" role="alert">
          <Icon name="alert" size="sm" style={{ marginTop: 3 }} />
          {err}
        </span>
      )}
      <span className="help">{t('admin.m_addHelp')}</span>
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-g" onClick={onClose}>
          {t('admin.m_cancel')}
        </button>
        <button className="btn btn-p" onClick={() => void submit()} disabled={add.isPending}>
          {t('admin.m_add')}
        </button>
      </div>
    </section>
  );
}

function AddMany({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [role, setRole] = useState<'member' | 'core'>('member');
  const [done, setDone] = useState<number | null>(null);
  const existing = useUsers({}).data?.pages.flatMap((p) => p.items).map((u) => u.email) ?? [];
  const preview = useMemo(() => {
    const seen = new Set<string>();
    const out = { fresh: [] as string[], existing: [] as string[], invalid: [] as string[], dupes: 0 };
    for (const raw of text.split(/[\s,;]+/).filter(Boolean)) {
      const e = raw.toLowerCase();
      if (!EMAIL.test(e)) out.invalid.push(raw);
      else if (seen.has(e)) out.dupes++;
      else {
        seen.add(e);
        (existing.includes(e) ? out.existing : out.fresh).push(e);
      }
    }
    return out;
  }, [text, existing]);
  const bulk = useAdminMutation((emails: string, r: 'member' | 'core') => api.bulkUsers(emails, r));
  return (
    <section className="panel stack" aria-labelledby="h-bulk" style={{ gap: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 className="t-h2" id="h-bulk">
          {t('admin.m_bulkTitle')}
        </h2>
        <button className="btn btn-g btn-sm btn-ic" aria-label={t('admin.m_close')} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="row" style={{ gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div className="field" style={{ flex: '2 1 320px' }}>
          <label className="label" htmlFor="bl">
            {t('admin.m_emails')}
          </label>
          <textarea className="input tnum" id="bl" rows={8} dir="ltr" value={text} onChange={(e) => setText(e.target.value)} />
          <span className="help">{t('admin.m_bulkHelp')}</span>
        </div>
        <div className="stack" style={{ flex: '1 1 240px', gap: 12 }}>
          <span className="label">{t('admin.m_preview')}</span>
          <ul className="stack t-sm" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6 }}>
            <li>
              <span className="st st-ok">{t('admin.m_new', { n: preview.fresh.length })}</span> {t('admin.m_newNote')}
            </li>
            {preview.existing.length > 0 && (
              <li>
                <span className="st st-q">{t('admin.m_existing', { n: preview.existing.length })}</span> <bdi>{preview.existing.slice(0, 3).join(', ')}</bdi>
              </li>
            )}
            {preview.invalid.length > 0 && (
              <li>
                <span className="st st-x">{t('admin.m_invalid', { n: preview.invalid.length })}</span> <bdi>“{preview.invalid.slice(0, 3).join('”, “')}”</bdi>
              </li>
            )}
            {preview.dupes > 0 && (
              <li>
                <span className="st st-q">{t('admin.m_dupes', { n: preview.dupes })}</span>
              </li>
            )}
          </ul>
          <div className="field">
            <label className="label" htmlFor="br">
              {t('admin.m_addAs')}
            </label>
            <select className="input" id="br" value={role} onChange={(e) => setRole(e.target.value as 'member' | 'core')}>
              <option value="member">{t('admin.m_members')}</option>
              <option value="core">{t('admin.m_core')}</option>
            </select>
          </div>
          <button
            className="btn btn-p"
            disabled={!preview.fresh.length || bulk.isPending}
            onClick={() => void bulk.mutateAsync([text, role]).then((r) => (setDone(r.created), setText('')))}
          >
            {t('admin.m_addN', { n: preview.fresh.length })}
          </button>
          {done !== null && (
            <span className="st st-ok" role="status">
              <Icon name="check" />
              {t('admin.m_added', { n: done })}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
