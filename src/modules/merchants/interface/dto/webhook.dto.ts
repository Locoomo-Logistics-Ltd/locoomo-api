import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { CursorQueryDto } from '../../../../common/pagination/cursor-query.dto';
import { WEBHOOK_EVENT_TYPES } from '../../domain/webhooks';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateWebhookEndpointDto {
  /** Public HTTPS URL. Redirects are not followed. */
  @Transform(trim)
  @IsString()
  @MaxLength(2048)
  url!: string;

  /** Event types to receive; omit or [] for all (including future ones). */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true })
  events?: string[];

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  description?: string;
}

export class UpdateWebhookEndpointDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true })
  events?: string[];

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  description?: string;

  /** Re-enable after fixing an endpoint we disabled (or pause one). */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class ReplayWebhooksDto {
  /** Resend every subscribed event since this time (within 30 days). */
  @IsISO8601()
  since!: string;
}

export class ListWebhookDeliveriesQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsUUID()
  endpointId?: string;

  @IsOptional()
  @IsIn(['pending', 'delivering', 'succeeded', 'failed'])
  status?: string;
}

export class WebhookEndpointView {
  id!: string;
  mode!: 'test' | 'live';
  url!: string;
  description!: string | null;
  @ApiProperty({ type: [String] })
  events!: string[];
  enabled!: boolean;
  /** Why we disabled it, if we did. */
  disabledReason!: string | null;
  /** First failure since the last success. */
  failingSince!: string | null;
  lastSuccessAt!: string | null;
  /** After a secret roll, the old secret also signs until this time. */
  previousSecretExpiresAt!: string | null;
  createdAt!: string;
}

export class CreatedWebhookEndpointView {
  endpoint!: WebhookEndpointView;
  /** `whsec_…`: shown once. */
  secret!: string;
}

export class WebhookTestResultView {
  delivered!: boolean;
  responseStatus!: number | null;
  durationMs!: number;
  error!: string | null;
}

export class WebhookDeliveryView {
  id!: string;
  eventId!: string;
  eventType!: string;
  endpointId!: string;
  status!: 'pending' | 'delivering' | 'succeeded' | 'failed';
  attempts!: number;
  nextAttemptAt!: string | null;
  lastAttemptAt!: string | null;
  responseStatus!: number | null;
  /** First 2 KB of your response. */
  responseBody!: string | null;
  error!: string | null;
  durationMs!: number | null;
  createdAt!: string;
}

export class WebhookDeliveryListView {
  @ApiProperty({ type: [WebhookDeliveryView] })
  items!: WebhookDeliveryView[];
  nextCursor!: string | null;
  hasMore!: boolean;
}
