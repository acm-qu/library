// Renders a translated message containing <b>…</b> with the design's emphasis, without dangerouslySetInnerHTML.
import { Trans } from 'react-i18next';

export function Rich({ k, values }: { k: string; values: Record<string, string | number> }) {
  return (
    <Trans
      i18nKey={k as never}
      values={values}
      components={{ b: <strong style={{ color: 'var(--text)', fontWeight: 600 }} /> }}
      shouldUnescape
    />
  );
}
