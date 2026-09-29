# Disclaimers and legal wording

Draft, 2026-09-29. These are the exact texts to place in the store listing, the README, the welcome page and the Options page. Other workstreams place them; this file only supplies the words.

**How to copy them:**
- Copy the texts in the fenced blocks as they are.
- Where a text contains a link, the linked words are marked like `[YGOPRODeck](https://ygoprodeck.com/)`.
- `[CONTACT EMAIL]` and `[PRIVACY POLICY URL]` are placeholders for decisions D4 and D5 in [`legal-audit.md`](legal-audit.md).

**Why these words:** [`legal-audit.md`](legal-audit.md), sections 7 (Konami), 6 (YGOPRODeck) and 8 (Anthropic).

## Where each text goes

| # | Text | Where | Owner |
|---|---|---|---|
| 1 | Short disclaimer | Footer of every Duel Lens page: welcome, Options → About, and (suggested) the side panel. The `DISCLAIMER` constant in `src/welcome/links.tsx`. | Onboarding (O) |
| 2 | Full legal notice | README "Legal", the end of the store listing's description, and Options → About (it may be collapsed) | README owner, store kit (S), O |
| 3 | Store listing: summary, legal and privacy paragraphs | Chrome Web Store listing | S |
| 4a | **First-run consent (required by the store)** | Welcome page, before first use; the page overlay if someone scans before agreeing | O, background |
| 4 | "What stays on your computer" | Welcome page privacy section | O |
| 5 | AI check wording | Options → AI check | O |
| 6 | Accuracy notice | Options → About, the store listing, the README; optionally a tooltip in the popover | O, S |
| 7 | README "Legal" section | README | README owner |
| 8 | Attribution lines | Welcome and Options footers (already there), the side panel footer (suggested), the store listing | O, S |
| 9 | Naming and wording rules | Everyone who writes copy | All |

## 1. Short disclaimer (every page)

```text
Duel Lens is an unofficial fan tool, not affiliated with or endorsed by Konami.
```

- This replaces the current `DISCLAIMER` ("Duel Lens is not affiliated with or endorsed by Konami."). It still matches the welcome test's `/not affiliated with or endorsed by Konami/`. Keep "not" in lowercase: the test is case-sensitive.
- Don't shorten it to "Not affiliated with Konami." on its own: "unofficial" is what tells people it's a fan project.

## 2. Full legal notice

```text
Duel Lens is an unofficial, fan-made tool for the Yu-Gi-Oh! TRADING CARD GAME. It is not produced, sponsored, endorsed or approved by, or affiliated with, Konami Digital Entertainment, Konami Group Corporation or their affiliates, Studio Dice, Shueisha or TV Tokyo. Yu-Gi-Oh!, KONAMI and the names, text and images of Yu-Gi-Oh! cards are trademarks and copyrights of their respective owners (© Studio Dice/SHUEISHA, TV TOKYO, KONAMI). Card data and card images come from YGOPRODeck (ygoprodeck.com), which is not affiliated with Duel Lens either.
```

Why it's worded this way:
- **The owners.** Konami's own terms claim "YU-GI-OH!" and "KONAMI" as its trademarks. In the US, "YU-GI-OH!" is registered to Shueisha. "© Studio Dice/SHUEISHA, TV TOKYO, KONAMI" is the rights line on Konami's own product page.
- **No 4K Media.** YGOPRODeck's footer still names "4K Media Inc", which became Konami Cross Media NY in 2019. Naming Konami's companies directly avoids the outdated name.
- **"for the Yu-Gi-Oh! TRADING CARD GAME"** only says what the tool works with. It is never part of the product's name.

## 3. Chrome Web Store listing

### 3.1 Summary (the manifest `description`, at most 132 characters)

**The current text is fine. Keep it:**

```text
Identify trading cards in duel videos and streams: select a Yu-Gi-Oh! card on screen to read its text in place. Unofficial fan tool.
```

(132 characters)

If you ever need to change it, these alternatives stay within the limit:

```text
Select a Yu-Gi-Oh! card in any video, stream or image to read its text in place. Unofficial fan tool, not affiliated with Konami.
```

(129 characters)

```text
Unofficial fan tool: select a Yu-Gi-Oh! card in a video, stream or image to read its text in place. Recognition runs on your device.
```

(132 characters)

### 3.2 Legal paragraph (end of the detailed description)

```text
Unofficial fan tool. Duel Lens is not affiliated with, sponsored, endorsed or approved by Konami, Studio Dice, Shueisha or TV Tokyo. Yu-Gi-Oh! and the names, text and images of Yu-Gi-Oh! cards are trademarks and copyrights of their respective owners (© Studio Dice/SHUEISHA, TV TOKYO, KONAMI). Card data and images: YGOPRODeck (ygoprodeck.com). The optional AI check uses Anthropic's Claude with your own API key; Claude and Anthropic are trademarks of Anthropic, PBC, and Duel Lens is not affiliated with Anthropic.

Rights holders and questions: [CONTACT EMAIL]
```

### 3.3 Privacy paragraph (in the detailed description, before the legal paragraph)

```text
Privacy: Duel Lens recognises cards on your computer. Screenshots and the images you select stay in your browser. Card data and card pictures are downloaded from YGOPRODeck, which can see your IP address and which card pictures your browser asks for. The optional AI check is off by default: if you turn it on and press Ask AI, the image you selected and up to five card names are sent to Anthropic, using your own API key. No account, no analytics, no ads, no tracking. Privacy policy: [PRIVACY POLICY URL]
```

If decisions D2/D3 change where images or data come from, change the second and third sentences to match. For example, "Card data comes from YGOPRODeck, through Duel Lens's own update server", or drop "and card pictures" for a text-only build. See the privacy policy's Appendix C.

### 3.4 In the listing, don't

- **Name:** don't put "Yu-Gi-Oh!", "Konami", "Neuron", "Master Duel" or "Duel Links" in the extension's name or title, the developer or publisher name, or the promo tile's headline.
- **Logos:** don't use the Yu-Gi-Oh! logo, the Konami logo, the card back, or event logos (YCS, World Championship, WCQ) in the icon, screenshots or promo images.
- **Footage:** don't use frames from Konami's broadcasts. Use your own footage of your own cards (audit §7.7).
- **Claims:** don't call it "official", "licensed" or "approved", and don't compare it with Google Lens or Konami's NEURON app.
- **Keywords:** don't list card names as keywords, and don't repeat "Yu-Gi-Oh!" over and over. The store's keyword-spam rule starts at more than 5 repetitions of the same keyword.

## 4a. First-run consent (required by the Chrome Web Store)

The store requires two things:
- a disclosure *inside the extension*;
- the user's "specific action clearly agreeing to the disclosure before collecting or handling user data".

The store listing doesn't count, and "by using you agree" doesn't count. Since the 2026-07-01 policy update, this covers *all* data handling, even when it's closely related to the feature (`legal-audit.md` §9).

Show this on the welcome page, and in the page overlay if someone scans before agreeing. Don't take the screenshot or record history until the user presses **Agree and start**.

**Heading**

```text
Before your first scan
```

**Body**

```text
Duel Lens needs your OK to handle this data:
```

```text
Screenshots. When you press the shortcut or the Duel Lens icon, it takes a screenshot of the tab and cuts out the card you choose. It recognises the card on this computer and doesn't send the image anywhere, unless you use the AI check.
```

```text
History. It keeps a list of the cards you scan in this browser, with the address and title of each page, so you can find them again. It keeps your last 300 scans, and you can clear them in the side panel.
```

```text
Card data and pictures. It downloads them from YGOPRODeck, which can see your IP address and which card pictures your browser asks for.
```

```text
AI check (off). If you turn it on later in Options, the image of a card you select and up to 5 card names go to Anthropic with your own API key, only when you press Ask AI.
```

**Optional switch** (decision D13), checked by default:

```text
Remember the page for each scan (address and title)
```

**Buttons**

- Primary:

  ```text
  Agree and start
  ```

- Secondary (closes without agreeing; scans stay off):

  ```text
  Not now
  ```

**Link under the buttons**

```text
Privacy policy
```

**When someone scans before agreeing** (the overlay heading):

```text
Duel Lens needs your OK before its first scan.
```

Then the same body text and buttons.

**When a later version handles data in a new way:** ask again, with a heading that says what changed. For example:

```text
Duel Lens has changed how it gets card pictures. Please review and agree to continue.
```

## 4. "What stays on your computer, and what goes online" (welcome page)

This replaces the current copy in `src/welcome/app.tsx`. The only real change is the YGOPRODeck item. The current text says "None of this sends anything from your screen", which is true but leaves out that the image requests reveal which cards you looked at.

**On this computer**

```text
Recognising cards. The screenshot, the card you select and the matching stay on this computer: Duel Lens runs its own recognition models in your browser.
```

```text
Your history and settings, including an API key if you add one, stay in this browser. The history keeps your last 300 scans, with the address of the page each came from, until you clear it in the side panel.
```

**Online**

```text
Card data and pictures come from [YGOPRODeck](https://ygoprodeck.com/). Duel Lens checks for new cards once a week, downloads a card's picture the first time it shows it, and downloads new cards' artwork so it can recognise them too. These requests carry nothing from your screen, but YGOPRODeck can see which card pictures your browser asks for.
```

```text
The AI check, only if you turn it on in Options: when you press Ask AI on an unsure match, the image of the card you selected and the names of up to 5 likely matches go to Anthropic, with your own API key. It's off by default.
```

```text
Nothing else. Duel Lens has no server of its own, no account and no analytics.
```

**Footer**

Short disclaimer (§1), then:

```text
Card data and images from [YGOPRODeck](https://ygoprodeck.com/).
```

Then the links: Options · Privacy policy · Licences · Version.

## 5. AI check (Options)

**Intro**

```text
Optional, and off until you turn it on. When Duel Lens isn't sure about a card, an Ask AI button lets you ask Claude, Anthropic's AI, for a second opinion.
```

**What it sends**

```text
What it sends: only when you press Ask AI, the image of the card you selected (with a small margin around it) and the names of up to 5 likely matches, straight from your browser to Anthropic. Nothing else from the page.
```

**What it costs**

```text
What it costs: it uses your own Anthropic API key, so Anthropic bills your account at its current API prices ([Anthropic's prices](https://platform.claude.com/docs/en/about-claude/pricing)). Duel Lens itself is free and never sees your bill.
```

Keep any per-check cent estimate approximate ("about…"), next to the price link. Prices change.

**Your key**

```text
Your key is stored in this browser without encryption. Only Duel Lens's own pages can read it, and it is sent only to Anthropic. Use a key made just for Duel Lens, with a spending limit, and remove it here when you stop using the AI check.
```

**Anthropic's terms**

```text
Your requests go to Anthropic under your own agreement with Anthropic and its privacy policy.
```

Link "its privacy policy" to <https://www.anthropic.com/legal/privacy>.

**Button and message**

- Button label:

  ```text
  Remove key
  ```

- Message after removing the key:

  ```text
  Key removed. The AI check is off.
  ```

## 6. Accuracy notice

**Full** (Options → About, the store listing, the README):

```text
Duel Lens can misidentify cards, and its card data can be out of date, including banlist status. Check the card itself or the official Yu-Gi-Oh! card database before relying on it in a game, a trade or a tournament.
```

**Short** (optional, for example a tooltip on the popover's "Not sure" state):

```text
Check the card itself before you rely on this.
```

## 7. README "Legal" section

Paste this as the README's last section. It replaces the current closing line and the DRAW2 items under "Before publishing". Fill in `[LICENCE]` after decision D1.

```markdown
## Legal

Duel Lens is an unofficial, fan-made tool for the Yu-Gi-Oh! TRADING CARD GAME. It is not produced, sponsored, endorsed or approved by, or affiliated with, Konami Digital Entertainment, Konami Group Corporation or their affiliates, Studio Dice, Shueisha or TV Tokyo. Yu-Gi-Oh!, KONAMI and the names, text and images of Yu-Gi-Oh! cards are trademarks and copyrights of their respective owners (© Studio Dice/SHUEISHA, TV TOKYO, KONAMI).

- **Card data and images** come from [YGOPRODeck](https://ygoprodeck.com/), which is not affiliated with Duel Lens. Thanks to YGOPRODeck for the Yu-Gi-Oh! API.
- **Licence.** Duel Lens's own code and its fine-tuned model are licensed under [LICENCE] (see `LICENSE`). The licence doesn't cover:
  - Konami's cards, card names, card text or card images, including the card data in `extension/data/cards.json`, which is compiled by YGOPRODeck;
  - the rights of Konami and its licensors in anything derived from card artwork, such as the artwork index;
  - the fonts, which are under the SIL Open Font License 1.1 (see `extension/fonts/OFL.txt`);
  - third-party code and models. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Privacy.** Recognition runs on your computer. Card data and images are downloaded from YGOPRODeck, and the optional AI check sends the selected image to Anthropic with your own key. See the [privacy policy]([PRIVACY POLICY URL]).
- **Accuracy.** Duel Lens can misidentify cards, and its card data can be out of date, including banlist status. Check the card itself or the official Yu-Gi-Oh! card database before relying on it.
- **Contact.** Rights holders and questions: [CONTACT EMAIL].
```

## 8. Attribution lines

| Where | Text |
|---|---|
| Welcome and Options footers (already present) | `Card data and images from [YGOPRODeck](https://ygoprodeck.com/).` |
| Side panel footer (suggested; the panel shows YGOPRODeck's images) | `Card data and images: [YGOPRODeck](https://ygoprodeck.com/) · Unofficial fan tool, not affiliated with or endorsed by Konami.` |
| Store listing | Covered by §3.2. |
| Anthropic (Options → AI check, and the listing) | Name "Claude" and "Anthropic" in plain text only, without logos. The listing's §3.2 sentence carries the trademark line. |
| Fonts, libraries and the model | No UI text needed. `THIRD_PARTY_NOTICES` in the package, and the Options "Licences" link to it, cover them. |

If you switch to a text-only build (D2 c), change "Card data and images" to "Card data".

## 9. Naming and wording rules

| Do | Don't |
|---|---|
| "Duel Lens" as the name | Put "Yu-Gi-Oh!", "Konami", "NEURON", "Master Duel" or "Duel Links" in the name, icon, developer name or promo headline |
| "for Yu-Gi-Oh! cards", "for the Yu-Gi-Oh! TRADING CARD GAME" (describes compatibility) | "Official", "licensed", "approved", "by Konami", "the Yu-Gi-Oh! card reader" |
| "Unofficial fan tool" next to any mention of Yu-Gi-Oh! in the listing | Imply a partnership with YGOPRODeck or Anthropic |
| "Recognition runs on your computer" | "Everything runs on your computer" or "Nothing leaves your computer": card data and images are downloaded, and the AI check sends images (audit §10) |
| "can misidentify cards"; "check the card itself" | "100% accurate", "never wrong", "works on every video" |
| The Duel Lens icon (a card outline under a magnifier) | Card backs, Millennium symbols, the Yu-Gi-Oh! logo lettering, card frames, event logos |
| Your own footage of your own cards in screenshots | Frames from Konami's YCS, World Championship or WCQ broadcasts, or identifiable people |
| Free, with no ads | Ads, paid tiers or donation links at launch (Konami's fan-use tolerance is for non-commercial use) |
