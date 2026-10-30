// "Duel Lens X is out": for a copy installed by hand, which never updates itself, the newer version the background
// found on GitHub (background/update-check.ts, shared/update.ts), with a link to it and how to update without losing
// the history. Nothing shows for a store copy: the background never asks for one.
import { useEffect, useState } from 'preact/hooks';
import { t } from '../shared/i18n';
import { noticeFor, RELEASES_PAGE, UPDATE_KEY, type UpdateNotice } from '../shared/update';

/**
 * The newer version, while there is one (it goes once this copy is updated, or the check is turned off). `active`
 * false (Options, for a store copy): nothing is read.
 */
export function useUpdateNotice(active = true): UpdateNotice | null {
  const [notice, setNotice] = useState<UpdateNotice | null>(null);
  useEffect(() => {
    if (!active) return;
    const current = chrome.runtime.getManifest().version;
    const read = () =>
      chrome.storage.local
        .get(UPDATE_KEY)
        .then((got) => setNotice(noticeFor(got[UPDATE_KEY], current)))
        .catch(() => setNotice(null));
    void read();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && UPDATE_KEY in changes) setNotice(noticeFor(changes[UPDATE_KEY].newValue, current));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [active]);
  return notice;
}

export function UpdateNote({ notice }: { notice: UpdateNotice }) {
  return (
    <div class="update-note" role="note">
      <p>
        <strong>{t('update_available', notice.version)}</strong>{' '}
        <a href={RELEASES_PAGE} target="_blank" rel="noopener noreferrer">
          {t('update_get')}
        </a>
      </p>
      <p class="how">{t('update_how')}</p>
    </div>
  );
}
