import { randomInt } from "crypto";

// Charset elegido para minimizar errores al transcribir/leer:
// - Sin 0/O, 1/l/I (ambigüedad visual)
// - Sin caracteres especiales raros (compatible con teclados latinos)
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const alpha = "abcdefghijkmnpqrstuvwxyz";
const DIGIT = "23456789";
const SYMBOL = "!@#$%&*-_+=?";
const ALL = ALPHA + alpha + DIGIT + SYMBOL;

function pick(charset: string): string {
  return charset[randomInt(0, charset.length)];
}

/**
 * Generates a cryptographically-random password using `crypto.randomInt`.
 * Default length 12. Always includes at least one upper, lower, digit and
 * symbol so it satisfies common password policies.
 *
 * Format example: "Bt9-jH4pYn28"
 */
export function generatePassword(length = 12): string {
  if (length < 8) length = 8;

  const required = [pick(ALPHA), pick(alpha), pick(DIGIT), pick(SYMBOL)];
  const rest: string[] = [];
  for (let i = required.length; i < length; i++) {
    rest.push(pick(ALL));
  }

  // Shuffle (Fisher–Yates) so the required chars aren't always in the same positions.
  const all = required.concat(rest);
  for (let i = all.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.join("");
}
