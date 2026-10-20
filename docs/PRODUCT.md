# Kadai (கடை) — product & offering

> **Strategy: on-premise first.** Most Tamil Nadu shops run billing on a PC in the shop, with
> patchy internet and power, and want their data in the shop. Kadai Server is our lead product;
> the cloud SaaS serves shops that prefer no hardware and multi-branch owners who live on their
> phones. Both run the same software, and a shop can move between them with its data.

## Who it is for

| Vertical | Typical shop | What hurts today | What Kadai gives them |
|---|---|---|---|
| **General store (மளிகை)** | 1 counter, 1,000–4,000 items, many loose items, heavy credit (கடன்) | Khata notebook, forgotten dues, no idea of margins | 3-second billing, loose-item weights, khata with WhatsApp reminders + UPI link, daily profit |
| **Supermarket** | 2–8 counters, 5,000–20,000 SKUs, weighing scale, offers | Queues, offer mistakes, shrinkage | Scale barcodes, multi-counter LAN POS that keeps billing through outages, promotions engine, stock-take, shift close with cash denominations |
| **Textiles / readymades (ஜவுளி)** | Sarees, readymades, fabric by metre, festival rush (Deepavali, Pongal) | Size/colour stock confusion, GST slab by price | Size × colour variants, barcode labels, metre billing, automatic 5%/18% price-slab GST, exchanges |
| **Pharmacy (மருந்தகம்)** | 3,000+ SKUs, batches, expiry, schedule drugs | Expired stock losses, H1 register by hand, strip/loose tablets | Batch & expiry with FEFO, near-expiry alerts & returns, strip/loose pricing, prescription capture, Schedule H1 register, generic search |
| **Footwear, hardware, electronics, bakery, stationery** | | | General retail features + sizes, serial numbers, weighed items |

## Kadai Server (on-premise) — the lead product

Installed on the shop's own Windows or Linux PC (or a small server). Every counter, tablet and
phone in the shop connects over the shop's Wi-Fi/LAN. **Works fully without internet, forever** —
the internet is only used, when available, for optional extras (UPI auto-confirmation, WhatsApp,
updates, cloud backup, remote dashboard).

### Editions (one-time, per store; prices excl. 18% GST; first year of updates & support included)

| Edition | Price | For | Includes |
|---|---|---|---|
| **Starter** | ₹7,999 | single-counter kirana, pharmacy, small textile shop | 1 store, 1 billing counter, 3 users, unlimited items & bills, GST invoices & GSTR-1/3B, khata, purchases, batches & expiry, variants & labels, shifts, static UPI QR |
| **Standard** ⭐ | ₹14,999 | busy single store | everything in Starter + 3 counters, 10 users, dynamic UPI QR with auto-confirmation, offers & loyalty, WhatsApp/SMS, accounting |
| **Pro** | ₹24,999 | supermarkets & multi-branch | everything in Standard + 3 branches (LAN/VPN), 10 counters, 30 users, stock transfers, branch pricing, advanced reports, custom roles, audit log, API |
| **Enterprise** | quote | chains, distributors | unlimited stores/counters, priority support, custom integrations |

**Yearly licence option** (lower upfront, updates & support always included): Starter ₹2,999/yr,
Standard ₹4,999/yr, Pro ₹8,999/yr. If a yearly licence lapses the shop keeps billing on the
Thodakkam (free) limits — data is never locked.

### Updates & support (AMC)

* First year included with every edition. Renewal per year: Starter ₹1,599, Standard ₹2,999,
  Pro ₹4,999 (≈20% of the edition).
* A perpetual licence **never expires**: without AMC the shop keeps using the last version it is
  entitled to; only releases published after the AMC end date need renewal. Security fixes for
  the last entitled version are back-ported for 12 months.
* Renewal is one tap inside the app (UPI/card via Razorpay); the licence refreshes automatically.

### Add-ons

| Add-on | Price |
|---|---|
| Extra billing counter | ₹2,500 one-time (+₹500/yr AMC) |
| Extra branch | ₹7,500 one-time (+₹1,500/yr AMC) |
| **Kadai Connect** — owner's remote dashboard on the phone + daily WhatsApp summary | ₹999/yr |
| Encrypted cloud backup (10 GB, we cannot read it — only the shop holds the key) | ₹1,199/yr |
| WhatsApp/SMS messages via Kadai (no DLT or WhatsApp API setup needed) | credits at cost |
| On-site installation & data migration (Chennai, Coimbatore, Madurai, Trichy, Salem, Tirunelveli, Erode, Vellore) | ₹1,500 |

### Licensing model

* A licence key (`KD-XXXX-XXXX-XXXX-XXXX`) activates one installation — online in one step, or
  **offline** with a request file (WhatsApp it to support or upload on kadai.app/activate).
* The signed licence file lives on the shop server and is checked locally; moving to a new PC is a
  self-service "deactivate & re-activate" (limited transfers per year).
* Optional check-in every 6 hours when online: refreshes renewals, shows offers and announcements,
  offers updates, powers Kadai Connect. No shop data is sent — only counts (stores, counters,
  bills in 30 days) and, for Connect subscribers, the dashboard summary.

## Kadai Cloud (SaaS)

Sign up with a mobile number, pick the shop type, bill in 5 minutes on any browser or Android
phone; installable as an app; offline POS queue for internet cuts.

| Plan | Price (excl. GST) | Includes |
|---|---|---|
| **Thodakkam (Free)** | ₹0 | 1 store, 2 users, 1 counter, 300 bills/month, GST invoices, stock, khata, static UPI QR, basic reports |
| **Valarchi (Growth)** ⭐ | ₹299/month or ₹2,999/year | unlimited bills & items, 5 users, 3 counters, purchases, GST returns, dynamic UPI, offers, loyalty, batches & expiry, variants, WhatsApp/SMS, shifts, accounting, labels |
| **Peru (Pro)** | ₹799/month or ₹7,999/year | 5 stores, 25 users, 15 counters, transfers, branch pricing, advanced reports, custom roles, audit log, API |
| **Enterprise** | quote | unlimited, SLA, dedicated support |

* 14-day Valarchi trial on signup, then Free (data is never deleted).
* Move to Kadai Server any time with a full data export/import (and back).

## Offers we run (managed in our vendor console — data, not code)

* **Festival campaigns**: Pongal, Tamil New Year, Aadi sale, Deepavali — e.g. 20% off editions or
  6 months free AMC, shown as banners inside existing installations and on the website.
* **Switch offer**: free data migration + 3 months extra AMC for shops moving from another billing
  software or paper.
* **Referral**: ₹1,000 off for the referring shop's next renewal and for the new shop.
* **Vertical bundles**: pharmacy (Starter + label printer partner bundle), textiles (Standard +
  barcode printer), supermarket (Pro + scale integration visit).
* **Coupon codes** for partners, exhibitions (e.g. trade fairs) and WhatsApp campaigns; limits per
  code, per shop, date windows, audience (business type, district/state, new vs renewing).

## Channel: local partners (resellers)

Hardware and billing-software dealers across Tamil Nadu sell, install and support Kadai:
partner price = list − 20–30% by tier (silver/gold/platinum), commissions on referred direct sales,
a partner portal to issue licences, track their customers' AMC renewals and earnings. AMC renewal
reminders go to both the shop and its partner.

## How we manage it (vendor console)

Our own control plane (same codebase, our cloud deployment with `KADAI_VENDOR_CONSOLE=true`):
customers, licences & activations, price book, offers & coupons, orders with GST invoices,
payments (Razorpay links / UPI), partners & commissions, releases & update rollout,
announcements, cloud tenant administration, Kadai Connect, cloud backup storage, messaging relay,
and a revenue/renewals dashboard.

## Go-to-market notes

* Tamil-first UI, Tamil invoices, Tamil support (WhatsApp + phone), Tamil video tutorials.
* Day-one data import from Excel/CSV and common billing tools; free migration on Standard and above.
* Festival readiness: offline-safe LAN POS, fast variant billing, bulk label printing.

## Roadmap (post-v1)

Hybrid multi-branch sync (store servers ↔ HQ cloud), e-invoicing (IRN) & e-way bills, online
store / WhatsApp catalogue orders, Tally export, owner mobile app, ONDC.
