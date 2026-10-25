// What the sender writes on the parcel before drop-off — Nodes have no
// printers, so the label is handwritten. The tracking code is what staff type
// in to find the order; the destination is for sorting at a glance.
export interface LabelInstructions {
  lines: string[];
  note: string;
}

export function labelInstructionsFor(
  trackingCode: string,
  destinationNodeName: string,
): LabelInstructions {
  return {
    lines: [trackingCode, `TO: ${destinationNodeName.toUpperCase()}`],
    note: 'Write this clearly on the parcel with a marker before drop-off.',
  };
}
