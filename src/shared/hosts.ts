// Remote hosts the extension talks to, in the form chrome.permissions and the manifest use.

/**
 * The Anthropic API, used only by the opt-in AI check with the user's own key. It's an optional
 * host permission (manifest optional_host_permissions): the options page requests it when the
 * AI check is turned on, and the background refuses to call the API without it.
 */
export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com/*';
