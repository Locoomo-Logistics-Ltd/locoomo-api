import { INestApplication, VersioningType } from '@nestjs/common';
import { createAppValidationPipe } from './common/pipes';

// Shared by main.ts and every e2e test that boots a real INestApplication —
// so tests exercise the exact same routing/validation config production
// uses, not a hand-approximated subset that can silently drift from it.
export function configureApp(app: INestApplication): void {
  // /health stays unprefixed/unversioned — it's an infra probe target
  // (Railway/Render), not app-facing API surface.
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createAppValidationPipe());
}
