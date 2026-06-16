# Delivery Sync Plan — "Phone-as-truth, freeze-once"

**Status:** v3 (hybrid matching chosen by founder) · **Date:** 2026-06-16
**Owner:** Curio store (`website/store`, Next.js + Prisma + Neon Postgres)

> **v3 changelog:** Founder chose **HYBRID** matching after the OrderDZ-code findings (`montant`/`produit`/`phone` are agent-editable in OrderDZ; `reference` = OrderDZ's **readonly** internal order id, which we already store as `externalId`). Matching is now: **Tier 1 exact-id (externalId ↔ Ecotrack reference) → Tier 2 independent phone+time fallback.** Independence preserved (reads only Curio's own Ecotrack; phone path is the permanent backbone). See §6, §11.

> **v3.1 — round-2 refinements adopted (scores 82/88/90, all GO):**
> - Freeze decision uses a NEW **strict** terminal test (`strictTerminalBucket` — trusts only `global_status` "livre*"/"retour*"), NOT the looser existing `bucketEcotrackOrder` (which freezes on bare `return_asked_at`/`livred_at`).
> - Audit stamp written to **`notes`** (append), not `webhookPayload` (OrderDZ overwrites that on every webhook).
> - **`SYNC_SECRET` must be non-empty** or the endpoint denies (no open default).
> - Matcher kept simple: Tier-2 **amount/product are report-only** (not confidence inputs); ≥2 in-window phone candidates → **AMBIGUOUS**. 
> - **Tier 0 (exact by-tracking lookup) DEFERRED to v2** — v1 matches against the clean `global_status` list each run (simpler, safer); tracking codes are still captured on write for v2. Run the sync regularly so orders are matched before they age off the list.
> - vitest suite deferred (matcher is a pure function, validated via the dry-run report); audit via JSON/notes, no new table.
> - Known accepted edge: the OrderDZ webhook's `CANCELLED` write is unguarded, so a (rare) webhook arriving exactly as the sync writes DELIVERED could clobber it — recoverable via the audit stamp.

> **v2 changelog (what the review changed):**
> - Corrected the core assumption: **OrderDZ creates the parcel**, so `produit`/`montant`/`reference` in Ecotrack are shaped *by OrderDZ*, not by the store's (dormant) `createParcel`. Product & amount are now **fuzzy signals**, never the sole reason to write. (Reviewer A showstopper.)
> - Added a hard rule: **no independent discriminator between candidates → AMBIGUOUS → never auto-write.** Closes the repeat-same-product wrong-write hole. (Reviewer A #2.)
> - **Dashboard fix is now in v1 scope** — the dashboard must read the DB as the primary truth, not override it with a live phone-match. (Reviewer C #1.)
> - **Capture the Ecotrack tracking code on first match** (not optional) → steady-state re-sync uses exact lookups, fixing scale + the returned-flip. (Reviewer C #3.)
> - Safety: **dry-run is the default** (writing needs explicit `?apply=1`, POST only); **guarded `updateMany`** writes; **per-run write cap + page/time budget**; **audit trail**; **single-flight**; run as a **scheduled/background function**. (Reviewer B.)
> - Stricter terminal definition for an irreversible freeze; **delivered→returned is LOG-ONLY in v1** (no auto-flip). (Reviewers A/B/C.)

---

## 1. Goal
Make the Command Center show **real, permanent** delivered/returned numbers that **Curio owns** and that **don't depend on OrderDZ** — by reading Curio's *own* Ecotrack account, matching each order to its parcel, and writing the final outcome **permanently into Curio's own database**.

## 2. Problem
The store DB never learns DELIVERED/RETURNED (all ~630 orders show 0 delivered). The dashboard *guesses* live by matching Ecotrack to orders **by phone**, every page load — fragile and recomputed forever.

## 3. Principles
1. **Curio's DB = single source of truth.** Dashboard reads the DB.
2. **Independent of OrderDZ** — match on customer/order data only (phone, product, amount, time). No OrderDZ IDs, no OrderDZ code changes. Delivery read from Curio's **own** Ecotrack token.
3. **Match once, then freeze** — match while the parcel is fresh in Ecotrack, write the terminal outcome, never re-match. All-time numbers become correct & permanent.
4. **Safety first** — writes ONLY delivery-outcome fields; never stock/confirmation/ads/sends; read-only to Ecotrack; reversible.

## 4. Ground truth (CORRECTED in v2)
- **Parcels are created by OrderDZ using Curio's Ecotrack token** (the store's `createParcel`/ship route is dormant — `order.trackingCode` is usually null). Therefore the Ecotrack fields below are **whatever OrderDZ sent**, to be verified against real data:
  - `montant` — defaults to `order.total` but is **AGENT-EDITABLE** in OrderDZ's ship form (confirmed in OrderDZ code). **Weak corroborator only** — match within tolerance {total, subtotal, total−delivery}; never a sole reason to write. (Coupon orders: `total = subtotal − discount + delivery`.)
  - `produit` — per item, OrderDZ sends the storage SKU if set, else `label_title ?? name` (+ variant/offer + `(qty)`), comma-joined; **AGENT-EDITABLE**. A **bundle** stays ONE label (does NOT auto-expand). **Weak corroborator only.**
  - `reference` — = **OrderDZ's internal order id**, and it is **READONLY** in OrderDZ (not editable). We already store this as `order.externalId`. → **This is the Tier-1 exact key** (see §6/§11).
  - `phone` — = `order.phone` in OrderDZ, **agent-editable** and validated to 10 digits. Consistent format, but may have been corrected during the call (then ≠ our stored phone → that order falls to manual review).
  - `phone` / `phone2` — the customer's number(s); the only field **guaranteed identical** on both sides (except when corrected during confirmation).
- **Order fields available:** `status`, `customerPhone`, `customerPhone2`, `total`, `subtotal`, `createdAt`, `deliveredAt`, `returnedAt`, `trackingCode`, `items[].{product.slug, product.name, quantity}`.
- **`fetchAllEcotrackOrders()`** reads Curio's Ecotrack list (read-only, cap `maxPages=30`≈1,200). Returns phone/phone2/status/globalStatus/livredAt/returnAskedAt/montant/createdAt/bucket — **must add `produit` and the parcel `tracking` code** (confirm field names from a real response).
- **`fetchOrderStatuses(trackings[])`** already exists — exact status lookup by tracking code, 100/call. (Used for steady-state once tracking is captured.)
- **Neon HTTP: no transactions**, `update()`+`include` fails → plain `update`, separate reads.
- Writing DELIVERED/RETURNED directly has **no side effects** (stock restore only fires on `CANCELLED`, which we never write).

## 5. The sync — `POST /api/sync/delivery`
Protected (dedicated `SYNC_SECRET`). **POST only. Dry-run is the DEFAULT; live write requires explicit `?apply=1`.** `force-dynamic`.

Steps:
1. **Single-flight guard** — refuse if a run is already in progress.
2. **Select in-flight orders:** `status ∈ {CONFIRMED, PROCESSING, SHIPPED}`, `createdAt` within 90 days. (Terminal orders skipped → idempotent freeze.)
3. **Get delivery status:**
   - Orders that already have a stored `trackingCode` → **exact** `fetchOrderStatuses` lookup (cheap, no fuzzy).
   - Orders without → fetch Curio's Ecotrack list (read-only; page+time budget; log if cap hit) and **fuzzy match** (§6).
4. **Decide & write (capped at ~50–100 writes/run):** HIGH-confidence + terminal bucket → **guarded write** (`updateMany where status ∈ non-terminal`), set `status` + timestamp + `trackingCode` (first time). **Audit-stamp** each write (prevStatus, matched tracking, confidence, runId) into `webhookPayload`/`notes` JSON.
5. **Leave & log** in-transit / MEDIUM / AMBIGUOUS / unmatched for manual review.
6. **Return JSON report** + persist a `lastSync` summary the dashboard can show.

## 6. Matching (the heart) — `src/lib/delivery-match.ts` (pure, testable) — HYBRID
Founder chose **HYBRID** (2026-06-16): exact-id primary + independent phone fallback. For each in-flight order `O`, try tiers in order; stop at the first confident match.

**Tier 0 — already linked (steady state):** if `O.trackingCode` is set → exact `fetchOrderStatuses([O.trackingCode])`. No fuzzy work. Confidence = EXACT.

**Tier 1 — EXACT ID (primary):** if `O.externalId` is set → find the parcel where `parcel.reference === O.externalId`. `reference` is OrderDZ's **readonly** internal id = exactly what we stored. Deterministic & immutable → confidence EXACT.
- *Self-check:* if real data shows `externalId` is OrderDZ's order_number rather than its internal id, Tier 1 finds nothing → fall through to Tier 2. The **dry-run report exposes which key actually links** (count of Tier-1 vs Tier-2 matches).

**Tier 2 — PHONE + time (independent fallback):** for orders with no `externalId` or no Tier-1 hit.
- candidate pool by `normalize(phone|phone2)` (both sides).
- **time:** parcel `createdAt` gap `∈ [−1d, +14d]` after the order; prefer smallest plausible positive gap (per-order, not cross-order sequencing).
- **amount / product (WEAK — agent-editable, hints only):** `montant` within tolerance {total, subtotal, total−delivery}; `produit` contains O's product name(s) (bundle via expansion map). **Never the sole reason to write.**
- **confidence:** HIGH only if a single candidate, OR an *independent* discriminator clearly separates the top candidate from the runner-up. **If ≥2 candidates and the only separator is fragile time on otherwise-identical parcels → AMBIGUOUS.** (Hard rule — closes the wrong-write hole.)

**Action (all tiers):**
- EXACT or HIGH + terminal bucket → **WRITE** + store `trackingCode` (enables Tier 0 next run).
- EXACT or HIGH + in-transit → store `trackingCode`; no freeze.
- MEDIUM / AMBIGUOUS / unmatched → log for manual review; **never write**.
- Never write CANCELLED.

## 7. Bucketing (stricter for an irreversible freeze)
- **DELIVERED** only when `global_status` starts "livre" (delivered & settled). Bare `livred_at` without a "livre" global → in-transit/log.
- **RETURNED** only when `global_status` is a terminal "retour" (returned to vendor). In-process return legs / bare `return_asked_at` → in-transit/log (a *return request* ≠ a completed return).
- Anything else → in-transit (no freeze).
- **delivered→returned / returned→delivered:** **LOG ONLY in v1** (manual PATCH). No auto-flip. (Also: frozen orders aren't re-selected, so an auto-flip couldn't fire anyway.)

## 8. What gets written (nothing else)
Guarded `updateMany({ where:{ orderNumber, status:{ in:[CONFIRMED,PROCESSING,SHIPPED] } }, data:{...} })` with ONLY:
- `DELIVERED` + `deliveredAt`, or `RETURNED` + `returnedAt`, + `trackingCode` (if null), + audit stamp in `webhookPayload`.

## 9. Dashboard fix (NOW in v1)
`dashboard/route.ts` currently derives stage from the live Ecotrack match FIRST (`if (!stage)` DB fallback). Change: **DB status is primary** for terminal states; keep a live Ecotrack read only for still-in-flight (`SHIPPED`) orders, or drop it entirely. Result: frozen DB truth is what the founder sees; aged-off orders no longer silently revert.

## 10. Code changes
1. `src/lib/ecotrack.ts` — capture `produit` + `tracking` in the list parse; raise page cap + add budget/log.
2. `src/lib/delivery-match.ts` (NEW) — pure `matchOrderToParcel(order, parcels) → {parcel, bucket, confidence, reasons[]}`.
3. `src/app/api/sync/delivery/route.ts` (NEW) — auth, single-flight, select, status (exact-then-fuzzy), guarded write w/ cap, audit, report.
4. `src/app/api/dashboard/route.ts` — DB-primary (§9).
5. **Add a test runner** (vitest) — repo has none; fixture tests for the matcher.

## 11. Independence verdict — HYBRID chosen (2026-06-16)
- **Decision:** HYBRID — exact-id primary (Tier 1) + independent phone+time fallback (Tier 2).
- **Independence preserved:** the sync calls **only Curio's own Ecotrack account** (Curio's token); it never calls OrderDZ. The Tier-1 link is a *read-side* comparison of `externalId` (already in our DB) to the Ecotrack `reference` — not a live dependency on OrderDZ.
- **Future-proof:** drop OrderDZ → new orders have no OrderDZ `externalId` → the matcher **falls through to the independent phone+time path automatically**. Phone is the permanent backbone; exact-id is only today's accuracy booster. No rework to stay independent.
- Caveat: `produit`/`montant`/`phone` are agent-editable in OrderDZ → amount/product are weak corroborators; a corrected phone with no `externalId` → manual review.

## 12. Testing (founder runs at the end)
- **Dry-run first** (default URL) → review report = the real-data check (shows actual produit/montant/match quality). Tune thresholds.
- Spot-check ~10 against the Ecotrack dashboard.
- Idempotency: run twice → 2nd writes ~0.
- Unit tests: single / repeat-far / repeat-same-product (→AMBIGUOUS) / changed-phone (→unmatched) / in-transit.

## 13. Risks → mitigations
| Risk | Mitigation |
|---|---|
| Wrong terminal write | HIGH-only + AMBIGUOUS hard rule + dry-run default + manual review |
| Vendor-shaped produit/montant | fuzzy signals; dry-run reveals real values; phone+time anchor |
| Repeat same-product customer | AMBIGUOUS unless an independent discriminator separates |
| Phone corrected at confirmation | unmatched → logged for manual review |
| Timeout on backfill | page/time budget + write cap + scheduled/background fn |
| Concurrency (webhook/sync) | guarded `updateMany` (status-conditioned) + single-flight |
| Bad run, no undo | audit stamp (prevStatus/tracking/conf/runId) + capped first live run |
| Ecotrack list truncation/aging | exact tracking lookups in steady state; raise cap; schedule ≤ retention |
| Mislabel frozen permanently | stricter terminal bucketing; in-process legs = no freeze |

## 14. Open items for round-2 review
1. Are the §6 confidence rules now tight enough to make wrong auto-writes effectively impossible?
2. Verify (from OrderDZ code, in progress) what `produit`/`montant`/`reference` OrderDZ actually sends → confirm tolerance bands & bundle map.
3. Confirm `produit` + `tracking` exist in the real `/get/orders` response (field names).
4. Audit via JSON column vs a small `DeliverySyncLog` table — which is worth it now?
