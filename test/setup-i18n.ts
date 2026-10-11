// Every test resolves the interface's strings from the English catalog (src/shared/i18n.ts): the English
// expectations hold, and a key missing from extension/_locales/en/messages.json throws.
import en from '../extension/_locales/en/messages.json';
import { useTestMessages } from '../src/shared/i18n';

useTestMessages(en);
