# Duel Lens report relay

The extension's **Report** button sends a card report here: the crop, the cards shown, the video moment and the user's comment. This Cloudflare Worker turns it into a GitHub issue in `mathulbrich/duel-lens`, so users need no GitHub account. The issue is opened by the **Duel Lens Reports** GitHub App, not by a person.

## What can go wrong, and what limits it

- **The GitHub key leaks:** the App's key can only read and write *issues* in `mathulbrich/duel-lens`. It can't touch code, settings, other repositories or anyone's account. Each request also cuts its 1-hour token down to issues on this one repository (`github-app.ts`). Revoke it under GitHub → Settings → Developer settings → GitHub Apps → Duel Lens Reports → Private keys, or uninstall the App.
- **Spam**, which is what could get the App or the account flagged:
  - **Per address:** at most 2 reports a minute from one address (an IPv6 address counts by its /64). This limiter counts in each Cloudflare location separately.
  - **In all:** a single Durable Object (`gate.ts`) holds the one real ceiling, across every location. It allows at most 6 issues a minute and `DAILY_CAP` (100) a day, UTC. GitHub's own limit for creating content is 80 a minute.
  - **Back-off:** when GitHub answers 403 or 429, the gate pauses every report for an hour.
  - **Fails closed:** without its rate limiter or its gate, the relay takes nothing.
  - **Only valid reports count:** junk is refused before it can use up the daily cap.
  - **Free plan caps:** 100,000 requests and 1,000 KV writes a day, at no cost. Past them, reports fail until the next day.
  - **Origin:** only requests from an extension page (`chrome-extension://` or `moz-extension://`) are accepted. Any script can fake that header, so it only filters casual abuse.
  - **Stop at once:** Cloudflare dashboard → Workers & Pages → `duel-lens-reports` → Settings → Disable, or `npx wrangler@4 delete`. Or suspend the App on GitHub (Settings → Applications → Duel Lens Reports → Suspend).
- **Malicious content:** every field is checked and cut to its limit (`report.ts`). The body is refused past 1 MB before it is read.
  - **Text:** escaped and neutralised: it can't format the issue, mention anyone (@name), reference an issue (#1, GH-1, owner/repo#1, a github.com address), render math, or hide a link. Invisible and bidirectional characters are dropped. Checked against GitHub's own renderer (`api.github.com/markdown`).
  - **Links:** a YouTube video is written as its canonical link, rebuilt from its id. Any other address is shown as code, which GitHub doesn't link.
  - **Images:** only PNG, JPEG or WebP whose bytes match their type, up to 200 KB. They are served with `Content-Security-Policy: default-src 'none'`, and deleted after 90 days.
- **Taking an image down:** `npx wrangler@4 kv key delete --binding REPORT_IMAGES img/<id>` (the id is in the image's address), then edit the issue. GitHub's image proxy keeps a copy for up to a day.
- **Privacy:** the relay keeps the image for 90 days (in Workers KV, shown in the issue) and the gate's counts (times of the last minute's issues, today's total), nothing else: no IP addresses, no logs of reports. Everything else goes into the public issue, and the user sees all of it before sending.
- **Cost:** the Cloudflare account is on the Free plan, with no payment method. Nothing here can bill it.

## Setup (once)

1. **The GitHub App** (github.com → Settings → Developer settings → GitHub Apps → New GitHub App):
   - **Name and homepage:** name `Duel Lens Reports`, homepage `https://github.com/mathulbrich/duel-lens`;
   - **Webhook:** off;
   - **Permissions:** Repository permissions → Issues: Read and write (Metadata: Read-only comes with it), and nothing else;
   - **Install scope:** "Only on this account";
   - **After creating it:**
     - note its **App ID**;
     - **Generate a private key** (a `.pem` download);
     - **Install App** → Only select repositories → `duel-lens`.
2. **Labels** (once): `gh label create card-report -c d4c5f9 -R mathulbrich/duel-lens`, and the same for `no-match`, `not-sure` and `wrong-card`.
3. **Cloudflare**, from `relay/`:
   ```sh
   npx wrangler@4 login                                   # click Allow on Cloudflare's page
   npx wrangler@4 kv namespace create REPORT_IMAGES       # put the printed id in wrangler.toml
   # put the App ID in wrangler.toml (GITHUB_APP_ID)
   npx wrangler@4 secret put GITHUB_APP_PRIVATE_KEY < ~/Downloads/<the key>.pem
   npx wrangler@4 deploy                                  # prints https://duel-lens-reports.<subdomain>.workers.dev
   npx wrangler@4 logout                                  # no Cloudflare login left on this computer
   ```
   Then delete the `.pem` file; the Worker keeps the only copy it needs, and GitHub can issue a new key any time.
4. **The extension:** the relay's address goes in `src/shared/hosts.ts` (`REPORT_RELAY_URL`).

## Changing it

`npx vitest run relay` runs its tests (part of `npm test`). To deploy again: `npx wrangler@4 login`, `npx wrangler@4 deploy`, `npx wrangler@4 logout`.
