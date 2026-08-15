// Returned by HandoffCodeIssuerService.issue() — moved here (not local to
// RequestHandoffCodeService) once ConfirmIntakeService/
// ResendCollectionCodeService needed the same shape for the
// RECEIVER_COLLECTION code.
export interface HandoffCodeIssued {
  code: string;
  expiresAt: Date;
}
