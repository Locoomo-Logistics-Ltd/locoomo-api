import { Module } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service';

// Shared signed-upload service — riders' verification evidence today,
// merchants' KYC documents next. Not global: import it where uploads are
// actually handled.
@Module({
  providers: [CloudinaryService],
  exports: [CloudinaryService],
})
export class CloudinaryModule {}
