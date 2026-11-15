// What goes on a shipping label (MERCHANT_API.md §9). Pure: the PDF
// renderer only lays these out. Personal data is kept to what a counter
// and a courier need: the receiver's first name and the last 4 digits of
// their phone, never the full number or email.

export type LabelFormat = 'a6' | 'a4';
export const LABEL_FORMATS: readonly LabelFormat[] = ['a6', 'a4'];
export const MAX_LABELS_PER_REQUEST = 100;

export interface LabelSource {
  mode: 'test' | 'live';
  trackingCode: string;
  reference: string;
  receiverName: string;
  receiverPhone: string;
  merchantName: string;
  origin: { nodeName: string | null };
  destination: {
    nodeName: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
  };
  parcel: { size: string; handling: string[]; weightKg: number | null };
  createdAt: Date;
}

export interface LabelContent {
  test: boolean;
  trackingCode: string;
  // What the barcode and QR encode: the tracking code, which every Node
  // scanner accepts.
  scanValue: string;
  toNode: string;
  toAddress: string;
  receiver: string;
  from: string;
  dropOffAt: string;
  reference: string;
  details: string;
  handling: string[];
}

const HANDLING_LABELS: Record<string, string> = {
  fragile: 'FRAGILE',
  keep_upright: 'THIS WAY UP',
  perishable: 'PERISHABLE',
  liquid: 'LIQUID',
};

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? '';
}

export function phoneLast4(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.slice(-4);
}

export function labelContent(source: LabelSource): LabelContent {
  const address = [
    source.destination.address,
    source.destination.city,
    source.destination.state,
  ]
    .filter((part): part is string => !!part)
    .join(', ');
  const weight =
    source.parcel.weightKg !== null ? ` · ${source.parcel.weightKg} kg` : '';
  return {
    test: source.mode === 'test',
    trackingCode: source.trackingCode,
    scanValue: source.trackingCode,
    toNode: source.destination.nodeName ?? 'Locoomo Node',
    toAddress: address,
    receiver: `${firstName(source.receiverName)} · phone ending ${phoneLast4(source.receiverPhone)}`,
    from: source.merchantName,
    dropOffAt: source.origin.nodeName ?? '',
    reference: source.reference,
    details: `Size ${source.parcel.size.replace('_', ' ')}${weight} · ${source.createdAt.toISOString().slice(0, 10)}`,
    handling: source.parcel.handling.map(
      (flag) => HANDLING_LABELS[flag] ?? flag.toUpperCase(),
    ),
  };
}
