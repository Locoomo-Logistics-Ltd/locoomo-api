import type { OpeningHours } from '../../../../common/opening-hours/opening-hours';
import type { PublicStatus, TimelineEntry } from '../../domain/public-status';

// Everything the public tracking page may show. Deliberately no names,
// phone numbers, emails, codes, shelf numbers, prices or internal ids —
// this is served without authentication.
export class PublicTrackingResponseDto {
  trackingCode!: string;
  status!: PublicStatus;
  statusLabel!: string;
  isFinal!: boolean;
  timeline!: (TimelineEntry & { at: Date })[];
  // address/state/openingHours only while the parcel is being returned.
  origin!: {
    name: string;
    city: string;
    address?: string;
    state?: string;
    openingHours?: OpeningHours | null;
  };
  destination!: {
    name: string;
    address: string;
    city: string;
    state: string;
    openingHours: OpeningHours | null;
  };
  courierLabel!: string | null;
  etaMinutes!: number | null;
  nextStep!: string;
  updatedAt!: Date;
}
