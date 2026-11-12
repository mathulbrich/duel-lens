// The page's entry: the interface language first (Options' "Interface language", shared/ui-language.ts), then the
// page itself, whose modules build some of their words as they load (main.tsx).
import { initPageUiLanguage } from '../shared/ui-language';

await initPageUiLanguage();
await import('./main');
