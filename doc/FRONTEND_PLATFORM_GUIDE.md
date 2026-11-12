# Platform Guide for the Locoomo Frontend Team

Covers the security and admin changes every Locoomo app must adopt, the new account-security
screens, and the merchant dashboard you'll build next.

Applies to: the consumer (sender) app, Node app, rider app, admin app, and the upcoming
merchant dashboard. The full per-endpoint reference stays in [API.md](API.md), and the
logistics flows stay in [LOGISTICS_API.md](LOGISTICS_API.md). This guide tells you what to
build and in what order.

**Status markers** used below:
- ✅ **Live**: deployed with this backend release, safe to build against now.
- 🛠 **Next**: contract agreed but not deployed yet. Build UI against the documented shapes
  and mock the calls. The [Merchant API guide](MERCHANT_API.md) is the shared contract.

## Contents

1. [Do these now (every app)](#1-do-these-now-every-app)
2. [HTTP client setup](#2-http-client-setup)
3. [Shared types (TypeScript)](#3-shared-types-typescript)
4. [Sign-in with two-factor authentication](#4-sign-in-with-two-factor-authentication)
5. [“Confirm it’s you” (step-up re-authentication)](#5-confirm-its-you-step-up-re-authentication)
6. [Account security settings screen](#6-account-security-settings-screen)
7. [Email verification banner](#7-email-verification-banner)
8. [Admin app](#8-admin-app)
9. [Merchant dashboard (next)](#9-merchant-dashboard-next)
10. [Error codes](#10-error-codes)
11. [Testing locally](#11-testing-locally)

---

## 1. Do these now (every app)

| # | Change | Why | Effort |
|---|---|---|---|
| 1 | **Send `X-Locoomo-Client: web` on every non-GET request** | CSRF protection. The API only logs missing headers today. Once every app sends it, missing ones are rejected with `403 CSRF_HEADER_MISSING`. | One line in your HTTP client ([§2](#2-http-client-setup)) |
| 2 | **Handle `{ mfaRequired: true, mfaToken }` from login and Google sign-in** | Accounts with 2FA get a challenge instead of a session | One extra screen ([§4](#4-sign-in-with-two-factor-authentication)) |
| 3 | **Handle `403 REAUTH_REQUIRED` with a “Confirm it’s you” dialog, then retry** | Sensitive actions need a fresh proof of identity | One interceptor + one dialog ([§5](#5-confirm-its-you-step-up-re-authentication)) |
| 4 | **Treat `401` as signed out, everywhere** | Signing out a device or resetting a password now ends sessions **immediately**. The old access token stops working on its next request, not 15 minutes later. | Probably already done: refresh on `401`, and if refresh fails, go to sign-in |
| 5 | Handle `413 PAYLOAD_TOO_LARGE` and `400 MALFORMED_JSON` | Bodies over 1 MB, and broken JSON, now return proper error codes (they used to return a `500` or a confusing `VALIDATION_FAILED`) | Generic error toast |
| 6 | Validation errors can point at nested fields: `receiver.phone`, `items[3].receiver.phone` | Show the message next to the right input | Map `details[].field` to your form paths |
| 7 | **Admin app only:** 2FA becomes mandatory 14 days after release, plus the permissions and approvals screens | [§8](#8-admin-app) | A few screens |

Nothing else in the existing API changed shape. Existing screens keep working.

---

## 2. HTTP client setup

```ts
import axios, { AxiosError } from 'axios';

export const api = axios.create({
  baseURL: `${import.meta.env.VITE_API_ORIGIN}/api/v1`,
  withCredentials: true,                    // send the httpOnly session cookies
  headers: { 'X-Locoomo-Client': 'web' },   // CSRF header; any non-empty value works
});
```

`fetch` equivalent:

```ts
fetch(url, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'X-Locoomo-Client': 'web' },
  body: JSON.stringify(body),
});
```

### Response handling

Every response is an envelope. Unwrap `data`, and branch on `error.code` (stable), never on
`error.message` (copy that may change).

```ts
api.interceptors.response.use(
  (res) => res.data.data,                       // unwrap { success, data, meta }
  (err: AxiosError<ApiError>) => Promise.reject(toAppError(err)),
);

export function toAppError(err: AxiosError<ApiError>): AppError {
  const body = err.response?.data;
  return {
    status: err.response?.status ?? 0,
    code: body?.error.code ?? 'NETWORK_ERROR',
    message: body?.error.message ?? 'Network error. Check your connection.',
    details: body?.error.details ?? [],
    correlationId: body?.error.correlationId,   // show in "report a problem"
  };
}
```

### Order of error handling

The handlers in [§4](#4-sign-in-with-two-factor-authentication) and [§5](#5-confirm-its-you-step-up-re-authentication)
plug into this order:

1. **`401 UNAUTHENTICATED`**: call `POST /auth/refresh` once and retry. If refresh fails,
   sign the user out locally and go to sign-in. (Unchanged.)
2. **`403 REAUTH_REQUIRED`**: open the "Confirm it's you" dialog, then retry the original
   request ([§5](#5-confirm-its-you-step-up-re-authentication)).
3. **`403 MFA_ENROLLMENT_REQUIRED`** (admin app): route to the 2FA setup screen.
4. **`403 EMAIL_NOT_VERIFIED`** (merchant dashboard): show the verify-email banner.
5. Everything else: show `message`, or field errors from `details`.

### Safe retries with `Idempotency-Key`

Endpoints that create things (all merchant `POST`s, starting with the merchant dashboard)
accept an `Idempotency-Key` header. Generate **one key per user action**, and reuse it if
you retry that action after a timeout:

```ts
const key = crypto.randomUUID();                 // when the user clicks "Create"
await api.post('/merchant/shipments', body, { headers: { 'Idempotency-Key': key } });
// on network error/timeout, retry with the SAME key: the shipment is created once
```

| Response | Meaning |
|---|---|
| Normal success + header `Idempotent-Replayed: true` | Your earlier attempt worked; this is its result |
| `409 IDEMPOTENCY_IN_PROGRESS` | First attempt still running. Wait ~1 s and retry |
| `422 IDEMPOTENCY_KEY_REUSED` | Same key, different body. That's a bug: use a new key per action |

---

## 3. Shared types (TypeScript)

```ts
export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    correlationId: string;
    details?: { field: string; constraint: string; message: string }[];
  };
}

export interface AppError {
  status: number;
  code: string;
  message: string;
  details: { field: string; constraint: string; message: string }[];
  correlationId?: string;
}

export type UserRole = 'consumer' | 'node_operator' | 'rider' | 'admin' | 'node_staff';
export type UserStatus = 'invited' | 'pending_review' | 'active' | 'suspended';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt: string | null;
  createdAt: string;
}

// POST /auth/login and POST /auth/google
export type SignInResponse = User | MfaChallenge;
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;            // valid 5 minutes, 5 wrong codes max
}
export const needsMfa = (r: SignInResponse): r is MfaChallenge =>
  (r as MfaChallenge).mfaRequired === true;

// GET /auth/mfa
export interface MfaStatus {
  enabled: boolean;
  confirmedAt: string | null;
  recoveryCodesRemaining: number;
  required: boolean;                  // must have 2FA (admins); can't turn off
  enrollmentDeadline: string | null;  // only when required && !enabled
}

// POST /auth/mfa/totp/setup
export interface MfaSetup {
  secret: string;       // base32, for "enter this key manually"
  otpauthUrl: string;
  qrDataUrl: string;    // <img src={qrDataUrl}>
}

// GET /auth/sessions
export interface Session {
  id: string;
  startedAt: string;
  lastActiveAt: string; // accurate to ~15 minutes
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

// Step-up: send exactly one
export type ReauthBody =
  | { code: string }            // 2FA on
  | { recoveryCode: string }    // 2FA on, phone lost
  | { password: string }        // no 2FA
  | { googleIdToken: string };  // Google-only account, no 2FA

// Admin
export type AdminPermission = 'super' | 'kyc' | 'finance' | 'ops' | 'support';
export interface AdminAccount {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: UserStatus;
  adminPermissions: AdminPermission[];
}

export type ApprovalStatus = 'pending' | 'executed' | 'rejected' | 'cancelled' | 'expired';
export interface ApprovalRequest {
  id: string;
  action: string;                     // e.g. 'wallet.manual_adjustment'
  status: ApprovalStatus;
  summary: string;                    // one line for the queue
  reason: string;                     // why the requester raised it
  payload: Record<string, unknown>;   // action-specific details
  merchantId: string | null;
  requestedByUserId: string;
  decidedByUserId: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  result: Record<string, unknown> | null;
  expiresAt: string;
  createdAt: string;
}

export interface Paginated<T> { items: T[]; page: number; limit: number; total: number }
```

---

## 4. Sign-in with two-factor authentication ✅

### Flow

```
[Email + password] ──POST /auth/login──► User ─────────────────────────► signed in
                                      └► { mfaRequired, mfaToken } ──► [Enter code]
[Google button] ──POST /auth/google──► (same two outcomes)                   │
                                                                             ▼
                             POST /auth/mfa/verify { mfaToken, code | recoveryCode }
                                      ├─ 200 User (cookies set) ─────────► signed in
                                      ├─ 401 INVALID_MFA_CODE ───────────► "Wrong code", stay
                                      └─ 401 INVALID_MFA_CHALLENGE ──────► back to sign-in
```

```ts
async function signIn(email: string, password: string) {
  const result: SignInResponse = await api.post('/auth/login', { email, password });
  if (needsMfa(result)) return navigate('/sign-in/code', { state: { mfaToken: result.mfaToken } });
  setCurrentUser(result);
}

async function submitCode(mfaToken: string, input: string, useRecovery: boolean) {
  try {
    const user: User = await api.post('/auth/mfa/verify',
      useRecovery ? { mfaToken, recoveryCode: input } : { mfaToken, code: input.replace(/\s/g, '') });
    setCurrentUser(user);
  } catch (e) {
    const err = e as AppError;
    if (err.code === 'INVALID_MFA_CHALLENGE') return navigate('/sign-in', { state: { notice: 'expired' } });
    if (err.code === 'INVALID_MFA_CODE') return setFieldError('That code didn’t work. Try the newest one.');
    throw e;
  }
}
```

### "Enter your code" screen

- Heading: *"Enter the 6-digit code from your authenticator app"*.
- One numeric field with `inputMode="numeric"` and `autocomplete="one-time-code"`. Accept
  pasted codes with spaces.
- Link: *"Lost your phone? Use a recovery code"*. This switches to a text field for codes
  like `abcde-fghij`. Case doesn't matter and the dash is optional.
- The challenge expires after **5 minutes** or **5 wrong codes**. After that, send the
  user back to the password screen with *"That sign-in attempt expired. Please sign in
  again."*
- Each code works once. If a code was just used, the user waits for the next one; the copy
  "Try the newest code" covers this.

---

## 5. "Confirm it's you" (step-up re-authentication) ✅

Sensitive actions require the user to have proven who they are in the **last 10 minutes**.
A normal sign-in counts, so most users never see the prompt right after signing in.
Otherwise the API answers `403 REAUTH_REQUIRED`.

**Which actions need it?** Today: starting 2FA setup, regenerating recovery codes, and
turning 2FA off. The merchant dashboard (🛠) will also use it for creating or rolling live
API keys, changing webhook URLs or the bank account, changing team roles, transferring
ownership and closing the account. Don't hard-code the list. React to the error code.

### One interceptor for every app

```ts
let reauthInFlight: Promise<void> | null = null;

api.interceptors.response.use(undefined, async (error) => {
  const err = toAppError(error);
  if (err.code !== 'REAUTH_REQUIRED' || error.config.__reauthRetried) throw err;

  // One dialog even if several requests hit this at once.
  reauthInFlight ??= openConfirmItsYouDialog().finally(() => (reauthInFlight = null));
  await reauthInFlight;                      // rejects if the user cancels

  error.config.__reauthRetried = true;
  return api.request(error.config);          // retry the original request
});
```

### The dialog

Ask for the strongest factor the account has. Call `GET /auth/mfa` (cache it per session)
to know which:

| `MfaStatus.enabled` | User signs in with | Show | Send to `POST /auth/reauth` |
|---|---|---|---|
| `true` | anything | 6-digit code field + "use a recovery code" link | `{ code }` or `{ recoveryCode }` |
| `false` | password | password field | `{ password }` |
| `false` | Google only | "Continue with Google" button (same Google account) | `{ googleIdToken }` |

If you don't know whether the user has a password, show the password field with a
"Continue with Google instead" link.

On `200` the API sets a new access cookie and returns
`{ reauthenticatedUntil: "2026-11-12T10:10:00.000Z" }`. Close the dialog; the interceptor
retries the request. On `401 INVALID_CREDENTIALS` or `INVALID_MFA_CODE`, show the error in
the dialog and let the user try again (5 attempts per minute).

Copy: title *"Confirm it's you"*, body *"For your security, confirm your identity to
continue."*

---

## 6. Account security settings screen ✅

One "Security" page in **every** app's account settings.

### 6.1 Two-factor authentication card

Load it with `GET /auth/mfa`.

| State | Show |
|---|---|
| `enabled: false`, `required: false` | "Two-factor authentication: **Off**", and a "Turn on" button |
| `enabled: false`, `required: true` | Warning banner: "Two-factor authentication is required for your account. Set it up by **{enrollmentDeadline}**." and a "Set up now" button |
| `enabled: true` | "**On** since {confirmedAt}", "Recovery codes: {recoveryCodesRemaining} left", "Generate new recovery codes" button, and a "Turn off" button **only if** `required` is `false`. Warn when 2 or fewer codes remain |

**Turn-on wizard**:

1. **Install an app.** "Use Google Authenticator, Microsoft Authenticator, Authy or
   1Password." [Continue]
2. **Scan.** Call `POST /auth/mfa/totp/setup` (step-up may trigger, handled by §5). Show
   `<img src={qrDataUrl} alt="QR code">` and a "Can't scan? Enter this key: **{secret}**"
   toggle, with the key in groups of four for readability. [Next]
3. **Enter a code.** Call `POST /auth/mfa/totp/confirm` with `{ code }`.
   On `INVALID_MFA_CODE`: "That code didn't work. Make sure your phone's time is set
   automatically, then try the newest code."
4. **Save your recovery codes.** Show the 10 `recoveryCodes` in a grid, with "Download
   .txt", "Copy" and "Print" buttons and a required checkbox *"I've saved these
   somewhere safe"*. **They can never be shown again.** Disable "Done" until the box is
   ticked.

Leaving the wizard between steps 2 and 3 is safe: 2FA isn't on until step 3. Running setup
again replaces the pending key.

**Generate new recovery codes** calls `POST /auth/mfa/recovery-codes` (step-up). Show them
using the same step 4 screen. The old codes stop working.

**Turn off** calls `DELETE /auth/mfa` (step-up). Confirm first: *"Turn off two-factor
authentication? Your account will only be protected by your password."*

Locoomo emails the user whenever 2FA is turned on or off.

### 6.2 Where you're signed in

`GET /auth/sessions` returns a list, newest first.

```
💻 Chrome on Windows · Lagos · 102.89.4.10      Active now     (This device)
📱 Safari on iPhone · 102.89.7.22               2 days ago     [Sign out]
                                                [Sign out of all other devices]
```

- Build the label by parsing `userAgent` (e.g. with `ua-parser-js`). Use `lastActiveAt`
  as a relative time.
- **Sign out** a row: `DELETE /auth/sessions/:id`. It takes effect immediately on that
  device.
- **Sign out of all other devices**: `POST /auth/sessions/revoke-others`, which returns
  `{ revoked: n }`. Toast: "Signed out of {n} other devices."
- Signing out the `current` row is the same as logging out. Clear local state and go to
  sign-in.

---

## 7. Email verification banner ✅

Users can sign in before verifying their email. Merchant screens (🛠) require a verified
email and answer `403 EMAIL_NOT_VERIFIED` otherwise.

When `user.emailVerifiedAt === null`, show a persistent banner on merchant screens (on
other apps it's optional):

> 📧 Verify your email to continue. We sent a link to **ada@example.com**. [Resend email]

**Resend** calls `POST /auth/verify-email/resend`, 3 per minute. Show "Sent. Check your
inbox (and spam)." On `409 EMAIL_ALREADY_VERIFIED`, refresh the user (`GET /users/me`) and
hide the banner. Each resend invalidates earlier links.

The link in the email opens `{FRONTEND_URL}/verify-email?token=…`. Your page calls the
existing `POST /auth/verify-email` with `{ token }`. That flow is unchanged.

---

## 8. Admin app

### 8.1 Mandatory 2FA ✅

Every admin must turn on 2FA. Existing admins have **14 days from release**; new admins
have 14 days from their invite.

- After sign-in, call `GET /auth/mfa`. If `required && !enabled`, show the countdown
  banner from §6.1 on every page.
- After the deadline, every admin route answers **`403 MFA_ENROLLMENT_REQUIRED`**.
  Intercept it globally and route to the 2FA setup wizard. These keep working during the
  lockout: `/users/me`, everything under `/auth/`, and logout.
- Admins can't turn 2FA off: no "Turn off" button when `required` is true.

### 8.2 Permissions ✅

Admins now have **permissions** on top of the admin role. Existing screens keep working
for every admin. Newer screens (merchant review, money moves) need a specific permission
and otherwise answer `403 FORBIDDEN`.

| Permission | Show to the admin as |
|---|---|
| `super` | **Full access**: everything, including managing other admins |
| `kyc` | Merchant verification (KYC review) |
| `finance` | Money: wallets, adjustments, claims, refunds, pricing |
| `ops` | Operations: reroutes, suspensions, hubs, exceptions |
| `support` | Support tools |

**Admins screen** (only for `super`; others get `403` from `GET /admin/admins`, so hide
the menu item):

- `GET /admin/admins` lists admins with checkboxes for each permission.
- Saving calls `PATCH /admin/admins/:id/permissions` with the **full** set:
  `{ "permissions": ["finance", "ops"] }`. Changes apply within seconds; no re-login
  needed.
- Render "Full access" as a separate toggle that greys out the others (super implies
  them).
- `409 LAST_SUPER_ADMIN`: "Give someone else full access first. There must always be at
  least one."

To hide menu items an admin can't use, load their own permissions from `GET /admin/admins`
if they're `super`. Otherwise just handle the `403` gracefully. The server is the source of
truth.

Every existing admin was given **Full access** at release. Narrow them down from this
screen.

### 8.3 Approvals queue (two-admin rule) ✅

Money moves and other risky actions are **requested** by one admin and **approved** by a
different one before they happen. Requests are raised from the screens where the actions
live (for example, a wallet adjustment on a merchant's page, coming with the merchant
platform). This queue is where the second admin decides.

```
Approvals                                          [Pending ▾]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Credit ₦25,000.00 to Ada Stores                            expires in 6 days │
│ “Goodwill credit for delayed parcel LCM-4F2K-9XPT” · requested by Bola · 2h   │
│                                         [Reject]  [Approve]                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

- List: `GET /admin/approvals?status=pending&page=1&limit=20`, oldest first. Any admin can
  view it.
- **Approve**: `POST /admin/approvals/:id/approve` with an optional `{ note }`. The action
  runs immediately and the result comes back with status `executed`.
- **Reject**: `POST /admin/approvals/:id/reject` with a **required** `{ note }` (3–1000
  chars). The requester sees the reason.
- **Cancel** (only on your own requests): `POST /admin/approvals/:id/cancel`.
- Requests left undecided for **7 days** expire.

| Error | Show |
|---|---|
| `403 SELF_APPROVAL_NOT_ALLOWED` | "You raised this request. A different admin must approve it." Better: hide Approve when `requestedByUserId === me.id` and show Cancel instead |
| `403 FORBIDDEN` | "You don't have permission to approve this kind of request." |
| `409 APPROVAL_NOT_PENDING` | "Already {status}." Then refresh the list |

---

## 9. Merchant dashboard 🛠 (next)

The merchant dashboard is a **new app** for businesses that ship through Locoomo: Temu,
Konga and Jiji sellers. Integrators' servers and your dashboard call **the same
`/api/v1/merchant/*` endpoints**. Their servers use API keys; the dashboard uses the
normal cookie session. So [MERCHANT_API.md](MERCHANT_API.md) is your endpoint
reference too.

### 9.1 Hosting and auth

- **Host it same-site with the API**, e.g. `merchant.locoomo.com`. Session cookies are
  `SameSite=Strict`, so a different registrable domain won't work.
- Sign-in, 2FA, step-up, sessions and verify-email are exactly the flows in §4–§7. Merchant
  users are ordinary Locoomo accounts. Anyone can create a merchant, or join one by
  invite.
- **Every merchant request sends `Locoomo-Mode: test` or `Locoomo-Mode: live`**, driven by
  a Test/Live toggle in the header. Default to `test` until the merchant is approved. A
  missing header means `test`.
- Merchant routes need a verified email (`403 EMAIL_NOT_VERIFIED` → §7).

### 9.2 Screens, in build order

| # | Screen | Purpose | Ships |
|---|---|---|---|
| 1 | Sign up / sign in / verify email / 2FA | §4–§7 | ✅ now |
| 2 | **Create business** | Business or individual seller, store name | next |
| 3 | **Onboarding checklist** | Profile, CAC (business only), owner/director ID, bank account, terms, then Submit. Shows `changes_requested` reasons per item | next |
| 4 | Home | Test/Live toggle, status banner (draft / in review / changes requested / approved / suspended), KPIs, go-live checklist | next |
| 5 | Team | Invite by email with a role, change roles (step-up), remove, transfer ownership | next |
| 6 | Developers › API keys | Create, roll and revoke test/live keys; the secret is shown **once**; live keys need step-up and 2FA | after |
| 7 | Developers › Webhooks | Endpoints, events, signing secret (shown once), delivery log, replay, send test | after |
| 8 | Developers › API logs | Recent requests by key: status, latency, correlation id | after |
| 9 | Shipments | List and filter, detail and timeline, create form, CSV import with row errors, cancel, return to sender, label PDF | after |
| 10 | Manifests | Group shipments for a hub drop, QR/PDF for the driver | after |
| 11 | Returns to collect | Parcels back at the hub, collection code per batch | after |
| 12 | Wallet | Balance, held funds, card top-up, bank-transfer account details, statement, invoices | after |
| 13 | Claims | Lost or damaged claims and their status | after |
| 14 | Test simulator | Move a test shipment through each status and watch webhooks fire | after |
| 15 | Audit log | Who did what in the team | after |

Screens 2–5 ship next. Each screen's request and response samples land in
[MERCHANT_API.md](MERCHANT_API.md) when its backend ships. Start with layouts and
navigation now.

### 9.3 Team roles: hide what a member can't do

| Can… | owner | admin | developer | operations | finance | viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| See shipments, returns, reports | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create/cancel shipments, manifests, CSV, claims | ✓ | ✓ | ✓ | ✓ | | |
| Return-batch collection codes | ✓ | ✓ | | ✓ | | |
| API keys, webhooks, API logs | ✓ | ✓ | ✓ | | | |
| Wallet top-up, statements, invoices | ✓ | ✓ | | | ✓ | |
| Bank, KYC, profile, settings | ✓ | ✓ | | | | |
| Team management | ✓ | ✓ | | | | |
| Transfer ownership, close account | ✓ | | | | | |

The server enforces this. The table is for hiding buttons.

### 9.4 Admin app additions 🛠

- **Merchants queue**: submitted merchants oldest first, with SLA age (`kyc` permission).
- **Merchant review**: profile, documents (open in a viewer; links expire in 5 minutes and
  each view is logged), bank name match score, directors, and an accept/reject toggle per
  item with a reason. Actions: Approve (tier, limits, hubs), Request changes, Reject.
- **Merchant 360** (read-only support view): status, team, keys (metadata only, never
  secrets), webhook health, wallet, shipments, audit log. There's no "log in as merchant";
  this view replaces it.
- **All orders**: a new cross-app order list (consumer and merchant) with filters.
- **Reroutes**: parcels whose destination Node is full or closed. Pick one of the 3 nearest
  suggested Nodes (`ops`).

---

## 10. Error codes

New in this release (✅). The full list is in [API.md › Error codes](API.md#error-codes-reference).

| HTTP | code | Where | What the UI does |
|---|---|---|---|
| 400 | `MALFORMED_JSON` | any | Generic error (it's a client bug) |
| 413 | `PAYLOAD_TOO_LARGE` | any | "That's too large to upload in one go." |
| 403 | `CSRF_HEADER_MISSING` | any non-GET | Not reachable once §2 is done (enforcement comes later) |
| 401 | `INVALID_MFA_CODE` | 2FA verify, confirm, reauth | Inline "That code didn't work" |
| 401 | `INVALID_MFA_CHALLENGE` | `/auth/mfa/verify` | Back to the password screen |
| 403 | `REAUTH_REQUIRED` | sensitive actions | "Confirm it's you" dialog, then retry (§5) |
| 403 | `MFA_ENROLLMENT_REQUIRED` | admin routes | Route to the 2FA setup wizard |
| 403 | `MFA_REQUIRED_FOR_ROLE` | `DELETE /auth/mfa` | Hide "Turn off" for admins |
| 403 | `EMAIL_NOT_VERIFIED` | merchant routes | Verify-email banner (§7) |
| 409 | `MFA_ALREADY_ENABLED` / `MFA_NOT_ENABLED` / `MFA_SETUP_NOT_STARTED` | 2FA settings | Refresh `GET /auth/mfa` |
| 409 | `EMAIL_ALREADY_VERIFIED` | resend | Refresh the user and hide the banner |
| 409 | `LAST_SUPER_ADMIN` | admin permissions | See §8.2 |
| 403 | `SELF_APPROVAL_NOT_ALLOWED` | approvals | See §8.3 |
| 409 | `APPROVAL_NOT_PENDING` | approvals | Refresh the list |
| 400 | `INVALID_IDEMPOTENCY_KEY` | idempotent POSTs | Bug: send a UUID |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | idempotent POSTs | Retry after ~1 s with the same key |
| 422 | `IDEMPOTENCY_KEY_REUSED` | idempotent POSTs | Bug: new key per action |

---

## 11. Testing locally

- **2FA without a phone**: during setup, take `secret` from the response and generate codes
  with `oathtool --totp -b <secret>` (package `oath-toolkit`), or add it manually to an
  authenticator app.
  Codes rotate every 30 seconds, and a code can't be used twice.
- **Admin lockout**: ask backend to set `mfaRequiredSince` 15 days in the past for your dev
  admin. That makes the `MFA_ENROLLMENT_REQUIRED` flow reproducible.
- **CSRF**: watch the API logs for `[CSRF report] … without the x-locoomo-client header`.
  When your app produces none, tell backend your app is ready for enforcement.
- **Sessions**: sign in from two browsers, revoke one from the other, and the revoked tab
  gets `401` on its next request.
- Include `X-Correlation-Id` (response header, also in every error body) in bug reports.
