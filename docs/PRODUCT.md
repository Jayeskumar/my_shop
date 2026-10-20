# Kadai (கடை) — product & offering

## Who it is for

Owner-run and family-run shops in Tamil Nadu (and the rest of India) that today bill on paper,
a calculator, or a desktop billing tool with no stock, GST or credit control:

| Vertical | Typical shop | What hurts today | What Kadai gives them |
|---|---|---|---|
| **General store (மளிகை)** | 1 counter, 1,000–4,000 items, many loose items, heavy credit (கடன்) | Khata notebook, forgotten dues, no idea of margins | 3-second billing, loose-item weights, khata with WhatsApp reminders + UPI link, daily profit |
| **Supermarket** | 2–8 counters, 5,000–20,000 SKUs, weighing scale, offers | Queues, offer mistakes, shrinkage | Scale barcodes, multi-counter offline-safe POS, promotions engine, stock-take, shifts with cash denomination close |
| **Textiles / readymades (ஜவுளி)** | Sarees, readymades, fabric by metre, festival rush (Deepavali, Pongal) | Size/colour stock confusion, GST slab by price | Size × colour variants, barcode labels, metre billing, automatic 5%/18% price-slab GST, exchanges |
| **Pharmacy (மருந்தகம்)** | 3,000+ SKUs, batches, expiry, schedule drugs | Expired stock losses, H1 register by hand, strip/loose tablets | Batch & expiry with FEFO, near-expiry alerts & returns, strip/loose pricing, prescription capture, Schedule H1 register, generic search |
| **Footwear, hardware, electronics, bakery, stationery** | | | General retail features + sizes, serial numbers, weighed items |

## How it is offered

### Cloud SaaS (default)

Sign up with a mobile number, pick the shop type, start billing in 5 minutes. Works on any PC
browser or Android phone; installable as an app; keeps billing during internet cuts (offline POS).

| Plan | Price (excl. GST) | For | Includes |
|---|---|---|---|
| **Thodakkam (Free)** | ₹0 | trying out / tiny shops | 1 store, 2 users, 1 counter, 300 bills/month, GST invoices, stock, khata, static UPI QR, basic reports |
| **Valarchi (Growth)** | ₹299/month or ₹2,999/year | a busy single store | unlimited bills & items, 5 users, 3 counters, purchases, GST returns (GSTR-1/3B), dynamic UPI QR with auto-confirmation, offers, loyalty, batches & expiry, variants, WhatsApp/SMS, shifts, accounting, offline POS, barcode labels |
| **Peru (Pro)** | ₹799/month or ₹7,999/year | multi-branch shops & supermarkets | 5 stores, 25 users, 15 counters, stock transfers, branch pricing, advanced reports, custom roles, audit log, API access |
| **Enterprise** | quote | chains, distributors | unlimited, SLA, dedicated support, custom integrations, on-prem or private cloud |

* 14-day free trial of Valarchi on signup; falls back to Free (data is never deleted).
* Messaging is metered at cost (SMS/WhatsApp credits); UPI via the shop's own UPI ID is free;
  dynamic QR via Razorpay is charged by Razorpay to the merchant directly.
* Annual plans paid by UPI AutoPay / card through Razorpay Subscriptions; GST invoice issued by the
  vendor for every payment.

### On-premise (Kadai Server)

For shops with unreliable internet, many counters on a LAN, or a preference to keep data in the
shop. Same software, installed on the shop's PC (Windows/Linux) or a small server, with all
counters connecting over the LAN.

| | Price (excl. GST) |
|---|---|
| Perpetual license, per store (includes 1 year updates & support) | ₹14,999 |
| Annual updates & support renewal | ₹2,999/year |
| Optional encrypted cloud backup | ₹99/month |
| Installation & data migration visit (Chennai, Coimbatore, Madurai, Trichy, Salem, Tirunelveli) | ₹1,500 |

License is a signed file tied to the business; features follow the Peru (Pro) plan by default.

## Go-to-market notes

* Tamil-first UI, Tamil invoices, Tamil support (WhatsApp + phone), video tutorials in Tamil.
* Distribution through local hardware vendors (barcode printers, thermal printers, scales) as
  resellers with a 20% margin; reseller portal is a future module.
* Data import from Excel/CSV and common billing tools on day one; free migration for annual plans.
* Festival-season readiness: offline-safe POS, fast variant billing, bulk label printing.

## Roadmap (post-v1)

E-invoicing (IRN) & e-way bills for shops crossing thresholds, online store / WhatsApp catalogue
orders, Tally export, mobile app for owners (reports & approvals), reseller portal, ONDC.
