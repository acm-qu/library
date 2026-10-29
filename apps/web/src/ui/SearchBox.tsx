// Event search: lives in the top bar on desktop and at the top of the Library on phones. Writes ?q= on the
// Library route (debounced), so results are linkable and the back button works.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Icon } from './Icon.tsx';

export function SearchBox({ big }: { big?: boolean }) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const loc = useLocation();
  const navigate = useNavigate();
  const onLibrary = loc.pathname === '/';
  const urlQ = onLibrary ? (params.get('q') ?? '') : '';
  const [value, setValue] = useState(urlQ);
  useEffect(() => setValue(urlQ), [urlQ]);
  useEffect(() => {
    if (value.trim() === urlQ.trim()) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(onLibrary ? params : undefined);
      if (value.trim()) next.set('q', value.trim());
      else next.delete('q');
      const s = next.toString();
      navigate(`/${s ? `?${s}` : ''}`, { replace: onLibrary });
    }, 300);
    return () => clearTimeout(timer);
  }, [value, urlQ, onLibrary, params, navigate]);

  return (
    <label className="search" style={big ? { height: 44 } : { width: 300 }}>
      <Icon name="search" />
      <input type="search" placeholder={t('library.search')} aria-label={t('library.search')} value={value} onChange={(e) => setValue(e.target.value)} enterKeyHint="search" />
    </label>
  );
}
