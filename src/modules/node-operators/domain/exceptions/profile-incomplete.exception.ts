import { BusinessException } from '../../../../common/exceptions';

// Dispatch/physical handoffs need a real contact number, so onboarding is
// the hard-gate enforcement point — see OnboardNodeService.onboard. Phone
// is no longer collected at registration (password or Google signup both
// leave it null); PATCH /users/me is how it gets set.
export class ProfileIncompleteException extends BusinessException {
  readonly errorCode = 'PROFILE_INCOMPLETE';
  readonly httpStatus = 400;

  constructor() {
    super(
      'Add a phone number to your profile before onboarding as a Node operator',
    );
  }
}
