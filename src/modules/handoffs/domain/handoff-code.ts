import { randomInt } from 'crypto';

// 6-digit numeric — short enough to read aloud/type quickly at a handoff,
// unlike trackingCode's alphanumeric format (which is meant to be written
// down and quoted later, not spoken in a live exchange). Not the tracking
// code's Crockford alphabet: a handoff code is read/typed once, on the
// spot, by two people standing together, so digit-only is simpler and
// there's no "misread later" risk to design around.
const CODE_LENGTH = 6;

export function generateHandoffCode(): string {
  return randomInt(10 ** CODE_LENGTH)
    .toString()
    .padStart(CODE_LENGTH, '0');
}
