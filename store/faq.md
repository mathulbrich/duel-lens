# Duel Lens: questions and troubleshooting

<!-- Maintainers: user-facing FAQ for the release (store support page, repo, or a page linked from the
listing's Support URL). Written 2026-09-29 against the 0.9.0 code, and updated the same day for the store
build (npm run release): the pop-up and side panel show the matched card's official picture, downloaded
from YGOPRODeck and cached; new cards' artwork is downloaded for the self-updating index; a consent step
comes before the first scan; no DRAW2, so no "may not be a card face" message. Every message quoted below
is the UI's own text (src/content/app.tsx MESSAGES, src/content/popover.tsx COPY, src/background/scan.ts,
src/background/router.ts, src/background/ai.ts, src/welcome/copy.ts, src/options/app.tsx). If the crop
build is ever shipped instead (--no-remote-images, a one-flag rollback), swap back in the text-only
answers: the popover shows the user's own crop, no "card images" or image-cache mentions under Storage,
and no `images.ygoprodeck.com` under Privacy or "Does Duel Lens need access to websites?". Replace
mathulbrich@gmail.com and https://gist.github.com/mathulbrich/a72fdebc8363a86bd16679ba1cbbea4e before publishing. The zip ships click to scan since A4 (our
card detector is in every build): "How do I scan a card?" and "What are the gold outlines?" describe it.
Updated 2026-09-30 for the next release: scan mode stays open after a read (ux1-stay-open-brief.md), the
hover preview and Options → "Show card details" (ux2-hover-brief.md), "Keep in side panel" on S with K
and Space resuming the video (the lead's ruling), a click reading the top card of a stack
(click-stack-report.md) and the 267 alternate artworks YGOPRODeck lacks (THIRD_PARTY_NOTICES.md §2.3).
Re-check the preview's and the bar's wording against the landed build (ux-core-report.md).
Updated 2026-10-30 for 0.9.4 (release/0.9.4-features.md): find a card by name, Report issue (Card reports),
the lower "Not sure" floor, the "Duel Lens X is out" notice for manual installs, verifying a GitHub download,
and the interface's 9 languages. -->

Duel Lens reads Yu-Gi-Oh! cards in duel videos: press a shortcut, point at a card for a quick look or click
it (or draw a box around it), and its name and text appear right on the page, next to its official
picture.

- [Using it](#using-it)
- [The shortcut doesn't work](#the-shortcut-doesnt-work)
- ["Couldn't match this" and other results](#couldnt-match-this-and-other-results)
- [Card reports](#card-reports)
- [Messages and what to do](#messages-and-what-to-do)
- [The AI check](#the-ai-check)
- [Privacy](#privacy)
- [Where it works](#where-it-works)
- [Offline](#offline)
- [Speed, memory and storage](#speed-memory-and-storage)
- [Updates and downloads from GitHub](#updates-and-downloads-from-github)
- [Everything else](#everything-else)

---

## Using it

**How do I scan a card?**
1. **The first time only:** Duel Lens's welcome page opens when you install it. Read what Duel Lens
   handles in "Before your first scan" and press **Agree and start**.
2. Press **Alt+Shift+Y** (on a Mac, **Option+Shift+Y**), or click the Duel Lens button in the toolbar.
   The frame freezes, and after a moment ("Finding cards…") every face-up card on it gets a thin gold
   outline. A small bar at the top says how many.
3. Point at a card for a quick preview: its name, type and ATK/DEF. Click it to read it in full. For a
   card without an outline, drag a box around it instead: the whole card works, and so does just its
   artwork.
4. The card appears in a popover beside it: its name, type and full text, next to its official
   picture.
5. Click another card to read that one: Duel Lens stays open until you leave (see below).

**What are the gold outlines?**
When you press the shortcut, Duel Lens looks for the cards on the frozen frame ("Finding cards…") and
outlines each face-up one. Point at a card to light it up (and, after a moment, see its preview) and click
to read it; Tab or the arrow keys step through the cards and Enter reads the one in focus. A card without
an outline can still be read by dragging a box around it. Face-down cards, sleeves and deck piles get no
outline: there's nothing on them to read.

The video pauses while Duel Lens is open — the frozen frame is only a picture of the moment you pressed
the shortcut — and plays again when you leave. (A video you had already paused stays paused.)

**What's the small preview when I point at a card?**
When the pointer rests on an outlined card for a moment, or the keyboard focus moves to one, a small
preview shows its name, its type and ATK/DEF, with its banlist status and Genesys points. It's for a quick
look: click the card for its full text and picture. When Duel Lens isn't sure, the preview says "Not
sure:" with its best guess, "Low match: click for options" or "No match: click to try". **Esc** hides it.
You can move the pointer onto it to read it, and a click on it opens the card.

What shows on hover isn't saved to your history, doesn't show in the side panel and never uses the AI
check: only a click does. In Options, **Show card details** offers **Full details on hover** (the whole
card) or **Click** (nothing until you click); the default is **Quick preview on hover**.

**Duel Lens stays open after I read a card. How do I leave?**
That's on purpose: you can read one card after another without pressing the shortcut again. To leave:
- **Esc**. If a card is open, the first Esc closes it and the outlines stay; press it again to leave.
- The **✕** on the bar at the top.
- The shortcut (or the toolbar button) again.
- **Space or K resumes the video**, leaving Duel Lens at the same time.
- A right-click on the frozen frame.

Resizing the window or switching fullscreen leaves too, since the frozen frame would no longer match the
page. A click on an empty part of the frozen frame only closes the card you're reading.

**I pressed the shortcut and the welcome page opened instead.**
Duel Lens asks for your OK before its first scan, and until you give it, the shortcut and the toolbar
button only open that step ("Duel Lens needs your OK before its first scan."). Nothing is captured from
the page before you agree. Press **Agree and start**, go back to your video and press the shortcut
again. **Not now** closes the page, and scans stay off. Options → About shows when you agreed.

**Where does the card's picture come from?**
Duel Lens downloads the card's official picture from YGOPRODeck the first time it shows it to you, and
keeps the latest 1,500 pictures so it isn't downloaded again; older ones are removed automatically.

**What can I do in the popover?**

| Key | Action |
|---|---|
| **←** / **→** | Show the other close matches |
| **C** | Copy the card's text |
| **S** | Keep the card in the side panel |
| **Esc** | Close the card; the outlines stay (a click on an empty part of the frozen frame closes it too) |
| **Space** or **K** | Leave Duel Lens and resume the video |

While Duel Lens is open, these keys go to Duel Lens, not to the page, so YouTube won't turn on captions
or skip under it; Space and K, YouTube's own play keys, leave Duel Lens and resume the video.

**What is the side panel?**
Press **Alt+Shift+U**, or **S** in the popover. The panel shows the last card in full, with its official
picture, and the list of cards you scanned. While it's open, each card you click shows there too. For a
scan from YouTube, the time shown (like 4:36 or 1:02:15) is itself a link back to that moment in the
video. "Clear history" empties the list. At its top, a box finds any card by name (below).

**Can I look up a card by name, without scanning it?**
Yes:
- **In the side panel,** type in the **Find a card by name** box at the top. From two letters on, it
  lists the matching cards, each with its type. **↓** moves to the matches, **Enter** opens one in full,
  with its picture, and **Esc** goes back.
- **Alt+Shift+F** (on a Mac, **Option+Shift+F**) opens the side panel on that box. So does
  **Find a card by name…** when you right-click the Duel Lens button in the toolbar.
- **While scanning,** press **/** or **Find card** on the bar: a search opens under the bar (above it, when
  the bar is at the bottom), and the card you pick shows in the popover, marked "Found by name".
- **When a scan finds nothing,** the popover offers **Find card**: the card you pick shows, and is saved
  to your history as the right answer for that scan.

The matches come from the card list on your computer, so nothing goes online while you type (a card's
picture is downloaded the first time it's shown). A card you look up in the side panel or from the bar
isn't added to your history.

**I don't see the Duel Lens button.**
Click the puzzle-piece icon in Chrome's toolbar and pin Duel Lens.

---

## The shortcut doesn't work

1. **Did the welcome page open?** Then Duel Lens is waiting for your OK: see
   [Using it](#using-it).
2. **Check what it is set to.** Open `chrome://extensions/shortcuts` (type it in the address bar), or
   use **Change shortcuts** in Duel Lens's Options. Find Duel Lens, "Scan a card on this page".
3. **"Not set"?** Another extension already had Alt+Shift+Y when Duel Lens was installed. Chrome
   doesn't take a shortcut from one extension to give it to another, so Duel Lens's stays empty. Click
   the pencil and press a combination you like, for example Ctrl+Shift+Y (Windows, Linux) or
   Command+Shift+Y (Mac).
4. **The shortcut is set but nothing happens.** Something outside Chrome may use the same keys:
   - **Windows:** Alt+Shift is also Windows' default shortcut for switching keyboard layouts when you
     have more than one installed. If your layout changes when you press it, or the scan doesn't start,
     choose another shortcut for Duel Lens (or change Windows' language hotkeys in its keyboard
     settings).
   - **Linux:** some desktops use Alt+Shift combinations for their own shortcuts or layout switching.
   - **Mac:** "Alt" is the Option key. The shortcut shows as ⌥⇧Y.
   - Apps that capture keys globally (screen recorders, overlays, launchers) can take it first.
5. **It works on some pages but not others.** Chrome doesn't let extensions read its own pages
   (`chrome://…`), the Chrome Web Store, the New Tab page or other extensions' pages. There, the Duel Lens
   button shows a **!** and its tooltip says "Duel Lens can't read this page".
6. **"Duel Lens was updated or restarted. Reload the page to scan again."** After Duel Lens updates or
   you reload it, pages that were already open need a reload.
7. **Local files** (`file://`): open `chrome://extensions`, click **Details** under Duel Lens and turn on
   **Allow access to file URLs**.
8. **Incognito:** extensions are off in Incognito unless you turn on **Allow in Incognito** in the same
   Details page.

The toolbar button always does the same as the scan shortcut, so you can use it while you sort out the
keys.

---

## "Couldn't match this" and other results

**"Couldn't match this. Frame the whole card, or just its artwork."**
Duel Lens found nothing close enough to show. Try:
- **Box the card more tightly,** or just its artwork. Duel Lens adds a small margin itself. A box that
  takes in half the playmat, or cuts the artwork, makes matching harder.
- **Pause on a clear frame.** Hands moving, the camera panning and motion blur all hurt.
- **Raise the video quality.** 720p or higher works best. When the match is unsure on a video of 480p or
  lower, Duel Lens says "Raise the video quality for a better match". On YouTube, use the gear icon →
  Quality.
- **Wait for the glare to pass.** Foil and sleeve reflections can hide the artwork. A frame or two later
  often reads fine.
- **Make the card bigger, on pages that aren't a video.** On most video sites Duel Lens reads the video's
  own frame, so the player's size doesn't matter, only the stream's quality. On pictures, and on players
  it can't read directly, it uses a screenshot, and there a bigger card (theater mode, fullscreen, browser
  zoom) helps.

A sleeved deck, an art sleeve or artwork printed on the playmat isn't a card face, so it usually ends
here too, or as "Not sure".

Know which card it is? Press **Find card** in the popover and pick it by name: it shows, and is saved to
your history as the right answer. To help Duel Lens read it next time, press **Report issue** (see
[Card reports](#card-reports)).

**"Not sure" with a percentage, and "Could also be" cards.**
The match wasn't clear enough to call. The top guess is shown, marked "Not sure", with the next closest
cards underneath. Click the right one, or step through them with ← and →. The percentage is how similar
the artwork looks, not a probability. If you've turned on the AI check, **Ask AI** is there too.

**I see "Not sure" lists where I used to see "Couldn't read this card".**
That's on purpose. Since 0.9.4, when nothing matches well enough to call, Duel Lens offers its closest
cards from a slightly lower score: "Low match: could be one of these.", with its best guess marked "Not
sure". In our tests on real duel videos, 16 more cards got a list this way instead of "Couldn't read this
card", each with the right card first. Treat the list as hints: click the right card, or press
**Report issue** if it isn't there.

**What about cards cut off at the edge, stacked, or covered by a hand?**
If a card runs off the edge of the picture and the normal match finds nothing, Duel Lens tries once more
to complete it as a whole card. At best that's a "Not sure" guess with the closest cards listed — never
a confident match. If it still can't tell, it says "Part of this card is outside the picture. Try when
it's fully in view, or box just its artwork."

In a pile of overlapping cards, a click on the top card reads it; the cards under it usually get no
outline. A card partly covered by a hand or another card doesn't get the cut-off cards' second try: you
get at best "Not sure" or its closest guesses, marked "Low match", and under another card, that guess can
be the card on top. Wait for a clearer frame, or box just its visible artwork.

**What does "Low match" mean?**
The match is below what Duel Lens calls "Not sure", but it can see there's a card there: you clicked its
outline, or your box holds one. So it shows its closest guesses instead of nothing. Often the right card
is among them; treat them as hints, not answers. Online duel simulators that draw a pile count over the
top card, like DuelingBook's "1", get a second try with the number painted out.

**"Face-down card: nothing to read yet."**
It's the back of a card. Scan it again when it's flipped.

**The popover shows the wrong card.**
Check the chips under "Not it?" or "Could also be", or press → to step through them. Picking one also
fixes that scan in your history. Not there? **Wrong card?** finds the right one by name, and
**Report issue** tells the Duel Lens team (see [Card reports](#card-reports)).

**A brand-new card isn't found.**
Duel Lens recognises a card by its artwork. It downloads new cards' artwork on its own — after you
install it, when you start Chrome (at most once a day), after the weekly card-data check finds new
cards, and with **Update now** in Options — and turns each one into a fingerprint on your computer, so
most new cards are recognised within about a day or a week of release, without waiting for a Duel Lens
update. Card text works the same way: Duel Lens checks for updates once a week, and **Check for updates
now** in Options checks right away. Both need an internet connection.

**Cards Duel Lens can't identify:** cards that aren't in YGOPRODeck's TCG/OCG card database (anime-only
cards, custom cards, proxies), Skill cards from Speed Duel, and some printings whose artwork isn't in that
database. Card names and text are in English.

**Does it know alternate artworks?**
Yes, the ones on YGOPRODeck, and also 267 official alternate artworks printed in the TCG that YGOPRODeck
has no picture of yet (such as Ash Blossom & Joyous Spring's third). For those, the popover shows the
card's usual picture. Artworks printed only in the OCG, or newer than Duel Lens's list, may not be
recognised until YGOPRODeck has them.

---

## Card reports

**How do I report a card Duel Lens got wrong, or couldn't read?**
Press **Report issue**, the coral button in the popover of a wrong, unsure or unmatched card. Duel Lens
first lists everything the report holds; you can add the right card (find it by name inside the report)
and a comment. Nothing is sent until you press **Send report**. Then you get the issue's number and a
**View on GitHub** link.

**What does a report send?**
- the card's picture, made smaller;
- the card Duel Lens showed and the other matches it offered;
- the right card, if you added it;
- the video's link and time (YouTube), or the page's address without the part after "?" or "#";
- your comment, if you wrote one (up to 500 characters);
- Duel Lens's version, your browser and your system.

Nothing else: no account, no analytics. A card you looked up by name has nothing read from the page, so it
has no **Report issue** button.

**Is it public? Do I need a GitHub account?**
Yes, it's public, and no, you don't need an account. The report becomes a public issue on
https://github.com/mathulbrich/duel-lens/issues, opened by the "Duel Lens Reports" app. Everything in it
is public, so don't write anything personal in the comment. Duel Lens's report service
(duel-lens-reports.mathulbrich.workers.dev, on Cloudflare) keeps the picture 90 days, for the issue, and
doesn't keep your IP address.

**In Firefox, the report says "Firefox needs your permission first: allow card reports in Options."**
Firefox asks your OK once before an add-on sends this kind of data. Open Duel Lens's Options, go to
**Card reports** and press **Allow card reports**, then send the report again. **Stop allowing card
reports** takes it back. Other browsers don't ask.

**"Too many reports right now." or "Today's reports are full."**
Each person can send 2 reports a minute, and there's a daily limit for all reports together. Wait a
minute, or try again tomorrow.

---

## Messages and what to do

| Message | What it means | What to do |
|---|---|---|
| The welcome page opens: "Duel Lens needs your OK before its first scan." | You pressed the shortcut or the button before agreeing | Read the points and press **Agree and start**, then scan again |
| **!** on the toolbar button, "Duel Lens can't read this page" | Chrome doesn't allow extensions on this page | Use it on a normal web page |
| "This video blocks screenshots" | The video is DRM-protected, so its frame is black to Duel Lens | Nothing to do on that site |
| "Couldn't read that part of the screen. Try again." | Cutting out your box failed | Scan again |
| "Duel Lens was updated or restarted. Reload the page to scan again." | The page still has the old version's code | Reload the page |
| "Duel Lens didn't answer. Try again." | The recognition engine didn't reply in time | Scan again; if it keeps happening, restart Chrome |
| "Duel Lens couldn't load its card matcher (…)" | The engine failed to start | Press **Open Options**; restart Chrome; reinstall if it persists and report it |
| "Card data isn't loaded. Open Options and check for updates." | The card database isn't ready | Options → **Check for updates now** |
| "Press Alt+Shift+U to open the side panel" | Chrome opens side panels only right after a key press or click, and this one came too late | Press Alt+Shift+U |
| "Copying is blocked here. Select the text instead." | The page doesn't allow copying | Select the text in the popover and copy it by hand |
| "Firefox needs your permission first: allow card reports in Options." | Firefox wants your OK before a card report is sent | Options → **Card reports** → **Allow card reports**, then send it again |
| "Couldn't reach the report service. Check your connection." | The report didn't go out | Check your connection and press **Send report** again |
| "Duel Lens … is out." (in the side panel or Options) | A newer version is on GitHub, and your copy was installed by hand | See [Updates and downloads from GitHub](#updates-and-downloads-from-github) |

---

## The AI check

**What is it?**
An optional second opinion for unsure matches. You press **Ask AI** and Anthropic's Claude looks at your
crop and names the card. It uses your own Anthropic API key, so Anthropic bills each request to your
account at its API prices.

**How do I turn it on?**
1. Get an API key in Anthropic's console (platform.claude.com, API keys).
2. Open Duel Lens's **Options**, turn on **Offer to ask Claude when a match is unsure**, and allow access
   to api.anthropic.com when Chrome asks.
3. Paste the key and press **Test**.

**When does it send something, and what?**
Only when you press **Ask AI** on an unsure popover (or **Test** in Options, which sends the word "ping").
It sends the crop of your box and up to five candidate card names, with your key, to api.anthropic.com.
Nothing else, and never on its own.

**What do "AI agrees", "AI says" and "AI isn't sure" mean?**
- "AI agrees": Claude named the card Duel Lens showed.
- "AI says …": it named another card from the database, and Duel Lens switched to it.
- "AI isn't sure: …": Claude wasn't confident either, so Duel Lens keeps its own result.
- "AI says "…", which isn't in the card data": the name didn't match a known card.

**Errors:** "Anthropic rejected the API key. Check it in Options." (wrong or revoked key); "Rate limited by
Anthropic. Try again in a moment."; "Could not reach the Anthropic API (network error)."

**How do I turn it off?** Turn off the switch in Options and delete the key from the field.

---

## Privacy

- **Before your first scan,** Duel Lens shows what it handles and asks you to agree. It takes no
  screenshot and records no history until you do.
- **On your computer:** recognition. The screenshot taken when you press the shortcut, the video frame and
  your crop are processed in the browser by Duel Lens's own models and aren't uploaded. The card database,
  your settings and your scan history are stored locally.
- **Your scan history** keeps, for each scan: the card, the page's address and title, the time, and the
  video time. It never leaves your computer. Only the cards you click or box are scans: a hover preview
  records nothing. "Clear history" in the side panel deletes it; uninstalling Duel Lens deletes everything
  it stored.
- **YGOPRODeck** is where the card data and card images come from: `db.ygoprodeck.com` for card text and
  `images.ygoprodeck.com` for pictures, downloaded once per card and cached on your computer. Duel Lens
  sends it nothing about you. Like any website, it sees your IP address, and which card pictures your
  browser asks for.
- **Anthropic** receives a crop and card names only when you use the AI check, as described above.
- **Card reports** go out only when you press **Report issue**, then **Send report**, and they become
  public issues on GitHub: see [Card reports](#card-reports) for what they hold.
- **A manual install** (from a GitHub zip) asks GitHub once a day for the number of the latest version.
  Nothing about you or your scans goes with it, and Options → **Updates** turns it off. A copy from a store
  never asks: the store updates it.
- **No account, no ads, no analytics.** Duel Lens's only server is its report service, which receives a card report only when you press Report issue and then Send report.
- Your API key is stored where web pages and Duel Lens's in-page code can't read it.

The full privacy policy: https://gist.github.com/mathulbrich/a72fdebc8363a86bd16679ba1cbbea4e. Duel Lens also carries a copy: Options → About →
Privacy policy.

**Does Duel Lens need access to websites?**
One: `images.ygoprodeck.com`, to download and cache the official card pictures it shows (that server
doesn't let pages read it directly, so Chrome asks for this when you install Duel Lens). Otherwise it
sees a page only when you press the shortcut or click its button, and only the page you're on: it has no
standing access to any page you browse. The one other site it can ask for is api.anthropic.com, and only
when you turn on the AI check.

---

## Where it works

- **YouTube:** tournament streams, VODs and duel videos, in normal, theater and fullscreen views. This is
  where Duel Lens is tested most.
- **Other video sites:** generally, when the player shows the video in the page. Not every player has
  been tested.
- **Web pages with card images:** deck lists, articles, screenshots.
- **Not:** DRM-protected players ("This video blocks screenshots"); Chrome's own pages, the Chrome Web
  Store, the New Tab page and other extensions' pages; local files unless you allow file access; Incognito
  unless you allow it.
- **Picture-in-picture:** return the video to the page first; Duel Lens reads the tab, not the floating
  window.

---

## Offline

- **Recognition works offline.** The models and the index of card artwork are part of Duel Lens.
- **Card text works offline,** from the card database stored on your computer (a snapshot comes with
  Duel Lens and is refreshed weekly while you're online).
- **A card's picture** is downloaded the first time you see that card, then cached for next time. A card you haven't seen before needs a connection to load its picture.
- **Finding a card by name works offline:** the matches come from the card list on your computer.
- **Card-data updates** need a connection. They catch up at the next weekly check, or right away with
  **Check for updates now** in Options. A brand-new card's artwork downloads the same way (see "A
  brand-new card isn't found" above), usually within a day or a week of release, without waiting for a
  Duel Lens update.
- **The AI check** and **card reports** need a connection.

---

## Speed, memory and storage

- **The first scan** after Chrome starts loads the recognition engine and takes a moment. After that, a
  scan usually takes under a second. A preview shows a moment after the pointer stops on a card, and a
  click on a card you've previewed opens its details at once.
- **Memory:** the engine uses a few hundred MB while it's loaded. It closes itself after 15 minutes
  without scans, and the next scan loads it again.
- **Disk:** about 62 MB for Duel Lens itself, plus the card database, the official card pictures it
  caches as you scan (the most recent 1,500; older ones are removed automatically), and your scan
  history (up to 300 scans).

---

## Updates and downloads from GitHub

**Does Duel Lens update itself?**
From the Chrome Web Store or Firefox Add-ons, yes: the store updates it. A manual install (a zip from
GitHub, loaded with **Load unpacked**) doesn't, but it tells you when a new version is out.

**What is "Duel Lens … is out."?**
Your copy was installed by hand, and GitHub has a newer version. Duel Lens asks GitHub once a day for the
latest version number (nothing about you or your scans goes with it) and says so in the side panel and in
Options → **Updates**, with a link to get it. To stop the notice, turn off **Tell me when a new version is
out** in Options → **Updates**. Store copies never ask.

**How do I update a manual install?**
1. Download the new `duel-lens-<version>.zip` from
   https://github.com/mathulbrich/duel-lens/releases/latest.
2. Unzip it **into the same folder** as before, replacing the old files. A new folder is a new extension to
   your browser: it starts without your history and settings.
3. Open `chrome://extensions` and click the reload icon (↻) on Duel Lens.

To switch to the store version instead, install it from the store, then remove the manual one (the two
don't share their history).

**How do I check that a zip from GitHub is genuine?**
Each release zip is built by GitHub from its version's tag and signed with where it came from (build
provenance). With the GitHub CLI (https://cli.github.com/), run:

```
gh attestation verify duel-lens-<version>.zip -R mathulbrich/duel-lens
```

The check fails if the zip was changed or wasn't built there. A release's files can't be changed after
it's published.

---

## Everything else

**Is Duel Lens made by Konami?**
No. Duel Lens is an unofficial, fan-made tool for the Yu-Gi-Oh! TRADING CARD GAME. It is not produced,
sponsored, endorsed or approved by, or affiliated with, Konami Digital Entertainment, Konami Group
Corporation or their affiliates, Studio Dice, Shueisha or TV Tokyo. Yu-Gi-Oh!, KONAMI and the names,
text and images of Yu-Gi-Oh! cards are trademarks and copyrights of their respective owners (© Studio
Dice/SHUEISHA, TV TOKYO, KONAMI). Card data comes from YGOPRODeck (ygoprodeck.com), which is not
affiliated with Duel Lens either.

**Does it work in other languages?**
The card text, yes: in Options → Card text language, pick French, German, Italian, Portuguese, Japanese or
Korean. Duel Lens downloads that language's card names and text once from YGOPRODeck (about 3 MB), keeps
them on your computer, and shows the English name under the translated one. A card without a translation
shows in English. Spanish and Chinese card text isn't available yet.

The interface (scan bar, popover, side panel, Options, welcome page) follows your browser's language:
English, French, German, Italian, Japanese, Korean, Brazilian Portuguese, Spanish or Simplified Chinese,
else English. The translations are machine-drafted and still await review by native speakers.

**Does it cost anything?**
No. The only possible cost is your own Anthropic usage if you turn on the AI check.

**Something's wrong or missing.**
A card read wrong, or not read at all? Press **Report issue** in its popover (see
[Card reports](#card-reports)). For anything else, tell us at
https://github.com/mathulbrich/duel-lens/issues (or mathulbrich@gmail.com). Mention the page (or video and
time), what you boxed, and what the popover said.

<!-- The click-to-scan answer that waited here is in "Using it" since A4 (the zip ships the card detector). -->
