export enum UserStatus {
  // Admin-provisioned accounts (NodeOperator, Rider, Admin) start here until the
  // user follows their emailed link and sets a password.
  INVITED = 'invited',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}
