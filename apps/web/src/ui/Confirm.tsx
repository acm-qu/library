// In-page confirmation (the boards confirm inline, next to the action, rather than in a modal).
import { type ReactNode, useEffect, useRef } from 'react';

export function Confirm({ title, children, confirm, cancel, onConfirm, onCancel, danger, busy }: { title: string; children: ReactNode; confirm: string; cancel: string; onConfirm: () => void; onCancel: () => void; danger?: boolean; busy?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div role="alertdialog" aria-labelledby="cf-t" className="panel stack" style={{ gap: 12, borderColor: danger ? 'var(--danger)' : 'var(--border-strong)', background: danger ? 'var(--danger-bg)' : 'var(--surface-2)' }} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <h3 className="t-h3" id="cf-t">
        {title}
      </h3>
      <div className="t-body muted">{children}</div>
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-g" onClick={onCancel}>
          {cancel}
        </button>
        <button ref={ref} className={danger ? 'btn btn-dp' : 'btn btn-p'} onClick={onConfirm} disabled={busy}>
          {confirm}
        </button>
      </div>
    </div>
  );
}
