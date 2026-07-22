# API Guide for Frontend Integration

What the frontend needs to consume this API: base URL, auth flow, response shape, error
codes, and endpoint-by-endpoint request/response contracts. Kept current as endpoints
ship — if something you need isn't here, it isn't built yet

## Base URL and versioning

```
{API_ORIGIN}/api/v1/...
```

`/health` is the one exception — unprefixed, unversioned, infra probe only, not for
frontend use.

## CORS and cookies — read this before writing any auth code

Sessions are httpOnly cookies, not bearer tokens — there is no token for frontend code
to read or store. This has real implications for how you call the API:

- **Every request that should carry the session must set `credentials: 'include'`**
  (`fetch`) or `withCredentials: true` (axios). Without it, the browser won't send the
  session cookies even if they exist.

- **The frontend origin must be on the allow-list** the API's `CORS_ORIGIN` env var
  defines. If you're getting CORS errors, that's almost certainly it — ask backend to
  add your dev origin (e.g. `http://localhost:5173`).

- **The frontend must be same-site with the API** — same registrable domain, e.g.
  `app.locoomo.com` calling `api.locoomo.com`. 

- You cannot read `access_token` or `refresh_token` from JavaScript (`document.cookie`)
  — they're httpOnly by design (XSS protection). Don't build UI that assumes you can
  inspect or manually attach them.

## Response envelope

Every response (except `/health`) is wrapped the same way. Always unwrap `data`, never
assume a raw resource body.

Success:

```json
{
  "success": true,
  "data": { "...": "endpoint-specific" },
  "meta": {
    "correlationId": "b1f2c3d4-...",
    "timestamp": "2026-07-22T09:14:00.000Z"
  }
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "correlationId": "b1f2c3d4-...",
    "details": [
      { "field": "email", "constraint": "isEmail", "message": "email must be an email" }
    ]
  }
}
```

`details` is only present on validation errors (400). Branch UI logic on `error.code`,
not `error.message` — the message is human-readable copy and can be reworded without
warning; the code is the stable contract.

Every response also carries an `X-Correlation-Id` response header (same value as
`meta.correlationId` / `error.correlationId`). Include it in bug reports — it's what
backend greps logs for.

## Error codes reference

| HTTP | code | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Request body failed DTO validation — see `error.details` for per-field reasons |
| 401 | `INVALID_CREDENTIALS` | Login failed — wrong password, unknown email, or account not yet activated. Deliberately identical for all three so a login attempt can't be used to enumerate registered emails; don't try to distinguish these cases in the UI |
| 403 | `ACCOUNT_SUSPENDED` | Password was correct but the account is suspended |
| 404 | `NOT_FOUND` | Route or resource doesn't exist |
| 409 | `EMAIL_ALREADY_REGISTERED` | Registration attempted with an email already on file |
| 500 | `INTERNAL_ERROR` | Unexpected server failure — message is always the generic "Something went wrong," never internal detail. Report the `correlationId` to backend |

## Endpoints

### `POST /api/v1/auth/register`

Consumer self-registration. Immediately active — no separate activation step.

Request:

```json
{
  "firstName": "Ada",
  "lastName": "Lovelace",
  "email": "ada@example.com",
  "phone": "+2348012345678",
  "password": "Correct-Horse-Battery-1",
  "passwordConfirmation": "Correct-Horse-Battery-1",
  "consentAccepted": true
}
```

| Field | Rules |
|---|---|
| `firstName`, `lastName` | 1–100 chars |
| `email` | valid email, max 255 chars, case-insensitive (stored lowercased) |
| `phone` | `+` optional, 7–15 digits |
| `password` | 12–128 chars. No composition rules beyond length (current OWASP guidance) — don't build a strength meter checking for uppercase/symbols/etc., it'd reject valid passwords this API accepts |
| `passwordConfirmation` | must exactly match `password` |
| `consentAccepted` | must be `true` — ToS/Privacy Policy acceptance (NDPA), there is no "accept later" |

Response `201`, `data`:

```json
{
  "id": "uuid",
  "email": "ada@example.com",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "phone": "+2348012345678",
  "role": "consumer",
  "status": "active",
  "emailVerifiedAt": null,
  "createdAt": "2026-07-22T09:14:00.000Z"
}
```

Registration does **not** log the user in — no session cookies are set. Send the user to
login next.

Errors: `400 VALIDATION_FAILED`, `409 EMAIL_ALREADY_REGISTERED`.

### `POST /api/v1/auth/login`

Request:

```json
{ "email": "ada@example.com", "password": "Correct-Horse-Battery-1" }
```

Response `200`, `data`: same `UserResponseDto` shape as register's response. The
session is delivered via `Set-Cookie`, not the body — see the cookie table below.

Errors: `400 VALIDATION_FAILED`, `401 INVALID_CREDENTIALS`, `403 ACCOUNT_SUSPENDED`.

| Cookie | Lifetime | Path | Notes |
|---|---|---|---|
| `access_token` | 15 min | `/` | Sent automatically on every request to the API's origin |
| `refresh_token` | 30 days | `/api/v1/auth/refresh` | Only ever sent to the refresh endpoint — don't expect to see it echoed elsewhere |

Both `httpOnly`, `Secure` in production, `SameSite=Strict`.


