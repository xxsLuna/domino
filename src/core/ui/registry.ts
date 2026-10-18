import type { ComponentType } from 'react'
import type { CardNode, UiSpec } from '../spec'
import {
  Accordion,
  Alert,
  Avatar,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  Checkbox,
  Columns,
  Divider,
  EmptyState,
  Form,
  Heading,
  Image,
  Input,
  KeyValue,
  Link,
  List,
  PageHeader,
  Pagination,
  Paragraph,
  Progress,
  Radio,
  RadioGroup,
  SearchField,
  Select,
  Skeleton,
  Spinner,
  Stack,
  StatCard,
  Switch,
  Table,
  Tabs,
  Textarea
} from './components'

export interface ComponentDef {
  /** The registered, unique component name used by .domino/LLM specs. */
  name: string
  category: 'layout' | 'text' | 'form' | 'data' | 'feedback' | 'media' | 'navigation'
  /** Human-readable description fed to the LLM system prompt. */
  description: string
  component: ComponentType<Record<string, unknown>>
}

function def(
  name: string,
  category: ComponentDef['category'],
  description: string,
  component: ComponentType<never>
): ComponentDef {
  return { name, category, description, component: component as ComponentType<Record<string, unknown>> }
}

export const COMPONENT_DEFS: ComponentDef[] = [
  // layout
  def('PageHeader', 'layout', 'Page title row — start every page with it. Props: title, description, icon, badge, badgeVariant. Children: action Buttons — secondary ones first, the one primary last (right-aligned, wrap on phones).', PageHeader),
  def('Card', 'layout', 'Surface grouping related content. Props: title, description, icon. Children allowed (any components).', Card),
  def('Section', 'layout', 'Alias of Card. Props: title, description. Children allowed.', Card),
  def('Columns', 'layout', 'Side-by-side children inside a Card/Form (collapses to one column on phones). Props: cols (2|3|4). Children allowed.', Columns),
  def('Stack', 'layout', 'Flex row/column of children. Props: direction (row|column), align (start|center|end|between), gap (sm|md|lg). Children allowed.', Stack),
  def('Tabs', 'layout', 'Tabbed panels switched locally (no round trip). Props: tabs (string[] labels, one per child). Each child is one panel.', Tabs),
  def('Accordion', 'layout', 'Collapsible panels. Props: items ({title, content}[]) OR children panels (labels from child props.title). Props: multiple.', Accordion),
  def('Divider', 'layout', 'Horizontal separator.', Divider),
  // text
  def('Heading', 'text', 'Title text. Props: text, level (1-6), align (left|center|right), description.', Heading),
  def('Paragraph', 'text', 'Body text. Props: text, muted, size (sm|md), align.', Paragraph),
  def('Badge', 'text', 'Status chip. Props: text, variant (neutral|accent|info|success|warning|danger), icon.', Badge),
  def('Chip', 'text', 'Alias of Badge.', Badge),
  def('Link', 'text', 'Text link. Props: text, href (external URLs open in a browser; without href it dispatches click).', Link),
  // form
  def('Form', 'form', 'Groups inputs; submitting dispatches "submit" with all values by name. Props: title, description, columns (1|2), submitText (adds a submit button when no Button child). Children: inputs, then Buttons (primary = submit, others = click).', Form),
  def('Input', 'form', 'Text field. Props: label, name, type (text|email|password|number|tel|url|date|time), placeholder, value, description, icon, required, readOnly, disabled.', Input),
  def('Textarea', 'form', 'Multi-line text. Props: label, name, placeholder, value, rows, description, required.', Textarea),
  def('Select', 'form', 'Dropdown choice. Props: label, name, options (string[] or {label,value}[]), value, placeholder, description, required. Outside a Form it dispatches "change".', Select),
  def('Checkbox', 'form', 'Checkbox. Props: label, name, defaultChecked, description.', Checkbox),
  def('RadioGroup', 'form', 'One-of-many visible choices. Props: label, name, options (string[] or {label,value,description}[]), value, orientation (vertical|horizontal).', RadioGroup),
  def('Radio', 'form', 'Single radio option (prefer RadioGroup). Props: label, name, value, defaultChecked.', Radio),
  def('Switch', 'form', 'On/off toggle for settings. Props: label, name, defaultChecked, description.', Switch),
  def('SearchField', 'form', 'Search box; Enter dispatches "search" {name, query}. Props: name, placeholder, value, label.', SearchField),
  def('Button', 'form', 'Action button; dispatches "click". Inside a Form the primary Button submits it; a Button outside a Form never submits one. Props: text, variant (primary|secondary|tertiary|outline|ghost|danger; default primary), icon, size (sm|md|lg), fullWidth, confirm (question shown in a dialog before acting), disabled.', Button),
  // data
  def('Table', 'data', 'Data table (stacks into cards on phones). Props: title, columns (string[]), rows (array of arrays or objects keyed by column), rowAction (rows dispatch "select" with the row), emptyText. A cell may be {text, variant} to render a status chip.', Table),
  def('List', 'data', 'App-style list rows. Props: items (string[] or {id,title,description,icon,avatar,meta,badge,badgeVariant}[]), ordered. Items with an id dispatch "select".', List),
  def('StatCard', 'data', 'KPI tile. Props: label, value, delta (e.g. "+12%"), deltaGood (false = red), icon, description.', StatCard),
  def('KeyValue', 'data', 'Label/value pairs for detail pages. Props: items ({label,value}[] or an object), columns (1|2).', KeyValue),
  def('Avatar', 'data', 'Person/entity avatar with optional name line. Props: name, src, description, size (sm|md|lg).', Avatar),
  def('EmptyState', 'data', 'Nothing-here-yet placeholder. Props: icon, title, description. Children: one or two action Buttons.', EmptyState),
  // feedback
  def('Alert', 'feedback', 'Inline status message. Props: title, message, variant (info|success|warning|danger).', Alert),
  def('Progress', 'feedback', 'Progress bar. Props: value (0-100), label, showValue.', Progress),
  def('Spinner', 'feedback', 'Loading indicator. Props: text.', Spinner),
  def('Skeleton', 'feedback', 'Loading placeholder lines. Props: lines.', Skeleton),
  // navigation
  def('Breadcrumbs', 'navigation', 'Location trail on detail/form pages. Props: items ({id,label}[]; earlier items dispatch "navigate" with page = id).', Breadcrumbs),
  def('Pagination', 'navigation', 'Page switcher under long tables. Props: page, total. Dispatches "page" {page}.', Pagination),
  // media
  def('Image', 'media', 'Image with graceful fallback. Props: src, alt, width, aspect (e.g. "16/9"), rounded.', Image)
]

export const registry: Record<string, ComponentDef> = Object.fromEntries(
  COMPONENT_DEFS.map((d) => [d.name, d])
)

/** Names models borrow from other UI kits → the registered component. */
const ALIASES: Record<string, string> = {
  text: 'Paragraph',
  title: 'Heading',
  header: 'PageHeader',
  textfield: 'Input',
  textinput: 'Input',
  dropdown: 'Select',
  toggle: 'Switch',
  datatable: 'Table',
  container: 'Stack',
  box: 'Stack',
  group: 'Stack',
  row: 'Stack',
  grid: 'Columns',
  kpi: 'StatCard',
  metric: 'StatCard',
  stat: 'StatCard',
  banner: 'Alert',
  callout: 'Alert',
  progressbar: 'Progress',
  tag: 'Badge',
  separator: 'Divider',
  breadcrumb: 'Breadcrumbs',
  searchbar: 'SearchField',
  search: 'SearchField'
}

const byKey = new Map(COMPONENT_DEFS.map((d) => [d.name.toLowerCase(), d]))

/** Exact name first; then case/punctuation slips ("text-area") and common aliases. */
export function getComponent(name: string): ComponentDef | undefined {
  if (registry[name]) return registry[name]
  const key = String(name).toLowerCase().replace(/[^a-z]/g, '')
  return byKey.get(key) ?? registry[ALIASES[key]]
}

export const componentNames: string[] = COMPONENT_DEFS.map((d) => d.name)

function renameNodes(nodes: CardNode[]): CardNode[] {
  let changed = false
  const out = nodes.map((n) => {
    const name = getComponent(n.name)?.name ?? n.name
    const children = n.children && renameNodes(n.children)
    if (name === n.name && children === n.children) return n
    changed = true
    return { ...n, name, ...(children ? { children } : {}) }
  })
  return changed ? out : nodes
}

/**
 * Rewrite near-miss component names ("TextField", "page-header") to their
 * registered names, so code that branches on `node.name` (Form buttons,
 * layout rules) sees the same names the renderer resolves. Unchanged specs
 * come back as the same object.
 */
export function withRegistryNames(spec: UiSpec): UiSpec {
  let changed = false
  const pages = spec.pages.map((p) => {
    const layout = renameNodes(p.layout)
    if (layout === p.layout) return p
    changed = true
    return { ...p, layout }
  })
  return changed ? { ...spec, pages } : spec
}
