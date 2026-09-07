# Frontend UI/UX Beautification Audit — 2026-09-06

Scope: design system (`client/src/index.css`), all flows (auth landing, profiles hub, play/munch, race, feast, progress), shared components (Modal, MunchBoard, Muncher, CelebrationBurst, AvatarPicker, RewardPreview), and the shipped screenshots in `docs/screenshots/`.

## What's already strong

- **Cohesive "playground arcade" design language**: Fredoka + Nunito, warm paper, candy operation colors, chunky hard-offset pressable buttons, 5 unlockable themes including a proper dark theme — all tokenized, with documented contrast-companion tokens (`--on-sun`, `--on-ink`, `--ink-accent`).
- **Accessibility is genuinely deep**: correct `prefers-reduced-motion` handling, roving tabindex + live regions on the munch grid, focus-trapped modals, per-profile easy-read/high-contrast/narration, 44px touch targets, WCAG contrast invariants enforced by `client/src/styles.test.ts`.
- **Hand-drawn SVG munchers** (cat/dog/fox/frog/bunny/panda/dragon) are the app's most distinctive asset.

No redesign needed — the findings were targeted gaps, all approved for implementation.

## Findings & implementation checklist

### 1. UI-chrome icons are OS emoji — FIXED

`⭐` coins, `🔥` streak, `👁️/🙈` password toggle, `🔊/🔇` mute + narrate replay, `✕` modal close, `←/↑/↓` arrows, `🖨️` print, `✦` brand glyph rendered differently per OS, couldn't be tinted per theme, and fought the chunky ink-stroke style of the munchers.

- [x] Hand-drawn inline SVG icon set created (`client/src/components/Icon.tsx` + `Icon.css`): spark (brand), star (coins), flame (streak), eye, eye-off, volume, volume-off, close, back, chevron up/down, print, flag, bowl, gift, sticker, chart, grid, gear, check — rounded 2.2-weight strokes and solid candy fills, all `currentColor` so they tint per theme.
- [x] Chrome emoji swapped → SVG icons in AuthPage (glyph, password toggle, scroll cues), PlayPage (quit, mute, narrate, streak ribbon, coin total, spend-coins), ProfilesPage (glyph, streak + coin badges), ProgressPage (streak StatCard, both print buttons), RacePage (quit, coins), FeastPage (quit, lobby ready ✓, standings coins), RewardsModal (balance + prices), Modal (close), HowItWorksPage (glyph). Celebratory emoji (🏆🎉🌟📚📡💫) kept — those are content, not chrome.

### 2. Desktop is a narrow island in empty paper — FIXED

Layouts cap at 460–720px centered; on wide screens the screenshots showed huge blank margins.

- [x] `client/src/components/Backdrop.tsx`: a fixed, aria-hidden layer of faint drifting numbers/operation glyphs in the operation colors, wide screens only (`min-width: 900px`), `z-index: -1`, pointer-transparent, stilled by the global reduced-motion rule (keyframes start/end at rest so a frozen frame looks placed).

### 3. Landing hero is plain — FIXED

The most-visited public screen was brand + tagline + button + form, no personality moment.

- [x] A bobbing fox mascot (`Muncher state="idle"`, with a drop-in entrance animation) now greets above the wordmark on the auth hero; the Backdrop supplies the floating candy numbers on desktop.

### 4. Profile tile actions read as bare text links — FIXED

"Race / Feast / Rewards / Stickers / Progress / Facts / Settings" were icon-less ghost buttons.

- [x] Small SVG icons on every tile action (flag, bowl, gift, sticker, chart, grid, gear, chevron for more/less). Live check showed icon + label didn't fit side by side in the ~55px columns (the label broke awkwardly), so the buttons stack icon above label, centered — tidy in every language.

## Verification

- [x] `npx eslint client/src --max-warnings 0` — clean.
- [x] `npm run typecheck -w client` — clean.
- [x] `npm run test -w client` — 16 files / 111 tests pass, incl. `styles.test.ts` (no new bare-class collisions; contrast tokens untouched).
- [x] `npm run build -w shared && npm run build -w client` — production build succeeds.
- [x] Prettier clean on all touched files.
- [x] Live browser visual check — done 2026-09-06 with headless Chrome driven over CDP (`scripts/screenshot.mjs`, no new deps) against `npm run dev` + the API on sqlite. Verified: landing desktop (1440×900) and mobile (390×844) — mascot, spark glyph, eye toggle, backdrop glyphs; profiles hub — badges, stacked tile-action icons; play screen — Quit back arrow, mute icon, progress bar; progress page — flame StatCard, print icons. One layout refinement came out of it (stacked tile actions, see #4).

## New finding (pre-existing, not fixed)

- **Mobile landing page clips on the right edge** at 390px width. Reproduced on this branch and byte-identical on the live production site (fact-fluency.onrender.com), so it predates this work. Likely a fixed-width element in the auth hero overflowing the viewport. Worth a follow-up; left untouched here as out of the approved scope.
