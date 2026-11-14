// How well the bank's account holder name (from Paystack resolve) matches
// the names the merchant gave us — legal/trading name and directors. A
// hint for the KYC reviewer, not a gate: a weak match is flagged on the
// review screen, never auto-rejected (banks abbreviate, reorder and
// truncate names).

export type NameMatchLevel = 'strong' | 'partial' | 'weak';

// Words that say nothing about *who* the account belongs to.
const NOISE = new Set([
  'LTD',
  'LIMITED',
  'PLC',
  'NIG',
  'NIGERIA',
  'NIGERIAN',
  'CO',
  'COMPANY',
  'ENTERPRISE',
  'ENTERPRISES',
  'VENTURE',
  'VENTURES',
  'GLOBAL',
  'INTL',
  'INTERNATIONAL',
  'SERVICES',
  'SERVICE',
  'AND',
  'THE',
  'OF',
  'MR',
  'MRS',
  'MS',
  'MISS',
  'DR',
]);

export function nameTokens(name: string): string[] {
  return [
    ...new Set(
      name
        .toUpperCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Z0-9]+/g, ' ')
        .split(' ')
        .filter((token) => token.length > 0 && !NOISE.has(token)),
    ),
  ];
}

function tokensMatch(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  // Truncation/abbreviation: "CHUKWUEMEKA" vs "CHUKWU", "INTL" handled above.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.startsWith(short)) {
    return true;
  }
  // One typo in a longer word.
  return short.length >= 5 && withinOneEdit(a, b);
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) {
    return false;
  }
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) {
      return false;
    }
    if (a.length > b.length) {
      i++;
    } else if (b.length > a.length) {
      j++;
    } else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// 0..1. Order-insensitive token overlap, measured against the shorter name
// (bank names often add a middle name), with a discount when only one word
// carries the whole match.
export function nameSimilarity(a: string, b: string): number {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const [shorter, longer] =
    left.length <= right.length ? [left, right] : [right, left];
  const unused = [...longer];
  let matches = 0;
  for (const token of shorter) {
    const index = unused.findIndex((other) => tokensMatch(token, other));
    if (index >= 0) {
      matches++;
      unused.splice(index, 1);
    }
  }
  let score = matches / shorter.length;
  if (shorter.length === 1 && longer.length > 1) {
    score *= 0.7;
  }
  return Math.round(score * 1000) / 1000;
}

export function bestNameMatch(
  accountName: string,
  candidates: readonly (string | null | undefined)[],
): number {
  return candidates.reduce<number>(
    (best, candidate) =>
      candidate ? Math.max(best, nameSimilarity(accountName, candidate)) : best,
    0,
  );
}

export function nameMatchLevel(score: number): NameMatchLevel {
  if (score >= 0.8) {
    return 'strong';
  }
  return score >= 0.5 ? 'partial' : 'weak';
}
