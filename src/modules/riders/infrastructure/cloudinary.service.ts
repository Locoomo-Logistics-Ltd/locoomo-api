import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { Env } from '../../../config/env.validation';

export interface UploadSignature {
  signature: string;
  timestamp: number;
  apiKey: string;
  cloudName: string;
  folder: string;
}

// Signed direct-to-Cloudinary upload — the client uploads bytes straight to
// Cloudinary using a signature we generate here, never proxied through this API
@Injectable()
export class CloudinaryService {
  constructor(private readonly configService: ConfigService<Env, true>) {
    cloudinary.config({
      cloud_name: configService.get('CLOUDINARY_CLOUD_NAME', { infer: true }),
      api_key: configService.get('CLOUDINARY_API_KEY', { infer: true }),
      api_secret: configService.get('CLOUDINARY_API_SECRET', { infer: true }),
    });
  }

  generateUploadSignature(folder: string): UploadSignature {
    const timestamp = Math.floor(Date.now() / 1000);
    const apiSecret = this.configService.get('CLOUDINARY_API_SECRET', {
      infer: true,
    });

    // `type: authenticated` must be signed here because the client sends it
    // as an upload parameter too — private delivery, never a public URL,
    // since this evidence may show the rider's real name/photo from another
    // platform's dashboard (NDPA).
    const signature = cloudinary.utils.api_sign_request(
      { folder, timestamp, type: 'authenticated' },
      apiSecret,
    );

    return {
      signature,
      timestamp,
      apiKey: this.configService.get('CLOUDINARY_API_KEY', { infer: true }),
      cloudName: this.configService.get('CLOUDINARY_CLOUD_NAME', {
        infer: true,
      }),
      folder,
    };
  }

  // Confirms the client actually completed the signed upload rather than
  // just reporting an arbitrary/stale public_id — the signature alone
  // guarantees a valid upload *could* happen with those parameters, not that
  // it *did*.
  async resourceExists(publicId: string): Promise<boolean> {
    try {
      await cloudinary.api.resource(publicId, {
        type: 'authenticated',
        resource_type: 'image',
      });
      return true;
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  getSignedViewUrl(publicId: string): string {
    return cloudinary.url(publicId, {
      type: 'authenticated',
      resource_type: 'image',
      sign_url: true,
      secure: true,
    });
  }

  // The SDK wraps the actual API error one level deeper than you'd expect —
  // `error.error.http_code`, not `error.http_code` — confirmed against a
  // real 404 response, not just the SDK's TypeScript types.
  private isNotFoundError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('error' in error)) {
      return false;
    }
    const inner = error.error;
    return (
      typeof inner === 'object' &&
      inner !== null &&
      (inner as { http_code?: unknown }).http_code === 404
    );
  }
}
