/**
 * On-device narrated audio via the Web Speech API (SpeechSynthesis). Fully
 * local — no network, no vendor, no data leaves the device — so it needs no
 * account or approval. Best-effort: silently no-ops where the browser has no
 * speech synthesis. Gated per-profile by the `narrate` accessibility setting.
 */
const synth: SpeechSynthesis | undefined =
  typeof window !== 'undefined' ? window.speechSynthesis : undefined;

// i18n code → a BCP-47 tag the synthesizer is likely to have a voice for.
const LANG_TAG: Record<string, string> = {
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  zh: 'zh-CN',
};

/** True if this browser can speak (so callers can hide a replay control). */
export function speechAvailable(): boolean {
  return !!synth;
}

/** Speak `text` in `lang` (an i18n code like 'es'), cancelling anything already
 *  in flight so rapidly-advancing prompts don't stack up. */
export function speak(text: string, lang: string): void {
  if (!synth) return;
  try {
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LANG_TAG[lang] ?? lang;
    u.rate = 0.95; // a touch slower for young listeners
    synth.speak(u);
  } catch {
    /* best-effort — never let TTS break play */
  }
}

/** Stop any in-flight narration (e.g. on quit / unmount). */
export function stopSpeaking(): void {
  try {
    synth?.cancel();
  } catch {
    /* best-effort */
  }
}
