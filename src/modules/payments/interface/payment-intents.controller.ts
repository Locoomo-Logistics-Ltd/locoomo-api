import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { CreatePaymentIntentService } from '../application/create-payment-intent.service';
import { PaymentIntentQueryService } from '../application/payment-intent-query.service';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { PaymentIntentResponseDto } from './dto/payment-intent-response.dto';

@Controller('payments/intents')
@Roles(UserRole.CONSUMER)
export class PaymentIntentsController {
  constructor(
    private readonly createPaymentIntentService: CreatePaymentIntentService,
    private readonly paymentIntentQueryService: PaymentIntentQueryService,
  ) {}

  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreatePaymentIntentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentIntentResponseDto> {
    const { intent, authorizationUrl } =
      await this.createPaymentIntentService.create(user.id, dto);
    return PaymentIntentResponseDto.fromEntity(intent, authorizationUrl);
  }

  @Get(':id')
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentIntentResponseDto> {
    const intent = await this.paymentIntentQueryService.getMine(user.id, id);
    return PaymentIntentResponseDto.fromEntity(intent);
  }
}
