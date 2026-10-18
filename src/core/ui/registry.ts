import type { ComponentType } from 'react'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Columns,
  Divider,
  Form,
  Heading,
  Image,
  Input,
  Link,
  List,
  Paragraph,
  Progress,
  Radio,
  Section,
  Select,
  Spinner,
  StatCard,
  Switch,
  Table,
  Textarea
} from './components'

export interface ComponentDef {
  /** The registered, unique component name used by .domino/LLM specs. */
  name: string
  category: 'layout' | 'text' | 'form' | 'data' | 'feedback' | 'media'
  /** Human-readable description fed to the LLM system prompt. */
  description: string
  component: ComponentType<Record<string, unknown>>
}

function def(
  name: string,
  category: ComponentDef['category'],
  description: string,
  component: ComponentType<Record<string, unknown>>
): ComponentDef {
  return { name, category, description, component }
}

export const COMPONENT_DEFS: ComponentDef[] = [
  // layout
  def('Section', 'layout', 'Titled container grouping related content. Props: title. Children allowed.', Section),
  def('Columns', 'layout', 'Multi-column layout for children. Props: cols (2|3|4). Children allowed.', Columns),
  def('Divider', 'layout', 'Horizontal rule separating content.', Divider),
  // text
  def('Heading', 'text', 'Title text. Props: text, level (1-6), align (left|center|right).', Heading),
  def('Paragraph', 'text', 'Body text. Props: text, muted.', Paragraph),
  def('Badge', 'text', 'Small status pill. Props: text, variant (neutral|success|warning|danger|info).', Badge),
  def('Link', 'text', 'Clickable link. Props: text, href.', Link),
  // form
  def('Form', 'form', 'Wrapper that groups inputs; submitting dispatches an action. Children allowed.', Form),
  def('Input', 'form', 'Text input. Props: label, placeholder, type, name, value, readOnly.', Input),
  def('Textarea', 'form', 'Multi-line input. Props: label, placeholder, name, rows.', Textarea),
  def('Select', 'form', 'Dropdown. Props: label, name, options (string[] or {label,value}[]).', Select),
  def('Checkbox', 'form', 'Checkbox. Props: label, name, defaultChecked.', Checkbox),
  def('Radio', 'form', 'Radio option (group by name). Props: label, name, value, defaultChecked.', Radio),
  def('Switch', 'form', 'Toggle switch. Props: label, name, defaultChecked.', Switch),
  def('Button', 'form', 'Clickable button that dispatches a click action. Props: text, variant (primary|secondary|danger|ghost).', Button),
  // data
  def('Table', 'data', 'Data table. Props: columns (string[]), rows (array of arrays).', Table),
  def('List', 'data', 'Bulleted/numbered list. Props: items (array), ordered.', List),
  def('StatCard', 'data', 'Key metric display. Props: label, value, delta, deltaGood.', StatCard),
  // feedback
  def('Alert', 'feedback', 'Inline message. Props: message, variant (info|success|warning|danger).', Alert),
  def('Progress', 'feedback', 'Progress bar. Props: value (0-100), label.', Progress),
  def('Spinner', 'feedback', 'Loading indicator. Props: text.', Spinner),
  // media
  def('Image', 'media', 'Image with fallback. Props: src, alt, width.', Image)
]

export const registry: Record<string, ComponentDef> = Object.fromEntries(
  COMPONENT_DEFS.map((d) => [d.name, d])
)

export function getComponent(name: string): ComponentDef | undefined {
  return registry[name]
}

export const componentNames: string[] = COMPONENT_DEFS.map((d) => d.name)
