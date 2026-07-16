// Single icon surface for the whole app — Lucide (bundled SVGs) instead of the
// Material Symbols web font. The font approach rendered icon *names* as literal
// ligature text ("dashboard", "search"…) whenever the Google font was slow or
// blocked, which is what made the UI look broken. Lucide ships each glyph as an
// inline SVG so there is no font to load and nothing to fail.
//
// No "use client" on purpose: these are pure SVG components and must also render
// inside server components (the dashboard layout header).

import {
  Activity,
  ArrowUpRight,
  Award,
  Bell,
  ChartColumn,
  Check,
  CircleAlert,
  CircleCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardCheck,
  Clock,
  CloudUpload,
  Download,
  FileUp,
  Flag,
  History,
  Info,
  LayoutDashboard,
  LoaderCircle,
  Lock,
  LogIn,
  LogOut,
  Mail,
  MapPin,
  Menu,
  Minus,
  Moon,
  Package,
  RefreshCw,
  Search,
  SearchX,
  Send,
  Shield,
  ShieldCheck,
  ShieldPlus,
  Square,
  Sun,
  Table,
  Trash2,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Trophy,
  Truck,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

// Maps the old Material Symbol ligature names (still used as string keys in
// data — sidebar nav items, connector rows, trend indicators) to Lucide icons.
const ICONS: Record<string, LucideIcon> = {
  analytics: ChartColumn,
  arrow_outward: ArrowUpRight,
  check: Check,
  check_circle: CircleCheck,
  chevron_left: ChevronLeft,
  chevron_right: ChevronRight,
  close: X,
  cloud_upload: CloudUpload,
  dark_mode: Moon,
  dashboard: LayoutDashboard,
  delete: Trash2,
  download: Download,
  error: CircleAlert,
  expand_less: ChevronUp,
  expand_more: ChevronDown,
  fact_check: ClipboardCheck,
  flag: Flag,
  group: Users,
  health_and_safety: ShieldPlus,
  history: History,
  info: Info,
  inventory_2: Package,
  leaderboard: Trophy,
  light_mode: Sun,
  local_shipping: Truck,
  location_on: MapPin,
  lock: Lock,
  menu: Menu,
  login: LogIn,
  logout: LogOut,
  mail: Mail,
  monitoring: Activity,
  notifications: Bell,
  person_add: UserPlus,
  progress_activity: LoaderCircle,
  report: TriangleAlert,
  schedule: Clock,
  search: Search,
  search_off: SearchX,
  send: Send,
  shield: Shield,
  sync: RefreshCw,
  sync_alt: RefreshCw,
  table_chart: Table,
  task_alt: CircleCheck,
  trending_down: TrendingDown,
  trending_flat: Minus,
  trending_up: TrendingUp,
  upload_file: FileUp,
  verified_user: ShieldCheck,
  warning: TriangleAlert,
  workspace_premium: Award,
};

export function Icon({
  name,
  size = 18,
  className,
  strokeWidth = 2,
}: {
  name: string;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  const Cmp = ICONS[name] ?? Square;
  // shrink-0 keeps icons from being squished inside flex rows; currentColor
  // means existing text-* color classes still tint them.
  return (
    <Cmp
      size={size}
      strokeWidth={strokeWidth}
      className={`shrink-0 ${className ?? ""}`}
    />
  );
}
