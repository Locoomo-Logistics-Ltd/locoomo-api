# Locoomo for Merchants: what's built and what's next

*Status as of 23 November 2026*

## In one paragraph

Locoomo is opening its Node network to online merchants: marketplaces and their sellers
(Temu, Konga, Jiji), small online shops and individual sellers. A merchant's buyer picks a
Locoomo Node at checkout. The merchant drops the parcel at any Node, we carry it to the
buyer's Node, and the buyer collects it there with a one-time code. Merchants pay from a
prepaid Locoomo wallet. There is no cash on delivery. Merchants use Locoomo in two ways:
big platforms connect their systems directly through our API, and smaller sellers use the
merchant dashboard.

## Where we are

| Area | Status |
|---|---|
| Merchant sign-up, verification (KYC) and approval | ✅ Built |
| Teams, roles and account security | ✅ Built |
| Sandbox for merchants to test their integration | ✅ Built |
| Sending real parcels from any Node | ✅ Built |
| Prepaid wallet, card and bank-transfer top-ups | ✅ Built |
| Pricing, volume discounts, statements and tax invoices | ✅ Built |
| Labels, bulk upload, buyer-code relay | ✅ Built |
| Returns, refusals, lost/damaged claims | ✅ Built |
| Hubs, manifests and bags (marketplace-scale inbound), full-Node reroutes | ✅ Built |
| Storage fees and disposal for returns nobody collects | ✅ Built |
| Staff views: all orders, merchant 360, platform health alerts | ✅ Built |
| Merchant reports and data exports | ✅ Built |
| Data retention, personal-data requests, operations runbook | ✅ Built |
| Pick links, developer toolkit, go-live checklist | 🔜 Planned |

"Built" means the system (backend) and its documentation are finished, tested and running
on our **staging** (test) environment. The screens merchants and staff will use are being
built by the frontend team from that documentation. Nothing merchant-facing is on the
production system yet, and live shipments stay switched off there until we decide to open.

---

## What's built

### 1. Getting merchants on board

- **Self sign-up.** A business or an individual seller creates an account and fills in
  their details: business registration (CAC) for companies, owner and director IDs, proof
  of address and a bank account, which is checked against the bank automatically.
- **Manual review by Locoomo.** Our KYC team reviews each application. They can approve
  it, reject it or ask for specific changes. Merchants are emailed at each step.
- **Teams.** A merchant can invite colleagues with set roles: owner, admin, developer,
  operations, finance or viewer. Each role sees and does only what it needs.
- **Security.** Two-step login, re-confirmation for sensitive actions, and session
  management. Staff with admin access must use two-step login.
- **Account controls for Locoomo.** Staff can suspend a merchant, pause new shipments, set
  limits per merchant, or close an account. There is also a platform-wide off switch.

### 2. Testing before going live

- Every merchant gets a **full sandbox**: test keys, test parcels, a test wallet with
  ₦1,000,000, and a simulator that walks a test parcel through every stage. Merchants can
  build and test their integration **before** they are approved, without touching real
  Nodes, couriers or money.
- **Notifications to merchant systems (webhooks).** Every change to a parcel is pushed to
  the merchant's system automatically: dropped off, on the way, ready, collected, returned
  and so on. Failed notifications are retried for about a day and a half.

### 3. Sending parcels

- **Buyer picks a Node at checkout.** Merchants can show our Nodes and prices on their own
  checkout page.
- **Create shipments** one at a time, or in bulk by uploading a spreadsheet (up to 10,000
  at once).
- **Shipping labels** with barcodes, printable one per page or four per A4 sheet.
- **Drop off at any Node.** If the parcel goes to a different Node than planned, or turns
  out bigger or heavier when the Node measures it, the price is adjusted automatically. The
  parcel never waits for this.
- **Buyer notification.** Locoomo sends the buyer their collection code. Merchants whose
  buyers have no reachable email can receive the code themselves and pass it on in their
  own app.
- **Changes after creation.** Merchants can cancel before drop-off, update the buyer's
  contact details, or call a parcel back ("return to sender") even while it's on its way.
- **Collection.** Buyers collect with their code. If they've lost it, Node staff can check
  photo ID instead. Every hand-over is recorded as proof of delivery.
- **7 working days to collect.** Reminders go out; uncollected parcels come back to the
  merchant automatically.

### 4. Paying

- **Prepaid wallet**, one for testing and one for live. Top up by **card** or by **bank
  transfer** to a dedicated account number per merchant. Every top-up is credited
  automatically and confirmed with a receipt.
- **Hold, then charge.** Creating a shipment reserves its price. The money is only taken
  when the Node receives the parcel, at the final price. Cancelled or unused shipments
  release the reserve, so merchants pay nothing for them.
- **Volume discounts.** 0%, 5%, 10% or 15% off, based on the previous month's volume, or a
  negotiated rate set by our commercial team. Discounts come out of Locoomo's share only:
  Node operators and riders are never paid less.
- **Low-balance alerts** to the merchant, and an alert to our finance team if a live wallet
  goes below its allowed overdraft.
- **Monthly statements and tax invoices** (PDF or spreadsheet), downloadable by the
  merchant and by our staff.
- **Reports and exports.** A dashboard summary for any period (volumes, how many buyers
  collect, typical delivery and pickup times, spend, busiest destinations) and
  spreadsheet downloads of shipments and wallet history, up to three months at a time.
- **Safety checks for finance.** Every wallet is checked against its records every night.
  Any manual credit or debit needs **two** finance staff: one requests it and a second
  approves it.

### 5. Problems and returns

- **Refused at the counter.** A Node can refuse a parcel (for example, a prohibited item).
  The merchant isn't charged.
- **Lost or damaged parcels: claims.** Merchants can file a claim within 30 days, with
  photos. We pay the declared value, up to ₦50,000 per parcel unless the contract says
  otherwise. If our staff record a parcel as lost or damaged, a claim opens automatically.
  Rejections need one staff member; payouts need two finance staff. Approved claims are
  paid into the merchant's wallet.
- **Collecting returns.** Returned parcels wait at the Node the merchant dropped them at.
  The merchant can collect them one by one, or create a **return batch**: one reference and
  one code to collect up to 200 parcels at once.
- **Returns nobody collects.** Storage is free for 10 working days, then ₦100 per parcel
  per day is charged to the merchant's wallet (shown on the monthly invoice). The merchant
  is emailed when fees start and a week before disposal; 30 days after fees start the
  parcel is disposed of under the merchant terms and our operations team is told to
  remove it from the Node.

### 6. Marketplace-scale inbound: hubs, manifests and bags

- **Hubs.** Locoomo marks some Nodes as hubs and assigns a hub to each large merchant;
  their shipments then start at the hub by default.
- **Manifests.** A merchant lists the parcels on a truck (up to 10,000) and prints a
  manifest with a QR code for the driver. The hub scans the manifest, then each parcel by
  our label, the merchant's own order number or the merchant's own barcode (so
  cross-border parcels don't need relabelling). When the hub finishes, the merchant gets
  a report: received, missing, and parcels that arrived without being listed.
- **Bags.** At the hub, parcels are sorted into one sealed bag per destination Node (up to
  50 a bag), and each bag travels as **one courier trip** instead of 50. Every parcel's
  status and notifications still update individually. At the destination, staff scan the
  parcels out of the bag as usual; anything still missing a day later is flagged to ops.
  Returns heading back to a hub travel in bags too.
- **Full or closed Nodes.** If the buyer's Node is full or closed when a parcel is dropped
  off, the parcel waits at its origin while ops pick a nearby Node (the system picks the
  nearest with space if nobody decides within a working day). The buyer and merchant are
  told; Locoomo absorbs any price difference. Small Nodes can also cap how many merchant
  parcels a day are addressed to them.
- **Tested at scale.** A load test pushed 2,000 parcels through one hub at about 15 per
  second with no errors: roughly **447,000 parcels in an 8-hour shift**, 4.5× the
  100,000-a-day target.

### 7. Tools for Locoomo staff

- Merchant review queue and account controls (KYC team and operations).
- Wallet view per merchant, manual adjustments with two-person approval, and a pricing
  screen for discount tiers and negotiated rates (finance).
- Claims queue with evidence, notes, rejection and payout (operations and finance).
- Recording parcels as lost or damaged, and managing public holidays so collection
  deadlines skip them (operations).
- Hubs, merchant hub assignment, daily caps on small Nodes, and the reroute queue for
  parcels whose Node is full or closed (operations).
- **All orders:** consumer and merchant parcels in one searchable list, with each
  parcel's full history and courier trips (buyer contact details masked for support).
- **Merchant 360:** one page per merchant with its team, API keys, webhook health,
  wallets, shipment volumes, API errors, open items and recent activity. It replaces
  any need to "log in as the merchant".
- **Platform health:** around ten checks (email and webhook backlogs, reroute and review
  queues, wallets below zero, bags without a courier, parcels missing from bags). Ops are
  emailed when one goes red, with reminders while it stays red.
- **Exports:** the All orders list downloads as a spreadsheet (CSV) for any period up to
  three months.
- **Privacy:** buyers' details are removed automatically 180 days after a parcel is
  finished (photos deleted too), KYC files are deleted on schedule, and a super admin can
  export or erase everything we hold about a buyer on request. An **operations runbook**
  covers alerts, everyday procedures and data-breach response (including the 72-hour
  notice to the NDPC).
- Every sensitive action is logged: who did what, and when.

---

## What's next

| Phase | What it adds | Why it matters |
|---|---|---|
| **Developer experience** | Pick links (a seller shares a link on WhatsApp and the buyer picks their Node), a ready-made developer toolkit, an in-dashboard go-live checklist. | Easier onboarding for small sellers and integrators. |

**Smaller items still open:**
- Refunding the delivery fee when a parcel is lost. Today a claim covers only the goods'
  value.
- Automatically flagging parcels with no scan for 5 working days.
- Bags travel only with Sendii today; Locoomo's own riders can't carry bags yet.
- A Node that closes while parcels are already on their way to it isn't rerouted
  automatically; ops redirect those by hand.
- Courier costs for bag trips aren't yet split per parcel in the margin report.

---

## Decisions we need from the business

These don't block building, but they must be settled before or soon after launch.

| Topic | Current default | Owner |
|---|---|---|
| Wallet as prepaid credit, refundable only on account closure | Built this way. **Needs legal sign-off (CBN).** | Legal |
| VAT | 7.5%, prices include it. VAT lines on invoices are switched **off** until finance confirms we charge VAT on these services. | Finance / tax |
| Invoice details | Our registered company name, address and tax ID must be set before the first live invoice. Do we need gap-free sequential invoice numbers for FIRS? | Finance |
| Volume discount tiers | 0/5/10/15% at 0/500/5,000/50,000 parcels a month | Commercial |
| Card top-up fees | Passed on to the merchant. Bank-transfer fees absorbed by Locoomo. | Finance |
| Liability and claims | ₦50,000 cap, 30-day window, prohibited-items list | Legal / ops |
| Storage fee for uncollected returns | Built with ₦100 per parcel per day after 10 working days, disposal 30 days later. **Needs ops/legal sign-off, and the merchant terms must say so.** | Ops / legal |
| Data retention and privacy | Built with: buyer details 180 days after delivery, KYC files 90 days after rejection / 5 years after closure, API logs 30 days. **DPO to confirm these, the deadline for answering data requests, the data-processing agreement, and NDPC registration.** | Legal / DPO |
| SMS | Sender name "Locoomo", merchant name in the message; cost absorbed | Commercial |
| Consumer refunds | Amount and approval when a consumer parcel is refused or lost | Finance / ops |

---

## Before the first live merchant

1. **Frontend:** the merchant dashboard and staff screens are built and tested against
   staging.
2. **Legal and finance sign-offs** above, especially the wallet (CBN) and VAT.
3. **Production setup:** release to production, live payment keys and bank-transfer
   accounts, invoice company details, SMS provider.
4. **Switch on live shipments** in production. This is a single setting, already on in
   staging.
5. **First merchant:** a small seller dropping at Nodes. Marketplace-scale merchants can
   follow once a hub is set up and Sendii (which carries the bags) is live in production.
