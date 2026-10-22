import type { DeliveryQuote } from '../../application/delivery-quote.service';
import { FeeBreakdown } from '../../domain/fee-breakdown';

// Prices are deterministic from the pricing rule, so a quote holds until the
// rule changes; validUntil gives clients a sensible refresh point rather
// than a hard reservation (nothing is reserved by quoting).
const QUOTE_VALIDITY_MS = 15 * 60_000;

export class DeliveryQuoteResponseDto {
  amountKobo!: number;
  vehicleClass!: string;
  estimatedDeliveryMinutes!: number;
  distanceKm!: number;
  feeBreakdown!: FeeBreakdown;
  validUntil!: Date;

  static fromQuote(quote: DeliveryQuote): DeliveryQuoteResponseDto {
    const dto = new DeliveryQuoteResponseDto();
    dto.amountKobo = quote.feeBreakdown.totalKobo;
    dto.vehicleClass = quote.feeBreakdown.vehicleClass;
    dto.estimatedDeliveryMinutes = quote.estimatedDeliveryMinutes;
    dto.distanceKm = quote.feeBreakdown.distanceKm;
    dto.feeBreakdown = quote.feeBreakdown;
    dto.validUntil = new Date(Date.now() + QUOTE_VALIDITY_MS);
    return dto;
  }
}
