// A date field: a button styled like `.input` opening a month calendar (a non-modal dialog with a roving-focus
// day grid). Value in and out is 'YYYY-MM-DD' or '' like <input type="date">. A time part would be a second
// popover section fed by the same value; none of the forms need one yet.
import { type ButtonHTMLAttributes, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtDate, fmtDayPart, loc } from '../i18n/format.ts';
import { addDays, addMonths, clampDay, firstWeekday, monthGrid, today, weekStart } from './calendar.ts';
import { Icon } from './Icon.tsx';
import { usePopover } from './usePopover.ts';

type Props = {
  value: string;
  onChange: (v: string) => void;
  min?: string;
  max?: string;
  /** Optional fields get a "Clear" action. */
  clearable?: boolean;
  placeholder?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange' | 'placeholder'>;

export function DateInput({ value, onChange, min, max, clearable, placeholder, className = '', ...rest }: Props) {
  const { t } = useTranslation();
  const p = usePopover(rest.id);
  const uid = useId();
  const [focus, setFocus] = useState(''); // the roving day; the calendar shows its month
  const moveFocus = useRef(false);
  const now = today();
  const first = firstWeekday(loc());
  const days = focus ? monthGrid(focus, first) : [];
  const inRange = (d: string) => clampDay(d, min, max) === d;

  const go = (d: string, toDay = false) => {
    moveFocus.current = toDay;
    setFocus(clampDay(d, min, max));
  };
  const show = () => {
    go(value || now, true);
    p.setOpen(true);
  };
  const pick = (d: string) => {
    onChange(d);
    p.close(true);
  };

  useEffect(() => {
    if (!p.open || !moveFocus.current) return;
    moveFocus.current = false;
    p.pop.current?.querySelector<HTMLElement>('[data-day][tabindex="0"]')?.focus();
  }, [p.open, p.pop, focus]);

  const onGridKey = (e: React.KeyboardEvent) => {
    const back = getComputedStyle(e.currentTarget).direction === 'rtl' ? 1 : -1; // Left goes forward in RTL
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDays(focus, back),
      ArrowRight: () => addDays(focus, -back),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, -1),
      PageDown: () => addMonths(focus, 1),
      Home: () => weekStart(focus, first),
      End: () => addDays(weekStart(focus, first), 6),
    };
    const move = moves[e.key];
    if (!move) return; // Enter and Space click the focused day button
    e.preventDefault();
    go(move(), true);
  };

  const month = focus.slice(0, 7);
  return (
    <div ref={p.wrap} className="pop-wrap block" onBlur={p.onBlur}>
      <button
        ref={p.trigger}
        type="button"
        className={`input pop-trigger tnum ${className}`.trim()}
        aria-haspopup="dialog"
        aria-expanded={p.open}
        {...rest}
        // The label names the button; the date is read as its description, before any error message.
        aria-describedby={[`${uid}-v`, rest['aria-describedby']].filter(Boolean).join(' ')}
        onClick={() => p.onTriggerClick(show)}>
        <span className={value ? 'truncate' : 'truncate subtle'} id={`${uid}-v`}>
          {value ? fmtDate(value) : (placeholder ?? t('picker.noDate'))}
        </span>
        <Icon name="calendar" />
      </button>
      {p.open && (
        <div
          ref={p.pop}
          role="dialog"
          aria-label={t('picker.chooseDate')}
          className="pop cal"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault(); // a surrounding <dialog> must not close too
            e.stopPropagation();
            p.close(true);
          }}>
          <div className="cal-head">
            <button type="button" className="btn btn-g btn-sm btn-ic" aria-label={t('picker.prevMonth')} disabled={!!min && month <= min.slice(0, 7)} onClick={() => go(addMonths(focus, -1))}>
              <Icon name="back" className="flip" />
            </button>
            <span className="cal-title" id={`${uid}-m`} aria-live="polite">
              {fmtDayPart(focus, { month: 'long', year: 'numeric' })}
            </span>
            <button type="button" className="btn btn-g btn-sm btn-ic" aria-label={t('picker.nextMonth')} disabled={!!max && month >= max.slice(0, 7)} onClick={() => go(addMonths(focus, 1))}>
              <Icon name="next" className="flip" />
            </button>
          </div>
          <table role="grid" className="cal-grid" aria-labelledby={`${uid}-m`} onKeyDown={onGridKey}>
            <thead>
              <tr>
                {days.slice(0, 7).map((d) => (
                  <th key={d} scope="col" abbr={fmtDayPart(d, { weekday: 'long' })}>
                    {fmtDayPart(d, { weekday: 'narrow' })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3, 4, 5].map((w) => (
                <tr key={w}>
                  {days.slice(w * 7, w * 7 + 7).map((d) => (
                    <td key={d} aria-selected={d === value}>
                      <button
                        type="button"
                        data-day
                        tabIndex={d === focus ? 0 : -1}
                        disabled={!inRange(d)}
                        data-out={d.slice(0, 7) !== month || undefined}
                        aria-current={d === now ? 'date' : undefined}
                        aria-label={fmtDate(d)}
                        onClick={() => pick(d)}>
                        {fmtDayPart(d, { day: 'numeric' })}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="cal-foot">
            <button type="button" className="btn btn-g btn-sm" disabled={!inRange(now)} onClick={() => pick(now)}>
              {t('picker.today')}
            </button>
            {clearable && value && (
              <button type="button" className="btn btn-g btn-sm" onClick={() => pick('')}>
                {t('picker.clear')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
