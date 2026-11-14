import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import {
  RequireRecentAuth,
  RequireVerifiedEmail,
} from '../../../common/auth/decorators/account-requirements.decorator';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { auditContextFrom } from '../../../common/audit/audit.service';
import type { UploadSignature } from '../../../common/cloudinary/cloudinary.service';
import type { BankOption } from '../../payments/application/paystack-bank.service';
import {
  MerchantAccountOverview,
  MerchantAccountService,
} from '../application/merchant-account.service';
import { MerchantBankAccountService } from '../application/merchant-bank-account.service';
import type {
  BankAccountView,
  DirectorView,
  DocumentView,
  MerchantActor,
} from '../application/merchant-state';
import { MerchantPermission } from '../domain/merchant-permissions';
import {
  AcceptTermsDto,
  AddDirectorDto,
  CreateMerchantDto,
  MerchantDocumentKindParam,
  PutMerchantDocumentDto,
  SetMerchantBankAccountDto,
  UpdateMerchantProfileDto,
} from './dto/merchant-account.dto';
import {
  CurrentMerchantActor,
  MerchantAccess,
  MerchantGuard,
} from './merchant.guard';

// Merchant dashboard: the account itself and onboarding (cookie sessions
// only — API keys never reach these). Not part of the public integrator
// OpenAPI document.
@ApiExcludeController()
@Controller('merchant/account')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class MerchantAccountController {
  constructor(
    private readonly accounts: MerchantAccountService,
    private readonly bankAccounts: MerchantBankAccountService,
  ) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMerchantDto,
    @Req() request: Request,
  ): Promise<MerchantAccountOverview> {
    return this.accounts.create(user.id, dto, auditContextFrom(request));
  }

  @Get()
  @MerchantAccess()
  get(
    @CurrentMerchantActor() actor: MerchantActor,
  ): Promise<MerchantAccountOverview> {
    return this.accounts.overview(actor.merchantId, actor.memberId, actor.role);
  }

  @Patch('profile')
  @MerchantAccess(MerchantPermission.ACCOUNT_MANAGE)
  updateProfile(
    @CurrentMerchantActor() actor: MerchantActor,
    @Body() dto: UpdateMerchantProfileDto,
  ): Promise<MerchantAccountOverview> {
    return this.accounts.updateProfile(actor, dto);
  }

  // Cloudinary signature for one KYC file (document or ID image).
  @Post('uploads')
  @HttpCode(HttpStatus.OK)
  @MerchantAccess(MerchantPermission.ACCOUNT_MANAGE)
  uploadSignature(
    @CurrentMerchantActor() actor: MerchantActor,
  ): Promise<UploadSignature> {
    return this.accounts.uploadSignature(actor);
  }

  @Put('documents/:kind')
  @MerchantAccess(MerchantPermission.ACCOUNT_MANAGE)
  putDocument(
    @CurrentMerchantActor() actor: MerchantActor,
    @Param() params: MerchantDocumentKindParam,
    @Body() dto: PutMerchantDocumentDto,
  ): Promise<DocumentView> {
    return this.accounts.putDocument(actor, params.kind, dto.publicId);
  }

  @Post('directors')
  @MerchantAccess(MerchantPermission.ACCOUNT_MANAGE)
  addDirector(
    @CurrentMerchantActor() actor: MerchantActor,
    @Body() dto: AddDirectorDto,
  ): Promise<DirectorView> {
    return this.accounts.addDirector(actor, dto);
  }

  @Delete('directors/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @MerchantAccess(MerchantPermission.ACCOUNT_MANAGE)
  removeDirector(
    @CurrentMerchantActor() actor: MerchantActor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.accounts.removeDirector(actor, id);
  }

  // Where money is sent: always re-confirm identity first.
  @Put('bank-account')
  @RequireRecentAuth()
  @MerchantAccess(MerchantPermission.ACCOUNT_MANAGE)
  setBankAccount(
    @CurrentMerchantActor() actor: MerchantActor,
    @Body() dto: SetMerchantBankAccountDto,
  ): Promise<BankAccountView> {
    return this.bankAccounts.set(actor, dto);
  }

  @Post('terms')
  @HttpCode(HttpStatus.OK)
  @MerchantAccess(MerchantPermission.ACCOUNT_MANAGE)
  acceptTerms(
    @CurrentMerchantActor() actor: MerchantActor,
    @Body() dto: AcceptTermsDto,
  ): Promise<MerchantAccountOverview> {
    return this.accounts.acceptTerms(actor, dto.version);
  }

  @Post('submit')
  @HttpCode(HttpStatus.OK)
  @MerchantAccess(MerchantPermission.ACCOUNT_MANAGE)
  submit(
    @CurrentMerchantActor() actor: MerchantActor,
  ): Promise<MerchantAccountOverview> {
    return this.accounts.submit(actor);
  }

  @Post('close')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireRecentAuth()
  @MerchantAccess(MerchantPermission.OWNERSHIP)
  close(@CurrentMerchantActor() actor: MerchantActor): Promise<void> {
    return this.accounts.close(actor);
  }
}

// Bank list for the settlement-account picker.
@ApiExcludeController()
@Controller('merchant/banks')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class MerchantBanksController {
  constructor(private readonly bankAccounts: MerchantBankAccountService) {}

  @Get()
  @MerchantAccess()
  list(): Promise<BankOption[]> {
    return this.bankAccounts.listBanks();
  }
}
