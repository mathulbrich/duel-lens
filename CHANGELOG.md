# Changelog

## 0.10.3

### Better

- **A smaller card box.** The card's facts are drawn the way the card draws them: its attribute icon, a star with its
  Level or Rank, a Link monster's arrows as a small grid, then ATK and DEF. Only what decides whether you can play the
  card is in colour: its banlist status, with the marks players know (a circled 1 for Limited, a circled 2 for
  Semi-Limited, a crossed circle for Forbidden), and its Genesys points. The passcode, prices and links share one line,
  the S key sits on its button, "Report issue" is a flag icon, and a sure match no longer shows its match bar.
  A box opened by hovering a card, and Live check's box, show the card and its text only (pin it for the rest).
- **Fewer buttons.** "Copy text" and its C key are gone (C reaches the page again: YouTube's captions), and a "Not
  sure" box no longer offers to turn on the AI check (it is in Options).
- **See the card's picture bigger.** Click the picture in a card box to see it across the box, and click again to
  shrink it.
- **Smaller card text by default.** A new install shows card text Small (Options → Card text changes it).
- **The banlist around the picture.** A Limited card's picture has an orange frame with one card in its band, a
  Semi-Limited card's a yellow frame with two, and a Forbidden card's a red frame with the prohibition sign, for the
  banlist you chose in Options (the status still shows in words beside it).
- **Choose Duel Lens's language.** Options → Interface language sets the language of Duel Lens's own words, whatever
  the browser's, apart from the card text's language. The default is still the browser's.
- **The OCG banlist for OCG players.** A new install in a Japanese, Korean or Chinese browser shows the OCG banlist
  (Options → Banlist changes it); every other language starts on the TCG's.
- **Space presses a focused button.** In a card box, Space presses the button you reached with Tab; anywhere else Space
  does what it did before.

### Fixed

- **A pile shows the card put on it.** In Live check, pointing back at a card that another card was put on (a
  graveyard beside a moving hand) showed the old card's name. It now shows the new card.
- **Live check works on the next video.** After YouTube went to another video, Live check could stay on the old one
  and read nothing until it was switched off and on. It now follows the page to the new video.
- **Live check shows the banlist you chose.** Live check's card box showed the TCG banlist unless a scan had run on
  the page; it now shows the one chosen in Options, as a scan does.
- **Covered hand cards are read.** In Live check, a hand card that the next card covers and the picture's edge cuts (a
  duel simulator's hand) is now read from the part that shows, where Live named few of them before.

### Card data

- **New cards and Genesys points.** The card data is up to date (11 Nov 2026): 74 new cards, 48 cards now under their
  real passcodes, and the latest Genesys points (345 cards changed).

## 0.10.2

### Fixed

- **A Live check box no longer vanishes while you point at its card.** On slower computers, a card's box could close
  just after its card was read, and only came back once you moved off the card and onto it again.
- **A Live check box closes when you leave it for another frame.** Moving from the box into an ad or a chat on the page
  left the box open.

### Better

- **Pictures show a loading box too.** Rest the pointer on a card in a picture and its box opens while the card is
  read, as in videos.

## 0.10.1

### Better

- **Live check shows a card at once.** Rest the pointer on a card and its box opens straight away, with a loading state
  until the card is read.
- **"Not sure" in Live check too.** When Live check can't be sure of a card but reads the same card twice, its box
  shows that card marked "Not sure", as a scan does. Such a card is never added to the Live check list.
- **Faster at Light.** Light reads two cards at a time, the one under the pointer first, and speeds up while you move
  the pointer over the video. On a paused video, the card you point at is read at once (it could take several seconds
  in Firefox).
- **A card under a passing hand isn't given up on.** Live check keeps reading a card it already read once while
  something covers it.

## 0.10.0

### New

- **Live check: point at any card, anywhere.** The toolbar icon opens a popup: **Scan this page** (with its shortcut),
  the **Live check** switch, **Speed**, Cards found and Options. With Live check on (it asks once for access to every
  site), rest the pointer on a card in a video (playing or paused), a picture or an embedded player, and its box
  shows. In a video, the card under the pointer is read first and the rest ahead of you; cards cut off at the
  picture's edge (a hand) are read whole; the cards it is sure of are listed in the side panel's **Live check** tab.
  The box opens above or below the card, so the cards beside it in a hand stay free to point at. Alt+Shift+L and the
  icon's right-click menu turn it on or off.
- **A new name: Duel Lens – Card Reader.** It reads cards in videos, deck lists, pictures and any page.
- **Speed: Light, Balanced, Best.** Light, the default, reads with a new model half the size of the main one (13.3 MB)
  and about 3x faster, on the same card list, and finds the cards in a smaller look at the picture (about 2.4x
  faster), looking closer around the pointer for small cards. Best runs every check on each card. On a computer
  with a graphics card every Speed shows a hand's cards at once; without one, Light shows the first in about half a
  second, Balanced and Best in about 1.3 s (a simulated weak PC).
- **Starts sooner.** The models load when Live check is turned on and stay loaded while it is on; until they are
  ready, the label on the video says **getting ready** with a progress bar.
- **New cards show sooner.** After a seek or a scene change the picture is searched at once, the card's box shows on
  its first sure read, and the card under the pointer goes first. A frame's cards are found and read in one go.
- **Card text is easier to read.** No scroll bar inside the card box's text any more, a wider box, and each numbered
  effect on its own line. Options → **Card text** sets the text size and the box width, with a preview.
- **Privacy policy and welcome page:** Live check's paragraph (videos, pictures, the tab screenshot it takes when a
  picture can't be read directly) and the first-run sentence, in all nine languages. The policy is effective
  7 November 2026.

## 0.9.4

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
