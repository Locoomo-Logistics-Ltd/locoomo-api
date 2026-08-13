import { HandoffCodeIssued } from '../../application/request-handoff-code.service';

// The one moment the raw code is ever exposed — the rider's own
// authenticated session requesting it, displayed in their app for them to
// show/state to the Node operator. Never emailed, never logged.
export class HandoffCodeResponseDto {
  code!: string;
  expiresAt!: Date;

  static fromResult(issued: HandoffCodeIssued): HandoffCodeResponseDto {
    const dto = new HandoffCodeResponseDto();
    dto.code = issued.code;
    dto.expiresAt = issued.expiresAt;
    return dto;
  }
}
