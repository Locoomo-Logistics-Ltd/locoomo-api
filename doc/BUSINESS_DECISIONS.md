# Locoomo for Merchants: business decisions and the defaults in use

*As of 23 November 2026.* For the business, finance, legal and operations teams.

The merchant platform needs a number of business decisions. So that work could continue,
**each one has a sensible default**, listed below. Most defaults are already built into
the system, so changing one later is usually a setting rather than new work. Please
confirm or change each, and tell us which owner signs it off.

**Status:** ✅ built and running on staging with this default · 🛠 default agreed here,
not built yet · ⚖️ needs a legal/regulatory answer before production

## Commercial

| # | Decision | Default in use | Status | Owner | To confirm |
|---|---|---|---|---|---|
| 1 | Volume discounts | 0% under 500 parcels/month, 5% from 500, 10% from 5,000, 15% from 50,000 (last month's volume). Negotiated rates for large merchants replace the tiers. Discounts come out of Locoomo's share only, never from Node operators or riders | ✅ | Commercial | The tiers and percentages |
| 2 | SMS to buyers | Sent as "Locoomo", with the merchant's name in the message; Locoomo pays for SMS | ✅ | Commercial | Sender name; whether to pass SMS cost on |
| 3 | Return of an uncollected parcel | The trip back to the merchant is free | ✅ | Commercial | That returns stay free |
| 4 | Buyer's Node full or closed | Parcel rerouted to a nearby Node; **Locoomo absorbs any price difference** | ✅ | Commercial / ops | That we absorb the difference |

## Money and tax

| # | Decision | Default in use | Status | Owner | To confirm |
|---|---|---|---|---|---|
| 5 | Prepaid wallet | Merchants pay from a prepaid wallet ("prepaid service credit"). No withdrawals; unused balance refunded to their verified bank account only when they close the account | ✅ ⚖️ | Legal | **That this isn't regulated e-money / deposit-taking (CBN)** |
| 6 | Card top-up fees | Paystack's card fee is passed on (the merchant is credited the amount minus the fee). Bank-transfer top-ups are credited in full (Locoomo absorbs that fee) | ✅ | Finance | Who bears each fee |
| 7 | VAT | Prices include 7.5% VAT. Invoices do **not** show a VAT line until Locoomo confirms it charges VAT on these services (one switch turns it on) | ✅ | Finance / tax | Are we VAT-registered for this? Withholding tax for corporate merchants? |
| 8 | Tax invoice details | Monthly invoice per merchant, numbered per merchant and month. Seller shown as "Locoomo" until the registered company name, address and tax ID are set | ✅ | Finance | **Registered name, address, TIN.** Do we need gap-free sequential invoice numbers (FIRS)? |
| 9 | Overdraft after re-pricing | A wallet may go below zero when a parcel measures bigger than declared (the parcel keeps moving). Limits: ₦50,000 (individual sellers), ₦1,000,000 (businesses); finance is alerted beyond that | ✅ | Finance | The limits |
| 10 | Maximum wallet balance | ₦50,000,000 (individual sellers), ₦2,000,000,000 (businesses), no limit for enterprise | ✅ | Finance | The ceilings |

## Parcels, returns and claims

| # | Decision | Default in use | Status | Owner | To confirm |
|---|---|---|---|---|---|
| 11 | Collection window | Buyers have 7 working days (Mon–Fri, excluding Nigerian public holidays) to collect; reminders on days 5 and 6; then the parcel returns to the merchant | ✅ | Ops | The 7 working days |
| 12 | Storage of uncollected returns | Free for 10 working days, then **₦100 per parcel per day** from the merchant's wallet; **disposed of 30 days later**, with email notices when fees start and 7 days before disposal | ✅ ⚖️ | Ops / legal | Fee, periods, and **the merchant terms must say so** |
| 13 | Liability for lost or damaged parcels | Merchant gets the declared value, **capped at ₦50,000 per parcel** (higher by contract); claims within 30 days; payouts need two finance staff | ✅ | Legal / ops | The cap and window |
| 14 | Delivery fee when a parcel is lost | **Not refunded** today (the claim covers the goods only). Recommended default: refund the delivery fee too when a claim for a lost parcel is approved | 🛠 | Commercial | Refund the fee or not |
| 15 | Prohibited items | Nodes refuse at the counter (no charge). Default list: cash and negotiable instruments; firearms, ammunition and weapons; drugs and controlled substances; flammable, explosive or hazardous materials; perishable food; live animals; counterfeit goods; anything illegal to ship in Nigeria | 🛠 ⚖️ | Legal / ops | The list (goes in the merchant terms and Node training) |
| 16 | Consumer parcel refused or lost (not merchants) | Recommended default: refused at drop-off → full refund to the original payment; lost or damaged in our care → full refund of the delivery fee, plus goods up to ₦50,000 on a claim | 🛠 | Finance / ops | The policy (then we build it) |

## Legal and privacy

| # | Decision | Default in use | Status | Owner | To confirm |
|---|---|---|---|---|---|
| 17 | How long we keep buyer details | 180 days after a parcel is finished, then removed automatically (delivery photos deleted too) | ✅ ⚖️ | DPO | The period |
| 18 | How long we keep KYC files | Deleted 90 days after an application is rejected; 5 years after a merchant closes their account | ✅ ⚖️ | DPO / legal | The periods |
| 19 | API logs and webhook records | 30 days | ✅ | DPO | 30 days (the original plan said 14 for API logs) |
| 20 | Sandbox (test) data | Deleted after 90 days | ✅ | DPO | — |
| 21 | Answering personal-data requests | Respond within **30 days** (export or erase; parcels still moving are done once delivered) | ✅ ⚖️ | DPO | The deadline the NDPA requires |
| 22 | Personal-data breach | Notify the NDPC within **72 hours**; tell affected people and merchants when the risk is high (runbook written) | ✅ ⚖️ | DPO | The procedure |
| 23 | NDPC registration | Assume Locoomo must register as a data controller of "major importance"; register before launch | ⚖️ | DPO / legal | **Whether it applies** |
| 24 | Merchant terms and data-processing agreement | Terms must cover: prepaid wallet (5), storage and disposal (12), liability (13), prohibited items (15), data processing for buyer data (we process it for the merchant) | ⚖️ | Legal | **The terms text** (the system records which version each merchant accepted) |

## Limits per merchant (safety nets, changeable per merchant)

| # | Decision | Default in use | Status | Owner | To confirm |
|---|---|---|---|---|---|
| 25 | Live parcels per day | 2,000 (individual sellers), 100,000 (businesses), unlimited (enterprise) | ✅ | Ops | The limits |
| 26 | Daily cap on small Nodes | None unless ops sets one per Node | ✅ | Ops | Which Nodes need one |

## Before production, the must-haves

1. **Legal:** wallet (5), terms and DPA text (24), prohibited items (15), NDPC registration (23).
2. **Finance:** registered company details and TIN on invoices (8), VAT decision (7).
3. **Ops:** storage fee and disposal (12) agreed and written into the terms.

Everything else can launch on its default and be adjusted afterwards.
