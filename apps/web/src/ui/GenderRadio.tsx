// Male / Female as two radio chips (same pattern as the theme picker on Account); the value is isFemale.
import { useTranslation } from 'react-i18next';

const OPTIONS = [
  [false, 'gender.male'],
  [true, 'gender.female'],
] as const;

export function GenderRadio({ id, value, onChange, invalid }: { id: string; value: boolean | null; onChange: (isFemale: boolean) => void; invalid?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="field">
      <span className="label" id={id}>
        {t('gender.label')}
      </span>
      <div role="radiogroup" aria-labelledby={id} aria-invalid={invalid || undefined} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {OPTIONS.map(([f, key]) => (
          <button key={key} type="button" className="chip" role="radio" aria-checked={value === f} aria-pressed={value === f} onClick={() => onChange(f)}>
            {t(key)}
          </button>
        ))}
      </div>
    </div>
  );
}
