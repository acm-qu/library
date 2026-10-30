// Male / Female as two radio chips (same pattern as the theme picker on Account).
import { GENDERS, type Gender } from '@acm/core/schemas';
import { useTranslation } from 'react-i18next';

export function GenderRadio({ id, value, onChange, invalid }: { id: string; value: Gender | null; onChange: (g: Gender) => void; invalid?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="field">
      <span className="label" id={id}>
        {t('gender.label')}
      </span>
      <div role="radiogroup" aria-labelledby={id} aria-invalid={invalid || undefined} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {GENDERS.map((g) => (
          <button key={g} type="button" className="chip" role="radio" aria-checked={value === g} aria-pressed={value === g} onClick={() => onChange(g)}>
            {t(`gender.${g}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
