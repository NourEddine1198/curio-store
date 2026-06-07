# Curio Command Center (`/dashboard`)

A **read-only** admin dashboard that shows the whole business on one screen: orders, status funnel, revenue, inventory, returns, and **live profit**. Built June 2026 (Phase 2 prep).

## Where it lives
- Page: `src/app/dashboard/page.tsx` (client component, self-contained CSS, no Tailwind dependency).
- API: `src/app/api/dashboard/route.ts` (read-only aggregation, `force-dynamic`).
- Ecotrack read helpers: `src/lib/ecotrack.ts` (`fetchAllEcotrackOrders`, `bucketEcotrackOrder`, `normalizePhone`).
- Link from the static admin: `website/frontend/admin/index.html` → "📊 Command Center" button.

## How to open it
`https://stirring-marigold-3dd8e9.netlify.app/dashboard` → log in with the **admin key** (same `ADMIN_KEY` as the rest of the admin; sent as `X-Admin-Key`). Cost settings are saved in the browser (`localStorage`), with Copy/Paste to sync devices.

## Where the numbers come from
| Data | Source |
|---|---|
| Orders, pending/confirmed/cancelled, revenue, inventory | Store Postgres DB (read-only) |
| **Delivered / Returned / In-transit truth** | **Ecotrack** `GET /get/orders` (read-only), matched to store orders **by phone** + closest date (±60-day guard). `global_status`: `livre`→delivered, `retour`→returned, `en_process`→in-transit |
| Ad spend / cost-per-order / ROAS / profit-after-ads | **Meta — stub.** `metaSpend` is hard-coded `null` in `page.tsx`. Wire Meta MCP later; profit auto-switches from the ad *estimate* to real spend |

> Why phone, not the store's order status? Flow is **website → OrderDZ → (confirmed) → Ecotrack**. Confirmation flows back to the DB via the OrderDZ webhook, but **shipped/delivered/returned never do** — so delivery truth is read live from Ecotrack. `reference` is inconsistent (null / store-id / unknown), so **phone is the join key**.

## Live profit formula (client-side, editable in ⚙ Costs)
```
For each DELIVERED order:  + subtotal − unitCost×units − confirmation − codFee − wrapping − adEstimate
For each RETURNED order:   − adEstimate − wrapping − returnFee   (product re-sells; no COGS loss)
Once per period:           − rent × (days / 30)
```
Defaults (money model v4): unit cost games 610 / origami 760; wrapping 30; confirmation 120; COD 0; return fee 250; rent 15,000/mo; ad estimate 450/order.

## Hard guarantees
- **Read-only.** No create/update/ship/confirm/cancel/delete anywhere. Only `count`/`findMany` and Ecotrack GETs.
- **Admin-gated** by `ADMIN_KEY`. Secrets (`DATABASE_URL`, `ECOTRACK_TOKEN`) stay server-side.
- The **live WhatsApp tracker is never touched**; Ecotrack is read independently.

## Phase-2 go-live notes
- When selling resumes, **confirmed** statuses populate automatically (OrderDZ webhook → store DB). **Delivered/returned** appear via the Ecotrack reconciliation above.
- Ecotrack's `get/orders` returns **in-process + recent** orders; fully-closed/paid-out orders age off the list. Great for an operations cockpit; not a lifetime-accounting ledger.
- To connect Meta later: replace `const metaSpend = null` in `page.tsx` with real spend (and optionally surface cost/order, ROAS) — the profit math already accounts for it.
- Env required (already set on Netlify): `ADMIN_KEY`, `ECOTRACK_TOKEN`, `DATABASE_URL`.
