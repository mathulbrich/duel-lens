// Remote hosts the extension talks to, in the form chrome.permissions and the manifest use.

/**
 * The Anthropic API, used only by the opt-in AI check with the user's own key. It's an optional
 * host permission (manifest optional_host_permissions): the options page requests it when the
 * AI check is turned on, and the background refuses to call the API without it.
 */
export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com/*';

/**
 * What the opt-in AI check asks for when the user turns it on (Options), what the background checks
 * before each call (router.ts), and what goes back when it is turned off: api.anthropic.com, and in the
 * Firefox build also the "websiteContent" data-collection permission its manifest declares optional
 * (decision D-FF4, build.mjs firefoxManifest): the card's crop goes to Anthropic, and only when the
 * user presses Ask AI. Chrome has no data-collection permissions (it would refuse the key).
 */
export function askAiPermissions(): chrome.permissions.Permissions {
  if (__DUEL_LENS_FIREFOX__) return { origins: [ANTHROPIC_ORIGIN], data_collection: ['websiteContent'] } as chrome.permissions.Permissions;
  return { origins: [ANTHROPIC_ORIGIN] };
}

/**
 * What "Report" needs before it sends anything (background/report.ts): in the Firefox build, consent to the two
 * data-collection permissions its manifest declares optional for it (build.mjs firefoxManifest), asked in Options:
 * "websiteContent" (the crop) and "browsingActivity" (the video's address and time). The relay itself is reached
 * without a host permission (it answers CORS). Chrome has no data-collection permissions, so nothing to ask there.
 */
export function reportPermissions(): chrome.permissions.Permissions {
  return { data_collection: ['websiteContent', 'browsingActivity'] } as chrome.permissions.Permissions;
}
