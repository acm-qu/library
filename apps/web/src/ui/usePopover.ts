// Shared open/close behaviour for Select and DateInput: a trigger button and a popover inside one wrapper.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export function usePopover(id?: string) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const viaLabel = useRef(false);

  const close = (refocus?: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  // Click outside closes.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);

  // A <label htmlFor> click is forwarded to the button as a click; like a native select, that only focuses it.
  useEffect(() => {
    if (!id) return;
    const sel = `label[for="${CSS.escape(id)}"]`;
    const click = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(sel)) return;
      viaLabel.current = true;
      setTimeout(() => (viaLabel.current = false)); // the forwarded click runs in the same task
    };
    document.addEventListener('click', click, true);
    return () => document.removeEventListener('click', click, true);
  }, [id]);

  // Opens below the trigger, or above it when the viewport has more room there. Set on the DOM, not in state, so
  // it is in place before the popover takes focus (focus scrolls it into view).
  useLayoutEffect(() => {
    if (!open || !trigger.current || !pop.current) return;
    const r = trigger.current.getBoundingClientRect();
    const below = innerHeight - r.bottom;
    pop.current.toggleAttribute('data-up', below < pop.current.offsetHeight + 8 && r.top > below);
  }, [open]);

  return {
    open,
    setOpen,
    close,
    wrap,
    trigger,
    pop,
    /** Toggles on a click, except the one a label forwards. */
    onTriggerClick: (show: () => void) => {
      if (viaLabel.current) return trigger.current?.focus();
      if (open) close();
      else show();
    },
    /** Focus moving out of the wrapper (Tab, Shift+Tab) closes. */
    onBlur: (e: React.FocusEvent) => e.relatedTarget && !wrap.current?.contains(e.relatedTarget as Node) && setOpen(false),
  };
}
