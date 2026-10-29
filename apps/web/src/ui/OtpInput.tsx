// Six visual boxes over one real input (autocomplete=one-time-code), so paste, SMS autofill and screen readers
// all work on a single field. Calls onComplete on the sixth digit.
import { forwardRef } from 'react';

type Props = {
  id: string;
  value: string;
  onChange: (digits: string) => void;
  onComplete: (code: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  describedBy?: string;
};

export const OtpInput = forwardRef<HTMLInputElement, Props>(function OtpInput(
  { id, value, onChange, onComplete, invalid, disabled, describedBy },
  ref,
) {
  const boxes = Array.from({ length: 6 }, (_, i) => {
    const cls = invalid ? 'bad' : !disabled && i === value.length ? 'on' : '';
    return (
      <span key={i} className={cls}>
        {value[i] ?? ''}
      </span>
    );
  });
  return (
    <div style={{ position: 'relative', alignSelf: 'flex-start' }} dir="ltr">
      <div className="otp" aria-hidden="true">
        {boxes}
      </div>
      <input
        ref={ref}
        id={id}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
          onChange(digits);
          if (digits.length === 6) onComplete(digits);
        }}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, fontSize: 16, cursor: 'text' }}
      />
    </div>
  );
});
