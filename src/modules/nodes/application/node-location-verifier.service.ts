import { Inject, Injectable, Logger } from '@nestjs/common';
import { NodeLocationMismatchException } from '../domain/exceptions/node-location-mismatch.exception';
import {
  NodeLocationCheck,
  pinMatchesAddress,
} from '../domain/node-location-check';
import type { GeocodeResult, Geocoder } from '../domain/ports/geocoder.port';
import { GEOCODER } from '../infrastructure/geocoder.token';

export interface NodeLocationInput {
  address: string;
  city: string;
  state: string;
  country: string;
  latitude: number;
  longitude: number;
}

// Checks a Node's map pin against its typed address. Fails *open*: if the
// address can't be geocoded at all (no key, Google down, or Google simply
// doesn't know the address) the Node is accepted and marked UNVERIFIED for
// an Admin to review — onboarding must never block on a third party. It
// only rejects when Google confidently places the address somewhere the pin
// isn't.
@Injectable()
export class NodeLocationVerifierService {
  private readonly logger = new Logger(NodeLocationVerifierService.name);

  constructor(@Inject(GEOCODER) private readonly geocoder: Geocoder) {}

  async verify(input: NodeLocationInput): Promise<NodeLocationCheck> {
    let geocoded: GeocodeResult | null;
    try {
      geocoded = await this.geocoder.geocode(input);
    } catch (error) {
      this.logger.warn(
        `Node location left unverified — ${error instanceof Error ? error.message : String(error)}`,
      );
      return NodeLocationCheck.UNVERIFIED;
    }
    if (!geocoded) {
      return NodeLocationCheck.UNVERIFIED;
    }

    const result = pinMatchesAddress(input, geocoded);
    if (!result.matches) {
      throw new NodeLocationMismatchException(
        result.distanceMeters,
        geocoded.formattedAddress,
        { latitude: geocoded.latitude, longitude: geocoded.longitude },
      );
    }
    return NodeLocationCheck.VERIFIED;
  }
}
