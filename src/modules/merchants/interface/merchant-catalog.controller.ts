import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { RequestWithUser } from '../../../common/auth/auth.guard';
import { RequireVerifiedEmail } from '../../../common/auth/decorators/account-requirements.decorator';
import { AllowApiKey } from '../../../common/auth/decorators/allow-api-key.decorator';
import { MerchantCatalogService } from '../application/merchant-catalog.service';
import { ApiKeyScope } from '../domain/api-key';
import {
  ListNodesQueryDto,
  MerchantNodeListView,
  MerchantNodeView,
  QuoteQueryDto,
  QuoteView,
} from './dto/merchant-catalog.dto';
import {
  MerchantAccess,
  MerchantGuard,
  MODE_HEADER,
  RequestWithMerchant,
} from './merchant.guard';

// Public integrator API (MERCHANT_API.md §6). Any key (publishable keys
// from the browser, with open CORS), or a dashboard session of any member.
@ApiTags('Nodes and quotes')
@ApiBearerAuth('apiKey')
@Controller('merchant')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class MerchantCatalogController {
  constructor(private readonly catalog: MerchantCatalogService) {}

  /** Nodes a buyer can collect from: open for business, with shelf space. */
  @Get('nodes')
  @AllowApiKey(ApiKeyScope.NODES_READ)
  @MerchantAccess()
  @ApiOkResponse({ type: MerchantNodeListView })
  listNodes(@Query() query: ListNodesQueryDto): Promise<MerchantNodeListView> {
    return this.catalog.listNodes(query);
  }

  /** One Node. 404 if it has closed or been withdrawn. */
  @Get('nodes/:id')
  @AllowApiKey(ApiKeyScope.NODES_READ)
  @MerchantAccess()
  @ApiOkResponse({ type: MerchantNodeView })
  getNode(@Param('id', ParseUUIDPipe) id: string): Promise<MerchantNodeView> {
    return this.catalog.getNode(id);
  }

  /** Estimated price to a destination Node. Fixed when the shipment is created. */
  @Get('quotes')
  @AllowApiKey(ApiKeyScope.QUOTES_READ)
  @MerchantAccess()
  @ApiOkResponse({ type: QuoteView })
  quote(
    @Query() query: QuoteQueryDto,
    @Req() request: RequestWithUser,
  ): Promise<QuoteView> {
    const principal = request.principal;
    const membership = (request as RequestWithMerchant).merchant;
    // Whose discount: the key's merchant and mode, or the signed-in
    // member's merchant in the Test/Live mode they're viewing.
    const who =
      principal?.kind === 'api_key'
        ? { merchantId: principal.merchantId, mode: principal.mode }
        : membership
          ? {
              merchantId: membership.merchantId,
              mode:
                request.headers[MODE_HEADER] === 'live'
                  ? ('live' as const)
                  : ('test' as const),
            }
          : null;
    return this.catalog.quote(query, {
      hidePrices: principal?.kind === 'api_key' && !!principal.hidePrices,
      merchant: who,
    });
  }
}
