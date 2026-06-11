/**
 * True when a key event targets an interactive element (button, link, form
 * control). Global game-key handlers must yield activation keys (Enter/Space)
 * in that case, so a keyboard user who Tabs to "Quit" or the mute toggle can
 * actually press it — instead of the key being swallowed into a munch.
 */
export function onInteractive(e: KeyboardEvent): boolean {
  return !!(e.target as HTMLElement | null)?.closest?.('button, a, input, select, textarea');
}
