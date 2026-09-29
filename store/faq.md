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
card detector is in every build): "How do I scan a card?" and "What are the gold outlines?" describe it. -->

Duel Lens reads Yu-Gi-Oh! cards in duel videos: press a shortcut, click a card (or draw a box around it),
and its name and text appear right on the page, next to its official picture.

- [Using it](#using-it)
- [The shortcut doesn't work](#the-shortcut-doesnt-work)
- ["Couldn't match this" and other results](#couldnt-match-this-and-other-results)
- [Messages and what to do](#messages-and-what-to-do)
- [The AI check](#the-ai-check)
- [Privacy](#privacy)
- [Where it works](#where-it-works)
- [Offline](#offline)
- [Speed, memory and storage](#speed-memory-and-storage)
- [Everything else](#everything-else)

---

## Using it

**How do I scan a card?**
1. **The first time only:** Duel Lens's welcome page opens when you install it. Read what Duel Lens
   handles in "Before your first scan" and press **Agree and start**.
2. Press **Alt+Shift+Y** (on a Mac, **Option+Shift+Y**), or click the Duel Lens button in the toolbar.
   The frame freezes, and after a moment ("Finding cards…") every face-up card on it gets a thin gold
   outline.
3. Click the card you want. For a card without an outline, drag a box around it instead: the whole card
   works, and so does just its artwork.
4. The card appears in a popover beside it: its name, type and full text, next to its official
   picture.

**What are the gold outlines?**
When you press the shortcut, Duel Lens looks for the cards on the frozen frame ("Finding cards…") and
outlines each face-up one. Point at a card to light it up and click to read it; Tab or the arrow keys step
through the cards and Enter reads the one in focus. A card without an outline can still be read by
dragging a box around it. Face-down cards, sleeves and deck piles get no outline: there's nothing on them
to read.

The video pauses while Duel Lens is open — the frozen frame is only a picture of the moment you pressed
the shortcut — and plays again when you close it. (A video you had already paused stays paused.) Press
**Esc** or right-click to cancel.

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
| **K** | Keep the card in the side panel |
| **Esc** | Close (a click outside the popover closes it too; on the video, a click only closes the popover) |

While the popover is open, these keys go to Duel Lens, not to the page, so YouTube won't pause, turn on
captions or skip.

**What is the side panel?**
Press **Alt+Shift+U**, or **K** in the popover. The panel shows the last card in full, with its official
picture, and the list of cards you scanned. For a scan from YouTube, the time shown (like 4:36 or
1:02:15) is itself a link back to that moment in the video. "Clear history" empties the list.

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

**"Not sure" with a percentage, and "Could also be" cards.**
The match wasn't clear enough to call. The top guess is shown, marked "Not sure", with the next closest
cards underneath. Click the right one, or step through them with ← and →. The percentage is how similar
the artwork looks, not a probability. If you've turned on the AI check, **Ask AI** is there too.

**What about cards cut off at the edge, or covered by a hand?**
If a card runs off the edge of the picture and the normal match finds nothing, Duel Lens tries once more
to complete it as a whole card. At best that's a "Not sure" guess with the closest cards listed — never
a confident match. If it still can't tell, it says "Part of this card is outside the picture. Try when
it's fully in view, or box just its artwork." A card covered by a hand or another card doesn't get this
second try. If Duel Lens can still see a card there, you get at best its closest guesses, marked "Low
match". Wait for a clearer frame, or box just its visible artwork.

**What does "Low match" mean?**
The match is below what Duel Lens calls "Not sure", but it can see there's a card there: you clicked its
outline, or your box holds one. So it shows its closest guesses instead of nothing. Often the right card
is among them; treat them as hints, not answers. Online duel simulators that draw a pile count over the
top card, like DuelingBook's "1", get a second try with the number painted out.

**"Face-down card: nothing to read yet."**
It's the back of a card. Scan it again when it's flipped.

**The popover shows the wrong card.**
Check the chips under "Not it?" or "Could also be", or press → to step through them. Picking one also
fixes that scan in your history.

**A brand-new card isn't found.**
Duel Lens recognises a card by its artwork. It downloads new cards' artwork on its own — after you
install it, when you start Chrome (at most once a day), after the weekly card-data check finds new
cards, and with **Update now** in Options — and turns each one into a fingerprint on your computer, so
most new cards are recognised within about a day or a week of release, without waiting for a Duel Lens
update. Card text works the same way: Duel Lens checks for updates once a week, and **Check for updates
now** in Options checks right away. Both need an internet connection.

**Cards Duel Lens can't identify:** cards that aren't in YGOPRODeck's TCG/OCG card database (anime-only
cards, custom cards, proxies), Skill cards from Speed Duel, and printings whose artwork isn't in that
database. Card names and text are in English.

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
  video time. It never leaves your computer. "Clear history" in the side panel deletes it; uninstalling
  Duel Lens deletes everything it stored.
- **YGOPRODeck** is where the card data and card images come from: `db.ygoprodeck.com` for card text and
  `images.ygoprodeck.com` for pictures, downloaded once per card and cached on your computer. Duel Lens
  sends it nothing about you. Like any website, it sees your IP address, and which card pictures your
  browser asks for.
- **Anthropic** receives a crop and card names only when you use the AI check, as described above.
- **No account, no ads, no analytics.** Duel Lens has no server of its own.
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
- **Card-data updates** need a connection. They catch up at the next weekly check, or right away with
  **Check for updates now** in Options. A brand-new card's artwork downloads the same way (see "A
  brand-new card isn't found" above), usually within a day or a week of release, without waiting for a
  Duel Lens update.
- **The AI check** needs a connection.

---

## Speed, memory and storage

- **The first scan** after Chrome starts loads the recognition engine and takes a moment. After that, a
  scan usually takes under a second.
- **Memory:** the engine uses a few hundred MB while it's loaded. It closes itself after 5 minutes
  without scans, and the next scan loads it again.
- **Disk:** about 62 MB for Duel Lens itself, plus the card database, the official card pictures it
  caches as you scan (the most recent 1,500; older ones are removed automatically), and your scan
  history (up to 300 scans).

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
The interface and the card text are English only for now.

**Does it cost anything?**
No. The only possible cost is your own Anthropic usage if you turn on the AI check.

**Something's wrong or missing.**
Tell us at mathulbrich@gmail.com. Mention the page (or video and time), what you boxed, and what the popover
said.

<!-- The click-to-scan answer that waited here is in "Using it" since A4 (the zip ships the card detector). -->
