# Merchant Platform: Frontend Guide

**For:** the Locoomo frontend team.
**Covers:** everything you build for the merchant platform, in one place:

- the shared foundations every app needs (HTTP client, sign-in with 2FA, "Confirm it's you");
- the **merchant dashboard**, screen by screen;
- the **admin app** screens that review and manage merchants.

Every endpoint, request and response shape, TypeScript type, error code and piece of UI copy
you need is in this document. You shouldn't need to open another doc. (If you're curious:
[API.md](API.md) is the full backend reference and [MERCHANT_API.md](MERCHANT_API.md) is the
public contract for merchants' developers. This guide wins if they ever disagree on
something UI-related; tell backend.)

**Status markers**

| Marker | Meaning |
|---|---|
| ✅ | Ready. Built, tested and deployed to staging. Build against it now |
| 🛠 | Coming. The contract is agreed but the endpoint isn't there yet. Build the screen against the documented shape behind a feature flag, and mock the calls |

---

## Contents

**Part A: Foundations**
1. [What you're building](#1-what-youre-building)
2. [Environments and hosting](#2-environments-and-hosting)
3. [The HTTP client](#3-the-http-client)
4. [Sign-in, 2FA and "Confirm it's you"](#4-sign-in-2fa-and-confirm-its-you)

**Part B: Merchant dashboard**
5. [First load, roles and the status banner](#5-first-load-roles-and-the-status-banner)
6. [Create business](#6-create-business)
7. [Onboarding checklist (KYC)](#7-onboarding-checklist-kyc)
8. [Team and accept-invite](#8-team-and-accept-invite)
9. [Developers › API keys and API logs](#9-developers--api-keys-and-api-logs)
10. [Developers › Webhooks](#10-developers--webhooks)
11. [Test / Live mode](#11-test--live-mode)
12. [Shipments](#12-shipments)
13. [Test simulator](#13-test-simulator)
14. [Settings › Close account](#14-settings--close-account)
15. [Wallet](#15-wallet)
16. [Coming next 🛠](#16-coming-next-)

**Part C: Admin app**
17. [Admin foundations: mandatory 2FA, permissions, approvals](#17-admin-foundations-mandatory-2fa-permissions-approvals)
18. [Merchants: queue, review and account controls](#18-merchants-queue-review-and-account-controls)
19. [Operations tools that affect merchant parcels](#19-operations-tools-that-affect-merchant-parcels)

**Reference**
20. [All TypeScript types](#20-all-typescript-types)
21. [Error codes](#21-error-codes)
22. [Endpoint index](#22-endpoint-index)
23. [Testing locally and on staging](#23-testing-locally-and-on-staging)

---

# Part A: Foundations

## 1. What you're building

**Who are merchants?** Any business or person that sends parcels to their buyers through
Locoomo. There are two broad kinds, and the dashboard serves both:

- **Large platforms and retailers** (for example Temu or Konga) that integrate Locoomo into
  their own checkout and systems through our API. They send parcels in bulk.
- **Registered businesses and individual sellers** (a small online shop, a Jiji seller, an
  Instagram vendor) who mostly create shipments by hand in the dashboard. Individuals can
  join without a CAC registration.

**How a merchant parcel moves:**

1. **The buyer picks a Node at checkout.** A Node is a Locoomo pickup point (a partner
   shop). The merchant's checkout shows Locoomo's Nodes and prices through our API.
2. **The merchant creates a shipment.** Its fee is held from the merchant's **prepaid
   wallet**. There is no cash on delivery: the buyer has already paid the merchant.
3. **The merchant drops the parcel off.** Small sellers drop it at any Node. Large merchants
   bulk-drop at an assigned **hub** (coming later). The fee is charged at drop-off, after the
   parcel is measured.
4. **Locoomo moves it to the buyer's Node** and tells the buyer it's ready.
5. **The buyer collects it** with a one-time code, or with photo ID if they've lost the code.
   They have 7 working days.
6. **If the buyer doesn't collect it**, the parcel goes back to where the merchant dropped
   it, and the merchant collects it from there.

**How merchants use Locoomo.** Two ways, and they share the same backend:

- **Their developers call our API with API keys** from their own systems. That's not your
  work, but the dashboard is where they create those keys, set up webhooks and read the API
  logs.
- **Their staff use the merchant dashboard**, which you build. It signs in with an ordinary
  Locoomo account (cookie session) and calls the same `/merchant/...` endpoints as the API.

**The merchant's journey, and the screen for each step:**

```
Sign up / sign in ─► Verify email ─► Create business ─► Onboarding checklist ─► Submit
   (§4)                 (§4.5)          (§6)              (§7)                    │
                                                                                  ▼
       Build in Test mode meanwhile: API keys, webhooks, test shipments    Locoomo reviews
                     (§9, §10, §12, §13)                                  in the admin app (§18)
                                                                                  │
                                                       approved ◄─────────────────┤
                                                          │        changes requested ─► fix and resubmit
                                                          ▼
                                     Live keys, then live shipments and the wallet (🛠, §16)
```

**Build order for the dashboard**

| # | Screen | Section | Status |
|---|---|---|---|
| 1 | Sign up, sign in, verify email, 2FA, "Confirm it's you" | §4 | ✅ |
| 2 | Create business | §6 | ✅ |
| 3 | Onboarding checklist | §7 | ✅ |
| 4 | Home: status banner and checklist progress | §5 | ✅ (KPIs and go-live checklist 🛠) |
| 5 | Team, and the accept-invite page | §8 | ✅ |
| 6 | Developers › API keys, API logs | §9 | ✅ |
| 7 | Developers › Webhooks | §10 | ✅ |
| 8 | Test / Live toggle | §11 | ✅ |
| 9 | Shipments: list, create, detail with timeline, edit, cancel, return (test and live) | §12 | ✅ (labels ✅; CSV import 🛠) |
| 10 | Test simulator on the shipment detail page | §13 | ✅ |
| 11 | Settings › Close account | §14 | ✅ |
| 12 | Wallet: balance, statement, holds, card top-up, bank-transfer account, test reset | §15 | ✅ |
| 13 | Manifests, returns, claims, audit log, go-live checklist | §16 | 🛠 |

**Admin app screens**

| Screen | Section | Status |
|---|---|---|
| Mandatory 2FA, Admins (permissions), Approvals | §17 | ✅ |
| Merchants queue, review, suspend/reinstate, settings | §18 | ✅ |
| Public holidays, lost/damaged parcel | §19 | ✅ |
| Merchant wallet panel and adjustments | §18.6 | ✅ |
| Merchant 360 support view | §18.7 | 🛠 |

---

## 2. Environments and hosting

| Environment | API origin | Consumer app | Merchant dashboard |
|---|---|---|---|
| Production | `https://api.locoomo.com` | `https://app.locoomo.com` | `https://merchant.locoomo.com` (DNS not created yet) |
| Staging | `https://api-loccomo.up.railway.app` | `https://staging.locoomo.com` | Your choice, e.g. `https://merchant-staging.locoomo.com` |

All endpoints live under `{API origin}/api/v1`. Paths in this guide leave that prefix out:
`GET /merchant/account` means `GET https://api.locoomo.com/api/v1/merchant/account`.

**Hosting rules**

- **Host the dashboard on the same site as the API**, e.g. `merchant.locoomo.com`. Session
  cookies are `httpOnly` and `SameSite=Strict`, so the browser only sends them to the API from
  a page on `locoomo.com`.
- **Tell backend the dashboard's origin** before you deploy it. Backend adds it to
  `CORS_ORIGIN` (or the browser blocks your requests) and sets it as `MERCHANT_DASHBOARD_URL`
  (links in invite and notification emails point there).
- **Staging caveat.** The staging API is on `*.up.railway.app`, a different site from
  `*.locoomo.com`, so cookies set by it are **not sent** from a `locoomo.com` page. Until
  backend moves staging to a `locoomo.com` subdomain (e.g. `api-staging.locoomo.com`), run
  the dashboard on `localhost` against staging (see §23) or ask backend for the subdomain.

---

## 3. The HTTP client

### 3.1 Setup

```ts
import axios, { AxiosError } from 'axios';

export const api = axios.create({
  baseURL: `${import.meta.env.VITE_API_ORIGIN}/api/v1`,
  withCredentials: true,                    // send the httpOnly session cookies
  headers: { 'X-Locoomo-Client': 'web' },   // CSRF header, see below
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

**`X-Locoomo-Client: web` on every non-GET request** is CSRF protection. Any non-empty value
works. Today the API only logs requests that miss it; once every app sends it, they'll be
refused with `403 CSRF_HEADER_MISSING`. Put it in the client defaults and forget about it.

### 3.2 The response envelope

Every response is wrapped. Success:

```json
{
  "success": true,
  "data": { "...": "the thing you asked for" },
  "meta": { "correlationId": "b1f2c3d4-…", "timestamp": "2026-11-14T09:14:00.000Z" }
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "correlationId": "b1f2c3d4-…",
    "details": [
      { "field": "receiver.phone", "constraint": "isPhoneE164", "message": "receiver.phone must be a valid phone number" }
    ]
  }
}
```

- **Branch on `error.code`.** It's stable. `error.message` is human copy and may change.
- `details` is usually the list of field errors on `400 VALIDATION_FAILED`. `field` is the full
  path (`address.city`, `items[3].receiver.phone`): map it to your form inputs. A few errors
  put an **object** in `details` instead (for example `ONBOARDING_INCOMPLETE`,
  `MFA_REQUIRED_FOR_LIVE_KEYS`); those are called out where they happen.
- `correlationId` is also in the `X-Correlation-Id` response header. Show it in "Report a
  problem" and in error toasts that say "Contact support".

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
    correlationId: body?.error.correlationId,
    retryAfter: Number(err.response?.headers['retry-after']) || undefined,
  };
}
```

**Conventions in every response**

| | |
|---|---|
| Money | Integer **kobo**, field names end in `Kobo`. `434400` is ₦4,344.00. Format with `(kobo / 100).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' })` |
| Time | ISO-8601 UTC strings. Show them in the user's local time. Deadlines (collection, drop-off) are end of day **Lagos time** |
| Phone numbers | We accept any Nigerian format and return E.164 (`+2348031234567`) |
| Ids | UUIDs |
| Unknown fields in a request body | Rejected with `400 VALIDATION_FAILED`. Send only the documented fields |
| Body size | 1 MB max (`413 PAYLOAD_TOO_LARGE`) |

### 3.3 Order of error handling

Handle errors in this order, in one place:

1. **`401`**: call `POST /auth/refresh` once, then retry the request. If refresh fails, clear
   local state and go to sign-in. A `401` can happen at any time: signing out a device or
   resetting a password ends sessions **immediately**.
2. **`403 REAUTH_REQUIRED`**: open "Confirm it's you", then retry ([§4.3](#43-confirm-its-you-step-up-)).
3. **`403 MFA_ENROLLMENT_REQUIRED`** (admin app): route to the 2FA setup wizard.
4. **`403 EMAIL_NOT_VERIFIED`** (dashboard): show the verify-email banner ([§4.5](#45-verify-email-banner-)).
5. **`503 MERCHANT_PLATFORM_DISABLED`** (dashboard): Locoomo switched merchant services off.
   Full-page "We'll be right back." and retry every minute.
6. **`429 RATE_LIMITED`**: wait `Retry-After` seconds. Show "Too many requests. Try again in a
   moment."
7. Everything else: show `message`, or field errors from `details`.

### 3.4 Safe retries with `Idempotency-Key`

Merchant `POST`s that create things (shipments, bulk shipments) accept an `Idempotency-Key`
header. Generate **one key per user action**, and reuse it when you retry that action:

```ts
const key = crypto.randomUUID();                 // when the user clicks "Create"
await api.post('/merchant/shipments', body, { headers: { 'Idempotency-Key': key } });
// network error or timeout? retry with the SAME key: the shipment is created once
```

| Response | Meaning |
|---|---|
| Normal success + header `Idempotent-Replayed: true` | Your earlier attempt worked; this is its result |
| `409 IDEMPOTENCY_IN_PROGRESS` | The first attempt is still running. Wait ~1 s and retry |
| `422 IDEMPOTENCY_KEY_REUSED` | Same key, different body. That's a bug: one key per action |

Keys are remembered for 24 hours. A failed first attempt can be retried with the same key.

### 3.5 Pagination

Two styles, depending on the endpoint:

- **Cursor** (shipments, API logs, webhook deliveries, Nodes):
  `?limit=50&cursor=…` → `{ items, nextCursor, hasMore }`. Pass `nextCursor` back as `cursor`
  until `hasMore` is `false`. Use infinite scroll or a "Load more" button, not page numbers.
  `400 INVALID_CURSOR` means the cursor was altered: reload from the top.
- **Pages** (admin lists): `?page=1&limit=20` → `{ items, page, limit, total }`.

### 3.6 Headers you can read

The API exposes these response headers to browser code: `X-Correlation-Id`,
`Idempotent-Replayed`, `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset`. Request headers you may send: `Content-Type`, `Authorization`,
`X-Correlation-Id`, `X-Locoomo-Client`, `Idempotency-Key`, `Locoomo-Mode`.

---

## 4. Sign-in, 2FA and "Confirm it's you"

Merchant users are **ordinary Locoomo accounts**. The dashboard uses the same auth endpoints
as every other app. These flows apply to every Locoomo app, not just the dashboard.

### 4.1 Sign-in with two-factor authentication ✅

Endpoints: `POST /auth/register`, `POST /auth/login`, `POST /auth/google`,
`POST /auth/mfa/verify`, `POST /auth/refresh`, `POST /auth/logout`, `GET /users/me`.

`POST /auth/login` (and `POST /auth/google`) returns **either** the signed-in `User` (cookies
are set) **or** a 2FA challenge:

```json
{ "mfaRequired": true, "mfaToken": "eyJ…" }
```

```
[Email + password] ──POST /auth/login──► User ──────────────────────────► signed in
                                     └─► { mfaRequired, mfaToken } ─────► [Enter code]
[Google button] ──POST /auth/google──► (same two outcomes)                      │
                                                                                ▼
                         POST /auth/mfa/verify { mfaToken, code } or { mfaToken, recoveryCode }
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

**"Enter your code" screen**

- Heading: *"Enter the 6-digit code from your authenticator app"*.
- One numeric field: `inputMode="numeric"`, `autocomplete="one-time-code"`. Accept pasted
  codes with spaces.
- Link: *"Lost your phone? Use a recovery code"*. It switches to a text field for codes like
  `abcde-fghij` (case doesn't matter, the dash is optional).
- The challenge expires after **5 minutes** or **5 wrong codes**. Then send the user back to
  the password screen: *"That sign-in attempt expired. Please sign in again."*
- Each code works once. *"Try the newest code"* covers a code that was just used.

### 4.2 Security settings page ✅

One "Security" page in account settings.

**Two-factor authentication card.** Load with `GET /auth/mfa` → `MfaStatus`.

| State | Show |
|---|---|
| `enabled: false`, `required: false` | "Two-factor authentication: **Off**" and a "Turn on" button |
| `enabled: false`, `required: true` | Warning: "Two-factor authentication is required for your account. Set it up by **{enrollmentDeadline}**." and "Set up now" |
| `enabled: true` | "**On** since {confirmedAt}", "Recovery codes: {recoveryCodesRemaining} left", "Generate new recovery codes", and "Turn off" **only if** `required` is `false`. Warn when 2 or fewer codes remain |

In the dashboard, add a line under the card for owners and developers: *"Live API keys need
two-factor authentication on your account and the owner's."*

**Turn-on wizard**

1. **Install an app.** "Use Google Authenticator, Microsoft Authenticator, Authy or
   1Password." [Continue]
2. **Scan.** `POST /auth/mfa/totp/setup` (needs step-up, handled by §4.3) →
   `{ secret, otpauthUrl, qrDataUrl }`. Show `<img src={qrDataUrl} alt="QR code">` and a
   "Can't scan? Enter this key: **{secret}**" toggle, with the key in groups of four. [Next]
3. **Enter a code.** `POST /auth/mfa/totp/confirm { code }` → `{ recoveryCodes: string[] }`.
   On `INVALID_MFA_CODE`: "That code didn't work. Make sure your phone's time is set
   automatically, then try the newest code."
4. **Save your recovery codes.** Show the 10 codes in a grid with "Download .txt", "Copy" and
   "Print", and a required checkbox *"I've saved these somewhere safe"*. **They can never be
   shown again.** Disable "Done" until it's ticked.

Leaving between steps 2 and 3 is safe: 2FA isn't on until step 3. Running setup again replaces
the pending key.

- **Generate new recovery codes**: `POST /auth/mfa/recovery-codes` (step-up) →
  `{ recoveryCodes }`. Show them with the step-4 screen. The old codes stop working.
- **Turn off**: `DELETE /auth/mfa` (step-up). Confirm first: *"Turn off two-factor
  authentication? Your account will only be protected by your password."*
- Locoomo emails the user whenever 2FA is turned on or off.

**Where you're signed in.** `GET /auth/sessions` → `Session[]`, newest first.

```
💻 Chrome on Windows · 102.89.4.10       Active now     (This device)
📱 Safari on iPhone · 102.89.7.22        2 days ago     [Sign out]
                                         [Sign out of all other devices]
```

- Build the label from `userAgent` (e.g. with `ua-parser-js`); show `lastActiveAt` as a
  relative time.
- **Sign out** a row: `DELETE /auth/sessions/:id`. It takes effect immediately on that device.
- **Sign out of all other devices**: `POST /auth/sessions/revoke-others` → `{ revoked: n }`.
  Toast: "Signed out of {n} other devices."
- Signing out the `current` row is the same as logging out.

### 4.3 "Confirm it's you" (step-up) ✅

Sensitive actions require the user to have proven who they are in the **last 10 minutes**. A
normal sign-in counts, so most users never see the prompt right after signing in. Otherwise
the API answers `403 REAUTH_REQUIRED`.

In the dashboard that's: setting the bank account, changing a member's role, transferring
ownership, closing the account, creating/rolling/editing **live** API keys, changing a webhook
URL and rolling a webhook secret. Also 2FA setup, recovery codes and turning 2FA off.
**Don't hard-code this list.** React to the error code with one interceptor:

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

**The dialog.** Ask for the strongest factor the account has (`GET /auth/mfa`, cached per
session):

| `MfaStatus.enabled` | User signs in with | Show | Send to `POST /auth/reauth` |
|---|---|---|---|
| `true` | anything | 6-digit code field + "use a recovery code" link | `{ code }` or `{ recoveryCode }` |
| `false` | password | Password field | `{ password }` |
| `false` | Google only | "Continue with Google" (same Google account) | `{ googleIdToken }` |

If you don't know whether the user has a password, show the password field with a "Continue
with Google instead" link.

On `200` the API sets a fresh cookie and returns `{ reauthenticatedUntil }`. Close the
dialog; the interceptor retries. On `401 INVALID_CREDENTIALS` or `INVALID_MFA_CODE`, show the
error in the dialog and let them try again (5 attempts per minute).

Copy: title *"Confirm it's you"*, body *"For your security, confirm your identity to
continue."*

### 4.4 Treat `401` as signed out

Covered by §3.3. Signing out a device, revoking other sessions or resetting a password ends
those sessions on their **next** request.

### 4.5 Verify-email banner ✅

Users can sign in before verifying their email, but **every merchant route needs a verified
email** and answers `403 EMAIL_NOT_VERIFIED` otherwise.

When `user.emailVerifiedAt === null`, show a persistent banner on every dashboard screen:

> 📧 Verify your email to continue. We sent a link to **ada@example.com**. [Resend email]

- **Resend**: `POST /auth/verify-email/resend` (3 per minute). Toast "Sent. Check your inbox
  (and spam)." On `409 EMAIL_ALREADY_VERIFIED`, refetch `GET /users/me` and hide the banner.
  Each resend invalidates earlier links.
- The email links to `{FRONTEND_URL}/verify-email?token=…`. That page calls
  `POST /auth/verify-email { token }`.

---

# Part B: Merchant dashboard

## 5. First load, roles and the status banner

### 5.1 Rules that apply to every dashboard screen

- **One merchant per user.** A user either has no merchant, or belongs to exactly one, as its
  owner or as a team member.
- **Verified email required** on every merchant route (§4.5).
- **Locoomo admin accounts can't use the dashboard**: `403 ADMINS_CANNOT_JOIN_MERCHANTS`.
  Show "Use a non-admin account for the merchant dashboard."
- `503 MERCHANT_PLATFORM_DISABLED`: full-page "We'll be right back", retry every minute.

### 5.2 Boot: where does this user go?

```ts
async function bootMerchantApp(): Promise<'create' | 'home'> {
  try {
    const overview = await api.get<MerchantAccountOverview>('/merchant/account');
    store.setOverview(overview);
    return 'home';
  } catch (e) {
    const err = e as AppError;
    if (err.code === 'NOT_A_MERCHANT_MEMBER') return 'create';   // §6
    if (err.code === 'EMAIL_NOT_VERIFIED') { showVerifyEmailBanner(); throw err; }
    throw err;
  }
}
```

If the user arrived from an invite link, go to the accept-invite page (§8.3) instead of
"Create business".

**`GET /merchant/account`** (any member) returns the whole account overview: the merchant,
your role and permissions, the onboarding checklist, documents, directors and bank account.

```json
{
  "merchant": {
    "id": "uuid",
    "type": "business",
    "status": "changes_requested",
    "tradingName": "Ada Stores",
    "legalName": "Ada Stores Limited",
    "category": "fashion",
    "storeUrl": "https://adastores.ng",
    "expectedMonthlyVolume": "up_to_10k",
    "contactEmail": "ops@adastores.ng",
    "contactPhone": "+2348031234567",
    "address": { "line1": "1 Allen Avenue", "line2": null, "city": "Ikeja", "state": "Lagos" },
    "cacNumber": "RC1234567",
    "tier": null,
    "limits": null,
    "receiverCodeRelay": false,
    "creationPaused": false,
    "terms": { "acceptedVersion": "2026-11-14", "acceptedAt": "2026-11-14T09:12:00.000Z", "currentVersion": "2026-11-14" },
    "submittedAt": "2026-11-14T09:15:00.000Z",
    "decidedAt": "2026-11-14T11:02:00.000Z",
    "decisionNote": "Almost there",
    "approvedAt": null,
    "suspendedAt": null,
    "suspensionReason": null,
    "closedAt": null,
    "createdAt": "2026-11-14T09:00:00.000Z",
    "updatedAt": "2026-11-14T11:02:00.000Z"
  },
  "me": {
    "memberId": "uuid",
    "role": "owner",
    "permissions": ["shipments.read", "shipments.write", "returns.collect", "developers.manage", "wallet.manage", "account.manage", "team.manage", "ownership"]
  },
  "onboarding": {
    "editable": true,
    "readyToSubmit": false,
    "items": [
      { "key": "profile", "complete": true, "missing": [], "review": { "decision": "accepted", "reason": null } },
      { "key": "business_registration", "complete": true, "missing": [], "review": null },
      { "key": "directors", "complete": true, "missing": [], "review": null },
      { "key": "bank_account", "complete": true, "missing": [], "review": { "decision": "rejected", "reason": "Use an account in the business name" } },
      { "key": "terms", "complete": true, "missing": [], "review": null }
    ]
  },
  "documents": [{ "id": "uuid", "kind": "cac_certificate", "uploadedAt": "2026-11-14T09:05:00.000Z" }],
  "directors": [{ "id": "uuid", "fullName": "Ada Okafor", "idType": "nin", "idNumberLast4": "8901", "createdAt": "2026-11-14T09:06:00.000Z" }],
  "bankAccount": { "bankCode": "058", "bankName": "GTBank", "accountNumberLast4": "6789", "accountName": "ADA STORES LIMITED", "verifiedAt": "2026-11-14T09:08:00.000Z" }
}
```

**Keep the overview in one store.** Profile, terms and submit calls all return the full
overview: **replace** the store with the response. The checklist, banner and `readyToSubmit`
then stay correct without refetching.

### 5.3 Roles and permissions: hide what a member can't do

Use **`me.permissions`**, not the role name, to show or hide controls:

| Can… | Permission | owner | admin | developer | operations | finance | viewer |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|
| See shipments, returns, reports | `shipments.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create, edit, cancel shipments; simulator; manifests, CSV, claims 🛠 | `shipments.write` | ✓ | ✓ | ✓ | ✓ | | |
| Return-batch collection codes 🛠 | `returns.collect` | ✓ | ✓ | | ✓ | | |
| API keys, API logs, webhooks | `developers.manage` | ✓ | ✓ | ✓ | | | |
| Wallet statement and holds; top-up and invoices 🛠 (the balance itself is visible to everyone) | `wallet.manage` | ✓ | ✓ | | | ✓ | |
| Profile, KYC, bank, terms, submit | `account.manage` | ✓ | ✓ | | | | |
| Team: invite, change roles, remove | `team.manage` | ✓ | ✓ | | | | |
| Transfer ownership, close account | `ownership` | ✓ | | | | | |

Hide nav items the member can't use (e.g. no "Developers" menu without `developers.manage`).
The server enforces it anyway: `403 MERCHANT_PERMISSION_DENIED` with
`details.permission`. Role changes apply on the member's next request, so if that `403`
surprises you, refetch `/merchant/account` and re-render.

### 5.4 Account status and the status banner

```
draft ──submit──► submitted ──► in_review ──► approved
  ▲                                   │
  └──── fix and resubmit ◄── changes_requested
                                      └──► rejected (final: the merchant can only close)

Locoomo can suspend from any status (and reinstate). The owner can close the account.
```

| `merchant.status` | Banner at the top of every screen | Onboarding details |
|---|---|---|
| `draft` | "Finish setting up to go live. You can use test mode meanwhile." | Editable |
| `submitted`, `in_review` | "We're reviewing your details, usually within one working day. Your details can't be changed until we're done." | Read-only |
| `changes_requested` | "We need a few changes before we can approve you." + `decisionNote` | Editable |
| `approved` | None (or a one-time "You're approved 🎉") | Names, CAC, directors and documents locked; contact details and bank account editable |
| `rejected` | "We couldn't approve this account." + `decisionNote` + a "Close account" button | Read-only |
| `suspended` | "Your account is suspended: {suspensionReason}. Contact your account manager." | Read-only. Team can sign in and read; no edits, no live keys or live shipments, no webhook changes |
| `closed` | (The user is no longer a member; they land on "Create business".) | — |

When `onboarding.editable` is `false`, render the checklist read-only.

---

## 6. Create business

**`POST /merchant/account`** (no membership needed). Creates the merchant with the caller as
**owner**, status `draft`.

```json
{ "type": "business", "tradingName": "Ada Stores" }
```

| Field | Rules |
|---|---|
| `type` | `business` (CAC-registered) or `individual` (sole seller, no CAC) |
| `tradingName` | 2–120 characters. The name buyers see |

Response `201`: the overview (§5.2). Error: `409 ALREADY_A_MERCHANT_MEMBER`.

**Screen.** Two big choices, then a name field:

- **"A registered business"** → `business`. Sub-copy: "You'll need your CAC certificate and RC/BN number."
- **"An individual seller"** → `individual`. Sub-copy: "Selling on your own? You'll need a government ID."

Then go straight to the onboarding checklist.

---

## 7. Onboarding checklist (KYC)

All write calls need `account.manage`.

### 7.1 The cards

One card per entry in `onboarding.items`, **in that order**. Individuals have no
`business_registration` card.

| `key` | Card title | What's in it |
|---|---|---|
| `profile` | Business profile | Legal name, trading name, category, store URL, monthly volume, contact email/phone, address |
| `business_registration` | CAC registration | CAC number and certificate (plus optional status report and proof of address) |
| `directors` | Directors' ID (business) / Your ID (individual) | One card per person with a government ID |
| `bank_account` | Settlement bank account | Bank and account number, verified with the bank |
| `terms` | Terms | Merchant terms and Data Processing Agreement |

Card state:

| Condition (check in this order) | Badge | Card text |
|---|---|---|
| `review?.decision === 'rejected'` | 🔴 Needs changes | Show `review.reason` prominently |
| `!complete` | ⚪ To do | "Still needed: …" from `missing` (map field names to labels) |
| `review?.decision === 'accepted'` | 🟢 Approved | — |
| otherwise | ✅ Done | — |

- `missing` names what's left, e.g. `legalName`, `address.city`, `documents.cac_certificate`,
  `directors`, `bankAccount`, `terms`. Keep a map from these to the labels on your form.
- **Editing a section clears its review** (`review` becomes `null`, "changed, waiting for
  review"). `readyToSubmit` is `false` while any section is incomplete or still rejected.

### 7.2 Profile

**`PATCH /merchant/account/profile`**. Every field optional: send what the form section
changed. Response `200`: the overview.

```json
{
  "legalName": "Ada Stores Limited",
  "category": "fashion",
  "storeUrl": "https://adastores.ng",
  "expectedMonthlyVolume": "up_to_10k",
  "contactEmail": "ops@adastores.ng",
  "contactPhone": "+2348031234567",
  "address": { "line1": "1 Allen Avenue", "line2": "Suite 4", "city": "Ikeja", "state": "Lagos" },
  "cacNumber": "RC1234567"
}
```

| Field | Rules | Label suggestion |
|---|---|---|
| `tradingName` | 2–120 chars. Locked once approved | "Trading name (what buyers see)" |
| `legalName` | 2–200 chars. The CAC name for businesses, the seller's full name for individuals. Locked once approved | Business: "Registered name (as on your CAC certificate)". Individual: "Your full name (as on your ID)" |
| `category` | 2–60 chars, free text | "What do you sell?" (suggest: fashion, electronics, beauty, home, food, other) |
| `storeUrl` | `http(s)://` URL | "Online store or social page" |
| `expectedMonthlyVolume` | `up_to_100`, `up_to_1k`, `up_to_10k`, `up_to_100k`, `over_100k` | "Parcels per month": Up to 100 / 1,000 / 10,000 / 100,000 / More |
| `contactEmail` | Email | "Contact email" |
| `contactPhone` | `+2348031234567` or `08031234567` | "Contact phone" |
| `address` | Whole object: `line1` (required), `line2`, `city`, `state` | "Business address" |
| `cacNumber` | Businesses only. `RC`, `BN` or `IT` + digits. Locked once approved | "RC / BN number" |

Errors: `409 MERCHANT_NOT_EDITABLE` (under review, rejected, suspended), `409
MERCHANT_DETAILS_LOCKED` with `details.fields` (approved: show "Contact your account manager to
change this." next to those fields), `422 NOT_APPLICABLE_TO_INDIVIDUALS` (CAC on an
individual).

### 7.3 Uploading files (CAC certificate, ID images)

Files go **straight to Cloudinary** as private uploads. They never pass through our API, and
they never get a public URL.

1. **`POST /merchant/account/uploads`** → a signature for **one** upload:

   ```json
   { "signature": "…", "timestamp": 1731575000, "apiKey": "…", "cloudName": "locoomo", "folder": "merchants/<merchantId>/kyc" }
   ```

2. Upload the file to Cloudinary with exactly those values.
3. Send the `public_id` Cloudinary returns to the documents or directors endpoint.

```ts
async function uploadKycFile(file: File): Promise<string> {
  const sig = await api.post<KycUploadSignature>('/merchant/account/uploads');

  const form = new FormData();
  form.append('file', file);
  form.append('api_key', sig.apiKey);
  form.append('timestamp', String(sig.timestamp));
  form.append('signature', sig.signature);
  form.append('folder', sig.folder);
  form.append('type', 'authenticated');          // private: never a public URL

  const res = await fetch(`https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`, {
    method: 'POST', body: form,                  // no credentials: this is Cloudinary
  });
  if (!res.ok) throw new Error('Upload failed');
  return (await res.json()).public_id as string;
}
```

- **One signature per file** (it's tied to a timestamp). Get a fresh one for each file.
- Accept JPG, PNG and PDF up to 10 MB. Check type and size in the browser first.
- Show upload progress; Nigerian mobile connections can be slow.
- `422 UPLOAD_NOT_FOUND` from the next step means the upload didn't land (or came from
  somewhere else): "Upload the file again."

### 7.4 CAC registration (businesses)

**`PUT /merchant/account/documents/:kind`** with `{ "publicId": "…" }` attaches or replaces a
document. Response `200`: `{ id, kind, uploadedAt }`.

| `kind` | Required? | Label |
|---|---|---|
| `cac_certificate` | Required (business) | "CAC certificate" |
| `cac_status_report` | Optional (business) | "CAC status report (optional)" |
| `proof_of_address` | Optional | "Proof of address (optional)" |

```ts
await api.put('/merchant/account/documents/cac_certificate', { publicId: await uploadKycFile(file) });
```

Show uploaded documents from `overview.documents` as "CAC certificate · uploaded {date}" with
a "Replace" button. You can't view or download them from the dashboard.

### 7.5 Directors' ID / Your ID

- **Business:** 1–10 directors. Card copy: "Add at least one director's government ID."
- **Individual:** exactly one, the seller. Card copy: "Your ID: must match the name you sell
  under."

**`POST /merchant/account/directors`** → `201 { id, fullName, idType, idNumberLast4, createdAt }`

```json
{ "fullName": "Ada Okafor", "idType": "nin", "idNumber": "12345678901", "idDocumentPublicId": "merchants/<merchantId>/kyc/nin" }
```

| Field | Rules | Label |
|---|---|---|
| `fullName` | 3–150 chars | "Full name (as on the ID)" |
| `idType` | `nin`, `passport`, `drivers_licence`, `voters_card` | NIN slip / International passport / Driver's licence / Voter's card |
| `idNumber` | 5–20 letters/digits | "ID number" |
| `idDocumentPublicId` | From §7.3 | "Photo of the ID" |

**`DELETE /merchant/account/directors/:id`** → `204`.

The ID number is stored encrypted; only the last 4 digits ever come back. Show
`{idType} •••• {idNumberLast4}` and never ask for the number again. To change it, delete and
re-add.

Errors: `409 DIRECTOR_LIMIT_REACHED` ("You can add up to 10 directors" / "Remove your current
ID first"), `409 MERCHANT_NOT_EDITABLE`, `409 MERCHANT_DETAILS_LOCKED`,
`422 UPLOAD_NOT_FOUND`.

### 7.6 Settlement bank account

1. Bank picker from **`GET /merchant/banks`** → `[{ "code": "058", "name": "GTBank" }, …]`.
   Make it searchable.
2. 10-digit account number field.
3. **`PUT /merchant/account/bank-account`** (needs **step-up**; your §4.3 interceptor
   handles it):

   ```json
   { "bankCode": "058", "bankName": "GTBank", "accountNumber": "0123456789" }
   ```

   Response `200`: `{ bankCode, bankName, accountNumberLast4, accountName, verifiedAt }`.

- `accountName` comes **from the bank**, not from the form. Show "Paid to: **{accountName}**"
  so the user can spot a wrong account.
- Allowed while onboarding **and** after approval. A change after approval emails the owner
  and admins.
- Copy hint: "Use an account in your business's name" (business) / "Use an account in your
  name" (individual).

Errors: `400 BANK_ACCOUNT_VERIFICATION_FAILED` → "We couldn't find that account. Check the
number and bank." `502 PAYMENT_PROVIDER_ERROR` → "We couldn't reach the bank. Try again in a
few minutes."

### 7.7 Terms

Show links to the merchant terms and the Data Processing Agreement for
`merchant.terms.currentVersion`, a checkbox *"I agree to the Merchant Terms and Data Processing
Agreement"*, then:

**`POST /merchant/account/terms`** `{ "version": "<merchant.terms.currentVersion>" }` →
`200` overview.

`409 TERMS_VERSION_OUTDATED` (`details.currentVersion`): the terms changed while the page was
open. Reload the terms and ask again.

### 7.8 Submit

"Submit for review" button, enabled when `onboarding.readyToSubmit`.

**`POST /merchant/account/submit`** → `200` overview (status `submitted`). The team and
Locoomo's reviewers are emailed.

- `422 ONBOARDING_INCOMPLETE` with `details.sections: [{ key, missing: [...] }]`: highlight
  those cards. A rejected-but-unchanged section shows `missing: ["changes requested by
  reviewer"]`.
- `409 INVALID_MERCHANT_TRANSITION`: someone else already submitted. Refetch.

After submitting, show: "Thanks! We usually review within one working day. We'll email you."

---

## 8. Team and accept-invite

### 8.1 Team screen

**`GET /merchant/team`** (any member):

```json
{
  "members": [
    { "id": "memberId", "userId": "uuid", "firstName": "Ada", "lastName": "Okafor", "email": "ada@adastores.ng", "role": "owner", "joinedAt": "…" }
  ],
  "invites": [
    { "id": "uuid", "email": "dev@adastores.ng", "role": "developer", "expiresAt": "…", "createdAt": "…" }
  ]
}
```

`invites` lists only open invitations (not accepted, revoked or expired).

| Action | Call | Who | Notes |
|---|---|---|---|
| Invite | `POST /merchant/team/invites { email, role }` → `201` invite | `team.manage` | `role`: `admin`, `developer`, `operations`, `finance`, `viewer` (never `owner`). Inviting the same email again re-sends with the new role. Expires in **7 days**. 20/min. `409 ALREADY_A_TEAM_MEMBER` |
| Revoke invite | `DELETE /merchant/team/invites/:id` → `204` | `team.manage` | |
| Change role | `PATCH /merchant/team/members/:id { role }` → `200` member | `team.manage` + **step-up** | Not on the owner row |
| Remove | `DELETE /merchant/team/members/:id` → `204` | `team.manage` | Not on the owner row |
| Leave team | `DELETE /merchant/team/members/me` → `204` | Anyone but the owner | Then send them to "Create business" |
| Transfer ownership | `POST /merchant/team/transfer-ownership { memberId }` → `204` | `ownership` + **step-up** | The new owner gets `owner`; you become `admin`. Confirm: "You'll no longer be able to close the account or transfer ownership." Then refetch `/merchant/account` |

The owner row has no controls (`409 OWNER_ROLE_PROTECTED` otherwise).

**Role descriptions for the invite dialog**

| Role | Description |
|---|---|
| Admin | Everything except transferring ownership and closing the account |
| Developer | API keys, webhooks, API logs; create and manage shipments |
| Operations | Create and manage shipments, collect returns |
| Finance | Wallet, statements and invoices; view shipments |
| Viewer | View only |

### 8.2 Invite email

The invite email links to `{MERCHANT_DASHBOARD_URL}/accept-invite?token=…`. Build that route.

### 8.3 Accept-invite page (`/accept-invite?token=…`)

1. **`POST /merchant/invites/preview { token }`** (works signed out, 10/min) →
   `{ merchantName, role, email, expiresAt }`. Show: "**{merchantName}** invited **{email}** to
   join as {role}."
   On `404 INVALID_MERCHANT_INVITE`: "This invitation has expired or was already used. Ask for
   a new one."
2. Not signed in? Offer sign-in, or sign-up **with that email**, then email verification, then
   come back to this URL. **Keep the token through the redirects** (put it in the `next` URL or
   session storage).
3. **`POST /merchant/invites/accept { token }`** → `{ merchantId, role }`. Go to home and run
   the boot (§5.2).

| Error | Copy |
|---|---|
| `403 INVITE_EMAIL_MISMATCH` | "This invitation is for {email}. Sign out and sign in with that address." |
| `409 ALREADY_A_MERCHANT_MEMBER` | "You're already on another business's team. Leave it first to join this one." |
| `404 INVALID_MERCHANT_INVITE` | As above |
| `403 EMAIL_NOT_VERIFIED` | Show the verify-email banner and keep them on this page |

---

## 9. Developers › API keys and API logs

Needs `developers.manage`. These screens are where merchants' developers get their keys.

### 9.1 What the keys are

| Kind | Prefix | Used from | Can do |
|---|---|---|---|
| Secret | `sk_test_…` / `sk_live_…` | The merchant's server | Everything the key's **scopes** allow |
| Publishable | `pk_test_…` / `pk_live_…` | The buyer's browser at checkout | Only list Nodes and get quotes (the Node picker) |

**Scopes** (secret keys only): `shipments:read`, `shipments:write`, `manifests:write`,
`webhooks:manage`, `wallet:read`, `claims:write`. Default: all except `webhooks:manage`.

| Scope | Checkbox label |
|---|---|
| `shipments:read` | Read shipments |
| `shipments:write` | Create and change shipments |
| `manifests:write` | Manifests (bulk drop-off) |
| `webhooks:manage` | Manage webhooks (off by default) |
| `wallet:read` | Read wallet balance |
| `claims:write` | File claims |

**Test keys** work right away, even before approval. **Live keys** (create, roll, edit) also
need:

- an **approved** account (`403 MERCHANT_NOT_APPROVED`; suspended → `403 MERCHANT_SUSPENDED`);
- **2FA on** for the person doing it **and** for the owner (`403 MFA_REQUIRED_FOR_LIVE_KEYS`
  with `details.who`: `"you"` or `"owner"`);
- **step-up** (the §4.3 interceptor handles it).

Revoking never needs step-up.

### 9.2 Key list

**`GET /merchant/api-keys?mode=test`** (`mode`: `test` default, or `live`). Active keys plus
keys revoked or expired in the last 30 days, newest first.

```json
[
  {
    "id": "uuid",
    "mode": "test",
    "kind": "secret",
    "name": "Production server",
    "displayKey": "sk_test_…a1B2",
    "scopes": ["shipments:read", "shipments:write", "manifests:write", "wallet:read", "claims:write"],
    "allowedIps": [],
    "allowedOrigins": [],
    "hidePrices": false,
    "state": "active",
    "expiresAt": null,
    "revokedAt": null,
    "lastUsedAt": "2026-11-14T10:01:00.000Z",
    "lastUsedIp": "203.0.113.7",
    "createdAt": "2026-11-14T09:00:00.000Z"
  }
]
```

**Screen layout**

- **Test / Live tabs.** Within each, two groups: *Secret keys* and *Publishable keys*.
- **Row:** `displayKey` (monospace), name, `state` badge, "Last used {lastUsedAt} from
  {lastUsedIp}" (or "Never used"), and a menu: Edit, Roll, Revoke.

  | `state` | Badge |
  |---|---|
  | `active` | Green "Active" |
  | `expiring` | Amber "Stops working {expiresAt}" (it was rolled) |
  | `expired` | Grey "Expired" |
  | `revoked` | Grey "Revoked" |

- **Live tab before approval:** replace the create button with "Live keys unlock when your
  account is approved." If 2FA is missing, show the `MFA_REQUIRED_FOR_LIVE_KEYS` message
  (below) up front.
- `lastUsedAt` updates at most once a minute.

### 9.3 Create a key

**`POST /merchant/api-keys`**

```json
{
  "mode": "test",
  "kind": "secret",
  "name": "Production server",
  "scopes": ["shipments:read", "shipments:write"],
  "allowedIps": ["203.0.113.0/24"]
}
```

| Field | Rules | UI |
|---|---|---|
| `mode` | `test` or `live` | From the current tab |
| `kind` | `secret` or `publishable` | Radio: "Secret key (for your server)" / "Publishable key (for your checkout page)" |
| `name` | 1–60 chars | "Name, e.g. Production server" |
| `scopes` | Secret only | Checklist, pre-ticked with the default |
| `allowedIps` | Secret only, ≤ 50 IPs or CIDR ranges. Empty = any | "Only allow these IP addresses (optional)", one per line |
| `allowedOrigins` | Publishable only, ≤ 50 exact origins like `https://shop.example.com`. Empty = any | "Only allow these websites (optional)" |
| `hidePrices` | Publishable only | Checkbox "Hide prices in checkout" |

Response `201`:

```json
{ "key": { "...": "as in the list" }, "secret": "sk_test_4fQ9…" }
```

**Show the secret once.** Open a modal with the full `secret`, a copy button, the warning
"You won't be able to see this key again. Store it somewhere safe, like a password manager or
your server's secrets.", and a button "I've stored it safely" that closes it. Don't keep the
secret in any store beyond that modal. Never log it or send it to analytics.

Errors: `409 API_KEY_LIMIT_REACHED` ("You have 20 active keys. Revoke an unused one first."),
`409 MERCHANT_NOT_EDITABLE`, plus the live-key errors:

| Error | Copy |
|---|---|
| `MERCHANT_NOT_APPROVED` | "Live keys unlock when your account is approved." |
| `MERCHANT_SUSPENDED` | "Your account is suspended. Contact your account manager." |
| `MFA_REQUIRED_FOR_LIVE_KEYS`, `details.who === 'you'` | "Turn on two-factor authentication to create live keys." + link to §4.2 |
| `MFA_REQUIRED_FOR_LIVE_KEYS`, `details.who === 'owner'` | "Ask the account owner to turn on two-factor authentication." |

### 9.4 Edit, roll, revoke

- **Edit:** **`PATCH /merchant/api-keys/:id`** with any of `name`, `scopes`, `allowedIps`,
  `allowedOrigins`, `hidePrices` → `200` key. Takes effect immediately. Live keys need
  step-up. `409 API_KEY_REVOKED` → refresh the list.
- **Roll** (replace a key, e.g. after a developer leaves): **`POST /merchant/api-keys/:id/roll
  { expireOldIn }`** → `201 { key, secret }`, the same show-once modal. Dialog: "Keep the old
  key working for: Don't (revoke now) / 1 hour / 24 hours / 7 days" → `now`, `1h`, `24h`,
  `7d`. The old key shows as `expiring` until then.
- **Revoke:** **`POST /merchant/api-keys/:id/revoke`** → `200` key with `state: "revoked"`.
  Confirm: "Revoke {name}? Anything using this key stops working immediately."
- **Revoke all live keys** (emergency, "a key leaked"): a red button at the bottom of the Live
  tab. **`POST /merchant/api-keys/revoke-all { mode: "live" }`** → `{ revoked: n }`. Confirm by
  making the user type the number of active live keys.

### 9.5 API logs

**`GET /merchant/api-logs?mode=test&outcome=errors&apiKeyId=…&limit=50&cursor=…`**: every
request made with the merchant's keys in the last **30 days**, newest first. Metadata only,
never request or response bodies.

```json
{
  "items": [
    {
      "id": "uuid",
      "apiKeyId": "uuid",
      "apiKeyName": "Production server",
      "method": "POST",
      "path": "/api/v1/merchant/shipments",
      "statusCode": 422,
      "durationMs": 48,
      "ip": "203.0.113.7",
      "correlationId": "b1f2c3d4-…",
      "createdAt": "2026-11-14T10:01:00.000Z"
    }
  ],
  "nextCursor": "eyJ0Ijoi…",
  "hasMore": true
}
```

- Table: time, method, path, status (red when ≥ 400), duration, key name, IP.
- Filters: Test/Live, "Errors only" toggle (`outcome=errors`), key picker (`apiKeyId`).
- Infinite scroll with `nextCursor` (`limit` 1–200).
- A copy button on `correlationId`: support asks for it.
- Dashboard (session) requests aren't logged here, only API-key requests.

---

## 10. Developers › Webhooks

Needs `developers.manage`. Webhooks are how a merchant's server hears about shipment changes.
Endpoints are **per mode**: send the `Locoomo-Mode` header (§11) so the screen shows the test
or live endpoints. Up to 5 endpoints per mode.

### 10.1 Endpoint list

**`GET /merchant/webhook-endpoints`** → `WebhookEndpoint[]`

```json
[
  {
    "id": "uuid",
    "mode": "test",
    "url": "https://shop.example.com/webhooks/locoomo",
    "description": "Order sync",
    "events": [],
    "enabled": true,
    "disabledReason": null,
    "failingSince": null,
    "lastSuccessAt": "2026-11-14T10:05:00.000Z",
    "previousSecretExpiresAt": null,
    "createdAt": "2026-11-14T09:00:00.000Z"
  }
]
```

| Condition | Status shown |
|---|---|
| `enabled && !failingSince` | Green "Active" (+ "Last delivered {lastSuccessAt}") |
| `enabled && failingSince` | Amber "Failing since {failingSince}". We disable it after 36 hours of failures |
| `!enabled` | Red "Disabled: {disabledReason}" + an **Enable** button |

`events: []` means **all events** (including ones added later). Show "All events".

### 10.2 Add an endpoint

**`POST /merchant/webhook-endpoints`**

```json
{ "url": "https://shop.example.com/webhooks/locoomo", "events": ["shipment.collected"], "description": "Order sync" }
```

- `url`: must be public `https://`. Show `422 INVALID_WEBHOOK_URL`'s `message` under the field
  (it explains what's wrong: not https, a private address, …).
- `events`: a checklist grouped as below, with "All events" ticked by default (send `[]` or
  leave it out).
- Response `201`: `{ endpoint, secret }`. The **signing secret** (`whsec_…`) is shown **once**:
  same show-once modal as API keys, with "Use this to verify our signatures."
- `409 WEBHOOK_ENDPOINT_LIMIT_REACHED`: "You can have 5 endpoints per mode. Remove one first."

**Event checklist**

| Group | Events |
|---|---|
| Shipment lifecycle | `shipment.created`, `shipment.updated`, `shipment.received`, `shipment.in_transit`, `shipment.ready_for_collection`, `shipment.collection_reminder`, `shipment.collected` |
| Ended before drop-off | `shipment.cancelled`, `shipment.expired`, `shipment.refused` |
| Changes we made | `shipment.fee_adjusted`, `shipment.destination_changed` |
| Returns | `shipment.returning`, `shipment.return_ready`, `shipment.returned`, `shipment.disposed` |
| Problems | `shipment.exception` |
| Account | `merchant.status_changed` |

`manifest.received`, `claim.decided`, `wallet.funded` and `wallet.low_balance` arrive with
their features (🛠). Fetching the list of event types from the API isn't available, so keep
this list in the app.

### 10.3 Edit, roll secret, delete

- **Edit:** **`PATCH /merchant/webhook-endpoints/:id`** with any of `url`, `events`,
  `description`, `enabled` → `200` endpoint.
  - Changing `url` needs **step-up**.
  - `enabled: false` pauses it (`disabledReason: "Paused by you"`); `enabled: true` re-enables
    one we disabled. After re-enabling, suggest a replay (§10.4).
- **Roll secret:** **`POST /merchant/webhook-endpoints/:id/roll-secret`** (step-up) →
  `{ endpoint, secret }`. Show-once modal, then on the row: "Old secret still accepted until
  {previousSecretExpiresAt}" (24 hours).
- **Delete:** **`DELETE /merchant/webhook-endpoints/:id`** → `204`. Confirm: "Stop sending
  events to {url}?"

Suspended merchants can't change **live** endpoints (`403 MERCHANT_SUSPENDED`).

### 10.4 Send test event, replay

- **Send test event:** **`POST /merchant/webhook-endpoints/:id/test`** sends a `webhook.test`
  event right away and answers
  `{ "delivered": true, "responseStatus": 200, "durationMs": 182, "error": null }`. Show ✓/✗
  with the status and time, or `error` ("Timed out after 10 seconds", "Connection refused", …).
- **Replay:** **`POST /merchant/webhook-endpoints/:id/replay { since }`** (ISO time, within the
  last 30 days) → `{ "queued": 37 }`. Date-time picker limited to the last 30 days; toast
  "Queued {queued} events." `422 REPLAY_WINDOW_EXCEEDED` if older than 30 days.

### 10.5 Delivery log

**`GET /merchant/webhook-deliveries?endpointId=…&status=failed&limit=50&cursor=…`** (newest
first, kept 30 days):

```json
{
  "items": [
    {
      "id": "uuid",
      "eventId": "msg_2b7e1c0a9f…",
      "eventType": "shipment.collected",
      "endpointId": "uuid",
      "status": "failed",
      "attempts": 3,
      "nextAttemptAt": "2026-11-14T11:05:00.000Z",
      "lastAttemptAt": "2026-11-14T10:35:00.000Z",
      "responseStatus": 500,
      "responseBody": "Internal Server Error",
      "error": null,
      "durationMs": 912,
      "createdAt": "2026-11-14T10:30:00.000Z"
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

- Table: time, event type, status, attempts, response status.
- `status`: `pending` (grey, "Next attempt {nextAttemptAt}"), `delivering` (spinner),
  `succeeded` (green), `failed` (red).
- Expand a row to show `responseBody` (first 2 KB of their reply, monospace) and `error`.
- Filters: endpoint, status.

**Retries, for help text:** a failed delivery is retried after 5 seconds, 1 minute, 5 minutes,
30 minutes, 2 hours, 5 hours, then three times 10 hours apart (about 1.5 days). Responses must
be 2xx within 10 seconds. Redirects count as failures.

---

## 11. Test / Live mode

A **Test / Live toggle** in the dashboard header decides which world the shipping and webhook
screens show.

- Send it as a header on every shipping and webhook request:
  `Locoomo-Mode: test` or `Locoomo-Mode: live`. Missing means `test`. Anything else →
  `400 INVALID_MODE`.
- Account, team, API-key and API-log routes ignore the header (API keys and logs take
  `?mode=` instead).
- Test mode has its own shipments, webhooks and a **test wallet** that starts with
  ₦1,000,000, is charged like a real one, and can be reset (§15).
  Nothing reaches real Nodes, couriers, buyers or money. Test tracking codes start with
  **`LCT-`**; live codes with `LCM-`.
- Make test mode **obvious**: an orange "TEST MODE" strip across the top of the page.
- **Live shipments** ✅ are built; Locoomo opens them per environment. Live creation
  answers `403 MERCHANT_NOT_APPROVED` before approval and
  `403 LIVE_SHIPMENTS_NOT_AVAILABLE` where live isn't open yet; reads always work. There's
  no "is live open?" endpoint: default the toggle to **Test**, let approved merchants
  switch to Live, and show the error's message if creation is refused.

```ts
api.interceptors.request.use((config) => {
  config.headers['Locoomo-Mode'] = store.mode;   // 'test' | 'live'
  return config;
});
```

When the user switches mode, clear cached shipment and webhook data and refetch.

---

## 12. Shipments

Reads need `shipments.read`; create, edit, cancel, return and the simulator need
`shipments.write`. All take `Locoomo-Mode`.

### 12.1 The Shipment object

```json
{
  "id": "0c7e5a7b-…",
  "mode": "test",
  "reference": "TEMU-ORD-88412-1",
  "trackingCode": "LCT-7K3M-Q9TD",
  "trackingUrl": null,
  "status": "ready_for_collection",
  "sequence": 5,
  "statusChangedAt": "2026-11-15T10:05:00.000Z",
  "origin": { "type": "node", "nodeId": "…", "nodeName": "Ikeja Node — Allen Avenue" },
  "destination": {
    "nodeId": "8b0e2f4a-…",
    "nodeName": "Yaba Node — Herbert Macaulay",
    "address": "312 Herbert Macaulay Way, Yaba",
    "city": "Lagos",
    "state": "Lagos",
    "changed": false
  },
  "receiver": { "name": "Chioma Okafor", "phone": "+2348031234567", "email": "chioma@example.com" },
  "parcel": {
    "description": "Wireless earbuds",
    "size": "small",
    "weightKg": 0.4,
    "lengthCm": 15,
    "widthCm": 10,
    "heightCm": 6,
    "handling": ["fragile"],
    "declaredValueKobo": 2500000,
    "measured": null
  },
  "externalBarcode": null,
  "manifestId": null,
  "fee": {
    "currency": "NGN",
    "quotedKobo": 180000,
    "chargedKobo": 180000,
    "state": "charged",
    "breakdown": { "baseKobo": 120000, "distanceKobo": 69000, "volumeDiscountKobo": -9000, "vatKobo": 12558 }
  },
  "dropDeadline": "2026-11-26T22:59:59.000Z",
  "collection": { "deadline": "2026-11-26T22:59:59.000Z", "collectedAt": null, "method": null, "collectorName": null },
  "return": null,
  "exception": null,
  "notifyReceiver": "locoomo",
  "metadata": { "orderId": "88412" },
  "createdAt": "2026-11-12T09:14:00.000Z",
  "updatedAt": "2026-11-15T10:05:00.000Z"
}
```

| Field | Show it as |
|---|---|
| `reference` | The merchant's own order/parcel id. Searchable |
| `trackingCode` | Big, monospace, with a copy button |
| `trackingUrl` | Live: "Public tracking page" link (safe to share with the buyer). `null` in test mode |
| `origin` | While `created`: "Drop off at {nodeName}" (any other Node except the buyer's also accepts it). After drop-off: "Dropped off at {nodeName}". If it was dropped somewhere else, `origin` is updated and the timeline's `received` entry has `data.previousOrigin` (§12.7); show "Booked for {previousOrigin.nodeName}, dropped at {nodeName}" |
| `destination` | "Buyer collects at {nodeName}, {address}". If `changed`, add "(changed by Locoomo: the original Node was unavailable)" |
| `parcel.measured` | If not null: "Measured at drop-off: {weightKg} kg, {size}". The fee was re-priced on it: if `fee.chargedKobo` differs from `fee.quotedKobo`, show both ("Quoted ₦…, charged ₦… after measuring") |
| `fee` | Quoted vs charged. `state`: `held` "Held", `charged` "Charged", `released` "Released (not charged)" |
| `dropDeadline` | While `created`: "Drop off by {date}, or it expires" |
| `collection.deadline` | While `ready_for_collection`: "Buyer has until {date} to collect" |
| `collection.method` | When collected: `code` "Collected with code" / `id_check` "Collected with photo ID" + `collectorName` |
| `return` | `{ reason, ... }`. `reason`: `not_collected` "Not collected in time", `delivery_failed` "Delivery failed", `merchant_request` "You asked for it back" |
| `exception` | `{ type, reportedAt, claimId }`. `type`: `lost` / `damaged` |
| `metadata` | Key/value list (collapsed by default) |

### 12.2 Statuses

```
created ──► received ──► in_transit ──► ready_for_collection ──► collected ✔
   │            │             │                   │
   │            └─────────────┴───────────────────┴──► returning ──► return_ready ──► returned ✔
   │                                                                      └──► disposed ✔
   ├──► cancelled ✔   (merchant cancelled before drop-off)
   ├──► expired ✔     (never dropped off)
   └──► refused ✔     (refused at the counter: prohibited, unsafe or badly packed)

   any active status ──► exception ✔ (lost or damaged)
```

| Status | Badge label | Colour |
|---|---|---|
| `created` | Awaiting drop-off | Grey |
| `received` | Dropped off | Blue |
| `in_transit` | In transit | Blue |
| `ready_for_collection` | Ready for collection | Purple |
| `collected` | Collected | Green |
| `returning` | Returning to you | Amber |
| `return_ready` | Ready for you to collect | Amber |
| `returned` | Returned | Grey |
| `cancelled` | Cancelled | Grey |
| `expired` | Expired | Grey |
| `refused` | Refused at drop-off | Red |
| `exception` | Problem (lost or damaged) | Red |
| `disposed` | Disposed | Grey |

**Tolerate unknown statuses.** New ones may be added: show the raw value in a grey badge.

### 12.3 List

**`GET /merchant/shipments`** → `{ items: Shipment[], nextCursor, hasMore }`

| Query | |
|---|---|
| `reference` | Exact match: the search box |
| `status` | One status: the filter chips |
| `destinationNodeId` | Filter by the buyer's Node |
| `manifestId` | 🛠 with manifests |
| `createdFrom`, `createdTo` | ISO date-times: the date-range picker |
| `updatedSince` | For sync loops; returns oldest change first. Not needed in the UI |
| `limit`, `cursor` | 1–200, default 50 |

Newest first. Columns: reference, tracking code, receiver name, destination Node, status
badge, fee, created. Row click → detail.

Empty state (test mode): "No test shipments yet. Create one to see how it works." with a
"Create test shipment" button.

### 12.4 Create

**The form.** Three parts, then a price preview:

1. **Where:**
   - **Drop-off Node** (`origin`). Until a hub is assigned to the merchant, the merchant drops
     each parcel at a Node, so this is **required**: send
     `{ "type": "node", "nodeId": "…" }`. (Once hubs open, `{ "type": "hub" }` becomes the
     default and the picker becomes optional. `422 ORIGIN_REQUIRED` means "pick a drop-off
     Node".)
   - **Buyer's collection Node** (`destinationNodeId`).
   Both use the Node picker (§12.5).
2. **Who:** receiver name, phone, email (optional, recommended: "We'll email the collection
   code too").
3. **What:** description, size (with a picture of each size), optional weight and dimensions
   (all three or none), handling checkboxes, declared value, your reference.

Then show the **price** from `GET /merchant/quotes` (§12.6) as soon as both Nodes and the size
are set, and update it when they change.

**`POST /merchant/shipments`** (send an `Idempotency-Key`, §3.4) → `201` Shipment

```json
{
  "reference": "TEMU-ORD-88412-1",
  "destinationNodeId": "8b0e2f4a-…",
  "origin": { "type": "node", "nodeId": "1f2e3d4c-…" },
  "receiver": { "name": "Chioma Okafor", "phone": "08031234567", "email": "chioma@example.com" },
  "parcel": {
    "description": "Wireless earbuds",
    "size": "small",
    "weightKg": 0.4,
    "lengthCm": 15, "widthCm": 10, "heightCm": 6,
    "handling": ["fragile"],
    "declaredValueKobo": 2500000
  },
  "notifyReceiver": "locoomo",
  "metadata": { "orderId": "88412" }
}
```

| Field | Rules | Label |
|---|---|---|
| `reference` | Required, 1–64 chars, unique per account and mode | "Your reference (order number)" |
| `destinationNodeId` | Required | "Buyer collects at" |
| `origin` | `{ type: 'node', nodeId }` (required for now) or `{ type: 'hub' }` | "You drop it off at" |
| `receiver.name` | Required, 2–100 chars | "Buyer's name" |
| `receiver.phone` | Required, any Nigerian format | "Buyer's phone" |
| `receiver.email` | Optional | "Buyer's email (recommended)" |
| `parcel.description` | Required, ≤ 500 chars | "What's inside? Be specific, e.g. Wireless earbuds" |
| `parcel.size` | `small` · `medium` · `large` · `extra_large` | Size cards |
| `parcel.weightKg` | Optional, 0.1–1000 | "Weight (kg)" |
| `parcel.lengthCm` / `widthCm` / `heightCm` | Optional, 1–500 each; all three or none | "Dimensions (cm)" |
| `parcel.handling` | Any of `fragile`, `keep_upright`, `perishable`, `liquid` | Checkboxes |
| `parcel.declaredValueKobo` | Optional | "Value of the goods (₦)". Help: "Used for claims. Compensation is capped at ₦50,000 unless your contract says otherwise." Convert naira to kobo |
| `externalBarcode` | Optional | Advanced: "Barcode already on the parcel" |
| `notifyReceiver` | `locoomo` (default), `merchant`, `both`. `merchant`/`both` only when `merchant.receiverCodeRelay` is `true` | Hide unless relay is enabled |
| `metadata` | Optional, ≤ 50 string keys/values | Advanced, optional key/value editor |

On success, go to the detail page with a toast: "Shipment created. Drop it off at
{origin.nodeName} by {dropDeadline}."

**Errors**

| Error | Show |
|---|---|
| `400 VALIDATION_FAILED` | Field errors from `details[].field` |
| `409 DUPLICATE_REFERENCE` | "You've already used this reference." + link to the existing shipment (`details.existingShipmentId`) |
| `402 INSUFFICIENT_WALLET_BALANCE` | `details.requiredKobo` / `details.availableKobo`. Test: "Not enough test funds (₦{available} available). Reset your test wallet or cancel shipments waiting for drop-off." + link to §15.4. Live: "Not enough funds: this shipment needs ₦{required}, you have ₦{available}. Top up your wallet." (top-up 🛠) |
| `422 DESTINATION_NODE_UNAVAILABLE` | Under the destination: "This Node isn't accepting parcels. Pick another." |
| `422 ORIGIN_NODE_UNAVAILABLE` | Under the drop-off: same copy |
| `422 ORIGIN_REQUIRED` | Under the drop-off: "Pick where you'll drop it off." |
| `422 RECEIVER_UNREACHABLE` | Under email: "Add the buyer's email so we can send the collection code." |
| `422 RECEIVER_RELAY_NOT_ENABLED` | Shouldn't happen if you hide the option |
| `422 NO_DELIVERY_OPTION` | "This parcel is too big or heavy for any of our vehicles, or we don't cover this route yet." |
| `403 MERCHANT_NOT_APPROVED`, `403 LIVE_SHIPMENTS_NOT_AVAILABLE` | Live mode: "Live shipments aren't available yet. Switch to Test." |
| `403 MERCHANT_SUSPENDED` | Live: "Your account is suspended, so you can't create live shipments. Existing parcels keep moving." |
| `403 SHIPMENT_CREATION_PAUSED` | Live: "New live shipments are paused on your account. Contact your account manager." |
| `429 DAILY_LIMIT_REACHED` 🛠 (live only) | "You've reached today's shipment limit. It resets at midnight." |

**Bulk (optional for the dashboard).** **`POST /merchant/shipments/bulk`** with
`{ "items": [ …up to 100 create bodies… ] }` (and an `Idempotency-Key`). Each item succeeds or
fails on its own:

```json
{
  "results": [
    { "index": 0, "ok": true, "shipment": { "...": "Shipment" } },
    { "index": 1, "ok": false, "error": { "code": "VALIDATION_FAILED", "message": "…", "details": [{ "field": "items[1].receiver.phone", "constraint": "isPhoneE164", "message": "…" }] } }
  ]
}
```

Useful for a "paste from spreadsheet" screen. The real CSV import (up to 10,000 rows) is 🛠.

### 12.5 The Node picker

Used twice in the create form. **`GET /merchant/nodes`** → `{ items: Node[], nextCursor, hasMore }`

| Query | |
|---|---|
| `near=lat,lng` | Sort by distance (e.g. from the device location, or a geocoded address) |
| `radiusKm` | With `near`. Default 10, max 50 |
| `q` | Search name, address, area |
| `state`, `city` | Filters |
| `parcelSize` | Only Nodes that can take this size right now |
| `limit`, `cursor` | Pagination |

```json
{
  "items": [
    {
      "id": "8b0e2f4a-…",
      "name": "Yaba Node — Herbert Macaulay",
      "address": "312 Herbert Macaulay Way, Yaba",
      "city": "Lagos",
      "state": "Lagos",
      "latitude": 6.5095,
      "longitude": 3.3711,
      "distanceKm": 1.42,
      "openingHours": { "mon": [{ "open": "08:00", "close": "20:00" }], "sun": [] },
      "contactPhone": "+2348090000000",
      "acceptingParcels": true
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

- Only open Nodes with shelf space are listed: nearest first with `near`, otherwise by name.
  `distanceKm` is `null` without `near`.
- Show a list (and a map if you have one) with name, address, distance and today's opening
  hours. `openingHours` has keys `mon`…`sun`; an empty array means closed that day.
- **`GET /merchant/nodes/:id`** re-checks a saved Node: `404` if it closed. A temporarily full
  Node is still returned with `acceptingParcels: false`; shipments to it are still accepted
  (we reroute if it's still full on arrival). Show "Busy right now" but allow it.
- Store the Node `id`, never the name.

### 12.6 Price preview

**`GET /merchant/quotes?originNodeId=…&destinationNodeId=…&parcelSize=small&weightKg=0.4`**
(`lengthCm`, `widthCm`, `heightCm` optional too) →

```json
{
  "currency": "NGN",
  "amountKobo": 180000,
  "breakdown": { "baseKobo": 120000, "distanceKobo": 69000, "volumeDiscountKobo": -9000, "vatKobo": 12558 },
  "vehicleClass": "motorbike",
  "estimatedReadyInWorkingDays": 2
}
```

- Show "**₦1,800.00**" and an expandable breakdown: Base ₦1,200 · Distance ₦690 · Volume
  discount −₦90. `base + distance + volumeDiscount = amount`.
- `vatKobo` is the VAT **already included** in the amount, not added on top. Show "includes
  VAT of ₦125.58" only when it's above 0.
- "Ready for collection in about {estimatedReadyInWorkingDays} working days after drop-off."
- It's an estimate: the price is fixed at creation and adjusted once when we measure the
  parcel at drop-off. Help text: "Final price is confirmed when we measure your parcel."
- Errors: `422 ORIGIN_REQUIRED` (pick a drop-off Node first), `404 NOT_FOUND` (a Node isn't
  available), `422 NO_DELIVERY_OPTION`, `503 PRICING_NOT_CONFIGURED` (show "Pricing
  unavailable", keep the form usable).
- Debounce the call (300 ms) while the user edits weight and dimensions.

### 12.7 Detail and timeline

- **`GET /merchant/shipments/:id`** → Shipment. (`404` if it belongs to the other mode: tell
  the user to switch mode.)
- **`GET /merchant/shipments/:id/timeline`** → events, oldest first:

  ```json
  [
    { "type": "created", "at": "2026-11-12T09:14:00.000Z", "nodeName": null, "sequence": 1, "data": null },
    { "type": "received", "at": "2026-11-14T11:02:00.000Z", "nodeName": "Ikeja Node — Allen Avenue", "sequence": 2,
      "data": { "previousOrigin": { "nodeId": "…", "nodeName": "Yaba Node — Sabo" } } },
    { "type": "fee_adjusted", "at": "2026-11-14T11:02:00.000Z", "nodeName": "Ikeja Node — Allen Avenue", "sequence": 3,
      "data": { "adjustment": { "previousKobo": 180000, "newKobo": 210000, "differenceKobo": 30000, "reason": "dropped_elsewhere" } } },
    { "type": "in_transit", "at": "2026-11-14T15:40:00.000Z", "nodeName": "Ikeja Node — Allen Avenue", "sequence": 4, "data": null },
    { "type": "ready_for_collection", "at": "2026-11-15T10:05:00.000Z", "nodeName": "Yaba Node — Herbert Macaulay", "sequence": 5, "data": null }
  ]
  ```

  `data` carries details worth showing: `received` → `previousOrigin` ("Booked for
  {nodeName}, dropped here"); `fee_adjusted` → `adjustment` ("Price changed from ₦{previous}
  to ₦{new}: measured / dropped at another Node"); `returning` → `reason`; `updated` →
  `changed`.

  `type` is a status name or one of `updated` ("Details changed"), `fee_adjusted` ("Price
  adjusted after measuring"), `destination_changed` ("Collection Node changed by Locoomo"),
  `collection_reminder` ("Buyer reminded to collect"). Render a vertical timeline with "at
  {nodeName}" where present. Unknown types: show the raw value.

**Labels** ✅. A **"Print label"** button on the detail page opens
`GET /merchant/shipments/{id}/label?format=a6` in a new tab (it's a PDF, not JSON: fetch it
with the session cookie and `Locoomo-Mode`, then show it from a blob URL). Offer A6 (label
printers) and A4 (office printers). On the list, let users tick shipments and **"Print
labels"**: `POST /merchant/shipments/labels` `{ shipmentIds, format }` (up to 100,
printed in the order sent; A4 prints four per page with cut lines).

```ts
async function openLabel(id: string, format: 'a6' | 'a4' = 'a6') {
  const res = await fetch(`${API}/merchant/shipments/${id}/label?format=${format}`, {
    credentials: 'include',
    headers: { 'Locoomo-Mode': store.mode },
  });
  if (!res.ok) throw (await res.json()).error; // errors are still the JSON envelope
  window.open(URL.createObjectURL(await res.blob()), '_blank');
}
```

**Detail page layout:** status badge and tracking code at the top; the action buttons
(§12.8); cards for receiver, parcel, route (origin → destination), fee, collection/return;
the timeline; and in test mode the simulator panel (§13).

### 12.8 Edit, cancel, return to sender

Show a button only when the action is allowed in the current status:

| Action | Call | Allowed when | Error otherwise |
|---|---|---|---|
| **Edit receiver** | `PATCH /merchant/shipments/:id { receiver: { name?, phone?, email? } }` | Until `collected`. The buyer gets a fresh code; `"email": null` removes the email | `409 SHIPMENT_NOT_EDITABLE` |
| **Change destination / parcel** | `PATCH … { destinationNodeId }` or `{ parcel: {...whole object} }` | Only while `created`. Re-quoted; the hold is adjusted | `409 SHIPMENT_NOT_EDITABLE` |
| **Edit metadata** | `PATCH … { metadata }` (replaces it) | Any time | — |
| **Cancel** | `POST /merchant/shipments/:id/cancel` | Only while `created`. Hold released | `409 SHIPMENT_NOT_CANCELLABLE` |
| **Return to sender** | `POST /merchant/shipments/:id/return-to-sender` | `received`, `in_transit`, `ready_for_collection` (e.g. the buyer cancelled the order), once. No extra fee | `409 SHIPMENT_NOT_RETURNABLE` |

All return the updated Shipment. Confirm copy:

- Cancel: "Cancel this shipment? The held ₦{quotedKobo} is released."
- Return, when `ready_for_collection`: "Bring this parcel back to {origin.nodeName}? The
  buyer's collection code stops working now."
- Return, when `received` or `in_transit`: "Bring this parcel back to {origin.nodeName}? It's
  already on its way, so it will reach the buyer's Node first and come straight back. The
  buyer won't be offered it."

After a return, the shipment says `returning` straight away. When it's back at the origin
(`return_ready`), Locoomo emails a collection code to the account's contact email (owner's
email if none), valid 10 working days. Show on the detail page: "Back at {origin.nodeName}.
We've emailed your collection code to {contact email}." (Return batches with one code for
many parcels are 🛠.)

A cancel can race with the drop-off scan: on `409 SHIPMENT_NOT_CANCELLABLE`, refetch and offer
"Return to sender" instead.

---

## 13. Test simulator

Test shipments don't move by themselves. On a **test** shipment's detail page, show a
"Simulate" panel so merchants (and you) can walk it through its life and watch the webhooks.

**`POST /merchant/test/shipments/:id/simulate`** (`shipments.write`) → the updated Shipment

```json
{ "to": "ready_for_collection" }
```

| Option | |
|---|---|
| `to` | Any status from §12.2, plus `fee_adjusted` and `destination_changed` |
| `exceptionType` | `lost` or `damaged`, with `to: "exception"` |
| `destinationNodeId` | With `to: "destination_changed"`. Default: the nearest other Node |

- Intermediate steps happen in order and each fires its webhook, as in live: `created` →
  `collected` passes through `received`, `in_transit` and `ready_for_collection`. Returns go
  via `ready_for_collection` (not collected in time).
- `fee_adjusted` needs a received parcel; it raises the charge by 15% with a measured weight.
- `409 INVALID_SIMULATION`: "That can't happen from {status}." `403 TEST_MODE_ONLY`: hide the
  panel on live shipments.

**Panel UI.** Buttons for the next useful steps given the current status, e.g. from `created`:
*Drop off*, *Cancel at counter (refused)*, *Expire*, *Deliver to buyer's Node*, *Collected*;
from `ready_for_collection`: *Collected*, *Not collected (return)*. Plus a "More…" menu with
every target. After each click:

1. Replace the shipment with the response and reload the timeline.
2. Load **`GET /merchant/webhook-deliveries?limit=10`** and show "Webhooks sent" with each
   delivery's status, so developers see their endpoint's responses.

---

## 14. Settings › Close account

Owner only (`ownership`). A "Danger zone" card at the bottom of Settings.

**`POST /merchant/account/close`** (step-up) → `204`.

- Closes the merchant, removes the whole team and revokes open invites. Everyone keeps their
  personal Locoomo sign-in and can create or join another merchant.
- Allowed from `draft`, `changes_requested`, `approved` and `rejected`. Not while under
  review or suspended (`409 INVALID_MERCHANT_TRANSITION`: "You can't close the account while
  it's under review or suspended.").
- Confirm by typing the trading name: "This can't be undone. Type **{tradingName}** to
  confirm."
- After `204`, clear the store and go to "Create business".
- 🛠 From the wallet release it will also require no parcels in flight and a non-negative
  wallet; unused balance is refunded to the verified bank account.

---

## 15. Wallet

✅ All of it is ready: balance, statement, holds, card top-ups, the bank-transfer account and
the test reset.

**How the money works**, for help text:

- Each merchant has **one wallet per mode** (Test / Live, from the `Locoomo-Mode` toggle).
- Creating a shipment **holds** its quoted fee. When the parcel is dropped off, the hold is
  **charged** at the final price. Cancelled, expired or refused shipments release their hold
  and cost nothing.
- **Available = balance − held.** New shipments need enough available balance, or they're
  refused with `402 INSUFFICIENT_WALLET_BALANCE`.
- The balance can go **below zero** if a parcel is re-priced after measuring. Parcels keep
  moving; only new shipments are blocked until a top-up.
- The **test wallet** starts with ₦1,000,000, is charged like a real one, and can be reset.

### 15.1 Wallet summary (header card, and the Wallet page)

**`GET /merchant/wallet`** (any member; sends `Locoomo-Mode`) → `Wallet`

```json
{
  "mode": "test",
  "currency": "NGN",
  "balanceKobo": 99820000,
  "heldKobo": 360000,
  "availableKobo": 99460000,
  "updatedAt": "2026-11-15T10:05:00.000Z"
}
```

```
Wallet · TEST                                             [Reset test wallet]
┌───────────────────────┬───────────────────────┬────────────────────────┐
│ Available             │ Held for shipments    │ Balance                │
│ ₦994,600.00           │ ₦3,600.00             │ ₦998,200.00            │
└───────────────────────┴───────────────────────┴────────────────────────┘
```

- Show **Available** biggest: it's what they can ship with.
- `balanceKobo < 0`: red, with "Your balance is negative. New shipments are paused until you
  top up." (live) or "Reset your test wallet to keep testing." (test).
- A small "Available ₦…" chip in the shipment create form saves a trip here.
- Refetch after creating, cancelling or simulating a shipment.

### 15.2 Statement (entries)

**`GET /merchant/wallet/entries?type=&from=&to=&limit=&cursor=`** (`wallet.manage`) →
`CursorPage<WalletEntry>`, newest first.

```json
{
  "items": [
    {
      "id": "uuid",
      "type": "shipment_charge",
      "amountKobo": -180000,
      "balanceAfterKobo": 99820000,
      "description": "Shipment LCT-7K3M-Q9TD",
      "shipmentId": "0c7e5a7b-…",
      "createdAt": "2026-11-14T11:02:00.000Z"
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

Table: date, description, type label, amount (green with "+" for credits, plain "−" for
debits), balance after. Link the row to the shipment when `shipmentId` is set. Filters: type,
date range (`from` inclusive, `to` exclusive). Infinite scroll.

| `type` | Label |
|---|---|
| `top_up` | Top-up |
| `shipment_charge` | Shipment |
| `shipment_adjustment` | Re-priced after measuring |
| `adjustment` | Adjustment by Locoomo |
| `claim_credit` | Claim payout |
| `refund` | Refund to bank |
| `test_funding` | Test funds |

Unknown types: show the raw value.

### 15.3 Holds

**`GET /merchant/wallet/holds?status=active&limit=&cursor=`** (`wallet.manage`) →
`CursorPage<WalletHold>`. A "Held for shipments" tab: one row per shipment waiting for
drop-off (`status: active`), with the amount and a link to the shipment. `captured` and
`released` holds are history; show them only behind a filter.

### 15.4 Reset test wallet

**`POST /merchant/test/wallet/reset`** (test mode, `shipments.write`) → `Wallet`. Sets the
balance back to ₦1,000,000; open holds stay. Show the button only in Test mode. Confirm:
"Reset your test balance to ₦1,000,000?" Live mode answers `403 TEST_MODE_ONLY`.

### 15.5 Top up by card

Needs `wallet.manage`. Works in Test (Paystack test cards) and Live (approved merchants).

1. **"Top up" dialog**: an amount in naira (₦1,000 to ₦10,000,000). Under it: "Card fees are
   deducted from the amount added to your wallet."
2. **`POST /merchant/wallet/top-ups`** `{ amountKobo }` (send an `Idempotency-Key`) →

   ```json
   {
     "topUp": { "id": "uuid", "status": "pending", "amountKobo": 500000, "...": "…" },
     "authorizationUrl": "https://checkout.paystack.com/…"
   }
   ```

   Redirect the browser to `authorizationUrl` (Paystack's payment page; a full redirect,
   not an iframe).
3. Paystack sends the user back to **`/wallet?topUp={id}`** on the dashboard. That page polls
   **`GET /merchant/wallet/top-ups/{id}`** every 2 seconds for up to a minute. Each call also
   checks with Paystack, so it settles even if our webhook is slow.

   | `status` | Show |
   |---|---|
   | `pending` | Spinner: "Confirming your payment…" After a minute: "Still confirming. We'll email you when it lands." |
   | `succeeded` | "₦{creditedKobo} added to your wallet" (and the fee if `feeKobo > 0`). Refetch the wallet |
   | `failed` | "The payment didn't go through. You haven't been charged." + "Try again" |
   | `abandoned` | Same as failed |

| Error | Show |
|---|---|
| `403 MERCHANT_NOT_APPROVED` | Live: "Top-ups unlock when your account is approved." |
| `422 WALLET_BALANCE_LIMIT_EXCEEDED` | "That would take your wallet over its ₦{details.maxWalletBalanceKobo} limit. Contact your account manager to raise it." |
| `422 TOP_UPS_UNAVAILABLE` | Test mode on some environments: "Test top-ups aren't available here. Use Reset test wallet." |
| `502 PAYMENT_PROVIDER_ERROR` | "We couldn't reach our payment provider. Try again in a few minutes." |

### 15.6 Top up by bank transfer (live wallet)

Every approved merchant can have a **dedicated account number**; money sent to it lands in
the live wallet automatically, usually within minutes, with no fee deducted.

- **`GET /merchant/wallet/funding-account`** (any member, `Locoomo-Mode: live`) →
  `{ bankName, accountNumber, accountName, createdAt }` or `null`.
- When it's `null`, show a **"Get my account number"** button (`wallet.manage`) that calls
  **`POST /merchant/wallet/funding-account`** → the same shape. Calling it twice returns the
  same account.
- When present, show it like a card with copy buttons:

  ```
  Fund your wallet by bank transfer
  Bank            Wema Bank
  Account number  9930000001   [Copy]
  Account name    LOCOOMO/ADA STORES WALLET
  Transfers usually arrive within minutes. No fees.
  ```

- In Test mode, hide this card (show "Bank transfers are for your live wallet").

| Error | Show |
|---|---|
| `422 CONTACT_DETAILS_REQUIRED` | "Add a contact email and phone to your business profile first." + link to the profile card (`details.missing`) |
| `409 FUNDING_ACCOUNT_CONFLICT` | "Your contact email is already used by another business on Locoomo. Change it in your profile and try again." |
| `403 MERCHANT_NOT_APPROVED` | "Your account number is available once you're approved." |
| `403 LIVE_MODE_ONLY` | Not reachable if you hide the card in Test mode |

### 15.7 Top-up history

**`GET /merchant/wallet/top-ups?limit=&cursor=`** (`wallet.manage`) →
`CursorPage<TopUp>`. A "Top-ups" tab: date, method (`card` "Card", `bank_transfer` "Bank
transfer"), amount paid, fee, credited, status badge, reference (copy button). Every
successful top-up also emails a receipt to the owner, admins and finance members.

---

## 16. Coming next 🛠

Build these behind feature flags against the shapes below. Final shapes land with the backend
phase; we'll update this section.

| Screen | Endpoints (planned) | Notes |
|---|---|---|
| **Low-balance alert** | Threshold setting on the Wallet page | `wallet.manage`. Emails and `wallet.low_balance` when available balance drops below it |
| **Invoices** | `GET /merchant/invoices/{yyyy-mm}` (PDF/CSV) | Monthly statement and tax invoice |
| **Manifests** | `POST /merchant/manifests`, `POST …/{id}/shipments`, `POST …/{id}/close`, `GET …/{id}/document` | Group shipments for a hub drop; PDF/QR for the driver; "received / missing / unexpected" report |
| **Returns to collect** | `GET /merchant/returns?state=ready`, `POST /merchant/return-batches { nodeId, shipmentIds }` → collection code | `returns.collect`. Show the batch code big, like a boarding pass. 10 working days free storage |
| **Claims** | `POST /merchant/claims { shipmentId, type, description, evidence }` | Within 30 days. Types: `lost`, `damaged`, `missing_item` |
| **CSV import** | `POST /merchant/shipment-imports`, `GET …/{id}` | Up to 10,000 rows, background job with a progress view |
| **Go-live checklist** | `GET /merchant/go-live-checklist` | On Home: approved, 2FA, live key, live webhook, wallet funded, test shipment simulated to `collected` and `returned` |
| **Audit log** | TBD | Who did what in the team |
| **Home KPIs** | TBD | Shipments today, awaiting drop-off, ready for collection, returns waiting |

---

# Part C: Admin app

## 17. Admin foundations: mandatory 2FA, permissions, approvals

### 17.1 Mandatory 2FA ✅

Every admin must turn on 2FA: existing admins within **14 days of release**, new admins within
14 days of their invite.

- After sign-in, call `GET /auth/mfa`. If `required && !enabled`, show the countdown banner
  from §4.2 on every page.
- After the deadline, every admin route answers **`403 MFA_ENROLLMENT_REQUIRED`**. Intercept
  it globally and route to the 2FA setup wizard. These keep working during the lockout:
  `/users/me`, everything under `/auth/`, and logout.
- Admins can't turn 2FA off (no "Turn off" button when `required` is true;
  `403 MFA_REQUIRED_FOR_ROLE` otherwise).

### 17.2 Permissions ✅

Admins have **permissions** on top of the admin role. Older screens work for every admin;
newer ones (merchant review, money moves) need a permission and answer `403 FORBIDDEN`
otherwise.

| Permission | Show as | Merchant screens it opens |
|---|---|---|
| `super` | **Full access**: everything, including managing admins | All |
| `kyc` | Merchant verification | Queue, review, approve, request changes, reject, view KYC files |
| `finance` | Money: wallets, adjustments, claims, refunds, pricing | Wallet panel and adjustments (§18.6); 🛠 claims |
| `ops` | Operations: reroutes, suspensions, hubs, exceptions | Queue, suspend/reinstate, settings, public holidays, lost/damaged |
| `support` | Support tools | Queue and detail (read-only), 🛠 Merchant 360 |

**Admins screen** (`super` only; others get `403` from `GET /admin/admins`, so hide the menu):

- `GET /admin/admins` → `AdminAccount[]` with a checkbox per permission.
- Save with `PATCH /admin/admins/:id/permissions` and the **full** set:
  `{ "permissions": ["kyc", "ops"] }`. Applies within seconds, no re-login.
- Render "Full access" as a separate toggle that greys out the others.
- `409 LAST_SUPER_ADMIN`: "Give someone else full access first. There must always be at least
  one."

To hide menu items, load the admin's own permissions from `GET /admin/admins` if they're
`super`; otherwise handle `403` gracefully. Every existing admin was given Full access at
release: narrow them down from this screen.

### 17.3 Approvals queue (two-admin rule) ✅

Money moves and other risky actions are **requested** by one admin and **approved** by
another before they run. (Wallet adjustments for merchants will be raised from the merchant's
page 🛠; this queue is where the second admin decides.)

```
Approvals                                          [Pending ▾]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Credit ₦25,000.00 to Ada Stores                            expires in 6 days │
│ “Goodwill credit for delayed parcel LCM-4F2K-9XPT” · requested by Bola · 2h   │
│                                         [Reject]  [Approve]                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

- List: `GET /admin/approvals?status=pending&page=1&limit=20` (oldest first). Any admin.
- Detail: `GET /admin/approvals/:id`.
- **Approve**: `POST /admin/approvals/:id/approve { note? }`. The action runs immediately; the
  result comes back with status `executed`.
- **Reject**: `POST /admin/approvals/:id/reject { note }` (required, 3–1000 chars).
- **Cancel** (own requests only): `POST /admin/approvals/:id/cancel`.
- Undecided requests expire after **7 days**.

| Error | Show |
|---|---|
| `403 SELF_APPROVAL_NOT_ALLOWED` | Better: hide Approve when `requestedByUserId === me.id` and show Cancel |
| `403 FORBIDDEN` | "You don't have permission to approve this kind of request." |
| `409 APPROVAL_NOT_PENDING` | "Already {status}." Refresh the list |

---

## 18. Merchants: queue, review and account controls

| Endpoint | Permission (any of; `super` always qualifies) |
|---|---|
| `GET /admin/merchants`, `GET /admin/merchants/:id` | `kyc`, `ops`, `support` |
| KYC file links, review, approve, request changes, reject | `kyc` |
| Suspend, reinstate, settings | `ops` |

These routes keep working when the merchant platform is switched off. Every action is in the
audit log.

### 18.1 Merchants queue ✅

**`GET /admin/merchants?status=submitted&q=ada&page=1&limit=20`**

```json
{
  "items": [
    {
      "id": "uuid",
      "tradingName": "Ada Stores",
      "legalName": "Ada Stores Limited",
      "type": "business",
      "status": "submitted",
      "tier": null,
      "contactEmail": "ops@adastores.ng",
      "submittedAt": "2026-11-14T09:15:00.000Z",
      "waitingHours": 3,
      "createdAt": "2026-11-14T09:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

- Tabs per status: **To review** (`submitted`), **In review** (`in_review`), Changes requested,
  Approved, Rejected, Suspended, Closed, All.
- With `status=submitted` or `in_review` the list is **oldest first** (it's a queue);
  otherwise newest first.
- `q` searches trading/legal name, contact email and CAC number.
- `waitingHours` (set while waiting for a decision): amber past 8 hours, red past 24. The
  target is a decision within one working day.

### 18.2 Merchant review ✅

**`GET /admin/merchants/:id`**

```json
{
  "merchant": { "...": "same shape as the dashboard's overview.merchant" },
  "checklist": { "items": [ "...same as onboarding.items..." ], "readyToSubmit": true },
  "reviews": [
    { "key": "bank_account", "decision": "rejected", "reason": "Use an account in the business name", "decidedByUserId": "uuid", "decidedAt": "…" }
  ],
  "team": { "members": [ "..." ], "invites": [ "..." ] },
  "directors": [{ "id": "uuid", "fullName": "Ada Okafor", "idType": "nin", "idNumberLast4": "8901", "createdAt": "…" }],
  "documents": [{ "id": "uuid", "kind": "cac_certificate", "uploadedAt": "…" }],
  "bankAccount": {
    "bankCode": "058", "bankName": "GTBank", "accountNumberLast4": "6789",
    "accountName": "ADA STORES LIMITED", "verifiedAt": "…",
    "nameMatch": { "score": 1, "level": "strong" }
  }
}
```

**Layout.** A header with trading name, type, status and `waitingHours`; then one panel per
`checklist.items` entry with the section's data, an **Accept / Reject** toggle and a reason
field (required when rejecting, shown to the merchant).

- **Documents and IDs.** Never load files on page open. A "View" button calls:
  - `POST /admin/merchants/:id/documents/:documentId/link` → `{ url, expiresAt }`;
  - `POST /admin/merchants/:id/directors/:directorId/identity` →
    `{ fullName, idType, idNumber, idDocument: { url, expiresAt } }` with the **full** ID
    number.
  Open the result in a viewer dialog. Links work for **5 minutes**. Each click is logged with
  the admin's name. Clear the full ID number from memory when the dialog closes.
- **Bank.** Show `bankAccount.accountName` (from the bank) next to the legal name with the
  `nameMatch.level`: `strong` green, `partial` amber, `weak` red. It's a hint; the reviewer
  decides.
- **Save review** (without deciding yet): **`POST /admin/merchants/:id/review`**

  ```json
  {
    "items": [
      { "key": "profile", "decision": "accepted" },
      { "key": "bank_account", "decision": "rejected", "reason": "Use an account in the business name" }
    ]
  }
  ```

  `reason` 3–500 chars, required when rejecting. Moves `submitted → in_review`. Response
  `200`: the detail.

### 18.3 Decisions ✅

| Button | Call | Rules |
|---|---|---|
| **Approve** | `POST /admin/merchants/:id/approve { tier?, limits? }` | Sections without a decision are accepted. `409 REVIEW_HAS_REJECTED_ITEMS` (`details.keys`) if any section is still rejected |
| **Request changes** | `POST /admin/merchants/:id/request-changes { items?, note? }` | Needs at least one rejected section (`422 NO_REJECTED_ITEMS`). The merchant is emailed the rejected sections with reasons |
| **Reject** | `POST /admin/merchants/:id/reject { reason }` | 3–1000 chars. Final: the merchant can only close the account. Confirm first |

All three work from `submitted` or `in_review` (`409 INVALID_MERCHANT_TRANSITION` otherwise:
someone else decided first, refresh).

**Approve dialog**

```json
{ "tier": "business", "limits": { "liveShipmentsPerDay": 150000 } }
```

| Field | Rules |
|---|---|
| `tier` | Optional: `individual`, `business`, `enterprise`. Defaults to the merchant's type |
| `limits` | Optional overrides: `liveShipmentsPerDay`, `maxWalletBalanceKobo` (≥ 0), `negativeBalanceFloorKobo` (≤ 0). `null` = unlimited |

Show the tier defaults next to the fields: individual 2,000/day, ₦50m wallet, −₦50k floor;
business 100,000/day, ₦2bn, −₦1m; enterprise unlimited.

Disable **Approve** while any panel is set to Reject, and **Request changes** while none is.

### 18.4 Account controls ✅ (`ops`)

- **Suspend:** `POST /admin/merchants/:id/suspend { reason }`, from any status except
  `closed`. The team can sign in and read but not edit; new live shipments, live keys and
  live webhook changes are blocked; parcels in flight continue. The team is emailed.
- **Reinstate:** `POST /admin/merchants/:id/reinstate` returns to the status before
  suspension.
- **Settings:** `PATCH /admin/merchants/:id/settings` with any subset →

  ```json
  { "receiverCodeRelay": true, "creationPaused": false, "tier": "enterprise", "limits": {} }
  ```

  | Field | Label |
  |---|---|
  | `receiverCodeRelay` | "Merchant may relay collection codes itself" (unlocks `notifyReceiver: merchant/both`) |
  | `creationPaused` | "Pause new live shipments for this merchant" |
  | `tier` | Tier select |
  | `limits` | **Replaces** all overrides; `{}` = back to tier defaults |

  Response `200`: the detail.

### 18.5 Statuses in the admin app

Same values as the dashboard (§5.4). Suggested badges: `draft` grey, `submitted` blue,
`in_review` blue, `changes_requested` amber, `approved` green, `rejected` red, `suspended`
red, `closed` grey.

### 18.6 Merchant wallet panel ✅ (`finance`, `ops`, `support` to view; `finance` to adjust)

A "Wallet" tab on the merchant page, with a Test / Live switch (`?mode=`, default `live`).

| Call | Returns |
|---|---|
| `GET /admin/merchants/:id/wallet?mode=live` | `Wallet` (same shape as the dashboard's, §15.1) |
| `GET /admin/merchants/:id/wallet/entries?mode=&type=&from=&to=&limit=&cursor=` | `CursorPage<WalletEntry>` (§15.2) |
| `GET /admin/merchants/:id/wallet/holds?mode=&status=&limit=&cursor=` | `CursorPage<WalletHold>` (§15.3) |
| `GET /admin/merchants/:id/wallet/top-ups?mode=&limit=&cursor=` | `CursorPage<TopUp>` (§15.7) |

**Adjust balance** (`finance` only; hide the button otherwise). A dialog:

- Credit / Debit toggle and an amount in naira (send **kobo**, negative for a debit).
- "Reason (internal)": required, 3–1000 chars. The approving admin sees it.
- "Note on the merchant's statement": optional, ≤ 200 chars. Default "Adjustment by
  Locoomo".

**`POST /admin/merchants/:id/wallet/adjustments`**

```json
{ "mode": "live", "amountKobo": 2500000, "reason": "Goodwill credit for delayed parcel LCM-4F2K-9XPT", "merchantNote": "Goodwill credit" }
```

→ `201 { approvalId, status: "pending", summary: "Credit ₦25,000.00 to Ada Stores (live wallet)", expiresAt }`.

**Nothing moves yet.** Toast: "Sent for approval. Another finance admin must approve it in
Approvals." It appears in the Approvals queue (§17.3). When a **different** `finance` admin
approves it, the money moves and the approval's `result` is
`{ entryId, amountKobo, balanceAfterKobo }`. A debit may take the balance below zero; warn
in the dialog when it would.

### 18.7 Coming 🛠

- **Merchant 360** (read-only support view): API key metadata, webhook health, wallet,
  shipments, audit log. There's no "log in as merchant"; this view replaces it.
- **All orders** and **Reroutes** for merchant parcels.

---

## 19. Operations tools that affect merchant parcels

### 19.1 Public holidays ✅ (`ops`)

Buyers have **7 working days** to collect a parcel. Public holidays don't count, so ops must
add them (federal holidays are often announced late).

| Call | |
|---|---|
| `GET /admin/public-holidays?from=2026-01-01` | `[{ "date": "2026-12-25", "name": "Christmas Day" }]`, oldest first |
| `POST /admin/public-holidays { date, name }` | `date` is a Lagos date (`YYYY-MM-DD`). Adding an existing date renames it. `201` |
| `DELETE /admin/public-holidays/:date` | `204`; `404` if it isn't listed |

Screen: a list for the current year with "Add holiday" (date picker + name) and a delete icon
per row. Help text: "A new holiday affects parcels shelved after it's added. Existing
deadlines aren't recalculated."

### 19.2 Lost or damaged parcel ✅ (`ops`)

On the admin order page, a "Report lost or damaged" action for parcels in our custody:

**`POST /admin/orders/:id/exception`**

```json
{ "type": "lost", "note": "Rider reports the parcel fell off the bike" }
```

`type`: `lost` or `damaged`. `note` (5–1000 chars) stays internal. The order moves to
`exception`, whatever it was holding is freed and the sender (or merchant) is told.
`409 ILLEGAL_ORDER_TRANSITION` before drop-off or after it's finished. Confirm: "Mark this
parcel as {type}? This can't be undone."

---

# Reference

## 20. All TypeScript types

```ts
// ─── Envelope and errors ────────────────────────────────────────────────
export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    correlationId: string;
    details?: FieldError[] | Record<string, unknown>;
  };
}
export interface FieldError { field: string; constraint: string; message: string }
export interface AppError {
  status: number;
  code: string;
  message: string;
  details: FieldError[] | Record<string, unknown>;
  correlationId?: string;
  retryAfter?: number;
}
export interface CursorPage<T> { items: T[]; nextCursor: string | null; hasMore: boolean }
export interface Paginated<T> { items: T[]; page: number; limit: number; total: number }

// ─── Users and auth ─────────────────────────────────────────────────────
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
export interface MfaChallenge { mfaRequired: true; mfaToken: string }   // 5 min, 5 tries
export type SignInResponse = User | MfaChallenge;
export const needsMfa = (r: SignInResponse): r is MfaChallenge =>
  (r as MfaChallenge).mfaRequired === true;
export interface MfaStatus {
  enabled: boolean;
  confirmedAt: string | null;
  recoveryCodesRemaining: number;
  required: boolean;                  // admins: must have it, can't turn it off
  enrollmentDeadline: string | null;  // only when required && !enabled
}
export interface MfaSetup { secret: string; otpauthUrl: string; qrDataUrl: string }
export interface Session {
  id: string;
  startedAt: string;
  lastActiveAt: string;               // accurate to ~15 minutes
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}
export type ReauthBody =
  | { code: string } | { recoveryCode: string }
  | { password: string } | { googleIdToken: string };

// ─── Merchant account ───────────────────────────────────────────────────
export type MerchantType = 'business' | 'individual';
export type MerchantStatus =
  | 'draft' | 'submitted' | 'in_review' | 'changes_requested'
  | 'approved' | 'rejected' | 'suspended' | 'closed';
export type MerchantTier = 'individual' | 'business' | 'enterprise';
export type MerchantRole = 'owner' | 'admin' | 'developer' | 'operations' | 'finance' | 'viewer';
export type MerchantPermission =
  | 'shipments.read' | 'shipments.write' | 'returns.collect' | 'developers.manage'
  | 'wallet.manage' | 'account.manage' | 'team.manage' | 'ownership';
export type SectionKey = 'profile' | 'business_registration' | 'directors' | 'bank_account' | 'terms';
export type MonthlyVolume = 'up_to_100' | 'up_to_1k' | 'up_to_10k' | 'up_to_100k' | 'over_100k';
export type IdType = 'nin' | 'passport' | 'drivers_licence' | 'voters_card';
export type DocumentKind = 'cac_certificate' | 'cac_status_report' | 'proof_of_address';

export interface MerchantLimits {
  liveShipmentsPerDay: number | null;      // null = unlimited
  maxWalletBalanceKobo: number | null;
  negativeBalanceFloorKobo: number | null;
}
export interface Merchant {
  id: string;
  type: MerchantType;
  status: MerchantStatus;
  tradingName: string;
  legalName: string | null;
  category: string | null;
  storeUrl: string | null;
  expectedMonthlyVolume: MonthlyVolume | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; state: string | null };
  cacNumber: string | null;
  tier: MerchantTier | null;
  limits: MerchantLimits | null;           // set once approved
  receiverCodeRelay: boolean;
  creationPaused: boolean;
  terms: { acceptedVersion: string | null; acceptedAt: string | null; currentVersion: string };
  submittedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  approvedAt: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ChecklistItem {
  key: SectionKey;
  complete: boolean;
  missing: string[];
  review: { decision: 'accepted' | 'rejected'; reason: string | null } | null;
}
export interface MerchantDocument { id: string; kind: DocumentKind; uploadedAt: string }
export interface Director { id: string; fullName: string; idType: IdType; idNumberLast4: string; createdAt: string }
export interface BankAccount {
  bankCode: string; bankName: string; accountNumberLast4: string;
  accountName: string; verifiedAt: string;
}
export interface MerchantAccountOverview {
  merchant: Merchant;
  me: { memberId: string; role: MerchantRole; permissions: MerchantPermission[] };
  onboarding: { items: ChecklistItem[]; readyToSubmit: boolean; editable: boolean };
  documents: MerchantDocument[];
  directors: Director[];
  bankAccount: BankAccount | null;
}
export interface KycUploadSignature {
  signature: string; timestamp: number; apiKey: string; cloudName: string; folder: string;
}
export interface Bank { code: string; name: string }

// ─── Team ───────────────────────────────────────────────────────────────
export interface TeamMember {
  id: string; userId: string; firstName: string; lastName: string;
  email: string; role: MerchantRole; joinedAt: string;
}
export interface TeamInvite {
  id: string; email: string; role: Exclude<MerchantRole, 'owner'>;
  expiresAt: string; createdAt: string;
}
export interface TeamView { members: TeamMember[]; invites: TeamInvite[] }
export interface InvitePreview {
  merchantName: string; role: Exclude<MerchantRole, 'owner'>; email: string; expiresAt: string;
}

// ─── Developers ─────────────────────────────────────────────────────────
export type Mode = 'test' | 'live';
export type ApiKeyKind = 'secret' | 'publishable';
export type ApiKeyScope =
  | 'shipments:read' | 'shipments:write' | 'manifests:write'
  | 'webhooks:manage' | 'wallet:read' | 'claims:write';
export interface ApiKey {
  id: string;
  mode: Mode;
  kind: ApiKeyKind;
  name: string;
  displayKey: string;                      // "sk_test_…a1B2"
  scopes: ApiKeyScope[];                   // [] for publishable keys
  allowedIps: string[];
  allowedOrigins: string[];
  hidePrices: boolean;
  state: 'active' | 'expiring' | 'expired' | 'revoked';
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
}
export interface CreatedApiKey { key: ApiKey; secret: string }   // secret: shown once
export interface ApiRequestLog {
  id: string;
  apiKeyId: string;
  apiKeyName: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ip: string;
  correlationId: string;
  createdAt: string;
}

export type WebhookEventType =
  | 'shipment.created' | 'shipment.updated' | 'shipment.cancelled' | 'shipment.expired'
  | 'shipment.refused' | 'shipment.received' | 'shipment.fee_adjusted' | 'shipment.in_transit'
  | 'shipment.destination_changed' | 'shipment.ready_for_collection'
  | 'shipment.collection_reminder' | 'shipment.collected' | 'shipment.returning'
  | 'shipment.return_ready' | 'shipment.returned' | 'shipment.disposed' | 'shipment.exception'
  | 'merchant.status_changed';
export interface WebhookEndpoint {
  id: string;
  mode: Mode;
  url: string;
  description: string | null;
  events: string[];                        // [] = all events
  enabled: boolean;
  disabledReason: string | null;
  failingSince: string | null;
  lastSuccessAt: string | null;
  previousSecretExpiresAt: string | null;  // set for 24h after a secret roll
  createdAt: string;
}
export interface CreatedWebhookEndpoint { endpoint: WebhookEndpoint; secret: string }   // whsec_…, once
export interface WebhookTestResult {
  delivered: boolean; responseStatus: number | null; durationMs: number; error: string | null;
}
export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: string;
  endpointId: string;
  status: 'pending' | 'delivering' | 'succeeded' | 'failed';
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  responseStatus: number | null;
  responseBody: string | null;             // first 2 KB
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

// ─── Nodes, quotes, shipments ───────────────────────────────────────────
export type ParcelSize = 'small' | 'medium' | 'large' | 'extra_large';
export type Handling = 'fragile' | 'keep_upright' | 'perishable' | 'liquid';
type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export interface MerchantNode {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  distanceKm: number | null;               // null without ?near=
  openingHours: Partial<Record<Day, { open: string; close: string }[]>>;
  contactPhone: string | null;
  acceptingParcels: boolean;
}
export interface FeeBreakdown {
  baseKobo: number; distanceKobo: number; volumeDiscountKobo: number; vatKobo: number;
}
export interface Quote {
  currency: 'NGN';
  amountKobo: number | null;               // null when the key hides prices
  breakdown: FeeBreakdown | null;
  vehicleClass: string;
  estimatedReadyInWorkingDays: number;
}

export type ShipmentStatus =
  | 'created' | 'received' | 'in_transit' | 'ready_for_collection' | 'collected'
  | 'returning' | 'return_ready' | 'returned'
  | 'cancelled' | 'expired' | 'refused' | 'exception' | 'disposed';
export type NotifyReceiver = 'locoomo' | 'merchant' | 'both';
export interface Parcel {
  description: string;
  size: ParcelSize;
  weightKg?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  handling?: Handling[];
  declaredValueKobo?: number;
}
export interface Shipment {
  id: string;
  mode: Mode;
  reference: string;
  trackingCode: string;                    // LCT-… (test) / LCM-… (live)
  trackingUrl: string | null;
  status: ShipmentStatus | string;         // tolerate new statuses
  sequence: number;
  statusChangedAt: string;
  origin: { type: 'hub' | 'node'; nodeId: string | null; nodeName: string | null };
  destination: {
    nodeId: string; nodeName: string; address: string | null;
    city: string | null; state: string | null; changed: boolean;
  };
  receiver: { name: string; phone: string; email: string | null };
  parcel: Parcel & { measured: { weightKg?: number; size?: ParcelSize } | null };
  externalBarcode: string | null;
  manifestId: string | null;
  fee: {
    currency: 'NGN';
    quotedKobo: number;
    chargedKobo: number | null;
    state: 'held' | 'charged' | 'released';
    breakdown: FeeBreakdown | null;
  };
  dropDeadline: string;
  collection: {
    deadline: string | null;
    collectedAt: string | null;
    method: 'code' | 'id_check' | null;
    collectorName: string | null;
  };
  return: { reason: 'not_collected' | 'delivery_failed' | 'merchant_request'; readyForCollectionAt?: string | null } | null;
  exception: { type: 'lost' | 'damaged'; reportedAt: string; claimId?: string | null } | null;
  notifyReceiver: NotifyReceiver;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
export interface CreateShipmentBody {
  reference: string;
  destinationNodeId: string;
  origin: { type: 'hub' } | { type: 'node'; nodeId: string };
  receiver: { name: string; phone: string; email?: string };
  parcel: Parcel;
  externalBarcode?: string;
  notifyReceiver?: NotifyReceiver;
  metadata?: Record<string, string>;
}
export interface TimelineEntry {
  type: ShipmentStatus | 'updated' | 'fee_adjusted' | 'destination_changed' | 'collection_reminder' | string;
  at: string;
  nodeName: string | null;
  sequence: number;
  data: Record<string, unknown> | null;   // event details (adjustment, previousOrigin, reason, …)
}
export interface BulkResult {
  results: (
    | { index: number; ok: true; shipment: Shipment }
    | { index: number; ok: false; error: { code: string; message?: string; details?: FieldError[] } }
  )[];
}
export type SimulateTarget = ShipmentStatus | 'fee_adjusted' | 'destination_changed';

// ─── Wallet ─────────────────────────────────────────────────────────────
export interface Wallet {
  mode: Mode;
  currency: 'NGN';
  balanceKobo: number;                     // may be negative
  heldKobo: number;
  availableKobo: number;                   // balance − held
  updatedAt: string;
}
export type WalletEntryType =
  | 'top_up' | 'shipment_charge' | 'shipment_adjustment' | 'adjustment'
  | 'claim_credit' | 'refund' | 'test_funding';
export interface WalletEntry {
  id: string;
  type: WalletEntryType | string;          // tolerate new types
  amountKobo: number;                      // signed: credits +, debits −
  balanceAfterKobo: number;
  description: string;
  shipmentId: string | null;
  createdAt: string;
}
export interface WalletHold {
  id: string;
  shipmentId: string;
  status: 'active' | 'captured' | 'released';
  amountKobo: number;
  capturedKobo: number | null;             // what was finally charged
  createdAt: string;
  resolvedAt: string | null;
}
export interface TopUp {
  id: string;
  mode: Mode;
  method: 'card' | 'bank_transfer';
  status: 'pending' | 'succeeded' | 'failed' | 'abandoned';
  amountKobo: number;                      // what the payer paid
  feeKobo: number;                         // card fee (0 for transfers)
  creditedKobo: number | null;             // what reached the wallet
  reference: string;
  paidAt: string | null;
  createdAt: string;
}
export interface StartedTopUp { topUp: TopUp; authorizationUrl: string }
export interface FundingAccount {
  bankName: string;
  accountNumber: string;
  accountName: string;
  createdAt: string;
}
export interface WalletAdjustmentRequested {
  approvalId: string;
  status: 'pending';
  summary: string;
  expiresAt: string;
}

// ─── Admin ──────────────────────────────────────────────────────────────
export type AdminPermission = 'super' | 'kyc' | 'finance' | 'ops' | 'support';
export interface AdminAccount {
  id: string; email: string; firstName: string; lastName: string;
  status: UserStatus; adminPermissions: AdminPermission[];
}
export type ApprovalStatus = 'pending' | 'executed' | 'rejected' | 'cancelled' | 'expired';
export interface ApprovalRequest {
  id: string;
  action: string;                          // e.g. 'wallet.manual_adjustment'
  status: ApprovalStatus;
  summary: string;
  reason: string;
  payload: Record<string, unknown>;
  merchantId: string | null;
  requestedByUserId: string;
  decidedByUserId: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  result: Record<string, unknown> | null;
  expiresAt: string;
  createdAt: string;
}
export interface AdminMerchantListItem {
  id: string;
  tradingName: string;
  legalName: string | null;
  type: MerchantType;
  status: MerchantStatus;
  tier: MerchantTier | null;
  contactEmail: string | null;
  submittedAt: string | null;
  waitingHours: number | null;
  createdAt: string;
}
export interface AdminMerchantDetail {
  merchant: Merchant;
  checklist: { items: ChecklistItem[]; readyToSubmit: boolean };
  reviews: {
    key: SectionKey; decision: 'accepted' | 'rejected'; reason: string | null;
    decidedByUserId: string; decidedAt: string;
  }[];
  team: TeamView;
  directors: Director[];
  documents: MerchantDocument[];
  bankAccount: (BankAccount & { nameMatch: { score: number; level: 'strong' | 'partial' | 'weak' } }) | null;
}
export interface PublicHoliday { date: string; name: string }   // date: YYYY-MM-DD (Lagos)
```

---

## 21. Error codes

Branch on `code`. Anything not listed: show `message`, and fall back on the HTTP status.

**Anywhere**

| HTTP | Code | What the UI does |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Field errors from `details[].field` |
| 400 | `MALFORMED_JSON` | Generic error (client bug) |
| 400 | `INVALID_CURSOR` | Reload the list from the top |
| 400 | `INVALID_MODE` | Bug: `Locoomo-Mode` must be `test` or `live` |
| 401 | `UNAUTHENTICATED` (and any 401) | Refresh once, else sign out (§3.3) |
| 403 | `CSRF_HEADER_MISSING` | Not reachable once §3.1 is done |
| 403 | `FORBIDDEN` | "You don't have access to this." |
| 404 | `NOT_FOUND` | "Not found." In the dashboard, maybe the other mode |
| 413 | `PAYLOAD_TOO_LARGE` | "That's too large to send in one go." |
| 429 | `RATE_LIMITED` | Wait `Retry-After` seconds |
| 500 | `INTERNAL_ERROR` | "Something went wrong." + `correlationId` |

**Sign-in and security**

| HTTP | Code | What the UI does |
|---|---|---|
| 401 | `INVALID_CREDENTIALS` | "Wrong email or password." / in step-up, "Wrong password." |
| 401 | `INVALID_MFA_CODE` | "That code didn't work." |
| 401 | `INVALID_MFA_CHALLENGE` | Back to the password screen |
| 403 | `REAUTH_REQUIRED` | "Confirm it's you", then retry (§4.3) |
| 403 | `MFA_ENROLLMENT_REQUIRED` | Admin: route to the 2FA wizard |
| 403 | `MFA_REQUIRED_FOR_ROLE` | Hide "Turn off" for admins |
| 403 | `EMAIL_NOT_VERIFIED` | Verify-email banner (§4.5) |
| 409 | `MFA_ALREADY_ENABLED` / `MFA_NOT_ENABLED` / `MFA_SETUP_NOT_STARTED` | Refetch `GET /auth/mfa` |
| 409 | `EMAIL_ALREADY_VERIFIED` | Refetch the user, hide the banner |

**Idempotency**

| HTTP | Code | What the UI does |
|---|---|---|
| 400 | `INVALID_IDEMPOTENCY_KEY` | Bug: send a UUID |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | Retry after ~1 s with the same key |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Bug: new key per action |

**Merchant account, onboarding, team**

| HTTP | Code | What the UI does |
|---|---|---|
| 503 | `MERCHANT_PLATFORM_DISABLED` | Full-page "We'll be right back"; retry every minute |
| 403 | `NOT_A_MERCHANT_MEMBER` | Route to "Create business" (§5.2) |
| 403 | `MERCHANT_PERMISSION_DENIED` | Hide the control; refetch `/merchant/account` |
| 403 | `ADMINS_CANNOT_JOIN_MERCHANTS` | "Use a non-admin account for the merchant dashboard." |
| 409 | `ALREADY_A_MERCHANT_MEMBER` | Create / accept invite (§6, §8.3) |
| 409 | `MERCHANT_NOT_EDITABLE` | Render read-only |
| 409 | `MERCHANT_DETAILS_LOCKED` | "Contact your account manager to change this." (`details.fields`) |
| 422 | `NOT_APPLICABLE_TO_INDIVIDUALS` | Hide CAC fields for individuals |
| 422 | `ONBOARDING_INCOMPLETE` | Highlight `details.sections[].key` |
| 422 | `UPLOAD_NOT_FOUND` | "Upload the file again." |
| 409 | `DIRECTOR_LIMIT_REACHED` | §7.5 |
| 400 | `BANK_ACCOUNT_VERIFICATION_FAILED` | "We couldn't find that account. Check the number and bank." |
| 502 | `PAYMENT_PROVIDER_ERROR` | "We couldn't reach the bank. Try again in a few minutes." |
| 409 | `TERMS_VERSION_OUTDATED` | Reload the terms |
| 409 | `INVALID_MERCHANT_TRANSITION` | Someone else acted first: refetch |
| 409 | `ALREADY_A_TEAM_MEMBER` | "They're already on your team." |
| 409 | `OWNER_ROLE_PROTECTED` | Not reachable if the owner row has no controls |
| 404 | `INVALID_MERCHANT_INVITE` | "This invitation has expired or was already used." |
| 403 | `INVITE_EMAIL_MISMATCH` | "This invitation is for {email}…" |

**Developers**

| HTTP | Code | What the UI does |
|---|---|---|
| 403 | `MERCHANT_NOT_APPROVED` | "Live keys unlock when your account is approved." |
| 403 | `MERCHANT_SUSPENDED` | "Your account is suspended…" |
| 403 | `MFA_REQUIRED_FOR_LIVE_KEYS` | Depends on `details.who` (§9.3) |
| 409 | `API_KEY_LIMIT_REACHED` | "Revoke an unused key first." |
| 409 | `API_KEY_REVOKED` | Refresh the list |
| 422 | `INVALID_WEBHOOK_URL` | Show `message` under the URL field |
| 409 | `WEBHOOK_ENDPOINT_LIMIT_REACHED` | "Remove an endpoint first." |
| 422 | `REPLAY_WINDOW_EXCEEDED` | "Replays reach back 30 days at most." |

**Shipments and quotes**

| HTTP | Code | What the UI does |
|---|---|---|
| 402 | `INSUFFICIENT_WALLET_BALANCE` | §12.4 |
| 422 | `WALLET_BALANCE_LIMIT_EXCEEDED` | Top-up: §15.5 |
| 422 | `TOP_UPS_UNAVAILABLE` | Test top-up where unsupported: point to Reset (§15.4) |
| 422 / 409 | `CONTACT_DETAILS_REQUIRED` / `FUNDING_ACCOUNT_CONFLICT` | Bank-transfer account: §15.6 |
| 403 | `LIVE_MODE_ONLY` | Hide live-only controls in Test mode |
| 403 | `LIVE_SHIPMENTS_NOT_AVAILABLE` | "Live shipments aren't available yet. Switch to Test." |
| 403 | `SHIPMENT_CREATION_PAUSED` | "New live shipments are paused on your account." |
| 403 | `TEST_MODE_ONLY` | Hide the simulator on live shipments |
| 409 | `DUPLICATE_REFERENCE` | Link to `details.existingShipmentId` |
| 409 | `SHIPMENT_NOT_EDITABLE` / `SHIPMENT_NOT_CANCELLABLE` / `SHIPMENT_NOT_RETURNABLE` | Refetch; hide the button |
| 409 | `INVALID_SIMULATION` | "That can't happen from {status}." |
| 422 | `DESTINATION_NODE_UNAVAILABLE` / `ORIGIN_NODE_UNAVAILABLE` | "Pick another Node." |
| 422 | `ORIGIN_REQUIRED` | "Pick where you'll drop it off." |
| 422 | `RECEIVER_UNREACHABLE` | "Add the buyer's email." |
| 422 | `RECEIVER_RELAY_NOT_ENABLED` | Hide the option unless `receiverCodeRelay` |
| 422 | `NO_DELIVERY_OPTION` | "Too big or heavy, or we don't cover this route yet." |
| 503 | `PRICING_NOT_CONFIGURED` | "Pricing unavailable right now." |
| 429 | `DAILY_LIMIT_REACHED` 🛠 | Live only: "You've reached today's shipment limit." |

**Admin**

| HTTP | Code | What the UI does |
|---|---|---|
| 409 | `LAST_SUPER_ADMIN` | §17.2 |
| 403 | `SELF_APPROVAL_NOT_ALLOWED` | Hide Approve on own requests |
| 409 | `APPROVAL_NOT_PENDING` | Refresh the list |
| 409 | `REVIEW_HAS_REJECTED_ITEMS` | Disable Approve while a section is rejected |
| 422 | `NO_REJECTED_ITEMS` | Disable Request changes until one is |
| 409 | `ILLEGAL_ORDER_TRANSITION` | "This parcel can't be marked that way now." |

---

## 22. Endpoint index

All under `/api/v1`. "Mode" = sends `Locoomo-Mode`. "Step-up" = may answer `REAUTH_REQUIRED`.

**Auth** (every app)

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register`, `/auth/login`, `/auth/google` | Login/Google may return an MFA challenge |
| POST | `/auth/mfa/verify` | `{ mfaToken, code \| recoveryCode }` |
| POST | `/auth/refresh`, `/auth/logout` | |
| POST | `/auth/reauth` | Step-up |
| POST | `/auth/verify-email`, `/auth/verify-email/resend` | |
| GET | `/users/me` | |
| GET | `/auth/mfa` | |
| POST | `/auth/mfa/totp/setup` (step-up), `/auth/mfa/totp/confirm`, `/auth/mfa/recovery-codes` (step-up) | |
| DELETE | `/auth/mfa` | Step-up |
| GET | `/auth/sessions` | |
| POST | `/auth/sessions/revoke-others` | |
| DELETE | `/auth/sessions/:id` | |

**Merchant dashboard**

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/merchant/account` | none | Create business |
| GET | `/merchant/account` | any member | Overview |
| PATCH | `/merchant/account/profile` | `account.manage` | |
| POST | `/merchant/account/uploads` | `account.manage` | Cloudinary signature |
| PUT | `/merchant/account/documents/:kind` | `account.manage` | |
| POST / DELETE | `/merchant/account/directors`, `/merchant/account/directors/:id` | `account.manage` | |
| GET | `/merchant/banks` | any member | |
| PUT | `/merchant/account/bank-account` | `account.manage` | Step-up |
| POST | `/merchant/account/terms` | `account.manage` | |
| POST | `/merchant/account/submit` | `account.manage` | |
| POST | `/merchant/account/close` | `ownership` | Step-up |
| GET | `/merchant/team` | any member | |
| POST / DELETE | `/merchant/team/invites`, `/merchant/team/invites/:id` | `team.manage` | |
| PATCH | `/merchant/team/members/:id` | `team.manage` | Step-up |
| DELETE | `/merchant/team/members/:id` | `team.manage` | |
| DELETE | `/merchant/team/members/me` | any but owner | |
| POST | `/merchant/team/transfer-ownership` | `ownership` | Step-up |
| POST | `/merchant/invites/preview` | public | |
| POST | `/merchant/invites/accept` | signed in | |
| GET / POST | `/merchant/api-keys` | `developers.manage` | Live: step-up + 2FA |
| PATCH | `/merchant/api-keys/:id` | `developers.manage` | Live: step-up |
| POST | `/merchant/api-keys/:id/roll` | `developers.manage` | Live: step-up + 2FA |
| POST | `/merchant/api-keys/:id/revoke`, `/merchant/api-keys/revoke-all` | `developers.manage` | |
| GET | `/merchant/api-logs` | `developers.manage` | |
| GET / POST | `/merchant/webhook-endpoints` | `developers.manage` | Mode |
| PATCH / DELETE | `/merchant/webhook-endpoints/:id` | `developers.manage` | Mode; URL change: step-up |
| POST | `/merchant/webhook-endpoints/:id/roll-secret` | `developers.manage` | Mode; step-up |
| POST | `/merchant/webhook-endpoints/:id/test`, `/merchant/webhook-endpoints/:id/replay` | `developers.manage` | Mode |
| GET | `/merchant/webhook-deliveries` | `developers.manage` | Mode |
| GET | `/merchant/nodes`, `/merchant/nodes/:id`, `/merchant/quotes` | any member | |
| GET | `/merchant/shipments`, `/merchant/shipments/:id`, `/merchant/shipments/:id/timeline` | `shipments.read` | Mode |
| POST | `/merchant/shipments`, `/merchant/shipments/bulk` | `shipments.write` | Mode; `Idempotency-Key` |
| PATCH | `/merchant/shipments/:id` | `shipments.write` | Mode |
| POST | `/merchant/shipments/:id/cancel`, `/merchant/shipments/:id/return-to-sender` | `shipments.write` | Mode |
| POST | `/merchant/test/shipments/:id/simulate` | `shipments.write` | Test mode only |
| GET | `/merchant/wallet` | any member | Mode |
| GET | `/merchant/wallet/entries`, `/merchant/wallet/holds` | `wallet.manage` | Mode |
| POST | `/merchant/test/wallet/reset` | `shipments.write` | Test mode only |
| POST | `/merchant/wallet/top-ups` | `wallet.manage` | Mode; dashboard only; `Idempotency-Key` |
| GET | `/merchant/wallet/top-ups`, `/merchant/wallet/top-ups/:id` | `wallet.manage` | Mode |
| GET | `/merchant/wallet/funding-account` | any member | Live (null in test) |
| POST | `/merchant/wallet/funding-account` | `wallet.manage` | Live only; dashboard only |

**Admin app**

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/admins` | `super` |
| PATCH | `/admin/admins/:id/permissions` | `super` |
| GET | `/admin/approvals`, `/admin/approvals/:id` | any admin |
| POST | `/admin/approvals/:id/approve`, `…/reject`, `…/cancel` | depends on the action |
| GET | `/admin/merchants`, `/admin/merchants/:id` | `kyc`, `ops`, `support` |
| POST | `/admin/merchants/:id/documents/:documentId/link`, `/admin/merchants/:id/directors/:directorId/identity` | `kyc` |
| POST | `/admin/merchants/:id/review`, `…/approve`, `…/request-changes`, `…/reject` | `kyc` |
| POST | `/admin/merchants/:id/suspend`, `…/reinstate` | `ops` |
| PATCH | `/admin/merchants/:id/settings` | `ops` |
| GET / POST | `/admin/public-holidays` | `ops` |
| DELETE | `/admin/public-holidays/:date` | `ops` |
| POST | `/admin/orders/:id/exception` | `ops` |
| GET | `/admin/merchants/:id/wallet`, `…/wallet/entries`, `…/wallet/holds`, `…/wallet/top-ups` | `finance`, `ops`, `support` |
| POST | `/admin/merchants/:id/wallet/adjustments` | `finance` (runs after a second `finance` admin approves) |

---

## 23. Testing locally and on staging

- **Point the dashboard at staging from `localhost`.** Ask backend to add your local origin
  (e.g. `http://localhost:5173`) to staging's `CORS_ORIGIN`. Note the cookie caveat in §2: if
  cookies don't stick, ask backend for the `locoomo.com` staging subdomain.
- **2FA without a phone.** During setup, take `secret` from the response and generate codes
  with `oathtool --totp -b <secret>` (package `oath-toolkit`), or add it manually to an
  authenticator app. Codes rotate every 30 seconds and can't be reused.
- **Get an approved merchant.** Create a business, complete the checklist and submit, then
  approve it from the admin app with a `kyc` (or `super`) admin. Use a **different** account
  for the admin: admins can't be merchant members.
- **Live keys.** Need an approved merchant and 2FA on both you and the owner.
- **Webhooks.** Use a request-catcher URL (any public `https://` endpoint that shows incoming
  requests) as the endpoint, then use *Send test event* and the simulator. `localhost` and
  private addresses are refused.
- **The whole shipment life.** In test mode create a shipment and simulate it to `collected`,
  then another to `returned`. Watch the timeline and the webhook deliveries.
- **Admin lockout.** Ask backend to set `mfaRequiredSince` 15 days in the past for your dev
  admin to reproduce `MFA_ENROLLMENT_REQUIRED`.
- **CSRF.** Backend logs `[CSRF report] … without the x-locoomo-client header` for requests
  missing the header. When your app produces none, tell backend it's ready for enforcement.
- **Sessions.** Sign in from two browsers, revoke one from the other: the revoked tab gets
  `401` on its next request.
- **Bug reports.** Always include the `correlationId` (error body or `X-Correlation-Id`
  header).
