// Event fields shared by the upload flow's "create" form and the edit dialog, plus the delete confirmation.
import type { EventDetail } from '@acm/core/schemas';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client.ts';
import { useDeleteEvent, useEvent, usePatchEvent } from '../data/library.ts';
import { useMe } from '../data/session.ts';
import type { Tier } from '../lib/uploader.ts';
import { Confirm } from '../ui/Confirm.tsx';
import { DateInput } from '../ui/DateInput.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Skeleton } from '../ui/Skeleton.tsx';

export type EventForm = { title: string; startsOn: string; endsOn: string; location: string; description: string; defaultTier: Tier };
type Errors = Partial<Record<keyof EventForm, string>>;

/** Message key per field, for both the client checks and the API's `fields` (other fields get the generic message). */
export const FIELD_MSG = { title: 'upload.titleRequired', startsOn: 'upload.dateRequired', endsOn: 'upload.endBeforeStart' } as const;

export function invalidFields(f: EventForm) {
  const bad: (keyof typeof FIELD_MSG)[] = [];
  if (!f.title.trim()) bad.push('title');
  if (!f.startsOn) bad.push('startsOn');
  if (f.endsOn && f.endsOn < f.startsOn) bad.push('endsOn');
  return bad;
}

export const eventBody = (f: EventForm) => ({
  title: f.title.trim(),
  startsOn: f.startsOn,
  endsOn: f.endsOn || null,
  location: f.location.trim() || null,
  description: f.description.trim() || null,
  defaultTier: f.defaultTier,
});

export const errorText = (e: unknown, t: ReturnType<typeof useTranslation>['t']) => t(`errors.${e instanceof ApiError ? e.code : 'internal'}`);

export function TierChoice({ value, onChange, labelledBy, label, long }: { value: Tier; onChange: (t: Tier) => void; labelledBy?: string; label?: string; long?: boolean }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} aria-label={label} className="row" style={{ gap: 8 }}>
      <button className="chip" role="radio" aria-checked={value === 'member'} aria-pressed={value === 'member'} onClick={() => onChange('member')}>
        {t(long ? 'upload.allMembers' : 'upload.members')}
      </button>
      <button className="chip" role="radio" aria-checked={value === 'core'} aria-pressed={value === 'core'} onClick={() => onChange('core')}>
        <Icon name="shield" size="sm" />
        {t(long ? 'upload.coreOnly' : 'upload.core')}
      </button>
    </div>
  );
}

function FieldError({ id, msg }: { id: string; msg?: string }) {
  return msg ? (
    <span className="err" id={id}>
      <Icon name="alert" size="sm" style={{ marginTop: 3 }} />
      {msg}
    </span>
  ) : null;
}

export function EventFields({ form, setForm, errors = {}, tierHelp }: { form: EventForm; setForm: (f: EventForm) => void; errors?: Errors; tierHelp: string }) {
  const { t } = useTranslation();
  const invalid = (k: keyof EventForm) => (errors[k] ? { 'aria-invalid': true, 'aria-describedby': `ev-${k}-e` } : {});
  return (
    <>
      <div className="field">
        <label className="label" htmlFor="ev-t">
          {t('upload.eventTitle')}
        </label>
        <input className="input" id="ev-t" value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} {...invalid('title')} />
        <FieldError id="ev-title-e" msg={errors.title} />
      </div>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label className="label" htmlFor="ev-d1">
            {t('upload.date')}
          </label>
          <DateInput id="ev-d1" value={form.startsOn} onChange={(v) => setForm({ ...form, startsOn: v })} {...invalid('startsOn')} />
          <FieldError id="ev-startsOn-e" msg={errors.startsOn} />
        </div>
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label className="label" htmlFor="ev-d2">
            {t('upload.endDate')} <span className="subtle">{t('upload.optional')}</span>
          </label>
          <DateInput id="ev-d2" clearable value={form.endsOn} min={form.startsOn || undefined} onChange={(v) => setForm({ ...form, endsOn: v })} {...invalid('endsOn')} />
          <FieldError id="ev-endsOn-e" msg={errors.endsOn} />
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor="ev-loc">
          {t('upload.location')} <span className="subtle">{t('upload.optional')}</span>
        </label>
        <input className="input" id="ev-loc" value={form.location} maxLength={200} onChange={(e) => setForm({ ...form, location: e.target.value })} {...invalid('location')} />
        <FieldError id="ev-location-e" msg={errors.location} />
      </div>
      <div className="field">
        <label className="label" htmlFor="ev-desc">
          {t('upload.description')} <span className="subtle">{t('upload.optional')}</span>
        </label>
        <textarea className="input" id="ev-desc" rows={2} placeholder={t('upload.descriptionHint')} value={form.description} maxLength={5000} onChange={(e) => setForm({ ...form, description: e.target.value })} {...invalid('description')} />
        <FieldError id="ev-description-e" msg={errors.description} />
      </div>
      <div className="field">
        <span className="label" id="tier-l">
          {t('upload.defaultTier')}
        </span>
        <TierChoice labelledBy="tier-l" value={form.defaultTier} onChange={(v) => setForm({ ...form, defaultTier: v })} long />
        <span className="help">{tierHelp}</span>
        <FieldError id="ev-defaultTier-e" msg={errors.defaultTier} />
      </div>
    </>
  );
}

/** Admins only. Confirms inline, then deletes the event; its items are purged by the worker. */
export function DeleteEventConfirm({ event, onCancel, onDeleted }: { event: { id: string; title: string }; onCancel: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const del = useDeleteEvent();
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setError(null);
    try {
      await del.mutateAsync(event.id);
      onDeleted();
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'not_allowed' ? t('event.deleteGirlsOnly') : errorText(e, t));
    }
  };
  return (
    <Confirm danger title={t('event.deleteTitle', { title: event.title })} confirm={t('event.delete')} cancel={t('upload.cancel')} onCancel={onCancel} onConfirm={() => void confirm()} busy={del.isPending}>
      <div className="stack" style={{ gap: 8 }}>
        {t('event.deleteBody')}
        {error && (
          <span className="err" role="alert">
            <Icon name="alert" size="sm" style={{ marginTop: 3 }} />
            {error}
          </span>
        )}
      </div>
    </Confirm>
  );
}

/** Modal edit form for core members (a native <dialog>: Esc closes it, focus stays inside and returns on close). */
export function EventEditDialog({ slug, onClose, onDeleted }: { slug: string; onClose: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const ev = useEvent(slug);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal(); // StrictMode runs this twice
  }, []);
  // Plays the exit animation before closing; close() fires onClose. Esc goes through here too (onCancel).
  const close = () => {
    const d = ref.current;
    if (!d?.open || d.classList.contains('closing')) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return d.close();
    d.classList.add('closing');
    setTimeout(() => {
      d.classList.remove('closing');
      d.close();
    }, 180);
  };
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="ee-t"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      style={{ width: 'min(560px, 100% - 32px)', maxWidth: 'none', padding: 24, color: 'inherit' }}>
      <div className="stack" style={{ gap: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 className="t-h2" id="ee-t">
            {t('event.edit')}
          </h2>
          <button className="btn btn-g btn-sm btn-ic" aria-label={t('event.close')} onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        {ev.data ? (
          <EditForm
            event={ev.data}
            onSaved={close}
            onCancel={close}
            onDeleted={() => {
              close();
              onDeleted();
            }}
          />
        ) : ev.isError ? (
          <span className="err" role="alert">
            <Icon name="alert" size="sm" style={{ marginTop: 3 }} />
            {errorText(ev.error, t)}
          </span>
        ) : (
          <div className="stack" style={{ gap: 16 }} aria-busy="true" aria-label={t('states.loading')}>
            {[0, 1, 2, 3].map((n) => (
              <div key={n} className="stack" style={{ gap: 6 }}>
                <Skeleton h={20} w={120} />
                <Skeleton h="var(--h-ctl)" />
              </div>
            ))}
          </div>
        )}
      </div>
    </dialog>
  );
}

function EditForm({ event, onSaved, onCancel, onDeleted }: { event: EventDetail; onSaved: () => void; onCancel: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const isAdmin = !!useMe().data?.isAdmin;
  const [form, setForm] = useState<EventForm>({
    title: event.title,
    startsOn: event.startsOn,
    endsOn: event.endsOn ?? '',
    location: event.location ?? '',
    description: event.description ?? '',
    defaultTier: event.defaultTier,
  });
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const patch = usePatchEvent();

  async function save() {
    setError(null);
    const bad = invalidFields(form);
    setErrors(Object.fromEntries(bad.map((k) => [k, t(FIELD_MSG[k])])));
    if (bad.length) return;
    try {
      await patch.mutateAsync({ id: event.id, ...eventBody(form) });
      onSaved();
    } catch (e) {
      const fields = Object.keys((e instanceof ApiError && e.body.fields) || {});
      const shown = fields.filter((k): k is keyof EventForm => k in form);
      setErrors(Object.fromEntries(shown.map((k) => [k, t(k in FIELD_MSG ? FIELD_MSG[k as keyof typeof FIELD_MSG] : 'errors.bad_request')])));
      if (!fields.length || shown.length < fields.length) setError(errorText(e, t));
    }
  }

  return (
    <>
      <EventFields form={form} setForm={setForm} errors={errors} tierHelp={t('event.tierHelpEdit')} />
      {error && (
        <span className="err" role="alert">
          <Icon name="alert" size="sm" style={{ marginTop: 3 }} />
          {error}
        </span>
      )}
      {deleting ? (
        <DeleteEventConfirm event={event} onCancel={() => setDeleting(false)} onDeleted={onDeleted} />
      ) : (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {isAdmin && (
            <button className="btn btn-g" style={{ color: 'var(--danger)' }} onClick={() => setDeleting(true)}>
              {t('event.delete')}
            </button>
          )}
          <span className="grow" />
          <button className="btn btn-g" onClick={onCancel}>
            {t('upload.cancel')}
          </button>
          <button className="btn btn-p" onClick={() => void save()} disabled={patch.isPending}>
            {t('event.save')}
          </button>
        </div>
      )}
    </>
  );
}
