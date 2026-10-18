import type { ComponentType, SVGProps } from 'react'
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowRightFromSquare,
  ArrowRightToSquare,
  ArrowRotateRight,
  ArrowShapeTurnUpRight,
  ArrowUpFromLine,
  ArrowUpRightFromSquare,
  Bars,
  Bell,
  BookOpen,
  Bookmark,
  Box,
  Briefcase,
  Bulb,
  Calculator,
  Calendar,
  Car,
  ChartColumn,
  ChartLine,
  ChartLineArrowUp,
  ChartPie,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleDollar,
  CircleInfo,
  CirclePlus,
  CircleQuestion,
  CircleXmark,
  Clock,
  Comment,
  Comments,
  Copy,
  CreditCard,
  Database,
  Ellipsis,
  Envelope,
  Eye,
  File,
  Flag,
  FloppyDisk,
  Folder,
  Funnel,
  Gear,
  Gift,
  Globe,
  Handset,
  Headphones,
  Heart,
  House,
  Key,
  Layers,
  LayoutCells,
  Link,
  ListUl,
  Lock,
  LockOpen,
  Magnifier,
  MapPin,
  Medal,
  Megaphone,
  Moon,
  PaperPlane,
  Paperclip,
  Pencil,
  Percent,
  Person,
  PersonPlus,
  Persons,
  Picture,
  Play,
  Plus,
  Pulse,
  Receipt,
  Rocket,
  Server,
  Shield,
  ShoppingCart,
  Sliders,
  Sparkles,
  Star,
  Sun,
  Tag,
  Target,
  ThumbsUp,
  Thunderbolt,
  Ticket,
  TrashBin,
  Tray,
  TriangleExclamation,
  Wallet,
  Xmark
} from '@gravity-ui/icons'

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

/**
 * Icon names the LLM may use (lucide-style vocabulary, mapped onto the
 * Gravity UI set HeroUI is designed with). Aliases keep near-misses working.
 */
const ICONS: Record<string, IconComponent> = {
  home: House,
  dashboard: LayoutCells,
  grid: LayoutCells,
  users: Persons,
  team: Persons,
  user: Person,
  profile: Person,
  account: Person,
  settings: Gear,
  gear: Gear,
  search: Magnifier,
  bell: Bell,
  notifications: Bell,
  plus: Plus,
  add: Plus,
  'plus-circle': CirclePlus,
  edit: Pencil,
  pencil: Pencil,
  trash: TrashBin,
  delete: TrashBin,
  back: ArrowLeft,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  more: Ellipsis,
  menu: Bars,
  chart: ChartColumn,
  'bar-chart': ChartColumn,
  analytics: ChartLine,
  'line-chart': ChartLine,
  'pie-chart': ChartPie,
  report: ChartPie,
  calendar: Calendar,
  file: File,
  document: File,
  folder: Folder,
  projects: Folder,
  mail: Envelope,
  email: Envelope,
  inbox: Tray,
  star: Star,
  heart: Heart,
  cart: ShoppingCart,
  orders: ShoppingCart,
  tag: Tag,
  list: ListUl,
  tasks: ListUl,
  check: Check,
  done: CircleCheck,
  success: CircleCheck,
  close: Xmark,
  x: Xmark,
  error: CircleXmark,
  logout: ArrowRightFromSquare,
  'log-out': ArrowRightFromSquare,
  refresh: ArrowRotateRight,
  filter: Funnel,
  download: ArrowDownToLine,
  upload: ArrowUpFromLine,
  info: CircleInfo,
  warning: TriangleExclamation,
  alert: TriangleExclamation,
  lock: Lock,
  security: Shield,
  shield: Shield,
  key: Key,
  globe: Globe,
  web: Globe,
  message: Comment,
  chat: Comments,
  messages: Comments,
  clock: Clock,
  history: Clock,
  database: Database,
  box: Box,
  package: Box,
  products: Box,
  briefcase: Briefcase,
  deals: Briefcase,
  card: CreditCard,
  billing: CreditCard,
  payment: CreditCard,
  sun: Sun,
  moon: Moon,
  image: Picture,
  photo: Picture,
  link: Link,
  copy: Copy,
  eye: Eye,
  view: Eye,
  sliders: Sliders,
  preferences: Sliders,
  flag: Flag,
  bookmark: Bookmark,
  rocket: Rocket,
  launch: Rocket,
  'thumbs-up': ThumbsUp,
  zap: Thunderbolt,
  bolt: Thunderbolt,
  'map-pin': MapPin,
  location: MapPin,
  lightbulb: Bulb,
  idea: Bulb,
  server: Server,
  layers: Layers,
  receipt: Receipt,
  invoice: Receipt,
  wallet: Wallet,
  calculator: Calculator,
  phone: Handset,
  paperclip: Paperclip,
  attachment: Paperclip,
  send: PaperPlane,
  gift: Gift,
  car: Car,
  archive: Archive,
  login: ArrowRightToSquare,
  'user-plus': PersonPlus,
  trending: ChartLineArrowUp,
  dollar: CircleDollar,
  revenue: CircleDollar,
  target: Target,
  goal: Target,
  activity: Pulse,
  percent: Percent,
  sparkles: Sparkles,
  help: CircleQuestion,
  save: FloppyDisk,
  unlock: LockOpen,
  external: ArrowUpRightFromSquare,
  share: ArrowShapeTurnUpRight,
  trophy: Medal,
  award: Medal,
  megaphone: Megaphone,
  campaign: Megaphone,
  ticket: Ticket,
  support: Headphones,
  book: BookOpen,
  play: Play
}

export const iconNames: string[] = Object.keys(ICONS)

/** Spellings models borrow from lucide / material / heroicons → a name above. */
const SYNONYMS: Record<string, string> = {
  'log-in': 'login',
  'sign-in': 'login',
  signin: 'login',
  'sign-out': 'logout',
  signout: 'logout',
  'person-add': 'user-plus',
  'add-user': 'user-plus',
  'trending-up': 'trending',
  'dollar-sign': 'dollar',
  money: 'dollar',
  currency: 'dollar',
  'credit-card': 'card',
  credit: 'card',
  'check-circle': 'success',
  'x-circle': 'error',
  'alert-circle': 'warning',
  'alert-triangle': 'warning',
  'help-circle': 'help',
  question: 'help',
  'external-link': 'external',
  'more-horizontal': 'more',
  'more-vertical': 'more',
  'layout-dashboard': 'dashboard',
  house: 'home',
  cog: 'gear',
  people: 'users',
  person: 'user',
  contacts: 'users',
  contact: 'user',
  building: 'briefcase',
  company: 'briefcase',
  note: 'file',
  notes: 'file',
  pipeline: 'filter',
  funnel: 'filter',
  pulse: 'activity',
  medal: 'trophy',
  headphones: 'support'
}

const PREFIX = /^(?:lucide|mdi|fa[srb]?|bi|ri|ion|icon|heroicons?)[-:]/
const SUFFIX = /-(?:outline|outlined|filled|fill|solid|alt|sharp|rounded|round|o|\d+)$/

/**
 * Resolve an icon name the way a model might write it: "TrendingUp",
 * "log_in", "trash-2", "mdi-account-outline", "calendar-days" (falls back to
 * the family's base icon).
 */
function resolveIcon(name: string): IconComponent | undefined {
  let key = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(PREFIX, '')
  for (let pass = 0; pass < 2; pass++) {
    const hit = ICONS[key] ?? ICONS[SYNONYMS[key]]
    if (hit) return hit
    key = key.replace(SUFFIX, '')
  }
  const head = key.split('-')[0]
  return ICONS[head] ?? ICONS[SYNONYMS[head]]
}

export function hasIcon(name: unknown): boolean {
  return typeof name === 'string' && resolveIcon(name) !== undefined
}

/**
 * Renders a named icon. Unknown names render nothing, except short non-ASCII
 * strings (emoji), which are shown as-is so `icon: "🚀"` still works.
 */
export function Icon({
  name,
  className,
  size = 16
}: {
  name?: unknown
  className?: string
  size?: number
}) {
  if (typeof name !== 'string' || !name) return null
  const Comp = resolveIcon(name)
  if (Comp)
    return <Comp width={size} height={size} className={className} aria-hidden focusable={false} />
  // eslint-disable-next-line no-control-regex
  if (name.length <= 4 && /[^\u0000-\u007f]/.test(name)) {
    return (
      <span className={className} aria-hidden style={{ fontSize: size, lineHeight: 1 }}>
        {name}
      </span>
    )
  }
  return null
}
