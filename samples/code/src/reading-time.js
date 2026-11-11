const WORDS_PER_MINUTE = 230;

/** Estimated reading time in whole minutes, never less than one. */
export function readingTime(text) {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}
