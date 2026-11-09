/**
 * How Tala's numbers are said aloud.
 *
 * Speech models read a block of digits as an amount: on 2026-11-09 ElevenLabs
 * Flash read the reference "5012 345 678901" as "5T12 345 678 901", fifty-twelve
 * and then hundreds. A caller confirming a reference needs every digit, so
 * before speech, a number of four or more digits is rewritten with a hyphen
 * between digits and a comma between its groups ("5-0-1-2, 3-4-5, ..."), the
 * form that was read digit by digit and chosen by ear.
 *
 * The SOP asks Tala to read references in small groups, but how "5012" sounds
 * is the speech model's call, not hers: the code makes it certain. Only what
 * is spoken changes. Transcripts, spans and records keep the original text.
 *
 * Left alone: numbers under four digits in total (times, dates, counts), peso
 * amounts (after ₱ or PHP, or followed by "pesos"), and digits inside a word.
 */

/** Digit groups joined by single spaces or hyphens, standing on their own. */
const DIGIT_SEQUENCE = /(?<![\p{L}\p{N}])\d+(?:[ -]\d+)*(?![\p{L}\p{N}])/gu;

const MONEY_BEFORE = /(?:₱|\bPHP)\s?$/iu;
const MONEY_AFTER = /^\s?pesos?\b/iu;

const MIN_DIGITS = 4;

export function spokenDigits(text: string): string {
  return text.replace(DIGIT_SEQUENCE, (sequence: string, offset: number) => {
    const groups = sequence.split(/[ -]/);
    if (groups.join("").length < MIN_DIGITS) return sequence;

    const before = text.slice(0, offset);
    const after = text.slice(offset + sequence.length);
    if (MONEY_BEFORE.test(before) || MONEY_AFTER.test(after)) return sequence;

    return groups.map((group) => group.split("").join("-")).join(", ");
  });
}
