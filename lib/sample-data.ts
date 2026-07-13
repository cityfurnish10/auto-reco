// SAMPLE DATA ONLY — placeholder until the central Supabase DB is provided.
// Shapes here are intentionally UI-facing and will be remapped to the real
// schema/column names when they are finalised.

export const CITIES = [
  "DELHI",
  "MUMBAI",
  "PUNE",
  "HYDRABAD",
  "BANGALORE",
] as const;

export type City = (typeof CITIES)[number];

export type Severity = "HIGH" | "MEDIUM" | "LOW";
export type VarianceStatus = "OPEN" | "CLOSED" | "DISPUTED";
export type ClosureReason =
  | "Data Entry Error"
  | "Transit Delay"
  | "Theft"
  | "System Glitch"
  | "Other";

export interface VarianceRow {
  id: string;
  itemCode: string;
  itemName: string;
  city: City;
  odooQty: number;
  dtQty: number;
  sheetQty: number;
  guardQty: number;
  delta: number;
  severity: Severity;
  status: VarianceStatus;
  closedBy?: string;
  closedAt?: string;
  closureReason?: ClosureReason;
  closureNote?: string;
}

export interface CitySummary {
  city: City;
  station: string;
  accuracy: number;
  openVariances: number;
  totalItems: number;
  highPct: number;
  medPct: number;
  lowPct: number;
  rank: number;
  trend: "up" | "down" | "flat";
}

export const CITY_SUMMARIES: CitySummary[] = [
  {
    city: "BANGALORE",
    station: "BLR-WH-01",
    accuracy: 96.4,
    openVariances: 14,
    totalItems: 1425,
    highPct: 7,
    medPct: 21,
    lowPct: 72,
    rank: 1,
    trend: "up",
  },
  {
    city: "MUMBAI",
    station: "BOM-WH-01",
    accuracy: 94.1,
    openVariances: 23,
    totalItems: 1180,
    highPct: 13,
    medPct: 30,
    lowPct: 57,
    rank: 2,
    trend: "up",
  },
  {
    city: "PUNE",
    station: "PNQ-WH-01",
    accuracy: 91.8,
    openVariances: 31,
    totalItems: 890,
    highPct: 19,
    medPct: 35,
    lowPct: 46,
    rank: 3,
    trend: "flat",
  },
  {
    city: "DELHI",
    station: "DEL-WH-01",
    accuracy: 86.2,
    openVariances: 48,
    totalItems: 1310,
    highPct: 35,
    medPct: 40,
    lowPct: 25,
    rank: 4,
    trend: "down",
  },
  {
    city: "HYDRABAD",
    station: "HYD-WH-01",
    accuracy: 81.7,
    openVariances: 57,
    totalItems: 760,
    highPct: 46,
    medPct: 33,
    lowPct: 21,
    rank: 5,
    trend: "down",
  },
];

const row = (
  id: number,
  itemCode: string,
  itemName: string,
  city: City,
  odooQty: number,
  dtQty: number,
  sheetQty: number,
  guardQty: number,
  severity: Severity,
  status: VarianceStatus
): VarianceRow => ({
  id: `VAR-${String(id).padStart(4, "0")}`,
  itemCode,
  itemName,
  city,
  odooQty,
  dtQty,
  sheetQty,
  guardQty,
  delta: dtQty - odooQty,
  severity,
  status,
});

export const VARIANCES: VarianceRow[] = [
  row(1, "CF-BED-Q201", "Queen Bed — Engineered Wood", "DELHI", 142, 128, 128, 127, "HIGH", "OPEN"),
  row(2, "CF-SOF-3S114", "3-Seater Fabric Sofa (Grey)", "DELHI", 96, 96, 94, 94, "MEDIUM", "OPEN"),
  row(3, "CF-WRD-3D302", "3-Door Wardrobe with Mirror", "DELHI", 61, 55, 55, 55, "HIGH", "OPEN"),
  row(4, "CF-MAT-Q109", "Queen Memory Foam Mattress", "DELHI", 210, 209, 209, 209, "LOW", "CLOSED"),
  row(5, "CF-DIN-4S220", "4-Seater Dining Set — Sheesham", "DELHI", 44, 40, 41, 40, "HIGH", "OPEN"),
  row(6, "CF-CHR-OF450", "Ergonomic Office Chair", "DELHI", 188, 186, 186, 185, "MEDIUM", "OPEN"),
  row(7, "CF-REF-D260", "Double-Door Refrigerator 260L", "DELHI", 37, 37, 36, 36, "LOW", "CLOSED"),
  row(8, "CF-STD-T118", "Study Table with Shelf", "DELHI", 73, 68, 68, 68, "MEDIUM", "OPEN"),
  row(9, "CF-AC-S15T", "Split AC 1.5 Ton (Inverter)", "MUMBAI", 58, 56, 56, 56, "MEDIUM", "OPEN"),
  row(10, "CF-SOF-LS208", "L-Shape Sofa — Teal", "MUMBAI", 42, 42, 42, 41, "LOW", "CLOSED"),
  row(11, "CF-BED-K305", "King Bed with Hydraulic Storage", "MUMBAI", 77, 71, 71, 71, "HIGH", "OPEN"),
  row(12, "CF-WSM-F70", "Front-Load Washing Machine 7kg", "MUMBAI", 29, 29, 29, 29, "LOW", "CLOSED"),
  row(13, "CF-TVU-W140", "TV Unit — Walnut 140cm", "MUMBAI", 65, 63, 64, 63, "MEDIUM", "OPEN"),
  row(14, "CF-MAT-S106", "Single Foam Mattress", "MUMBAI", 154, 154, 152, 152, "LOW", "CLOSED"),
  row(15, "CF-CHR-AC112", "Accent Chair — Mustard", "PUNE", 51, 47, 47, 47, "HIGH", "OPEN"),
  row(16, "CF-BED-S102", "Single Bed — Metal Frame", "PUNE", 89, 87, 87, 87, "MEDIUM", "OPEN"),
  row(17, "CF-DIN-2S119", "2-Seater Breakfast Table", "PUNE", 33, 33, 32, 32, "LOW", "CLOSED"),
  row(18, "CF-REF-S190", "Single-Door Refrigerator 190L", "PUNE", 48, 44, 44, 44, "HIGH", "OPEN"),
  row(19, "CF-STD-C455", "Computer Desk — Compact", "PUNE", 112, 110, 110, 110, "MEDIUM", "OPEN"),
  row(20, "CF-SOF-2S110", "2-Seater Fabric Sofa (Beige)", "HYDRABAD", 68, 59, 59, 58, "HIGH", "OPEN"),
  row(21, "CF-AC-W10T", "Window AC 1 Ton", "HYDRABAD", 41, 38, 38, 38, "HIGH", "DISPUTED"),
  row(22, "CF-WRD-2D301", "2-Door Wardrobe — Oak", "HYDRABAD", 55, 52, 52, 52, "MEDIUM", "OPEN"),
  row(23, "CF-BED-Q202", "Queen Bed — Solid Wood", "HYDRABAD", 84, 76, 77, 76, "HIGH", "OPEN"),
  row(24, "CF-MAT-K111", "King Latex Mattress", "HYDRABAD", 62, 62, 61, 61, "LOW", "CLOSED"),
  row(25, "CF-TVU-B120", "TV Unit — Black 120cm", "HYDRABAD", 39, 36, 36, 36, "MEDIUM", "OPEN"),
  row(26, "CF-CHR-OF451", "Mesh Office Chair — High Back", "BANGALORE", 176, 175, 175, 175, "LOW", "CLOSED"),
  row(27, "CF-SOF-3S115", "3-Seater Leatherette Sofa", "BANGALORE", 54, 54, 53, 53, "LOW", "CLOSED"),
  row(28, "CF-BED-B404", "Bunk Bed — Kids", "BANGALORE", 27, 25, 25, 25, "MEDIUM", "OPEN"),
  row(29, "CF-WSM-T65", "Top-Load Washing Machine 6.5kg", "BANGALORE", 35, 35, 35, 34, "LOW", "CLOSED"),
  row(30, "CF-DIN-6S221", "6-Seater Dining Set — Mango Wood", "BANGALORE", 22, 21, 21, 21, "MEDIUM", "OPEN"),
];

export const OVERALL = {
  avgAccuracy:
    Math.round(
      (CITY_SUMMARIES.reduce((s, c) => s + c.accuracy, 0) /
        CITY_SUMMARIES.length) *
        10
    ) / 10,
  itemsReconciledToday: CITY_SUMMARIES.reduce((s, c) => s + c.totalItems, 0),
};

// ---------------------------------------------------------------------------
// Platform users (seed — managed from User Management, becomes Supabase later)
// ---------------------------------------------------------------------------

export type UserRole = "ADMIN" | "MANAGER";

export interface PlatformUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  city: City | null;
  status: "ACTIVE" | "INACTIVE";
}

export const PLATFORM_USERS: PlatformUser[] = [
  {
    id: "USR-001",
    name: "Admin User",
    email: "admin@cityfurnish.com",
    role: "ADMIN",
    city: null,
    status: "ACTIVE",
  },
  {
    id: "USR-002",
    name: "Rajesh Kumar",
    email: "delhi.manager@cityfurnish.com",
    role: "MANAGER",
    city: "DELHI",
    status: "ACTIVE",
  },
  {
    id: "USR-003",
    name: "Amit Sharma",
    email: "mumbai.manager@cityfurnish.com",
    role: "MANAGER",
    city: "MUMBAI",
    status: "ACTIVE",
  },
  {
    id: "USR-004",
    name: "Rohan Khanna",
    email: "pune.manager@cityfurnish.com",
    role: "MANAGER",
    city: "PUNE",
    status: "ACTIVE",
  },
  {
    id: "USR-005",
    name: "Sneha Joshi",
    email: "hydrabad.manager@cityfurnish.com",
    role: "MANAGER",
    city: "HYDRABAD",
    status: "ACTIVE",
  },
  {
    id: "USR-006",
    name: "Vikram Patel",
    email: "bangalore.manager@cityfurnish.com",
    role: "MANAGER",
    city: "BANGALORE",
    status: "ACTIVE",
  },
];

// ---------------------------------------------------------------------------
// Guard Register uploads (seed history)
// ---------------------------------------------------------------------------

export type UploadStatus = "PENDING" | "UPLOADED" | "PARSED" | "ERROR";

export interface GuardUpload {
  id: string;
  city: City;
  date: string;
  fileName: string;
  status: UploadStatus;
  uploadedBy: string;
  time: string;
  rows?: number;
}

export const GUARD_UPLOADS: GuardUpload[] = [
  { id: "UPL-101", city: "DELHI", date: "2026-07-10", fileName: "delhi_guard_jul10.xlsx", status: "PARSED", uploadedBy: "Rajesh Kumar", time: "09:42 PM", rows: 118 },
  { id: "UPL-102", city: "MUMBAI", date: "2026-07-10", fileName: "mumbai_guard_jul10.xlsx", status: "PARSED", uploadedBy: "Amit Sharma", time: "09:15 PM", rows: 96 },
  { id: "UPL-103", city: "PUNE", date: "2026-07-10", fileName: "pune_guard_jul10.xlsx", status: "UPLOADED", uploadedBy: "Rohan Khanna", time: "09:58 PM", rows: 74 },
  { id: "UPL-104", city: "HYDRABAD", date: "2026-07-10", fileName: "hydrabad_guard_jul10_retry.xlsx", status: "ERROR", uploadedBy: "Sneha Joshi", time: "10:04 PM" },
  { id: "UPL-105", city: "BANGALORE", date: "2026-07-10", fileName: "bangalore_guard_jul10.xlsx", status: "PARSED", uploadedBy: "Vikram Patel", time: "08:51 PM", rows: 131 },
  { id: "UPL-106", city: "DELHI", date: "2026-07-09", fileName: "delhi_guard_jul09.xlsx", status: "PARSED", uploadedBy: "Rajesh Kumar", time: "09:30 PM", rows: 122 },
  { id: "UPL-107", city: "HYDRABAD", date: "2026-07-09", fileName: "hydrabad_guard_jul09.xlsx", status: "PARSED", uploadedBy: "Sneha Joshi", time: "09:47 PM", rows: 83 },
];

// ---------------------------------------------------------------------------
// System health (sample connector + log data)
// ---------------------------------------------------------------------------

export interface ConnectorStatus {
  name: string;
  description: string;
  icon: string;
  status: "OK" | "FAILED" | "DEGRADED";
  lastSync: string;
}

export const CONNECTORS: ConnectorStatus[] = [
  { name: "Odoo Sync", description: "ERP integration status", icon: "sync", status: "OK", lastSync: "2 mins ago" },
  { name: "Delivery Tracker", description: "Trip confirmations sync", icon: "local_shipping", status: "OK", lastSync: "45s ago" },
  { name: "Google Sheets", description: "5 warehouse sheets pipeline", icon: "table_chart", status: "FAILED", lastSync: "12 mins ago" },
  { name: "Guard Register", description: "Daily Excel processor", icon: "shield", status: "OK", lastSync: "1h ago" },
];

export interface ErrorLog {
  timestamp: string;
  source: string;
  sourceColor: string;
  city: City;
  message: string;
  status: "UNRESOLVED" | "RETRYING" | "RESOLVED";
}

export const ERROR_LOGS: ErrorLog[] = [
  { timestamp: "2026-07-11 14:32:01", source: "Google Sheets Sync", sourceColor: "bg-amber-400", city: "BANGALORE", message: "403: Insufficient Permission for API scope", status: "UNRESOLVED" },
  { timestamp: "2026-07-11 14:15:22", source: "Odoo ERP", sourceColor: "bg-primary", city: "MUMBAI", message: "Connection timeout: Retrying in 5s...", status: "RETRYING" },
  { timestamp: "2026-07-11 13:50:11", source: "Delivery Tracker", sourceColor: "bg-blue-500", city: "DELHI", message: "Success: Backlog data sync completed (452 rows)", status: "RESOLVED" },
  { timestamp: "2026-07-11 12:44:09", source: "Guard Register", sourceColor: "bg-slate-400", city: "PUNE", message: "Validation Error: Row 44 contains invalid character set", status: "UNRESOLVED" },
  { timestamp: "2026-07-11 11:20:55", source: "Google Sheets Sync", sourceColor: "bg-amber-400", city: "HYDRABAD", message: "Quota Exceeded: Daily API read limit reached", status: "UNRESOLVED" },
];
