# Policy Pilot

A web app that retrieves a user's insurance policy documents from personal-lines carrier portals via headless-browser automation.

The user enters their carrier credentials in the local UI. The backend logs in on their behalf, surfaces an MFA prompt when the carrier challenges, and returns the user's policy documents to the browser when the flow completes.

## How it works

1. **Frontend** — vanilla HTML/JS. A carrier dropdown, credential inputs, an MFA prompt that appears only when the carrier challenges, and a documents list at the end. Polls the backend every 500 ms for status updates and progress.
2. **Backend** — Fastify HTTP server. Per session, holds a long-lived Playwright browser context so the login → MFA pause → docs flow runs inside one continuous browser session, never reloading from scratch and never losing cookies in the middle.
3. **Carrier drivers** — pluggable per-carrier modules under `server/carriers/`. Each implements a `run(session)` function that drives the carrier portal: navigates login, awaits the user's MFA code, finds policies and documents. Drivers can use DOM automation or the carrier's own dashboard APIs when those are reachable from the authenticated browser context.
4. **Persistent profiles** — each unique `(carrier, username)` pair gets its own Chrome user-data directory. Subsequent runs reuse the existing session, skipping login and MFA entirely when the carrier still trusts the device.
5. **Document proxy** — each discovered document is exposed at `/api/sessions/:id/documents/:docId`. The proxy refetches the source URL through the authenticated browser context so cookie-protected document URLs work transparently in the user's browser.

## Anti-detection considerations

- Real Chrome (channel `chrome`) launched via `playwright-extra` with the stealth plugin patches applied (`navigator.webdriver`, plugin list, WebGL vendor strings, etc.).
- `--disable-blink-features=AutomationControlled` to drop the last common Chrome automation tell.
- Per-keystroke typing with randomised delays.
- Hover-before-click on submit buttons; randomised think-time between major steps.
- Runs locally — carriers see a residential IP, real timezone, real GPU fingerprint.
- Self-imposed rate limit so a single user can't hammer a carrier from refreshes or retries.

## Stack

- Node 18+
- Fastify
- Playwright + `playwright-extra` + `puppeteer-extra-plugin-stealth`
- System-installed Google Chrome

## Getting started

```bash
git clone https://github.com/jeetkatariya/policy-pilot.git
cd policy-pilot
npm install
npm start
# open http://127.0.0.1:3001
```

Google Chrome must be installed at the standard OS path (`/Applications/Google Chrome.app` on macOS).

### Useful environment variables

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `3001`) |
| `HEADFUL=1` | Show the carrier browser window (for debugging) |
| `DEBUG_DUMP=1` | Save a screenshot + HTML at every stage to `./dumps/<sessionId>/` |
| `RATE_LIMIT_MS` | Minimum ms between session starts per `(carrier, username)`. Default 60000; set `86400000` for a strict one-per-day in production-style use |

### Smoke test

```bash
npm run smoke
```

Runs an offline end-to-end test against a local fake-portal driver that exercises the full session state machine — login → MFA → multi-policy discovery — without touching any real carrier.

## Project structure

```
public/                vanilla HTML/JS frontend
server/
  app.js               Fastify app factory
  index.js             entrypoint
  sessions.js          in-memory session store + state machine
  rateLimit.js         per-user-key rate limiter
  fakePortal.js        local fake-portal routes (smoke tests + dev)
  runtime/
    playwright.js      real-Chrome + stealth runtime; persistent contexts
  carriers/
    index.js           carrier registry
    _shared.js         logging, selector helpers, behavioural-mimicry primitives
    stub.js            in-memory stub (no browser)
    stub-pw.js         Playwright stub against the local fake portal
    progressive.js     Progressive driver
    lemonade.js        Lemonade driver
scripts/
  smoke.js             offline smoke test harness
  probe-login.js       dumps the DOM structure of a public login URL
  inspect.js           headful interactive inspector for a carrier login
```

## Production considerations

This implementation is suitable for single-user use on the user's own machine. Productionising would need:

- Aggregator partnerships (Canopy Connect, Axle, MeasureOne) where available — sanctioned by carriers and resilient to portal layout changes.
- IP-pool routing for users who can't run the app locally.
- Per-carrier mobile-API reverse engineering as the most resilient automation path.
- Persistent storage for session metadata and audit logs (without ever persisting raw credentials).
- Per-carrier retry policy with backoff that respects carrier-side rate limits.

## Roadmap

- Broader carrier coverage (Geico, Allstate, State Farm, etc.).
- Document parsing / structured policy data extraction.
- Webhook-based async retrieval flow.
- WebSocket transport for status updates in place of polling.
