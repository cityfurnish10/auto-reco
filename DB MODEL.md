# Data Source Models — auto-reco

_Last updated: 2026-07-14 (rev 2 — added: Done-only filter, city normalisation rules, Metabase transport confirmation)_

This document is the single source of truth for all external data the auto-reco reconciliation engine ingests.  
It covers every source model, all fields extracted, how to query each source, and how each field maps to the engine's `SourceRow` type.

**Sources documented:**
- [Part I — Odoo (`stock.move.line`)](#part-i--odoo-source-model)
- [Part II — Delivery Tracker / DT (MongoDB `tasks`)](#part-ii--delivery-tracker-dt-source-model)

---

# Part I — Odoo Source Model

## 1. Source Model

| Property | Value |
|---|---|
| **Odoo model** | `stock.move.line` |
| **Postgres table** | `stock_move_line` |
| **UI path** | Inventory → Detailed Operations |
| **What it is** | One row per barcode/lot physically moved — the lowest-level stock movement record |
| **Direction scope** | Both IN (customer returns, inbound) and OUT (new deployments, outbound) |
| **Row ID format** | `__export__.stock_move_line_{id}_{hash}` (Odoo export prefix; numeric `id` is the PK) |

> **Why this model and not `stock.move`?**  
> `stock.move` is one row per product-level move (aggregate). `stock.move.line` is one row per barcode/serial number — exactly what the reconciliation engine needs since it operates barcode-by-barcode.

> **✅ Metabase transport confirmed:** `stock.move.line` is accessible at `analytics.rentofurniture.com` under the "**Odoo Live Database**" Metabase connection. Existing query cards and the native SQL interface both work against this table. The auto-reco connector may query Odoo directly (§5 JSON-RPC or §6 Postgres — transport TBD) or via the Metabase `/api/dataset` endpoint; either path hits the same underlying data.

---

## 2. Field Map — Excel → Odoo field → SourceRow

The source data for 13 July was exported from Odoo as two sheets (Odoo In / Odoo out). Below is the complete mapping of every column in that export.

| # | Excel Column | Odoo Field Path | Postgres Column | SourceRow Field | Notes |
|---|---|---|---|---|---|
| 1 | ID | `id` (export prefix stripped) | `sml.id` | — | Internal PK; strip `__export__.stock_move_line_` prefix to get the integer |
| 2 | Date | `date` | `sml.date` | `date`, `movementDate` | UTC datetime; this is the **movement completion time** |
| 3 | Reference | `picking_id.name` | `sp.name` | `ticketId` | Picking reference e.g. `BAN/IN/22557`, `BAN/OUT/56762` |
| 4 | Product | `product_id.name` | `pt.name` | `product` | Product display name e.g. `# Belle Entertainment Unit` |
| 5 | Lot/Serial Number | `lot_id.name` | `sl.name` | `barcode` | **The barcode** — primary key for reconciliation |
| 6 | Sale order ID | `picking_id.origin` | `sp.origin` | `soNumber` | The SO/service-order reference e.g. `ON-RET-BAN-19563` |
| 7 | Reference# | `picking_id.partner_id.ref` (or custom) | `rp.ref` | — | Customer phone / external ref; not used by engine directly |
| 8 | Warehouse Code | `picking_id.picking_type_id.warehouse_id.code` | `sw.code` | _(city filter)_ | `BAN` / `GUR` / `PUN` / `MUM` / `HYD` — used to split rows by city |
| 9 | Created on | `create_date` | `sml.create_date` | `createdOn` | When the move line was created in Odoo |
| 10 | Last Updated on | `write_date` | `sml.write_date` | — | Last write; used for change detection |
| 11 | Product Category | `product_id.categ_id.name` | `pc.name` | — | Always `Furniture` for rental stock |
| 12 | Customer / Vendor | `picking_id.partner_id.name` | `rp.name` | `customer` | Customer display name |
| 13 | Procurement Condition | `move_id.procure_method` (or custom field) | `sm.procure_method` | `jobType` | `Ok` = return/recall, `New` = new rental. Passed through as `jobType` for the Odoo-window rule in the engine |
| 14 | SO / PO number | `picking_id.origin` | `sp.origin` | `soNumber` | Same as field 6 — confirms the link |
| 15 | Movement Type | derived from `picking_type_id.code` | `spt.code` | `direction` | `incoming` → `"IN"`, `outgoing` → `"OUT"` |
| 16 | Quantity in Product UoM | `product_uom_qty` | `sml.product_uom_qty` | — | Planned qty; use `qty_done` (col 20) for actuals |
| 17 | Pick From | `move_id.created_purchase_line_id` or custom | — | — | Usually empty; not used by engine |
| 18 | From | `location_id.complete_name` | `loc_from.complete_name` | — | e.g. `Partner Locations/Customers` (IN), `BAN/Output` (OUT) |
| 19 | To | `location_dest_id.complete_name` | `loc_to.complete_name` | — | e.g. `BAN/Stock` (IN), `Partner Locations/Customers` (OUT) |
| 20 | Quantity | `qty_done` | `sml.qty_done` | — | Actual quantity moved (always 1 for serialised items) |
| 21 | Status | `state` | `sml.state` | `status` | `done` = completed; filter to `done` only |

---

## 3. Direction Detection

Direction is NOT stored directly on `stock.move.line`. Derive it from the picking type:

```
picking_type_id.code = "incoming"  →  direction = "IN"
picking_type_id.code = "outgoing"  →  direction = "OUT"
```

Alternatively (more robust — works even without joining picking_type):

```
If location_dest_id points to an internal warehouse location  →  "IN"
If location_id points to an internal warehouse location       →  "OUT"
```

Observed location patterns in the BAN data:

| Direction | From (`location_id`) | To (`location_dest_id`) |
|---|---|---|
| IN | `Partner Locations/Customers` | `BAN/Stock` |
| OUT | `BAN/Output` | `Partner Locations/Customers` |

---

## 4. Date Filter Logic

Always filter on `date` (movement completion time), NOT `create_date`:

```
date >= '2026-07-13 00:00:00'   (IST = 2026-07-12 18:30:00 UTC)
date <= '2026-07-13 23:59:59'   (IST = 2026-07-13 18:29:59 UTC)
state = 'done'
```

> **Timezone note:** Odoo stores `date` in UTC. The BAN data for "13 July" shows records with `date` as late as `2026-07-12 23:50:16` UTC — which is `2026-07-13 05:20 IST`. Always apply the run-date filter in **IST = UTC + 5:30** and convert before querying.

IST-to-UTC conversion for a given `runDate` (YYYY-MM-DD):

```
UTC start  =  runDate  00:00:00 IST  →  runDate-1  18:30:00 UTC
UTC end    =  runDate  23:59:59 IST  →  runDate    18:29:59 UTC
```

---

## 5. Query — Option A: Odoo JSON-RPC (Recommended)

Use this when Odoo transport is decided as **JSON-RPC** (`lib/connectors/odoo.ts`).

**Endpoint:** `POST {ODOO_URL}/web/dataset/call_kw`  
**Auth:** Must first call `/web/session/authenticate` to get a session cookie, or use an API key header.

### Step 1 — Authenticate

```
POST /web/session/authenticate
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "db":       "<ODOO_DB_NAME>",
    "login":    "<ODOO_USER>",
    "password": "<ODOO_PASSWORD>"
  }
}
```

Response sets a session cookie. Reuse across all subsequent calls.

### Step 2 — Fetch stock.move.line

```
POST /web/dataset/call_kw
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "model":  "stock.move.line",
    "method": "search_read",
    "args": [[
      ["date",              ">=", "2026-07-12 18:30:00"],
      ["date",              "<=", "2026-07-13 18:29:59"],
      ["state",             "=",  "done"],
      ["company_id.name",   "=",  "Cityfurnish"]
    ]],
    "kwargs": {
      "fields": [
        "id",
        "date",
        "create_date",
        "write_date",
        "picking_id",
        "lot_id",
        "product_id",
        "location_id",
        "location_dest_id",
        "qty_done",
        "product_uom_qty",
        "state",
        "move_id"
      ],
      "limit":  2000,
      "offset": 0
    }
  }
}
```

Many2one fields (`picking_id`, `lot_id`, `product_id`, etc.) are returned as `[id, display_name]` tuples automatically.  
To get `picking_id.origin`, `picking_id.partner_id`, `picking_type_id.code`, etc., do a **second call** to `stock.picking` using the picking IDs from Step 2:

```
POST /web/dataset/call_kw
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "model":  "stock.picking",
    "method": "search_read",
    "args": [[["id", "in", [<picking_ids>]]]],
    "kwargs": {
      "fields": [
        "id",
        "name",
        "origin",
        "partner_id",
        "picking_type_id",
        "picking_type_code"
      ],
      "limit": 2000
    }
  }
}
```

Then join in Node.js on `picking_id[0]` → `picking.id`.

### Warehouse / City Filter

Add to the domain to fetch a single city:

```
["picking_type_id.warehouse_id.code", "=", "BAN"]
```

Or fetch all and split in the connector orchestrator by warehouse code.

---

## 6. Query — Option B: Direct Postgres SQL

Use this if Odoo transport is decided as **direct Postgres** (`lib/connectors/odoo.ts` using the `pg` driver).

```sql
SELECT
    sml.id                                          AS odoo_id,
    sml.date                                        AS date,
    sml.create_date                                 AS created_on,
    sml.write_date                                  AS last_updated_on,
    sml.qty_done                                    AS quantity,
    sml.product_uom_qty                             AS planned_qty,
    sml.state                                       AS status,

    sp.name                                         AS reference,
    sp.origin                                       AS so_number,

    sl.name                                         AS barcode,

    pt.name                                         AS product,
    pc.complete_name                                AS product_category,

    rp.name                                         AS customer,
    rp.ref                                          AS customer_ref,

    loc_from.complete_name                          AS location_from,
    loc_to.complete_name                            AS location_to,

    sw.code                                         AS warehouse_code,

    CASE
        WHEN spt.code = 'incoming' THEN 'IN'
        WHEN spt.code = 'outgoing' THEN 'OUT'
        ELSE spt.code
    END                                             AS direction,

    sm.procure_method                               AS procurement_condition

FROM stock_move_line sml

-- Picking (gives us reference, origin/SO, partner, warehouse)
JOIN stock_picking          sp   ON sp.id  = sml.picking_id

-- Picking type (gives us direction: incoming / outgoing)
JOIN stock_picking_type     spt  ON spt.id = sp.picking_type_id

-- Warehouse (gives us city code: BAN / GUR / PUN / MUM / HYD)
JOIN stock_warehouse         sw   ON sw.id  = spt.warehouse_id

-- Lot / serial number (the barcode)
JOIN stock_lot               sl   ON sl.id  = sml.lot_id

-- Product
JOIN product_product         pp   ON pp.id  = sml.product_id
JOIN product_template        pt   ON pt.id  = pp.product_tmpl_id
JOIN product_category        pc   ON pc.id  = pt.categ_id

-- Partner (customer / vendor)
LEFT JOIN res_partner        rp   ON rp.id  = sp.partner_id

-- Locations
JOIN stock_location          loc_from ON loc_from.id = sml.location_id
JOIN stock_location          loc_to   ON loc_to.id   = sml.location_dest_id

-- Parent move (for procure_method / job type)
LEFT JOIN stock_move         sm   ON sm.id = sml.move_id

WHERE
    sml.state = 'done'

    -- 13 July IST = 12 July 18:30 UTC → 13 July 18:29 UTC
    AND sml.date >= '2026-07-12 18:30:00'
    AND sml.date <  '2026-07-13 18:30:00'

    -- Direction filter (both IN and OUT)
    AND spt.code IN ('incoming', 'outgoing')

ORDER BY sml.date ASC;
```

**To filter a single city**, add:

```sql
AND sw.code = 'BAN'
```

**Lot table name:** In Odoo 16+ the table is `stock_lot`. In Odoo 14/15 it may be `stock_production_lot`. Confirm with `\dt stock_*lot*` in psql.

---

## 7. SourceRow Mapping

After fetching, each row from `stock.move.line` maps to the engine's `SourceRow` type as follows:

```
SourceRow {
  source:       "ODOO"
  direction:    picking_type_code == "incoming" ? "IN" : "OUT"
  barcode:      lot_id.name                    // e.g. FULXAV19120774
  date:         date (ISO string, UTC)         // movement completion
  status:       state                          // "done"
  soNumber:     picking_id.origin              // e.g. ON-RET-BAN-19563
  ticketId:     picking_id.name                // e.g. BAN/IN/22557
  customer:     picking_id.partner_id.name     // e.g. Sushma Rao
  product:      product_id.name               // e.g. # Belle Entertainment Unit
  jobType:      sm.procure_method              // "Ok" | "New" | null
  createdOn:    create_date (ISO string, UTC)
  movementDate: date (ISO string, UTC)
}
```

Fields NOT used by the engine but worth persisting in `source_rows.raw`:
`reference`, `product_category`, `customer_ref`, `location_from`, `location_to`, `planned_qty`, `quantity`, `last_updated_on`, `odoo_id`

---

## 8. City Normalisation — Odoo Warehouse Code → Engine City

**This mapping is the Odoo connector's responsibility.** Raw warehouse codes must never reach the engine; the connector (`lib/connectors/odoo.ts`) must translate before constructing a `SourceRow`.

| Odoo Warehouse Code | Cityfurnish City | Engine `City` value |
|---|---|---|
| `BAN` | Bangalore | `BANGALORE` |
| `GUR` | Gurugram | `DELHI` _(engine uses DELHI, not GUR)_ |
| `PUN` | Pune | `PUNE` |
| `MUM` | Mumbai | `MUMBAI` |
| `HYD` | Hyderabad | `HYDERABAD` _(engine legacy spelling)_ |

> The engine's `City` union (`lib/engine/types.ts`) uses `DELHI` and `HYDERABAD` (legacy spellings). Map warehouse codes → engine City in the connector. Any unknown warehouse code should be logged and the row skipped, not passed to the engine.

---

## 9. Volume Reference (13 July — BAN)

From the actual export used to build this document:

| Sheet | Row Count | Total Qty |
|---|---|---|
| Odoo In  | 110 done rows | 1,536.89 |
| Odoo Out | 128 done rows | 128 |

This gives a daily IN+OUT volume of ~238 move lines for Bangalore alone. Expect ~1,200 rows/day across all 5 cities. The `limit: 2000` in the JSON-RPC call is sufficient with a per-city filter; increase to 5000 if fetching all cities in one call.

---

## 10. Open Decisions (from DB_Plan.md)

| Decision | Status | Impact here |
|---|---|---|
| Odoo transport: JSON-RPC vs direct Postgres vs Metabase API | ⬜ deferred | Determines which query (§5 vs §6) to implement; Metabase is confirmed accessible as a 3rd option |
| Confirm `procure_method` = "Ok"/"New" or custom field | ⬜ needs Odoo admin check | Affects `jobType` mapping |
| Lot table name: `stock_lot` vs `stock_production_lot` | ⬜ needs psql check | Affects §6 SQL only |
| IST vs UTC run-date boundary handling | ✅ documented (§4) | Engine uses IST business date |
| Metabase access confirmed for Odoo | ✅ confirmed | "Odoo Live Database" at `analytics.rentofurniture.com` — `stock.move.line` accessible |
| Metabase access confirmed for DT | ✅ confirmed | "Delivery Tracker MongoDB" DB ID 6 at `analytics.rentofurniture.com` — `tasks` accessible |

---

---

# Part II — Delivery Tracker (DT) Source Model

_Added: 2026-07-14_

## 11. Source Overview

| Property | Value |
|---|---|
| **System** | Delivery Tracker (DT) — Cityfurnish internal field-ops app |
| **MongoDB database** | `cityfurnish` (Atlas cluster: `cluster0-shard-00-01.ecb1dy.mongodb.net`) |
| **Primary collection** | `tasks` (Metabase table ID 2663, database ID 6) |
| **Joined collections** | `orderfromcityfurnishes` (barcode/product detail), `users` (agent name) |
| **What it is** | One `tasks` document per delivery/pickup task; each task has ≥1 barcode rows in `orderfromcityfurnishes` |
| **Direction scope** | Both IN (pickups, returns) and OUT (new deliveries) |
| **Barcode location** | `orderfromcityfurnishes.barcode` — NOT on the `tasks` document itself |
| **Metabase access** | ✅ confirmed — "Delivery Tracker MongoDB" connection, DB ID 6 at `analytics.rentofurniture.com` |
| **Done-only rule** | ✅ **Only ingest rows where `orderfromcityfurnishes.status = "2"` (Done). Exclude "3" (Not Done) and "1"/"other" (Pending).** |

> **Why two collections?**  
> `tasks` holds the task header (who, when, city, job type). `orderfromcityfurnishes` holds the per-item lines including the barcode scanned, physical status, and product name. The reconciliation engine is barcode-level, so it needs the joined result — one row per barcode per task.

---

## 12. Collection Schemas

### 12a. `tasks` — Task Header

Confirmed fields (from existing Metabase queries on database 6):

| MongoDB Field | Type | Excel Column | Notes |
|---|---|---|---|
| `_id` | ObjectId | — | Primary key; used as join target for `orderfromcityfurnishes` |
| `ticketNumber` | String | Ticket ID | Task reference e.g. `T-BAN-98765` |
| `caseId` | String | — | CF case/support reference |
| `city` | String | City | City name as stored in DT: `"Bangalore"`, `"Gurgaon"`, `"Mumbai"`, `"Pune"`, `"Hyderabad"` |
| `firstName` | String | — | Customer first name (concatenated for Customer Name) |
| `lastName` | String | — | Customer last name |
| `email` | String | — | Customer email (used to filter out internal CF test tasks) |
| `jobType` | String | Job Type | See §13 for full value list |
| `category` | String | Task Category | `"Order"` for standard deliveries; drives direction logic |
| `subCategory` | String | — | `"Replace"` \| `"Repair"` \| `"Upgrade"` — drives direction for service tasks |
| `movement` | String | — | Raw direction on task (`"In"` \| `"OUT"` \| `"in"` \| `"Out"`) — used for Refurb/Stock Transfer |
| `scheduledDate` | ISODate | Scheduled Date | **The filter date** — run-date filter is applied here |
| `createdAt` | ISODate | — | When the task was created in DT |
| `status` | String/Int | Status (1/2/3) | Task-level completion status (numeric or text) |
| `agentId` | String | — | ObjectId string of assigned agent; join to `users._id` |
| `cf_odoo_id` | String | — | Odoo SO reference on the task (fallback SO number) |
| `orderId` | String | — | Order identifier |
| `transport` | String | Vehicle Number | Primary vehicle reference |
| `adhoc_vehicle` | String | — | Fallback vehicle if `transport` is empty |

### 12b. `orderfromcityfurnishes` — Per-Item / Barcode Lines

Join condition: `orderfromcityfurnishes.pickup_deliveryId = tasks._id` OR `orderfromcityfurnishes.deliveryId = tasks._id`

| MongoDB Field | Type | Excel Column | Notes |
|---|---|---|---|
| `_id` | ObjectId | — | Item line PK |
| `pickup_deliveryId` | ObjectId | — | Reference to `tasks._id` (IN/pickup flow) |
| `deliveryId` | ObjectId | — | Reference to `tasks._id` (OUT/delivery flow) |
| `barcode` | String | Barcode | **The barcode** — primary reconciliation key |
| `triedBarcode` | String | Tried Barcode | What the agent actually scanned (may differ from `barcode`) |
| `status` | String | Physical Status (raw) | Numeric string: `"1"` \| `"2"` \| `"3"` → decoded (see §14) |
| `message` | String | Not scanning reasons | Agent's reason when barcode not scanned |
| `agentMarkqty` | Number | Quantity | Quantity marked by agent (always 1 for serialised items) |
| `Sale_Order` | String | SO Number | Odoo SO reference e.g. `ON-RET-BAN-19563` |
| `Product_name` | String | Product Name | Product display name |
| `client_Status` | String | — | `"Delivery Pending"` \| `"Replacement In"` — drives direction for service tasks |
| `esd` | String/Date | Expected Shipment Date | Expected delivery/pickup date |
| `updatedAt` | ISODate | Transition date | **Movement completion time** — when item status was last updated |

### 12c. `users` — Agent Details

Join condition: `users._id = ObjectId(tasks.agentId)`

| MongoDB Field | Type | Excel Column | Notes |
|---|---|---|---|
| `_id` | ObjectId | — | Agent PK |
| `name` | String | Agent Name | Full name of the delivery agent |

---

## 13. Job Type Values

| DT `jobType` | Direction | Notes |
|---|---|---|
| `New-Rental` | OUT | New deployment to customer |
| `Pickup and Refund` | IN | Customer return / recall |
| `PO Payment` | IN | Payment-on-order pickup |
| `Replace` | IN or OUT | Service replacement (direction from `subCategory` + `client_Status`) |
| `Repair` | IN or OUT | Repair pickup/return (direction from `subCategory` + `client_Status`) |
| `Upgrade` | IN or OUT | Upgrade swap (direction from `subCategory` + `deliveryId`/`pickup_deliveryId`) |
| `Refurb Transfer` | IN or OUT | Refurbishment transfer (direction from raw `movement` field) |
| `Stock Transfer` | IN or OUT | Warehouse-to-warehouse (direction from raw `movement` field) |
| `Manual entry` | IN or OUT | Manual data entry |
| `B2B` | — | B2B orders — **excluded from reconciliation** |
| `New - Buy` | — | Buy orders — **excluded from reconciliation** |
| `Order Transfer` | — | Order transfer — **excluded from reconciliation** |

---

## 14. Direction Derivation

Direction is NOT stored directly on `tasks`. Derive it using this priority-ordered switch (mirrors the existing Metabase query logic):

```
1. category = "Order"                                              → OUT
2. jobType IN ("Pickup and Refund", "PO Payment")                 → IN
3. jobType IN ("Refurb Transfer", "Stock Transfer")               → use raw tasks.movement field
4. subCategory IN ("Replace", "Repair")
     AND orderfromcityfurnishes.client_Status = "Delivery Pending" → OUT
     AND orderfromcityfurnishes.client_Status = "Replacement In"  → IN
5. subCategory = "Upgrade"
     AND orderfromcityfurnishes.deliveryId IS NOT NULL            → OUT
     AND orderfromcityfurnishes.pickup_deliveryId IS NOT NULL     → IN
6. default                                                         → "=" (ambiguous — skip row)
```

**Normalize movement strings in the connector:**

| Raw value from DT | Normalized `direction` |
|---|---|
| `"OUT"`, `"Out"` | `"OUT"` |
| `"In"`, `"in"` | `"IN"` |
| `"="` or any other | skip row (invalid direction) |

---

## 15. Physical Status Decoding — and Done-Only Ingestion Rule

`orderfromcityfurnishes.status` is stored as a numeric string. Decode before persisting:

| Raw `result.status` | Decoded `physicalStatus` | Ingest? |
|---|---|---|
| `"2"` | `"Done"` | ✅ **Yes — only these rows enter the engine** |
| `"3"` | `"Not Done"` | ❌ **Exclude** |
| `"1"` or any other | `"Pending"` | ❌ **Exclude** |

> **Critical rule (confirmed by user):** The reconciliation engine must only process tasks where the agent has physically completed the barcode scan — i.e., `status = "2"` (Done). Rows with "Not Done" (agent attempted but could not complete) or "Pending" (not yet attempted) represent incomplete operations and must not be fed into the reconciliation engine. This filter is applied in the connector via a `$match` on `items.status` **after** the `$lookup` + `$unwind` of `orderfromcityfurnishes` (see §18, Step 5b).

---

## 16. matchStatus Derivation

Derived field — not stored in MongoDB:

```
matchStatus = (barcode === triedBarcode) ? "match" : "non match"
```

---

## 17. Date Filter Logic

Filter on `tasks.scheduledDate` (the task's scheduled run date), NOT `createdAt`:

```javascript
{
  scheduledDate: {
    $gte: ISODate("2026-07-12T18:30:00.000Z"),  // 13 July 00:00 IST
    $lte: ISODate("2026-07-13T18:29:59.999Z")   // 13 July 23:59 IST
  }
}
```

IST-to-UTC conversion (same rule as Odoo):

```
UTC start  =  runDate  00:00:00 IST  →  runDate-1  18:30:00 UTC
UTC end    =  runDate  23:59:59 IST  →  runDate    18:29:59 UTC
```

> **Note:** `scheduledDate` is the date the task was scheduled to be executed, not the completion date. Use `orderfromcityfurnishes.updatedAt` as the movement completion timestamp (maps to `movementDate` in `SourceRow`).

---

## 18. MongoDB Aggregation Query

This is the production query for the DT connector (`lib/connectors/dt.ts`). Replace `{{START}}` and `{{END}}` with ISO strings computed from the run date.

```javascript
db.tasks.aggregate([
  // Step 1 — date filter
  {
    $match: {
      scheduledDate: {
        $gte: new Date("{{START}}"),  // e.g. 2026-07-12T18:30:00.000Z
        $lte: new Date("{{END}}")     // e.g. 2026-07-13T18:29:59.999Z
      },
      // Exclude internal CF test tasks
      email: { $not: { $regex: "cityfurnish\\.com$", $options: "i" } },
      $nor: [
        { firstName: { $regex: "cityfurnish", $options: "i" } },
        { lastName:  { $regex: "cityfurnish", $options: "i" } }
      ],
      // Exclude non-reconcilable job types
      jobType: { $nin: ["New - Buy", "B2B", "Order Transfer"] }
    }
  },

  // Step 2 — build customer name and resolve agentId to ObjectId
  {
    $addFields: {
      customerName: {
        $concat: [
          { $ifNull: ["$firstName", ""] },
          " ",
          { $ifNull: ["$lastName", ""] }
        ]
      },
      agentObjId: {
        $convert: { input: "$agentId", to: "objectId", onError: null, onNull: null }
      },
      odooId: "$cf_odoo_id"
    }
  },

  // Step 3 — join users (agent name)
  {
    $lookup: {
      from: "users",
      localField: "agentObjId",
      foreignField: "_id",
      as: "agent"
    }
  },
  { $unwind: { path: "$agent", preserveNullAndEmptyArrays: true } },

  // Step 4 — join orderfromcityfurnishes (barcode lines)
  {
    $lookup: {
      from: "orderfromcityfurnishes",
      let: { taskId: { $convert: { input: "$_id", to: "objectId", onError: null, onNull: null } } },
      pipeline: [
        {
          $match: {
            $expr: {
              $or: [
                { $eq: ["$pickup_deliveryId", "$$taskId"] },
                { $eq: ["$deliveryId",         "$$taskId"] }
              ]
            }
          }
        }
      ],
      as: "items"
    }
  },

  // Step 5 — unwind barcode lines (one output doc per barcode)
  { $unwind: { path: "$items", preserveNullAndEmptyArrays: false } },

  // Step 5b — DONE-ONLY FILTER: exclude Not Done ("3") and Pending ("1")
  // Only physical status "2" (Done) rows enter the reconciliation engine.
  { $match: { "items.status": "2" } },

  // Step 6 — project all fields needed by SourceRow + raw storage
  {
    $project: {
      _id: 0,
      // SourceRow fields
      ticketId:     "$ticketNumber",
      soNumber:     { $ifNull: ["$items.Sale_Order", "$odooId"] },
      customer:     "$customerName",
      product:      "$items.Product_name",
      jobType:      "$jobType",
      barcode:      "$items.barcode",
      city:         "$city",
      scheduledDate: "$scheduledDate",
      movementDate: "$items.updatedAt",
      createdOn:    "$createdAt",
      // Direction inputs (resolved in connector code — see §14)
      _category:    "$category",
      _subCategory: "$subCategory",
      _movement:    "$movement",
      _clientStatus: "$items.client_Status",
      _hasDeliveryId:       { $cond: [{ $gt: [{ $ifNull: ["$items.deliveryId", null] }, null] }, true, false] },
      _hasPickupDeliveryId: { $cond: [{ $gt: [{ $ifNull: ["$items.pickup_deliveryId", null] }, null] }, true, false] },
      // Physical status (raw — decode in connector per §15)
      physicalStatusRaw: "$items.status",
      // Extra fields for raw storage
      triedBarcode:      "$items.triedBarcode",
      notScanningReason: { $ifNull: ["$items.message", ""] },
      quantity:          "$items.agentMarkqty",
      agentName:         "$agent.name",
      vehicleNumber:     { $cond: { if: { $eq: ["$transport", ""] }, then: "$adhoc_vehicle", else: "$transport" } },
      esd:               "$items.esd",
      taskStatus:        "$status"
    }
  }
])
```

> **City filter** — add to the `$match` stage to fetch a single city:
> ```javascript
> city: "Bangalore"   // or "Gurgaon", "Mumbai", "Pune", "Hyderabad"
> ```

---

## 19. SourceRow Mapping

After the aggregation, apply direction derivation (§14) and physical status decoding (§15) in the connector, then map to `SourceRow`:

```
SourceRow {
  source:       "DT"
  direction:    derived (see §14)   // "IN" | "OUT"
  barcode:      items.barcode        // e.g. FULXAV19120774 — primary reco key
  date:         items.updatedAt      // ISO string — movement completion time
  status:       decoded physicalStatus  // "Done" | "Not Done" | "Pending"
  soNumber:     items.Sale_Order ?? cf_odoo_id   // e.g. ON-RET-BAN-19563
  ticketId:     ticketNumber         // e.g. T-BAN-98765
  customer:     firstName + " " + lastName
  product:      items.Product_name   // e.g. Belle Entertainment Unit
  jobType:      jobType              // e.g. "Pickup and Refund", "New-Rental"
  createdOn:    createdAt            // ISO string — task creation time
  movementDate: items.updatedAt      // ISO string — same as date
}
```

Fields NOT used by the engine but worth persisting in `source_rows.raw`:
`triedBarcode`, `notScanningReason`, `matchStatus`, `physicalStatusRaw`, `agentName`, `vehicleNumber`, `quantity`, `esd`, `taskStatus`, `scheduledDate`, `city`

---

## 20. City Normalisation — DT City String → Engine City

**This mapping is the DT connector's responsibility.** DT stores full city names; the engine expects its own `City` union values. The connector (`lib/connectors/dt.ts`) must translate before constructing a `SourceRow`. Never pass raw DT city strings to the engine.

| DT `city` value | Engine `City` value | Notes |
|---|---|---|
| `"Bangalore"` | `"BANGALORE"` | |
| `"Gurgaon"` | `"DELHI"` | Engine uses DELHI for the Gurugram/NCR bucket |
| `"Gurugram"` | `"DELHI"` | Alternate spelling — same bucket |
| `"Noida"` | `"DELHI"` | Noida is in the same NCR / DELHI bucket |
| `"Delhi"` | `"DELHI"` | |
| `"New Delhi"` | `"DELHI"` | |
| `"Pune"` | `"PUNE"` | |
| `"Mumbai"` | `"MUMBAI"` | |
| `"Hyderabad"` | `"HYDERABAD"` | Engine legacy spelling (missing 'E') |
| `"Hyd"` | `"HYDERABAD"` | Abbreviation seen in some DT records |

> **Unknown cities:** DT also contains `"Hosur"`, `"Chennai"`, `"Nasik"`, `"Jaipur"`, `"Karnal"` etc. These are cities the engine does not currently reconcile. The connector must log and drop rows with unknown city values rather than passing them to the engine.

> **Source:** City normalisation rules confirmed from the n8n reference workflow (`warehouse_reco_n8n_workflow.json` node "Normalise DT city") and cross-checked against Metabase card 317 data.

---

## 21. Volume Reference (13 July — BAN)

From the actual export used to build this document:

| Direction | Row Count | Notes |
|---|---|---|
| DT In  | 169 rows | Pickups / returns |
| DT Out | 137 rows | Deliveries |

Total: 306 barcode-level rows for Bangalore. Expect ~1,500 rows/day across all 5 cities when running the full connector.

---

## 22. Metabase Reference Queries

Two existing Metabase saved questions on database 6 (Delivery Tracker MongoDB) can be used as references during connector development:

| Card ID | Name | Purpose |
|---|---|---|
| 317 | Barcode Level Data Aditya | Full barcode-level export with date filter + all joins; matches the Excel export structure |
| 404 | Barcode Level DT Query V2 Aditya | V2 with parameterised `{{start_date}}`/`{{end_date}}` template variables |
| 564 | Pending Tasks- DT | Task-header only (no barcode join); useful for understanding `tasks` fields: `ticketNumber`, `caseId`, `city`, `status`, `scheduledDate`, `createdAt`, `orderId`, `jobType` |

---

---

# Part III — Connector Responsibilities Summary

_This section summarises the rules each source connector must enforce before handing a row to the reconciliation engine. These are **connector-level concerns** — the engine itself is stateless and assumes all inputs are already clean._

## 23. Pre-Engine Rules (all connectors)

### 23a. Odoo Connector (`lib/connectors/odoo.ts`)

| Rule | Detail |
|---|---|
| **Done-only** | Filter `state = 'done'` on `stock.move.line` — partially done or cancelled moves are excluded |
| **Date filter** | Apply on `sml.date` (movement completion time) in UTC, converted from IST run date (§4) |
| **City normalisation** | Map `warehouse_code` → engine `City` using the table in §8; log + skip unknown codes |
| **Direction** | Derive from `picking_type_id.code`: `incoming`→`IN`, `outgoing`→`OUT`; skip anything else |
| **Excluded job types** | None — all Odoo move lines that pass `state=done` are reconcilable |
| **Transport (TBD)** | JSON-RPC (§5), direct Postgres (§6), or Metabase API — all confirmed accessible; decision pending |

### 23b. DT Connector (`lib/connectors/dt.ts`)

| Rule | Detail |
|---|---|
| **Done-only** | Filter `orderfromcityfurnishes.status = "2"` (Done) **after** the `$lookup`+`$unwind` — this is Step 5b in §18. Rows with `"3"` (Not Done) or `"1"` (Pending) are excluded |
| **Date filter** | Apply on `tasks.scheduledDate` in UTC, converted from IST run date (§17) |
| **City normalisation** | Map DT city string → engine `City` using the table in §20; log + skip unknown cities |
| **Direction** | Apply the 6-rule priority switch in §14; skip rows that resolve to `"="` (ambiguous) |
| **Excluded job types** | `"B2B"`, `"New - Buy"`, `"Order Transfer"` — filtered out in the `$match` stage (§18, Step 1) |
| **Excluded tasks** | Internal CF test tasks (email matches `@cityfurnish.com` or name contains "cityfurnish") — filtered in Step 1 |
| **Transport** | MongoDB Atlas — confirmed via Metabase "Delivery Tracker MongoDB" (DB ID 6). Direct Atlas connection URI also available |

### 23c. City Normalisation — Cross-Source Reference

Both connectors must produce the same `City` enum value for the same physical city. The full mapping across both sources:

| Physical City | Odoo Warehouse Code | DT `city` values | Engine `City` |
|---|---|---|---|
| Bangalore | `BAN` | `"Bangalore"` | `BANGALORE` |
| Gurugram / NCR | `GUR` | `"Gurgaon"`, `"Gurugram"`, `"Noida"`, `"Delhi"`, `"New Delhi"` | `DELHI` |
| Pune | `PUN` | `"Pune"` | `PUNE` |
| Mumbai | `MUM` | `"Mumbai"` | `MUMBAI` |
| Hyderabad | `HYD` | `"Hyderabad"`, `"Hyd"` | `HYDERABAD` |

> **Single source of truth:** This table is the canonical normalisation map. Whenever city strings change in DT or new Odoo warehouses are added, update this table first, then update both connectors to match.
