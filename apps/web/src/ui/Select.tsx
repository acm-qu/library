// A select: a button showing the value and a chevron, opening a listbox. Focus moves to the listbox, which
// tracks the highlighted option with aria-activedescendant. Controlled only (the forms keep their own state).
import { type ButtonHTMLAttributes, useEffect, useId, useState } from 'react';
import { Icon } from './Icon.tsx';
import { usePopover } from './usePopover.ts';

export type SelectOption<T extends string> = { value: T; label: string; disabled?: boolean };

type Props<T extends string> = {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (v: T) => void;
  /** `input` looks like `.input` (full width); `chip` like `.chip`. */
  variant?: 'input' | 'chip';
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange'>;

export function Select<T extends string>({ value, options, onChange, variant = 'input', className = '', ...rest }: Props<T>) {
  const p = usePopover(rest.id);
  const uid = useId();
  const [active, setActive] = useState(0);
  const sel = options.findIndex((o) => o.value === value);

  const show = () => {
    setActive(Math.max(0, sel));
    p.setOpen(true);
  };
  const choose = (i: number) => {
    if (options[i]!.disabled) return;
    onChange(options[i]!.value);
    p.close(true);
  };

  useEffect(() => {
    if (p.open) p.pop.current?.focus();
  }, [p.open, p.pop]);
  useEffect(() => {
    if (p.open) p.pop.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [p.open, p.pop, active]);

  const onListKey = (e: React.KeyboardEvent) => {
    const last = options.length - 1;
    const to = ({ ArrowDown: Math.min(active + 1, last), ArrowUp: Math.max(active - 1, 0), Home: 0, End: last } as Record<string, number>)[e.key];
    if (to !== undefined) setActive(to);
    else if (e.key === 'Enter' || e.key === ' ') choose(active);
    else if (e.key === 'Tab') return p.close(true); // Tab then moves on from the button, as from a native select
    else if (e.key === 'Escape') {
      e.stopPropagation(); // and preventDefault below: a surrounding <dialog> must not close too
      p.close(true);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-ahead: the next option starting with the typed letter, wrapping around.
      const k = e.key.toLocaleLowerCase();
      const next = options.findIndex((_, i) => options[(active + 1 + i) % options.length]!.label.toLocaleLowerCase().startsWith(k));
      if (next >= 0) setActive((active + 1 + next) % options.length);
    } else return;
    e.preventDefault();
  };

  return (
    <div ref={p.wrap} className={`pop-wrap${variant === 'input' ? ' block' : ''}`} onBlur={p.onBlur}>
      <button
        ref={p.trigger}
        type="button"
        className={`${variant} pop-trigger ${className}`.trim()}
        aria-haspopup="listbox"
        aria-expanded={p.open}
        {...rest}
        // The label names the button; the value is read as its description, before any error message.
        aria-describedby={[`${uid}-v`, rest['aria-describedby']].filter(Boolean).join(' ')}
        onClick={() => p.onTriggerClick(show)}
        onKeyDown={(e) => {
          if (!['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
          e.preventDefault();
          show();
        }}>
        <span className="truncate" id={`${uid}-v`}>
          {options[sel]?.label}
        </span>
        <Icon name="chevron" size="sm" />
      </button>
      {p.open && (
        <div
          ref={p.pop}
          role="listbox"
          tabIndex={-1}
          className="pop"
          aria-labelledby={rest['aria-labelledby']}
          aria-label={rest['aria-labelledby'] ? undefined : (p.trigger.current?.labels?.[0]?.textContent ?? undefined)}
          aria-activedescendant={`${uid}-${active}`}
          onKeyDown={onListKey}>
          {options.map((o, i) => (
            <div key={o.value} id={`${uid}-${i}`} role="option" aria-selected={i === sel} aria-disabled={o.disabled || undefined} data-active={i === active || undefined} onPointerEnter={() => setActive(i)} onClick={() => choose(i)}>
              {o.label}
              {i === sel && <Icon name="check2" size="sm" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
