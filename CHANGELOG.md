# Changelog

## next (unreleased)

### New

- **Live: cards as they appear.** Press **Alt+Shift+L** (Mac: ⌥⇧L), use **Start Live** in the toolbar icon's
  right-click menu, press **L** or the **Live** button in scan mode, or press **Start Live** in the side panel.
  While a video plays, Duel Lens follows its cards and lists the ones it is sure of in the side panel's **Live**
  tab; a **LIVE** label shows on the video. Click a row to see the card in the panel and over the video. The list
  lasts until the tab closes and is not your scan history. Options → **Live** sets the effort (Balanced, or Light)
  and the label. While Live is on, Duel Lens reads the playing video's frames continuously, on your computer; they
  stay in memory and are dropped after each frame, and nothing is sent anywhere. No new permission. **Wrong card?**
  and **Report issue** are not in a Live row yet.
- **Privacy policy and welcome page:** a Live paragraph in section 1, and a sentence in the first-run step in all
  nine languages. The policy's effective date will change at release.

## 0.9.4 (unreleased)

### New

- **Find a card by name**, no scan needed: the search box at the top of the side panel finds any card from the
  card list on your computer (nothing goes online while you type). **Alt+Shift+F** (Mac: ⌥⇧F) and
  **Find a card by name…** in the toolbar icon's right-click menu open it.
- **Find card** while scanning: the button on the bar, or **/**, opens a search under the bar, and the card you
  pick shows in the popover, marked "Found by name". When a scan matches nothing, the popover offers
  **Find card** too, and saves your pick to the history as the right answer.
- **Report issue**: a coral button in the popover of a wrong, unsure or unmatched card. It lists what will be
  sent first (the card's picture, the cards shown, the video's link and time, your comment, versions), and
  nothing goes before **Send report**. The report becomes a public issue on GitHub, with no account needed. In
  Firefox, turn on **Allow card reports** in Options → **Card reports** first.
- **Show card details** has a third choice: **Full details on hover** shows the whole card, kept out of your
  history until you click. **Quick preview on hover** (the default) and **Click** stay.
- **"Duel Lens … is out."**: a copy installed by hand from a GitHub zip asks GitHub once a day for the latest
  version number (nothing about you goes with it) and says so in the side panel and Options → **Updates**, with
  how to update. You can turn it off there. Store copies never ask: the store updates them.
- **More "Not sure" answers**: when nothing matches well enough, Duel Lens offers its closest cards a little
  sooner. In tests, 16 more real cards got a list, always with the right card first, instead of "Couldn't read
  this card".

### Better

- **Faster on slower computers**: on a simulated low-end PC, scans took about half the time, and the first
  outlines after installing came in about 4.8 s instead of 8.1 s. The engine frees its memory after 15 minutes
  without a scan.
- **Read the whole board**: the side panel's **Board** view is now one list of cards. The Near/Far player split
  is gone: it was often wrong.
- **Typing in Duel Lens's boxes** (**Wrong card?**, **Find card**, a report's comment): Space, K, F and the
  arrows no longer reach YouTube or Duel Lens's own shortcuts, **Tab** stays inside Duel Lens, and **Esc**
  closes the open panel, then the card.
- **Welcome page**: new tips for finding a card by name and for a wrong card (**Wrong card?**, **Report issue**).
- **New cards keep arriving in Firefox**: the weekly card-data check now survives browser restarts.
- **Card pictures from YGOPRODeck, more politely**: at most 4 downloads at once, one download per picture,
  retries that respect YGOPRODeck's "slow down", and no new tries for pictures that don't exist.
- **Privacy policy** (effective 30 October 2026): new sections on card reports and the update check. The
  welcome page's consent text now mentions card reports, in all 9 languages.

### For people who download from GitHub

- Each release zip is built by GitHub from its tag and signed with where it came from (build provenance).
  Check a download with `gh attestation verify duel-lens-<version>.zip -R mathulbrich/duel-lens`.
- A release's files can't be changed after it's published (release immutability).

Earlier versions: see https://github.com/mathulbrich/duel-lens/releases.
