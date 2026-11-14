import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuditService } from '../../../common/audit/audit.service';
import { createSecretBox } from '../../../common/crypto/data-encryption-key';
import { SecretBox } from '../../../common/crypto/secret-box';
import { Env } from '../../../config/env.validation';
import { UserLookupService } from '../../identity/application/user-lookup.service';
import {
  BankOption,
  PaystackBankService,
} from '../../payments/application/paystack-bank.service';
import { MerchantNotEditableException } from '../domain/exceptions/merchant.exceptions';
import { MerchantStatus, ReviewItemKey } from '../domain/merchant.enums';
import {
  CONTACT_EDITABLE,
  ONBOARDING_EDITABLE,
} from '../domain/merchant-status';
import { bestNameMatch } from '../domain/name-match';
import { MerchantBankAccountEntity } from '../infrastructure/entities/merchant-bank-account.entity';
import { MerchantDirectorEntity } from '../infrastructure/entities/merchant-director.entity';
import { SetMerchantBankAccountDto } from '../interface/dto/merchant-account.dto';
import { MerchantNotifierService } from './merchant-notifier.service';
import {
  BankAccountView,
  bankAccountView,
  clearReview,
  lockMerchant,
  MerchantActor,
} from './merchant-state';

// Settlement account (plan §4.1): resolved through Paystack so the holder
// name comes from the bank, never the merchant; number encrypted at rest.
@Injectable()
export class MerchantBankAccountService {
  private readonly box: SecretBox;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly paystackBanks: PaystackBankService,
    private readonly audit: AuditService,
    private readonly notifier: MerchantNotifierService,
    private readonly userLookup: UserLookupService,
    config: ConfigService<Env, true>,
  ) {
    this.box = createSecretBox(config, 'bank-account');
  }

  listBanks(): Promise<BankOption[]> {
    return this.paystackBanks.listBanks();
  }

  async set(
    actor: MerchantActor,
    dto: SetMerchantBankAccountDto,
  ): Promise<BankAccountView> {
    // Outside the transaction: a slow bank lookup mustn't hold the row lock.
    const { accountName } = await this.paystackBanks.resolveAccountNumber(
      dto.bankCode,
      dto.accountNumber,
    );

    return this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, actor.merchantId);
      if (!CONTACT_EDITABLE.includes(merchant.status)) {
        throw new MerchantNotEditableException(merchant.status);
      }
      const directors = await manager.findBy(MerchantDirectorEntity, {
        merchantId: merchant.id,
      });
      const score = bestNameMatch(accountName, [
        merchant.legalName,
        merchant.tradingName,
        ...directors.map((director) => director.fullName),
      ]);

      const repo = manager.getRepository(MerchantBankAccountEntity);
      const existing = await repo.findOneBy({ merchantId: merchant.id });
      const before = existing
        ? {
            bankName: existing.bankName,
            accountNumberLast4: existing.accountNumberLast4,
            accountName: existing.accountName,
          }
        : null;
      const saved = await repo.save(
        Object.assign(existing ?? repo.create({ merchantId: merchant.id }), {
          bankCode: dto.bankCode,
          bankName: dto.bankName,
          accountNumberSealed: this.box.seal(
            Buffer.from(dto.accountNumber, 'utf8'),
          ),
          accountNumberLast4: dto.accountNumber.slice(-4),
          accountName,
          nameMatchScore: score,
          verifiedAt: new Date(),
          setByUserId: actor.userId,
        }),
      );

      if (ONBOARDING_EDITABLE.includes(merchant.status)) {
        await clearReview(manager, merchant.id, ReviewItemKey.BANK_ACCOUNT);
      }
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: existing
            ? 'merchant.bank_account_changed'
            : 'merchant.bank_account_set',
          merchantId: merchant.id,
          target: { type: 'merchant_bank_account', id: saved.id },
          before,
          after: {
            bankName: saved.bankName,
            accountNumberLast4: saved.accountNumberLast4,
            accountName: saved.accountName,
            nameMatchScore: score,
          },
          context: actor.context,
        },
        manager,
      );
      // Once live, a change of where money goes is a security event.
      if (existing && merchant.status === MerchantStatus.APPROVED) {
        const [changer] = await this.userLookup.getContacts([actor.userId]);
        await this.notifier.bankAccountChanged(
          merchant,
          {
            bankName: saved.bankName,
            last4: saved.accountNumberLast4,
            changedBy: changer
              ? `${changer.firstName} ${changer.lastName} (${changer.email})`
              : 'a team member',
          },
          manager,
        );
      }
      return bankAccountView(saved);
    });
  }
}
