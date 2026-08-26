import { BankOption } from '../../application/paystack-bank.service';

export class BankResponseDto {
  code!: string;
  name!: string;

  static fromOption(bank: BankOption): BankResponseDto {
    const dto = new BankResponseDto();
    dto.code = bank.code;
    dto.name = bank.name;
    return dto;
  }
}
