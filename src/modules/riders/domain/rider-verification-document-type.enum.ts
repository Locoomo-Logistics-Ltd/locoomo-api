// Only one document type today (a screenshot of the rider's ratings/reviews
// dashboard at the company they currently ride for) — deliberately an enum,
// not a boolean/hardcoded string, so adding a second required document later
// (e.g. an ID photo) is an enum value + a new upload call, not a schema
// rework. See RiderVerificationDocumentEntity.
export enum RiderVerificationDocumentType {
  RATING_SCREENSHOT = 'rating_screenshot',
}
