import { Injectable } from '@nestjs/common';
import {
  CloudinaryService,
  UploadSignature,
} from '../../../common/cloudinary/cloudinary.service';
import { CounterUploadNotFoundException } from '../domain/exceptions/counter.exceptions';

// Photos taken at a Node counter (refused parcels, ID-check collections):
// signed, private Cloudinary uploads into the staff member's own folder,
// checked before they're attached to an order.
@Injectable()
export class CounterUploadsService {
  constructor(private readonly cloudinary: CloudinaryService) {}

  signature(staffUserId: string): UploadSignature {
    return this.cloudinary.generateUploadSignature(this.folder(staffUserId));
  }

  async assertOwnUpload(staffUserId: string, publicId: string): Promise<void> {
    if (
      !publicId.startsWith(`${this.folder(staffUserId)}/`) ||
      !(await this.cloudinary.resourceExists(publicId))
    ) {
      throw new CounterUploadNotFoundException();
    }
  }

  private folder(staffUserId: string): string {
    return `counter/${staffUserId}`;
  }
}
