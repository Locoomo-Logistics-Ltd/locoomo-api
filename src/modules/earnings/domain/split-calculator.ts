export interface RevenueSplitShares {
  riderShareKobo: number;
  nodeShareKobo: number;
  platformShareKobo: number;
}

// Platform absorbs the rounding remainder — guarantees
// riderShareKobo + nodeShareKobo + platformShareKobo === amountKobo exactly,
// always, regardless of how the percentages divide.
export function calculateSplit(
  amountKobo: number,
  riderPercent: number,
  nodePercent: number,
): RevenueSplitShares {
  const riderShareKobo = Math.floor((amountKobo * riderPercent) / 100);
  const nodeShareKobo = Math.floor((amountKobo * nodePercent) / 100);
  const platformShareKobo = amountKobo - riderShareKobo - nodeShareKobo;
  return { riderShareKobo, nodeShareKobo, platformShareKobo };
}
