# Frontend UI/UX Audit — 2026-08-27

Scope: design system (`client/src/index.css`), all main flows (auth, profiles hub, play/munch, calibrate, race, feast, progress), the modal shell, and the shipped screenshots in `docs/screenshots/`.

## What's already strong

This is not a generic-UI codebase — most of what an audit would normally flag is already handled:

- **Cohesive design language**: warm paper + candy operation colors + chunky hard-shadow pressable buttons, all tokenized, with 5 unlockable themes including a proper dark theme. Screenshots confirm it renders as intended.
- **Accessibility is genuinely deep**: `prefers-reduced-motion` done correctly (not the strobe trap), roving tabindex on the munch grid, focus-trapped modals with focus restore, per-profile easy-read/high-contrast/narration, 44px touch targets, WCAG contrast tokens (`--on-op`, `--ink-accent`).
- **Honest UX details**: skeleton states shaped like what replaces them, a progress bar that can't overpromise, offline queue with graceful degradation, i18n-aware layouts that wrap long translations.

No redesign needed. The findings below are targeted gaps.

## Findings worth fixing

### Accessibility quick wins (small, safe)

1. **Error banners are invisible to screen readers** — `.error-banner` is used in 11 places (`client/src/pages/AuthPage.tsx:126`, every modal), none with `role="alert"`. The sibling error cards on Profiles/Progress _do_ have it. One-line-per-file fix, or make it part of the class convention.
2. **No `<main>` landmark on any page** — every screen is a bare `<div className="screen">`, so keyboard/screen-reader users can't jump straight to content.
3. **Only HowItWorksPage sets `document.title`** — Profiles/Play/Progress/Race tabs all show the same title.

### UX gaps

4. **No password visibility toggle** on the auth form — parents typing on mobile benefit; it's the one standard pattern missing there.
5. **Profile tile is getting crowded** — each tile now carries Play + 7 ghost actions (Race, Feast, Rewards, Stickers, Progress, Facts, Settings). On a kid-facing picker that's a wall of small text; worth considering Play + 1–2 secondaries and tucking the rest behind a manage affordance. (Side note: `docs/screenshots/profiles-v2.png` is stale — it shows 4 actions.)
6. **Mid-session Quit has no guard** (`client/src/pages/PlayPage.tsx:361`, `client/src/pages/RacePage.tsx:502`) — one accidental tap abandons a session. A tiny confirm (or just more separation from the progress bar) would prevent rage-quits-by-elbow. Trade-off: added friction, so it's a judgment call.
7. **No exit during the calibrate probe** — skip exists on the grade step (`client/src/pages/CalibratePage.tsx:110`) but once questions start, the only way out is finishing.

## Suggested follow-up options

- **A11y quick wins**: `role="alert"` on error banners, `<main>` landmarks, per-page document titles. Small, safe, no visual change.
- **Quick wins + auth toggle**: above, plus a show/hide password toggle on the auth form.
- **Everything incl. hub redesign**: above, plus decluttering profile tiles, Quit confirm, calibrate exit. Bigger UX decisions involved.

## Audit limitation

Findings are based on code review plus the shipped screenshots — there was no live visual verification across breakpoints/themes. A Playwright/browser MCP would enable screenshotting real viewports if that loop is wanted.
