import { HandoffCodeIssued } from '../../domain/handoff-code-issued';

// Deliberately excludes the code itself — see ResendCollectionCodeService.
// expiresAt alone is enough for the operator's UI to show a countdown.
export class CollectionCodeResendResponseDto {
  expiresAt!: Date;

  static fromResult(
    issued: Pick<HandoffCodeIssued, 'expiresAt'>,
  ): CollectionCodeResendResponseDto {
    const dto = new CollectionCodeResendResponseDto();
    dto.expiresAt = issued.expiresAt;
    return dto;
  }
}
