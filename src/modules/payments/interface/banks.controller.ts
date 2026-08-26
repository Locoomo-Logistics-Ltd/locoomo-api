import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { PaystackBankService } from '../application/paystack-bank.service';
import { BankResponseDto } from './dto/bank-response.dto';

// Deliberately not paginated — flagged deviation from decision #8, same
// reasoning as GET /admin/capacity-audit: this is a wholesale reference
// list (Paystack's supported banks) meant to back a single client-side
// dropdown/search, not a growing browsable resource. Paginating it would
// force the client to fetch multiple pages just to populate one dropdown.
@Controller('payments/banks')
@Roles(UserRole.RIDER, UserRole.NODE_OPERATOR)
export class BanksController {
  constructor(private readonly paystackBankService: PaystackBankService) {}

  @Get()
  async list(): Promise<BankResponseDto[]> {
    const banks = await this.paystackBankService.listBanks();
    return banks.map((bank) => BankResponseDto.fromOption(bank));
  }
}
