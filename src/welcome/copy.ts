// The legal and privacy wording on Duel Lens's own pages (welcome, Options, side panel), word for
// word from the legal workstream's docs/release/disclaimers.md: copy.test.ts fails when they drift
// apart, so change both together.
//
// The crop build (`--no-remote-images`: __DUEL_LENS_REMOTE_IMAGES__ off) shows the user's own
// crop instead of YGOPRODeck's card images and downloads no artwork. There, the texts change only
// where the doc says to for a text-only build ("Card data and images" becomes "Card data": its §3.3
// and §8), and disclose the small picture each scan keeps for the side panel (thumbnail.ts).
//
// Links are written [like this](url), as in the doc; <Rich> renders them (markdown.tsx).

export const YGOPRODECK_LINK = '[YGOPRODeck](https://ygoprodeck.com/)';

/** §1: the short disclaimer, on every page. */
export const DISCLAIMER = 'Duel Lens is an unofficial fan tool, not affiliated with or endorsed by Konami.';

/** §2: the full legal notice (Options → About, the welcome page's footer). */
export function legalNotice(remoteImages: boolean): string {
  return (
    'Duel Lens is an unofficial, fan-made tool for the Yu-Gi-Oh! TRADING CARD GAME. It is not produced, sponsored, ' +
    'endorsed or approved by, or affiliated with, Konami Digital Entertainment, Konami Group Corporation or their ' +
    'affiliates, Studio Dice, Shueisha or TV Tokyo. Yu-Gi-Oh!, KONAMI and the names, text and images of Yu-Gi-Oh! cards ' +
    'are trademarks and copyrights of their respective owners (© Studio Dice/SHUEISHA, TV TOKYO, KONAMI). ' +
    (remoteImages ? 'Card data and card images come' : 'Card data comes') +
    ' from YGOPRODeck (ygoprodeck.com), which is not affiliated with Duel Lens either.'
  );
}

/** §4 and §8: the credit in the welcome and Options footers. */
export function attribution(remoteImages: boolean): string {
  return `${remoteImages ? 'Card data and images' : 'Card data'} from ${YGOPRODECK_LINK}.`;
}

/** §8: the side panel's footer. */
export function sidePanelCredit(remoteImages: boolean): string {
  return `${remoteImages ? 'Card data and images' : 'Card data'}: ${YGOPRODECK_LINK} · Unofficial fan tool, not affiliated with or endorsed by Konami.`;
}

/** §6: the accuracy notice (Options → About). */
export const ACCURACY =
  'Duel Lens can misidentify cards, and its card data can be out of date, including banlist status. Check the card ' +
  'itself or the official Yu-Gi-Oh! card database before relying on it in a game, a trade or a tournament.';

/** One point of a list: `lead` shown in bold, then `rest` (which starts with its own space or comma). */
export interface Point {
  lead: string;
  rest: string;
}

/** The point as the doc writes it. */
export const pointText = (p: Point) => p.lead + p.rest;

/** §4a: the first-run consent the Chrome Web Store requires before the first scan. */
export const CONSENT = {
  heading: 'Before your first scan',
  /** When a scan brought the user here before they agreed (welcome.html#consent). */
  headingAfterScan: 'Duel Lens needs your OK before its first scan.',
  intro: 'Duel Lens needs your OK to handle this data:',
  agree: 'Agree and start',
  notNow: 'Not now',
  privacy: 'Privacy policy',
} as const;

const SMALL_PICTURE = 'a small picture of what you selected';

export function consentPoints(remoteImages: boolean): Point[] {
  return [
    {
      lead: 'Screenshots.',
      rest:
        ' When you press the shortcut or the Duel Lens icon, it takes a screenshot of the tab and cuts out the card you ' +
        "choose. It recognises the card on this computer and doesn't send the image anywhere, unless you use the AI check.",
    },
    {
      lead: 'History.',
      rest:
        ' It keeps a list of the cards you scan in this browser, with the address and title of each page' +
        (remoteImages ? '' : ` and ${SMALL_PICTURE}`) +
        ', so you can find them again. It keeps your last 300 scans, and you can clear them in the side panel.',
    },
    remoteImages
      ? {
          lead: 'Card data and pictures.',
          rest: ' It downloads them from YGOPRODeck, which can see your IP address and which card pictures your browser asks for.',
        }
      : {
          lead: 'Card data.',
          rest:
            ' It downloads card updates from YGOPRODeck, which can see your IP address. The picture it shows beside a card ' +
            'is the one you selected, not one from the internet.',
        },
    {
      lead: 'AI check (off).',
      rest:
        ' If you turn it on later in Options, the image of a card you select and up to 5 card names go to Anthropic with ' +
        'your own API key, only when you press Ask AI.',
    },
  ];
}

/** §4, "On this computer" (the welcome page). */
export function onThisComputer(remoteImages: boolean): Point[] {
  return [
    {
      lead: 'Recognising cards.',
      rest:
        ' The screenshot, the card you select and the matching stay on this computer: Duel Lens runs its own recognition ' +
        'models in your browser.',
    },
    {
      lead: 'Your history and settings',
      rest:
        ', including an API key if you add one, stay in this browser. The history keeps your last 300 scans, with the ' +
        `address of the page each came from${remoteImages ? '' : ` and ${SMALL_PICTURE}`}, until you clear it in the side panel.`,
    },
  ];
}

/** §4, "Online" (the welcome page). "Options" links to the Options page there. */
export function online(remoteImages: boolean): Point[] {
  return [
    remoteImages
      ? {
          lead: 'Card data and pictures',
          rest:
            ` come from ${YGOPRODECK_LINK}. Duel Lens checks for new cards once a week, downloads a card's picture the ` +
            "first time it shows it, and downloads new cards' artwork so it can recognise them too. These requests carry " +
            'nothing from your screen, but YGOPRODeck can see which card pictures your browser asks for.',
        }
      : {
          lead: 'Card data',
          rest:
            ` comes from ${YGOPRODECK_LINK}. Duel Lens checks for new cards once a week. These requests carry nothing ` +
            'from your screen, but YGOPRODeck can see your IP address. Duel Lens downloads no card pictures: the picture ' +
            'beside a card is the one you selected.',
        },
    {
      lead: 'The AI check',
      rest:
        ', only if you turn it on in [Options](options.html): when you press Ask AI on an unsure match, the image of the ' +
        "card you selected and the names of up to 5 likely matches go to Anthropic, with your own API key. It's off by default.",
    },
    { lead: 'Nothing else.', rest: ' Duel Lens has no server of its own, no account and no analytics.' },
  ];
}
