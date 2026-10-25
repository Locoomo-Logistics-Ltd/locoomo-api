import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { seconds, Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { DeliveryQuoteService } from '../application/delivery-quote.service';
import { DeliveryQuoteResponseDto } from './dto/delivery-quote-response.dto';
import { DeliveryQuoteDto } from './dto/delivery-quote.dto';

@Controller('delivery-quotes')
export class DeliveryQuotesController {
  constructor(private readonly deliveryQuoteService: DeliveryQuoteService) {}

  // Price preview before payment — reserves nothing. Consumers only see
  // public Nodes (same rule as checkout); Node staff quoting their own
  // dispatch may use private ones, as POST /node-operators/.../dispatch can.
  @Roles(UserRole.CONSUMER, UserRole.NODE_OPERATOR, UserRole.NODE_STAFF)
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Post()
  @HttpCode(HttpStatus.OK)
  async quote(
    @Body() dto: DeliveryQuoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeliveryQuoteResponseDto> {
    const quote = await this.deliveryQuoteService.quote(dto, dto, {
      restrictToPublicNodes: user.role === UserRole.CONSUMER,
    });
    return DeliveryQuoteResponseDto.fromQuote(quote);
  }
}
