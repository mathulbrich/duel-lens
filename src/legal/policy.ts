// The privacy policy as the extension shows it (privacy.html), so no hosting is needed inside the
// extension: the text of docs/release/privacy-policy.md without its draft box and appendices
// (policy.test.ts fails if they drift apart), for the build it's in:
// - every build: the first-run consent step ships (the doc's Appendix C, "The first-run consent step
//   ships"), and no build asks for access to db.ygoprodeck.com any more (its API allows any origin);
// - the crop build (`--no-remote-images`): no card images or artwork from YGOPRODeck, and a small
//   picture of each scan kept with the history (thumbnail.ts) (Appendix C, "The crop build");
// - builds without the developer options (store builds): no "Save crops" (Appendix C, D8).
// The doc's full text is the `--dev` build's. The store build's (remote images on, developer options
// off) is the doc's Appendix D, the text to host (policy.test.ts keeps it word for word).
//
// The parts that differ are chosen by the build flags themselves, so each build's legal.js holds only
// its own text (esbuild drops the other variant).

/** The parts of the policy that depend on where card pictures come from. */
interface ImageVariant {
  summaryCardData: string;
  historyInSummary: string;
  /** "They aren't saved…", with the developer options and without. */
  saved: { dev: string; plain: string };
  popUp: string;
  historyRowEnd: string;
  imageRows: string[];
  section31: string;
  requestKinds: string;
  imageRequests: string[];
  noImages: string;
  fileRequested: string;
  storageRow: string;
  hostRows: string[];
  noHosts: string;
}

/** YGOPRODeck's card images and artwork downloads (__DUEL_LENS_REMOTE_IMAGES__: every build but the crop build, the store build's included). */
const REMOTE_IMAGES: ImageVariant = {
  summaryCardData:
    "- **Card data and card images come from YGOPRODeck.** To show a card's text and picture, Duel Lens downloads them from YGOPRODeck's servers. These requests carry nothing from your screen. YGOPRODeck can see your IP address and which card images your browser asks for.",
  historyInSummary: '',
  saved: {
    dev: " They aren't saved, except by the optional debug setting described in section 2.",
    plain: " They aren't saved.",
  },
  popUp: '',
  historyRowEnd: 'and whether the image came from a video or a screenshot',
  imageRows: [
    // The latest MAX_CACHED_IMAGES (image-cache.ts); policy.test.ts fails if the two differ.
    '| **Card images** | Pictures of the cards Duel Lens has shown you, downloaded from YGOPRODeck | The latest 1,500 pictures. Older ones are removed automatically. | Uninstall |',
    "| **New cards' artwork index** | Numeric \"fingerprints\" of new cards' artwork, computed on your computer, plus technical records of the last update | Until you uninstall | Uninstall |",
  ],
  section31: 'card data and images',
  requestKinds: 'three kinds',
  imageRequests: [
    '- **Card images.**',
    "  - The first time Duel Lens shows you a card, it downloads that card's picture from `images.ygoprodeck.com`.",
    '  - It also downloads small pictures of up to three other possible matches.',
    "  - It keeps the latest 1,500 pictures, so it doesn't download them again.",
    "- **New cards' artwork.**",
    '  - When new cards are released, it downloads their artwork from `images.ygoprodeck.com`.',
    '  - It turns the artwork into numeric fingerprints on your computer, so it can recognise those cards, and then discards the images.',
    '  - This happens when the weekly check finds new cards, after you install Duel Lens or start Chrome (at most once a day), and when you press **Update now** in Options.',
  ],
  noImages: '',
  fileRequested: ' So it can see which card pictures your browser downloads.',
  storageRow: '| storage, unlimitedStorage | To keep your settings, history, the card database, card pictures and the artwork index on your computer |',
  hostRows: ["| Access to `images.ygoprodeck.com` | To download card pictures and new cards' artwork (section 3.1) |"],
  noHosts: '',
};

/** The crop build (`--no-remote-images`): the user's own crop as the picture, the bundled artwork index only. */
const OWN_CROP: ImageVariant = {
  summaryCardData:
    "- **Card data comes from YGOPRODeck.** To show a card's text, Duel Lens downloads the card list from YGOPRODeck's servers. These requests carry nothing from your screen. YGOPRODeck can see your IP address. Duel Lens downloads no card images: the picture it shows beside a card is the one you selected.",
  historyInSummary: ' (with a small picture of what you selected)',
  saved: {
    dev: " They aren't saved, except for a small copy of the cut-out image, which is kept with your scan history, and by the optional debug setting (section 2).",
    plain: " They aren't saved, except for a small copy of the cut-out image, which is kept with your scan history (section 2).",
  },
  popUp: ' The cut-out image is also shown in the pop-up, in place of a picture of the card.',
  historyRowEnd: 'whether the image came from a video or a screenshot, and a small picture (160 pixels) of what you selected',
  imageRows: [],
  section31: 'card data',
  requestKinds: 'one kind',
  imageRequests: [],
  noImages:
    '\nIt downloads no card images and no artwork. The picture shown beside a card is the one you selected, and Duel Lens learns to recognise newly released cards through its own updates.\n',
  fileRequested: '',
  storageRow: '| storage, unlimitedStorage | To keep your settings, your scan history (with a small picture of each scan) and the card database on your computer |',
  hostRows: [],
  noHosts: "\nDuel Lens doesn't ask to access any website: YGOPRODeck's card data is public, and any page may download it (section 3.1).\n",
};

/** Developer builds only (__DUEL_LENS_DEV__): Options' "Save crops for a test set". */
const SAVED_CROPS_ROW =
  '| **Saved crops** (debug setting, off by default) | If you turn on "Save crops for a test set": the images you selected (the latest 300) and the card each one turned out to be | Until you uninstall | Uninstall. **Export test set** creates a file only when you click it. |';

const lines = (...parts: (string | false)[]) => parts.filter((p): p is string => p !== false).join('\n');

/** The policy, in Markdown, for this build (__DUEL_LENS_REMOTE_IMAGES__, __DUEL_LENS_DEV__). */
export function privacyPolicy(): string {
  const v = __DUEL_LENS_REMOTE_IMAGES__ ? REMOTE_IMAGES : OWN_CROP;
  const savedCrops = __DUEL_LENS_DEV__ ? SAVED_CROPS_ROW : false;
  const saved = __DUEL_LENS_DEV__ ? v.saved.dev : v.saved.plain;

  return `**Effective date:** 30 September 2026
**Applies to:** the Duel Lens extension for Google Chrome, version 0.9.0 and later
**Contact:** mathulbrich@gmail.com

## Summary

- **Duel Lens recognises cards on your computer.** The screenshots and the images you select are processed inside your browser. They aren't sent to us or to anyone else, unless you use the optional AI check.
${v.summaryCardData}
- **The AI check is optional and off by default.** If you turn it on and press **Ask AI**, Duel Lens sends the image you selected and the names of up to five possible cards to Anthropic. It uses your own Anthropic API key.
- **Your data stays in your browser.** Your scan history${v.historyInSummary}, settings and optional API key are stored in your browser, on your computer.
- **We collect nothing.** We have no server, and we don't collect, receive, sell or share any of your data. There are no analytics, no ads and no tracking.

## Who we are

Duel Lens is a free, unofficial browser extension made by the Duel Lens project ("we", "us"). It identifies Yu-Gi-Oh! cards that you select on your screen, for example in a duel video or a stream, and shows their text. It isn't affiliated with Konami, YGOPRODeck or Anthropic.

## 1. The page you're viewing

**Duel Lens can't see a page until you ask it to.** It has no access to your tabs until you press its keyboard shortcut (Alt+Shift+Y by default) or click its toolbar icon. Chrome then gives Duel Lens temporary access to that one tab, until you leave the page or close the tab. Chrome calls this permission "activeTab".

Before your first scan, Duel Lens shows what it handles and asks you to agree. It takes no screenshot and records no history until you do.

When you start a scan, Duel Lens:

- **takes a screenshot** of the visible part of the tab, to show the frozen frame and to find the cards on it;
- **copies the current frame of any video that is visible** on the page, at the video's own resolution, so that a card in a video can be cut out sharply;
- **cuts out the card you choose**: the part of the image you click, drag a box around or, with the hover preview on, rest the pointer on, plus a small margin;
- **identifies the card with its own recognition models**, which run inside your browser.

The screenshot, the video frames and the cut-out image are kept in memory only while the scan is open.${saved} They aren't sent anywhere, except to Anthropic when you press **Ask AI** (section 3).${v.popUp}

When a scan identifies a card, Duel Lens records the page's address and title, and the video's playback time, in your scan history on your computer, so you can find the card and the moment again. Apart from the screenshot, the video frames, and the page's address and title, Duel Lens doesn't read the page's content.

## 2. What is stored on your computer

Duel Lens stores the following in your browser's storage for the extension. Chrome keeps it on your computer. It isn't synced to your Google account, and we can't see it.

${lines(
  '| What | Contains | How long | How to delete it |',
  '|---|---|---|---|',
  `| **Scan history** | For each scan that identified a card: the card, how sure the match was, whether you picked a different card, the time, the page's address and title, the video's playback time (if the card was in a video), ${v.historyRowEnd} | The latest 300 scans. Older ones are removed automatically. | **Clear history** in the side panel, or uninstall Duel Lens |`,
  '| **Current card** | Which history entry the side panel shows | Until you close Chrome | Automatic |',
  '| **Settings** | Whether the AI check is on, the Claude model chosen, and the debug setting | Until you change them | Options, or uninstall |',
  '| **Anthropic API key** (only if you add one) | The key you paste in Options | Until you delete it | Clear the key field in Options, or uninstall |',
  '| **Card database** | Card names, text and statistics from YGOPRODeck | Replaced when YGOPRODeck publishes an update (checked weekly) | Uninstall |',
  ...v.imageRows,
  savedCrops,
  '| **Your agreement** | The date you agreed to this data handling | Until you uninstall | Uninstall |',
)}

Your API key is stored without encryption. Chrome lets only Duel Lens's own pages and background process read it, not websites and not the scripts Duel Lens runs on web pages. Anyone with access to your computer or Chrome profile could still find it. So use a key made just for Duel Lens, with a spending limit, and delete it when you stop using the AI check.

**Uninstalling Duel Lens deletes all of the data above from Chrome.**

## 3. What goes over the internet

### 3.1 YGOPRODeck: ${v.section31} (always)

Duel Lens gets its card information from YGOPRODeck (<https://ygoprodeck.com/>), a free Yu-Gi-Oh! card database. It makes ${v.requestKinds} of request:

${lines(
  '- **Card data.**',
  '  - Once a week, and when you press **Check for updates now** in Options, it asks YGOPRODeck (`db.ygoprodeck.com`) whether the card database has changed.',
  '  - If it has, it downloads the updated card list.',
  '  - With the card list, it downloads the list of Genesys points: how many points each card costs in the Genesys format.',
  ...v.imageRequests,
)}
${v.noImages}
These requests don't contain anything from your screen, and Duel Lens adds no identifier or account information to them. Like any website your browser contacts, YGOPRODeck receives your **IP address**, your browser's standard request information (such as its user agent), and **the address of each file requested**.${v.fileRequested} See YGOPRODeck's privacy policy: <https://ygoprodeck.com/privacy-policy/>.

### 3.2 Anthropic: the AI check (only if you turn it on)

The AI check is **off by default**. To use it, you have to:

1. turn it on in Options;
2. allow Duel Lens to contact \`api.anthropic.com\` (Chrome asks you);
3. paste your own Anthropic API key.

When a match is unsure and you press **Ask AI**, Duel Lens sends one request **directly from your browser to Anthropic's API**, containing:

- the image you selected (the card, plus a small margin around it);
- the names of up to 5 cards Duel Lens thinks it might be;
- a fixed instruction asking Claude to name the card;
- the Claude model chosen in Options;
- your API key, which Anthropic uses to identify your account;
- technical information added by Anthropic's software library: the library's version, and your browser's name and version.

The **Test** button in Options sends only the word "ping", with your key.

Anthropic receives this data under **your own agreement with Anthropic**, and handles it under Anthropic's policies:
- privacy policy: <https://www.anthropic.com/legal/privacy>;
- how long Anthropic keeps API data: <https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data>.

We never receive your key, your images or Claude's answers. Anthropic charges your account for these requests.

### 3.3 Links you open

Duel Lens shows links to other websites: YGOPRODeck (a card's page, and its home page), YouTube (the moment a card appeared), and Anthropic's Console and price list. They open only when you click them, and those websites' own privacy policies apply.

### 3.4 Nothing else

Duel Lens has no server of its own and no user accounts. It has no analytics, crash reporting, advertising or tracking. It doesn't load code from the internet: its recognition models and software are inside the extension.

## 4. What we collect

**Nothing.** We don't operate any server that Duel Lens sends data to. We don't receive your history, your images, your settings or your API key. We don't sell, rent or share personal information, and we don't use any data for advertising or for any purpose other than the extension's features.

Because your data never reaches us, we can't look at it, export it or delete it for you. It's on your computer and under your control (section 2). For data that YGOPRODeck or Anthropic hold, contact them.

## 5. Why Duel Lens asks for its permissions

${lines(
  '| Permission | Why |',
  '|---|---|',
  '| activeTab | To take a screenshot of the current tab and show the selection there, only after you press the shortcut or click the icon |',
  "| scripting | To add Duel Lens's selection layer and card pop-up to that tab when you start a scan |",
  '| offscreen | To run the recognition models in a hidden extension page |',
  v.storageRow,
  "| sidePanel | To show the scanned card and your history in Chrome's side panel |",
  "| alarms | For the weekly card-data check, and to close the recognition engine when it's idle |",
  ...v.hostRows,
  '| Optional access to `api.anthropic.com` | Only for the AI check, and requested only when you turn it on (section 3.2) |',
)}
${v.noHosts}
## 6. Children

Duel Lens isn't directed at children under 13, and it doesn't collect personal information from anyone.

## 7. Where the data is processed

Everything described in sections 1 and 2 happens on your computer. YGOPRODeck and Anthropic may process the requests described in section 3 in other countries, including the United States. See their privacy policies.

## 8. Chrome Web Store User Data Policy

Duel Lens's use of information complies with the Chrome Web Store User Data Policy, including the Limited Use requirements (<https://developer.chrome.com/docs/webstore/program-policies/limited-use>).

## 9. Changes to this policy

We'll update this page, and its effective date, whenever Duel Lens's handling of data changes. If a new version would send more data off your computer, it will tell you in the extension before that happens.

## 10. Contact

Questions or requests: mathulbrich@gmail.com.
`;
}
