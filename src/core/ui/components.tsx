import { createPortal } from 'react-dom'
import {
  Children,
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from 'react'
import {
  Accordion as HAccordion,
  Alert as HAlert,
  AlertDialog,
  Avatar as HAvatar,
  Breadcrumbs as HBreadcrumbs,
  Button as HButton,
  Card as HCard,
  Checkbox as HCheckbox,
  Chip,
  CloseButton,
  Description,
  FieldError,
  Form as HForm,
  Input as HInput,
  InputGroup,
  Label,
  Link as HLink,
  ListBox,
  Pagination as HPagination,
  ProgressBar,
  Radio as HRadio,
  RadioGroup as HRadioGroup,
  SearchField as HSearchField,
  Select as HSelect,
  Separator,
  Skeleton as HSkeleton,
  Spinner as HSpinner,
  Switch as HSwitch,
  Table as HTable,
  Tabs as HTabs,
  TextArea,
  TextField
} from '@heroui/react'
import type { CardNode } from '../spec'
import { useCell, useLayout, useRuntime } from './context'
import { Icon } from './icons'

export { RuntimeContext, useRuntime, type Runtime } from './context'

/**
 * The domino component registry, rendered with HeroUI v3.
 *
 * Props come from LLM output, so every component coerces defensively:
 * strings may be numbers, arrays may be missing, enums may be misspelled.
 * Interaction goes through `useRuntime().dispatch` — components never
 * navigate or fetch on their own.
 */

interface NodeProps {
  nodeId?: string
  nodeName?: string
  children?: ReactNode
  /** Spec of the children (labels for Tabs/Accordion, Form layout). */
  childNodes?: CardNode[]
}

/** True inside a Card-like surface: nested blocks drop their own card chrome. */
const SurfaceContext = createContext(false)
/** Set inside a Form: buttons submit, fields stay quiet until submit. */
const FormContext = createContext(false)

const useSize = (): 'sm' | 'md' => (useLayout().density === 'compact' ? 'sm' : 'md')
/** Fields inside cards use HeroUI's flat "secondary" look. */
const useFieldVariant = (): 'primary' | 'secondary' =>
  useContext(SurfaceContext) ? 'secondary' : 'primary'

const text = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
const truthy = (v: unknown): boolean => v === true || v === 'true' || v === 1

type Tone = 'default' | 'accent' | 'success' | 'warning' | 'danger'
/** Map the spec's status vocabulary onto HeroUI colors. */
function tone(variant: unknown): Tone {
  switch (String(variant ?? '').toLowerCase()) {
    case 'accent':
    case 'info':
    case 'primary':
      return 'accent'
    case 'success':
    case 'ok':
      return 'success'
    case 'warning':
    case 'warn':
      return 'warning'
    case 'danger':
    case 'error':
      return 'danger'
    default:
      return 'default'
  }
}

interface Option {
  label: string
  value: string
  description?: string
}
function toOptions(options: unknown): Option[] {
  if (!Array.isArray(options)) return []
  return options.flatMap((o): Option[] => {
    if (o === null || o === undefined) return []
    if (typeof o !== 'object') return [{ label: String(o), value: String(o) }]
    const rec = o as Record<string, unknown>
    const value = text(rec.value ?? rec.id ?? rec.label)
    return [
      {
        label: text(rec.label ?? rec.value),
        value,
        description: rec.description ? text(rec.description) : undefined
      }
    ]
  })
}

/** Wrap content in a card unless it already sits on a surface. */
function Surface({ children, className }: { children: ReactNode; className?: string }) {
  const nested = useContext(SurfaceContext)
  if (nested) return <>{children}</>
  return (
    <HCard className={`h-full ${className ?? ''}`}>
      <SurfaceContext.Provider value>{children}</SurfaceContext.Provider>
    </HCard>
  )
}

function IconBadge({ name, tone: t = 'accent' }: { name: unknown; tone?: Tone }) {
  const colors: Record<Tone, string> = {
    default: 'bg-default text-default-foreground',
    accent: 'bg-accent-soft text-accent-soft-foreground',
    success: 'bg-success-soft text-success-soft-foreground',
    warning: 'bg-warning-soft text-warning-soft-foreground',
    danger: 'bg-danger-soft text-danger-soft-foreground'
  }
  if (!name) return null
  return (
    <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${colors[t]}`}>
      <Icon name={name} size={18} />
    </span>
  )
}

/* --------------------------------- Layout --------------------------------- */

export function PageHeader({
  title,
  description,
  icon,
  badge,
  badgeVariant,
  children,
  childNodes
}: NodeProps & {
  title?: string
  description?: string
  icon?: string
  badge?: string
  badgeVariant?: string
}) {
  const { bp } = useLayout()
  const actions = Children.toArray(children)
  // Phones: the page's primary action floats above the tab bar (Material FAB);
  // the rest stay as compact buttons under the title.
  const fabIndex =
    bp === 'sm'
      ? (childNodes ?? []).findIndex(
          (n) => n.name === 'Button' && ['primary', undefined].includes(n.props?.variant as string)
        )
      : -1
  const fab = fabIndex >= 0 ? actions[fabIndex] : null
  const inline = fab ? actions.filter((_, i) => i !== fabIndex) : actions
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-1">
      <div className="flex min-w-0 items-center gap-3">
        <IconBadge name={icon} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1
              className={`${bp === 'sm' ? 'text-xl' : 'text-2xl'} font-semibold tracking-tight text-foreground`}
            >
              {text(title)}
            </h1>
            {badge ? (
              <Chip size="sm" variant="soft" color={tone(badgeVariant)}>
                {text(badge)}
              </Chip>
            ) : null}
          </div>
          {description ? <p className="mt-0.5 text-sm text-muted">{text(description)}</p> : null}
        </div>
      </div>
      {inline.length ? (
        <div className={`flex flex-wrap items-center gap-2 ${bp === 'sm' ? 'w-full' : ''}`}>
          {inline}
        </div>
      ) : null}
      {fab && typeof document !== 'undefined'
        ? createPortal(<div className="fab-slot">{fab}</div>, document.body)
        : null}
    </header>
  )
}

export function Card({
  title,
  description,
  icon,
  children
}: NodeProps & { title?: string; description?: string; icon?: string }) {
  const nested = useContext(SurfaceContext)
  const head =
    title || description ? (
      <HCard.Header>
        <div className="flex items-center gap-2">
          {icon ? <Icon name={icon} size={16} className="text-muted" /> : null}
          {title ? <HCard.Title>{text(title)}</HCard.Title> : null}
        </div>
        {description ? <HCard.Description>{text(description)}</HCard.Description> : null}
      </HCard.Header>
    ) : null
  return (
    <HCard variant={nested ? 'secondary' : 'default'} className="h-full">
      {head}
      <HCard.Content className="flex flex-col gap-3">
        <SurfaceContext.Provider value>{children}</SurfaceContext.Provider>
      </HCard.Content>
    </HCard>
  )
}

export function Columns({ children, cols = 2 }: NodeProps & { cols?: number }) {
  const { bp } = useLayout()
  const want = Math.max(1, Math.min(4, Number(cols) || 2))
  const n = bp === 'sm' ? 1 : bp === 'md' ? Math.min(want, 2) : want
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
      {children}
    </div>
  )
}

export function Stack({
  children,
  direction = 'column',
  align,
  gap = 'md'
}: NodeProps & { direction?: string; align?: string; gap?: string }) {
  const row = direction === 'row' || direction === 'horizontal'
  const gaps: Record<string, string> = { sm: 'gap-2', md: 'gap-3', lg: 'gap-5' }
  const justify: Record<string, string> = {
    start: 'justify-start',
    center: 'justify-center',
    end: 'justify-end',
    between: 'justify-between'
  }
  const items: Record<string, string> = {
    start: 'items-start',
    center: 'items-center',
    end: 'items-end',
    between: 'items-stretch'
  }
  const alignment = row
    ? `items-center ${justify[String(align)] ?? ''}`
    : (items[String(align)] ?? '')
  return (
    <div
      className={`flex ${row ? 'flex-row flex-wrap' : 'flex-col'} ${gaps[gap] ?? 'gap-3'} ${alignment}`}
    >
      {children}
    </div>
  )
}

/** Panel label: explicit `tabs[i]`, else the child's title/label. */
function panelLabel(labels: unknown, child: CardNode | undefined, i: number): string {
  if (Array.isArray(labels) && labels[i] !== undefined) {
    const l = labels[i]
    return typeof l === 'object' && l
      ? text((l as Record<string, unknown>).label ?? (l as Record<string, unknown>).title)
      : text(l)
  }
  const p = child?.props ?? {}
  return text(p.title ?? p.label ?? child?.name ?? `Tab ${i + 1}`)
}

export function Tabs({ tabs, childNodes, children, nodeId }: NodeProps & { tabs?: unknown }) {
  const panels = Children.toArray(children)
  const base = nodeId ?? 'tabs'
  if (panels.length === 0) return null
  return (
    <HTabs className="w-full" variant="secondary" align="start">
      <HTabs.ListContainer>
        <HTabs.List aria-label={panelLabel(tabs, childNodes?.[0], 0)}>
          {panels.map((_, i) => (
            <HTabs.Tab key={i} id={`${base}-${i}`}>
              {panelLabel(tabs, childNodes?.[i], i)}
              <HTabs.Indicator />
            </HTabs.Tab>
          ))}
        </HTabs.List>
      </HTabs.ListContainer>
      {panels.map((panel, i) => (
        <HTabs.Panel key={i} id={`${base}-${i}`} className="pt-4">
          {panel}
        </HTabs.Panel>
      ))}
    </HTabs>
  )
}

export function Accordion({
  items,
  multiple,
  childNodes,
  children,
  nodeId
}: NodeProps & { items?: unknown; multiple?: boolean }) {
  const base = nodeId ?? 'acc'
  const fromItems = Array.isArray(items)
    ? items.map((it) => {
        const rec = (typeof it === 'object' && it ? it : { title: it }) as Record<string, unknown>
        return {
          title: text(rec.title ?? rec.label),
          body: <p className="text-sm text-muted">{text(rec.content ?? rec.text)}</p>
        }
      })
    : []
  const fromChildren = Children.toArray(children).map((child, i) => ({
    title: panelLabel(undefined, childNodes?.[i], i),
    body: child
  }))
  const entries = fromItems.length ? fromItems : fromChildren
  const nested = useContext(SurfaceContext)
  return (
    <HAccordion allowsMultipleExpanded={truthy(multiple)} variant={nested ? 'default' : 'surface'}>
      {entries.map((e, i) => (
        <HAccordion.Item key={i} id={`${base}-${i}`}>
          <HAccordion.Heading>
            <HAccordion.Trigger>
              {e.title}
              <HAccordion.Indicator />
            </HAccordion.Trigger>
          </HAccordion.Heading>
          <HAccordion.Panel>
            <HAccordion.Body>{e.body}</HAccordion.Body>
          </HAccordion.Panel>
        </HAccordion.Item>
      ))}
    </HAccordion>
  )
}

export function Divider() {
  return <Separator className="my-1" />
}

/* ---------------------------------- Text ---------------------------------- */

const HEADING_SIZE = ['', 'text-3xl', 'text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm']

export function Heading({
  text: value,
  level = 2,
  align,
  description
}: {
  text?: string
  level?: number
  align?: 'left' | 'center' | 'right'
  description?: string
}) {
  const lvl = Math.max(1, Math.min(6, Number(level) || 2)) as 1 | 2 | 3 | 4 | 5 | 6
  const Tag = `h${lvl}` as 'h2'
  return (
    <div style={{ textAlign: align ?? 'left' }}>
      <Tag className={`${HEADING_SIZE[lvl]} font-semibold tracking-tight text-foreground`}>
        {text(value)}
      </Tag>
      {description ? <p className="mt-1 text-sm text-muted">{text(description)}</p> : null}
    </div>
  )
}

export function Paragraph({
  text: value,
  muted,
  size,
  align
}: {
  text?: string
  muted?: boolean
  size?: string
  align?: string
}) {
  return (
    <p
      className={`whitespace-pre-line ${size === 'sm' ? 'text-sm' : 'text-[15px] leading-relaxed'} ${truthy(muted) ? 'text-muted' : 'text-foreground'}`}
      style={align ? { textAlign: align as 'left' } : undefined}
    >
      {text(value)}
    </p>
  )
}

export function Badge({
  text: value,
  variant,
  icon
}: {
  text?: string
  variant?: string
  icon?: string
}) {
  return (
    <Chip size="sm" variant="soft" color={tone(variant)}>
      {icon ? <Icon name={icon} size={12} /> : null}
      <Chip.Label>{text(value)}</Chip.Label>
    </Chip>
  )
}

export function Link({
  text: value,
  href,
  nodeId,
  nodeName
}: NodeProps & { text?: string; href?: string }) {
  const runtime = useRuntime()
  const external = typeof href === 'string' && /^(https?:|mailto:|tel:)/i.test(href)
  if (external) {
    return (
      <HLink href={href} target="_blank" rel="noreferrer" className="text-accent">
        {text(value)}
        <HLink.Icon />
      </HLink>
    )
  }
  return (
    <HLink
      className="text-accent"
      onPress={() =>
        runtime.dispatch({ event: 'click', nodeId, nodeName, data: href ? { href } : undefined })
      }
    >
      {text(value)}
    </HLink>
  )
}

/* ---------------------------------- Form ---------------------------------- */

/** Children that span both columns of a two-column form. */
const FULL_ROW = new Set([
  'Textarea',
  'Switch',
  'Checkbox',
  'RadioGroup',
  'Alert',
  'Paragraph',
  'Heading',
  'Divider',
  'Columns',
  'Card',
  'Table',
  'List',
  'KeyValue',
  'Stack'
])

export function Form({
  title,
  description,
  columns,
  submitText,
  children,
  childNodes,
  nodeId,
  nodeName
}: NodeProps & { title?: string; description?: string; columns?: number; submitText?: string }) {
  const runtime = useRuntime()
  // Only a form that owns its card gets the sticky phone action bar (it bleeds to the card edge).
  const ownsCard = !useContext(SurfaceContext)
  const { bp } = useLayout()
  const size = useSize()
  const kids = Children.toArray(children)
  const specs = childNodes ?? []
  const isButton = (i: number): boolean => specs[i]?.name === 'Button'
  const fields = kids.filter((_, i) => !isButton(i))
  const fieldSpecs = specs.filter((_, i) => !isButton(i))
  const buttons = kids.filter((_, i) => isButton(i))
  const twoCol = Number(columns) === 2 && bp !== 'sm'
  const hasSubmit = specs.some((s) => s.name === 'Button' && buttonSubmits(s.props, true))
  // A form that collects data must offer a submit action even when the model
  // sent only a Cancel (or nothing at all) — render the missing primary in,
  // labeled by submitText or a default. Also covers Cancel + submitText,
  // which the old "only when no buttons" rule silently dropped.
  const autoSubmit =
    !hasSubmit && (fields.length > 0 || (!buttons.length && Boolean(submitText)))

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const data: Record<string, unknown> = {}
    const fd = new FormData(e.currentTarget)
    for (const key of new Set(fd.keys())) {
      const all = fd.getAll(key)
      data[key] = all.length > 1 ? all.map(String) : String(all[0])
    }
    // Unchecked checkboxes/switches are absent from FormData → record false.
    for (const el of e.currentTarget.querySelectorAll<HTMLInputElement>(
      'input[type=checkbox][name]'
    )) {
      if (!(el.name in data)) data[el.name] = false
      else if (data[el.name] === 'on') data[el.name] = true
    }
    runtime.dispatch({ event: 'submit', data, nodeName, nodeId })
  }

  const body = (
    <HForm onSubmit={handleSubmit} className="flex flex-col gap-5">
      {title || description ? (
        <div>
          {title ? <h2 className="text-lg font-semibold tracking-tight">{text(title)}</h2> : null}
          {description ? <p className="mt-0.5 text-sm text-muted">{text(description)}</p> : null}
        </div>
      ) : null}
      <div className={twoCol ? 'grid grid-cols-2 gap-x-4 gap-y-4' : 'flex flex-col gap-4'}>
        {fields.map((field, i) => (
          <div
            // Stable key: positional keys let React reuse an uncontrolled input
            // across field changes, so typed values stick to the wrong field.
            key={fieldSpecs[i]?.id ?? i}
            className={twoCol && FULL_ROW.has(fieldSpecs[i]?.name ?? '') ? 'col-span-2' : 'min-w-0'}
          >
            {field}
          </div>
        ))}
      </div>
      {buttons.length || autoSubmit || submitText ? (
        <div
          className={
            bp === 'sm'
              ? `flex gap-2 ${buttons.length > 2 ? 'flex-col-reverse [&>*]:w-full' : '[&>*]:flex-1'} ${ownsCard ? 'form-actions-sticky' : ''}`
              : 'flex flex-wrap items-center justify-end gap-2'
          }
        >
          {buttons}
          {autoSubmit ? (
            <HButton type="submit" size={size} fullWidth={bp === 'sm'}>
              {text(submitText || '저장')}
            </HButton>
          ) : null}
        </div>
      ) : null}
    </HForm>
  )

  return (
    <FormContext.Provider value>
      <Surface className="p-5">{body}</Surface>
    </FormContext.Provider>
  )
}

interface FieldProps {
  label?: string
  name?: string
  placeholder?: string
  value?: unknown
  description?: string
  required?: boolean
  readOnly?: boolean
  disabled?: boolean
}

/**
 * The visible label, repeated as aria-label on the focusable element itself.
 * Screen readers still name the control from its <Label> (aria-labelledby
 * outranks aria-label; wrapped toggles read the same text), but DOM-heuristic
 * readers such as LLM browser agents rank the placeholder — or a checkbox's
 * value "on" — above an associated or wrapping <label>.
 */
const controlLabel = (label: unknown): string | undefined => (label ? text(label) : undefined)

function FieldHelp({ description }: { description?: string }) {
  return (
    <>
      {description ? <Description>{text(description)}</Description> : null}
      <FieldError />
    </>
  )
}

const INPUT_TYPES = new Set([
  'text',
  'email',
  'password',
  'number',
  'tel',
  'url',
  'search',
  'date',
  'time',
  'datetime-local',
  'month'
])

export function Input({
  label,
  name,
  type,
  placeholder,
  value,
  description,
  required,
  readOnly,
  disabled,
  icon
}: FieldProps & { type?: string; icon?: string }) {
  const variant = useFieldVariant()
  const t = INPUT_TYPES.has(String(type)) ? String(type) : 'text'
  return (
    <TextField
      name={name}
      type={t}
      defaultValue={value === undefined || value === null ? undefined : text(value)}
      isRequired={truthy(required)}
      isReadOnly={truthy(readOnly)}
      isDisabled={truthy(disabled)}
      aria-label={label ? undefined : text(placeholder || name || 'input')}
      variant={variant}
      fullWidth
    >
      {label ? <Label>{text(label)}</Label> : null}
      {icon ? (
        <InputGroup fullWidth variant={variant}>
          <InputGroup.Prefix>
            <Icon name={icon} size={16} className="text-muted" />
          </InputGroup.Prefix>
          <InputGroup.Input placeholder={placeholder} aria-label={controlLabel(label)} />
        </InputGroup>
      ) : (
        <HInput placeholder={placeholder} aria-label={controlLabel(label)} />
      )}
      <FieldHelp description={description} />
    </TextField>
  )
}

export function Textarea({
  label,
  name,
  placeholder,
  value,
  rows = 4,
  description,
  required,
  disabled
}: FieldProps & { rows?: number }) {
  const variant = useFieldVariant()
  return (
    <TextField
      name={name}
      defaultValue={value === undefined || value === null ? undefined : text(value)}
      isRequired={truthy(required)}
      isDisabled={truthy(disabled)}
      aria-label={label ? undefined : text(placeholder || name || 'text')}
      variant={variant}
      fullWidth
    >
      {label ? <Label>{text(label)}</Label> : null}
      <TextArea
        rows={Math.max(2, Math.min(20, Number(rows) || 4))}
        placeholder={placeholder}
        aria-label={controlLabel(label)}
      />
      <FieldHelp description={description} />
    </TextField>
  )
}

/** Outside a Form, choice controls report changes straight to the agent (filters, toggles). */
function useChangeDispatch(nodeId?: string, nodeName?: string, name?: string) {
  const runtime = useRuntime()
  const inForm = useContext(FormContext)
  return inForm
    ? undefined
    : (value: unknown) =>
        runtime.dispatch({
          event: 'change',
          nodeId,
          nodeName,
          data: { name: name ?? nodeId, value }
        })
}

export function Select({
  label,
  name,
  options,
  value,
  placeholder,
  description,
  required,
  disabled,
  nodeId,
  nodeName
}: NodeProps & FieldProps & { options?: unknown }) {
  const opts = toOptions(options)
  const onChange = useChangeDispatch(nodeId, nodeName, name)
  const variant = useFieldVariant()
  const initial = value === undefined || value === null ? undefined : text(value)
  // Accept a label as the value too ("Asia/Seoul" vs. {label: "Seoul", value: "Asia/Seoul"}).
  const defaultKey =
    opts.find((o) => o.value === initial)?.value ?? opts.find((o) => o.label === initial)?.value
  return (
    <HSelect
      name={name}
      placeholder={placeholder ?? (opts[0] ? undefined : '—')}
      defaultValue={defaultKey}
      isRequired={truthy(required)}
      isDisabled={truthy(disabled)}
      aria-label={label ? undefined : text(placeholder || name || 'select')}
      variant={variant}
      onChange={onChange ? (key) => onChange(key === null ? null : String(key)) : undefined}
      fullWidth
    >
      {label ? <Label>{text(label)}</Label> : null}
      <HSelect.Trigger aria-label={controlLabel(label)}>
        <HSelect.Value />
        <HSelect.Indicator />
      </HSelect.Trigger>
      <FieldHelp description={description} />
      <HSelect.Popover>
        <ListBox>
          {opts.map((o) => (
            <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </HSelect.Popover>
    </HSelect>
  )
}

export function Checkbox({
  label,
  name,
  defaultChecked,
  checked,
  description,
  disabled,
  nodeId,
  nodeName
}: NodeProps & FieldProps & { defaultChecked?: boolean; checked?: boolean }) {
  const onChange = useChangeDispatch(nodeId, nodeName, name)
  const variant = useFieldVariant()
  return (
    <HCheckbox
      name={name}
      defaultSelected={truthy(defaultChecked ?? checked)}
      isDisabled={truthy(disabled)}
      variant={variant}
      aria-label={controlLabel(label) ?? text(name)}
      onChange={onChange}
    >
      <HCheckbox.Content>
        <HCheckbox.Control>
          <HCheckbox.Indicator />
        </HCheckbox.Control>
        {text(label)}
      </HCheckbox.Content>
      {description ? <Description>{text(description)}</Description> : null}
    </HCheckbox>
  )
}

function RadioOption({ option }: { option: Option }) {
  return (
    <HRadio value={option.value} aria-label={controlLabel(option.label)}>
      <HRadio.Content>
        <HRadio.Control>
          <HRadio.Indicator />
        </HRadio.Control>
        {option.label}
      </HRadio.Content>
      {option.description ? <Description>{option.description}</Description> : null}
    </HRadio>
  )
}

export function RadioGroup({
  label,
  name,
  options,
  value,
  orientation,
  description,
  required,
  nodeId,
  nodeName
}: NodeProps & FieldProps & { options?: unknown; orientation?: string }) {
  const opts = toOptions(options)
  const onChange = useChangeDispatch(nodeId, nodeName, name)
  const { bp } = useLayout()
  const variant = useFieldVariant()
  const initial = value === undefined || value === null ? undefined : text(value)
  return (
    <HRadioGroup
      name={name}
      defaultValue={opts.find((o) => o.value === initial || o.label === initial)?.value}
      orientation={orientation === 'horizontal' && bp !== 'sm' ? 'horizontal' : 'vertical'}
      isRequired={truthy(required)}
      aria-label={label ? undefined : text(name)}
      variant={variant}
      onChange={onChange}
    >
      {label ? <Label>{text(label)}</Label> : null}
      {description ? <Description>{text(description)}</Description> : null}
      {opts.map((o) => (
        <RadioOption key={o.value} option={o} />
      ))}
      <FieldError />
    </HRadioGroup>
  )
}

/** Legacy single radio — a one-option group (prefer RadioGroup). */
export function Radio({
  label,
  name,
  value,
  defaultChecked
}: {
  label?: string
  name?: string
  value?: string
  defaultChecked?: boolean
}) {
  const v = text(value ?? label)
  return (
    <HRadioGroup
      name={name}
      defaultValue={truthy(defaultChecked) ? v : undefined}
      aria-label={text(label)}
    >
      <RadioOption option={{ label: text(label), value: v }} />
    </HRadioGroup>
  )
}

/** Settings-row switch: label (and help) on the left, toggle on the right. */
export function Switch({
  label,
  name,
  defaultChecked,
  checked,
  description,
  disabled,
  nodeId,
  nodeName
}: NodeProps & FieldProps & { defaultChecked?: boolean; checked?: boolean }) {
  const onChange = useChangeDispatch(nodeId, nodeName, name)
  // The help text sits inside the <label>; name the switch by its label alone and
  // announce the help as its description.
  const descriptionId = useId()
  return (
    <HSwitch
      name={name}
      defaultSelected={truthy(defaultChecked ?? checked)}
      isDisabled={truthy(disabled)}
      aria-label={controlLabel(label) ?? text(name)}
      aria-describedby={description ? descriptionId : undefined}
      onChange={onChange}
      className="w-full"
    >
      <HSwitch.Content className="flex w-full items-center justify-between gap-4">
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-medium text-foreground">{text(label)}</span>
          {description ? (
            <span id={descriptionId} className="text-xs text-muted">
              {text(description)}
            </span>
          ) : null}
        </span>
        <HSwitch.Control>
          <HSwitch.Thumb />
        </HSwitch.Control>
      </HSwitch.Content>
    </HSwitch>
  )
}

export function SearchField({
  name,
  placeholder,
  value,
  label,
  nodeId,
  nodeName
}: NodeProps & FieldProps) {
  const runtime = useRuntime()
  const variant = useFieldVariant()
  const key = name ?? nodeId ?? 'q'
  return (
    <HSearchField
      name={key}
      defaultValue={value === undefined || value === null ? undefined : text(value)}
      aria-label={label ? undefined : text(placeholder || 'Search')}
      variant={variant}
      onSubmit={(query) =>
        runtime.dispatch({ event: 'search', nodeId, nodeName, data: { name: key, query } })
      }
      fullWidth
    >
      {label ? <Label>{text(label)}</Label> : null}
      <HSearchField.Group>
        <HSearchField.SearchIcon />
        <HSearchField.Input
          placeholder={placeholder ?? 'Search…'}
          aria-label={controlLabel(label)}
        />
        <HSearchField.ClearButton />
      </HSearchField.Group>
    </HSearchField>
  )
}

const BUTTON_VARIANTS = new Set([
  'primary',
  'secondary',
  'tertiary',
  'outline',
  'ghost',
  'danger',
  'danger-soft'
])

/**
 * Whether a Button acts as its form's submit: an explicit type="submit", or
 * the default/primary variant inside a form. One definition — the Button
 * component and Form's missing-submit repair both consult it.
 */
export function buttonSubmits(
  props: { type?: unknown; variant?: unknown } | null | undefined,
  inForm: boolean
): boolean {
  const type = props?.type
  const variant = props?.variant
  if (type === 'submit') return true
  if (!inForm || type === 'button') return false
  const v = BUTTON_VARIANTS.has(String(variant))
    ? String(variant)
    : variant === 'link'
      ? 'ghost'
      : 'primary'
  return v === 'primary'
}

const hasHangul = (s: string): boolean => /[가-힣]/.test(s)

export function Button({
  text: label,
  variant,
  icon,
  size,
  fullWidth,
  type,
  confirm,
  confirmText,
  cancelText,
  disabled,
  nodeName,
  nodeId
}: NodeProps & {
  text?: string
  variant?: string
  icon?: string
  size?: string
  fullWidth?: boolean
  type?: 'button' | 'submit'
  confirm?: string
  confirmText?: string
  cancelText?: string
  disabled?: boolean
}) {
  const runtime = useRuntime()
  const inForm = useContext(FormContext)
  const cell = useCell()
  const density = useSize()
  const ref = useRef<HTMLButtonElement>(null)
  const v = (
    BUTTON_VARIANTS.has(String(variant)) ? variant : variant === 'link' ? 'ghost' : 'primary'
  ) as 'primary' | 'secondary' | 'tertiary' | 'outline' | 'ghost' | 'danger' | 'danger-soft'
  // Inside a form the primary button submits (its submit event carries the
  // data); secondary actions like "Cancel" stay plain clicks.
  const submits = buttonSubmits({ type, variant }, inForm)
  const s = size === 'sm' || size === 'lg' ? size : density
  const caption = text(label || 'Button')

  const act = (): void => {
    if (submits) ref.current?.form?.requestSubmit()
    else runtime.dispatch({ event: 'click', nodeName, nodeId })
  }

  const content = (
    <>
      {icon ? <Icon name={icon} size={16} /> : null}
      {caption}
    </>
  )
  const common = {
    ref,
    variant: v,
    size: s,
    fullWidth: truthy(fullWidth) || cell.fill,
    isDisabled: truthy(disabled)
  } as const

  if (confirm) {
    const ko = hasHangul(String(confirm) + caption)
    return (
      <AlertDialog>
        <HButton {...common}>{content}</HButton>
        <AlertDialog.Backdrop>
          <AlertDialog.Container size="sm">
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Icon status={v.startsWith('danger') ? 'danger' : 'accent'} />
                <AlertDialog.Heading>{text(confirm)}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Footer>
                <HButton slot="close" variant="tertiary">
                  {cancelText ? text(cancelText) : ko ? '취소' : 'Cancel'}
                </HButton>
                <HButton
                  slot="close"
                  variant={v.startsWith('danger') ? 'danger' : 'primary'}
                  onPress={act}
                >
                  {confirmText ? text(confirmText) : caption}
                </HButton>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    )
  }

  return (
    <HButton {...common} type={submits ? 'submit' : 'button'} onPress={submits ? undefined : act}>
      {content}
    </HButton>
  )
}

/* ---------------------------------- Data ---------------------------------- */

/** Rows/items per List/Table render: a hostile or broken spec carrying tens of
 *  thousands of entries must not freeze the renderer (a note shows the cut). */
const MAX_LIST_ROWS = 200

interface Column {
  key: string
  label: string
}

function toColumns(columns: unknown, rows: unknown[]): Column[] {
  if (Array.isArray(columns) && columns.length) {
    return columns.map((c, i) => {
      if (c && typeof c === 'object') {
        const rec = c as Record<string, unknown>
        const key = text(rec.key ?? rec.id ?? rec.label ?? i)
        return { key, label: text(rec.label ?? rec.title ?? key) }
      }
      return { key: text(c), label: text(c) }
    })
  }
  const first = rows.find((r) => r && typeof r === 'object' && !Array.isArray(r)) as
    Record<string, unknown> | undefined
  if (first) return Object.keys(first).map((k) => ({ key: k, label: k }))
  const width = Math.max(0, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)))
  return Array.from({ length: width }, (_, i) => ({ key: String(i), label: '' }))
}

/** Row cells in column order; object rows are matched by key or label (case-insensitive). */
function rowCells(row: unknown, cols: Column[]): unknown[] {
  if (Array.isArray(row)) return cols.map((_, i) => row[i])
  if (row && typeof row === 'object') {
    const rec = row as Record<string, unknown>
    const lower = new Map(Object.keys(rec).map((k) => [k.toLowerCase(), k]))
    return cols.map((c) => {
      const k = lower.get(c.key.toLowerCase()) ?? lower.get(c.label.toLowerCase())
      return k === undefined ? undefined : rec[k]
    })
  }
  return [row]
}

function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '')
    return <span className="text-muted">—</span>
  if (typeof value === 'boolean') return <>{value ? '✓' : '—'}</>
  if (typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>
    if ('text' in rec || 'label' in rec) {
      return (
        <Chip size="sm" variant="soft" color={tone(rec.variant ?? rec.color ?? rec.status)}>
          {text(rec.text ?? rec.label)}
        </Chip>
      )
    }
  }
  return <>{text(value)}</>
}

export function Table({
  title,
  columns,
  rows,
  rowAction,
  emptyText,
  nodeId,
  nodeName
}: NodeProps & {
  title?: string
  columns?: unknown
  rows?: unknown
  rowAction?: boolean
  emptyText?: string
}) {
  const runtime = useRuntime()
  const { bp } = useLayout()
  const nested = useContext(SurfaceContext)
  const totalRows = Array.isArray(rows) ? rows.length : 0
  const body = Array.isArray(rows) ? rows.slice(0, MAX_LIST_ROWS) : []
  const cols = toColumns(columns, body)
  const interactive = truthy(rowAction)
  const select = (index: number): void => {
    const cells = rowCells(body[index], cols)
    const row = Object.fromEntries(cols.map((c, i) => [c.label || c.key, cellText(cells[i])]))
    runtime.dispatch({ event: 'select', nodeId, nodeName, data: { index, row } })
  }
  const header = (
    <>
      {title ? <h3 className="px-1 pb-3 text-base font-semibold">{text(title)}</h3> : null}
      {totalRows > body.length ? (
        <p className="px-1 pb-2 text-xs text-muted">
          렌더링 상한으로 처음 {body.length}행만 표시합니다 (전체 {totalRows}행)
        </p>
      ) : null}
    </>
  )

  if (body.length === 0) {
    return (
      <Surface className="p-5">
        {header}
        <p className="py-8 text-center text-sm text-muted">{text(emptyText || 'No data')}</p>
      </Surface>
    )
  }

  // Phones: a native list — first column as the title, the other text columns as
  // one subtitle line, the last column (amount, date…) and any status chip at the end.
  if (bp === 'sm') {
    const isChip = (v: unknown): boolean =>
      !!v && typeof v === 'object' && !Array.isArray(v) && ('text' in v || 'label' in v)
    const last = cols.length - 1
    return (
      <Surface className="p-4">
        {header}
        <ul className="-mx-1 flex flex-col divide-y divide-separator">
          {body.map((row, i) => {
            const cells = rowCells(row, cols)
            const chipAt = cells.findIndex((c, j) => j > 0 && isChip(c))
            const valueAt = last > 0 && last !== chipAt ? last : -1
            const sub = cells
              .flatMap((c, j) => (j > 0 && j !== chipAt && j !== valueAt ? [cellText(c)] : []))
              .filter((v) => v !== null && v !== undefined && v !== '')
              .map(String)
              .join(' · ')
            const inner = (
              <>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[15px] font-medium text-foreground">
                    <Cell value={cells[0]} />
                  </span>
                  {sub ? <span className="truncate text-xs text-muted">{sub}</span> : null}
                </span>
                {valueAt >= 0 || chipAt >= 0 ? (
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    {valueAt >= 0 ? (
                      <span className="text-sm font-medium tabular-nums text-foreground">
                        <Cell value={cells[valueAt]} />
                      </span>
                    ) : null}
                    {chipAt >= 0 ? <Cell value={cells[chipAt]} /> : null}
                  </span>
                ) : null}
                {interactive ? (
                  <Icon name="chevron-right" size={16} className="shrink-0 text-muted" />
                ) : null}
              </>
            )
            const cls = 'flex min-h-14 w-full items-center gap-3 px-1 py-2.5 text-left'
            return (
              <li key={i}>
                {interactive ? (
                  <button
                    type="button"
                    className={`${cls} cursor-pointer rounded-xl transition-colors active:bg-default`}
                    onClick={() => select(i)}
                  >
                    {inner}
                  </button>
                ) : (
                  <div className={cls}>{inner}</div>
                )}
              </li>
            )
          })}
        </ul>
      </Surface>
    )
  }

  return (
    <div className="flex flex-col">
      {header}
      <HTable variant={nested ? 'secondary' : 'primary'}>
        <HTable.ScrollContainer>
          <HTable.Content
            aria-label={text(title) || humanize(nodeId) || 'Table'}
            onRowAction={interactive ? (key) => select(Number(key)) : undefined}
          >
            <HTable.Header>
              {cols.map((c, i) => (
                <HTable.Column key={i} id={`c${i}`} isRowHeader={i === 0}>
                  {c.label}
                </HTable.Column>
              ))}
            </HTable.Header>
            <HTable.Body>
              {body.map((row, i) => {
                const cells = rowCells(row, cols)
                return (
                  <HTable.Row key={i} id={i} className={interactive ? 'cursor-pointer' : undefined}>
                    {cells.map((cell, j) => (
                      <HTable.Cell key={j}>
                        <Cell value={cell} />
                      </HTable.Cell>
                    ))}
                  </HTable.Row>
                )
              })}
            </HTable.Body>
          </HTable.Content>
        </HTable.ScrollContainer>
      </HTable>
    </div>
  )
}

/** "leads-table" → "Leads table" (accessible names for unlabeled nodes). */
function humanize(id: string | undefined): string {
  if (!id) return ''
  const words = id.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function cellText(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>
    if ('text' in rec || 'label' in rec) return rec.text ?? rec.label
  }
  return v
}

interface ListItem {
  id?: string
  title: string
  description?: string
  icon?: string
  avatar?: string
  meta?: string
  badge?: string
  badgeVariant?: string
}

function toListItems(items: unknown): ListItem[] {
  if (!Array.isArray(items)) return []
  return items.map((it) => {
    if (it === null || typeof it !== 'object') return { title: text(it) }
    const r = it as Record<string, unknown>
    return {
      id: r.id === undefined ? undefined : text(r.id),
      title: text(r.title ?? r.label ?? r.name ?? r.text),
      description: r.description || r.subtitle ? text(r.description ?? r.subtitle) : undefined,
      icon: r.icon ? text(r.icon) : undefined,
      avatar: r.avatar ? text(r.avatar) : undefined,
      meta: r.meta || r.time ? text(r.meta ?? r.time) : undefined,
      badge: r.badge !== undefined && r.badge !== '' ? text(r.badge) : undefined,
      badgeVariant: r.badgeVariant ? text(r.badgeVariant) : undefined
    }
  })
}

export function List({
  items,
  ordered,
  nodeId,
  nodeName
}: NodeProps & { items?: unknown; ordered?: boolean }) {
  const runtime = useRuntime()
  const total = Array.isArray(items) ? items.length : 0
  const list = toListItems(Array.isArray(items) ? items.slice(0, MAX_LIST_ROWS) : items)
  const rich = list.some((i) => i.description || i.icon || i.avatar || i.badge || i.meta || i.id)

  if (!rich) {
    const Tag = truthy(ordered) ? 'ol' : 'ul'
    return (
      <>
        <Tag
          className={`flex flex-col gap-1.5 pl-5 text-[15px] ${truthy(ordered) ? 'list-decimal' : 'list-disc'}`}
        >
          {list.map((item, i) => (
            <li key={i}>{item.title}</li>
          ))}
        </Tag>
        {total > list.length ? (
          <p className="pl-5 text-xs text-muted">
            렌더링 상한으로 처음 {list.length}개만 표시합니다 (전체 {total}개)
          </p>
        ) : null}
      </>
    )
  }

  const rows = (
    <ul className="-mx-2 flex flex-col">
      {list.map((item, i) => {
        const inner = (
          <>
            {item.avatar ? (
              <HAvatar size="sm">
                <HAvatar.Image src={item.avatar} alt={item.title} />
                <HAvatar.Fallback>{initials(item.title)}</HAvatar.Fallback>
              </HAvatar>
            ) : item.icon ? (
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-default text-default-foreground">
                <Icon name={item.icon} size={16} />
              </span>
            ) : null}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-foreground">{item.title}</span>
              {item.description ? (
                <span className="truncate text-xs text-muted">{item.description}</span>
              ) : null}
            </span>
            {item.meta ? <span className="shrink-0 text-xs text-muted">{item.meta}</span> : null}
            {item.badge ? (
              <Chip size="sm" variant="soft" color={tone(item.badgeVariant)}>
                {item.badge}
              </Chip>
            ) : null}
            {item.id ? (
              <Icon name="chevron-right" size={14} className="shrink-0 text-muted" />
            ) : null}
          </>
        )
        const cls = 'flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left'
        return (
          <li key={item.id ?? i}>
            {item.id ? (
              <button
                type="button"
                className={`${cls} cursor-pointer transition-colors hover:bg-default focus-visible:outline-2 focus-visible:outline-focus`}
                onClick={() =>
                  runtime.dispatch({
                    event: 'select',
                    nodeId,
                    nodeName,
                    data: { id: item.id, title: item.title }
                  })
                }
              >
                {inner}
              </button>
            ) : (
              <div className={cls}>{inner}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
  return (
    <Surface className="p-3">
      {rows}
      {total > list.length ? (
        <p className="px-2 pt-2 text-xs text-muted">
          렌더링 상한으로 처음 {list.length}개만 표시합니다 (전체 {total}개)
        </p>
      ) : null}
    </Surface>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (
    parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)
  ).toUpperCase()
}

export function StatCard({
  label,
  value,
  delta,
  deltaGood,
  icon,
  description
}: {
  label?: string
  value?: string | number
  delta?: string
  deltaGood?: boolean
  icon?: string
  description?: string
}) {
  const { bp } = useLayout()
  const good =
    deltaGood === undefined
      ? !String(delta ?? '')
          .trim()
          .startsWith('-')
      : truthy(deltaGood)
  return (
    <HCard className="h-full">
      <HCard.Content className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm text-muted">{text(label)}</span>
          {icon && bp !== 'sm' ? <IconBadge name={icon} /> : null}
        </div>
        <span
          className={`${bp === 'sm' ? 'text-2xl' : 'text-3xl'} font-semibold tracking-tight tabular-nums text-foreground`}
        >
          {text(value)}
        </span>
        {delta || description ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {delta ? (
              <Chip size="sm" variant="soft" color={good ? 'success' : 'danger'}>
                {text(delta)}
              </Chip>
            ) : null}
            {description ? <span className="text-muted">{text(description)}</span> : null}
          </div>
        ) : null}
      </HCard.Content>
    </HCard>
  )
}

export function KeyValue({ items, columns }: { items?: unknown; columns?: number }) {
  const { bp } = useLayout()
  const pairs: Array<{ label: string; value: unknown }> = Array.isArray(items)
    ? items.map((it) => {
        const r = (it && typeof it === 'object' ? it : { label: it }) as Record<string, unknown>
        return { label: text(r.label ?? r.key ?? r.name), value: r.value }
      })
    : items && typeof items === 'object'
      ? Object.entries(items as Record<string, unknown>).map(([label, value]) => ({ label, value }))
      : []
  const n = bp === 'sm' ? 1 : Math.max(1, Math.min(3, Number(columns) || 1))
  return (
    <dl
      className="grid gap-x-6 gap-y-4"
      style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
    >
      {pairs.map((p, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs font-medium text-muted">{p.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-foreground">
            <Cell value={p.value} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function Avatar({
  name,
  src,
  description,
  size
}: {
  name?: string
  src?: string
  description?: string
  size?: string
}) {
  const s = size === 'sm' || size === 'lg' ? size : 'md'
  const avatar = (
    <HAvatar size={s} color="accent" variant="soft">
      {src ? <HAvatar.Image src={src} alt={text(name)} /> : null}
      <HAvatar.Fallback>{initials(text(name))}</HAvatar.Fallback>
    </HAvatar>
  )
  if (!name && !description) return avatar
  return (
    <div className="flex min-w-0 items-center gap-3">
      {avatar}
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{text(name)}</span>
        {description ? (
          <span className="truncate text-xs text-muted">{text(description)}</span>
        ) : null}
      </div>
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  children
}: NodeProps & { icon?: string; title?: string; description?: string }) {
  return (
    <Surface>
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-12 text-center">
        <span className="grid size-12 place-items-center rounded-2xl bg-default text-muted">
          <Icon name={icon ?? 'inbox'} size={22} />
        </span>
        <div>
          <p className="text-base font-semibold text-foreground">
            {text(title || 'Nothing here yet')}
          </p>
          {description ? (
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{text(description)}</p>
          ) : null}
        </div>
        {Children.count(children) ? (
          <div className="mt-1 flex flex-wrap justify-center gap-2">{children}</div>
        ) : null}
      </div>
    </Surface>
  )
}

/* ------------------------------- Feedback --------------------------------- */

export function Alert({
  title,
  message,
  variant,
  onClose
}: {
  title?: string
  message?: string
  variant?: string
  /** Runtime-only: renders a dismiss button. */
  onClose?: () => void
}) {
  const status = tone(variant)
  return (
    <HAlert status={status} role={status === 'danger' ? 'alert' : undefined}>
      <HAlert.Indicator />
      <HAlert.Content>
        {title ? <HAlert.Title>{text(title)}</HAlert.Title> : null}
        {message ? (
          title ? (
            <HAlert.Description>{text(message)}</HAlert.Description>
          ) : (
            <HAlert.Title>{text(message)}</HAlert.Title>
          )
        ) : null}
      </HAlert.Content>
      {onClose ? <CloseButton aria-label="Dismiss" onPress={onClose} /> : null}
    </HAlert>
  )
}

export function Progress({
  value,
  label,
  showValue,
  variant
}: {
  value?: number
  label?: string
  showValue?: boolean
  variant?: string
}) {
  const pct = Math.max(0, Math.min(100, Number(value ?? 0) || 0))
  const t = tone(variant)
  return (
    <ProgressBar
      value={pct}
      aria-label={label ? undefined : 'Progress'}
      color={t === 'default' ? 'accent' : t}
      size="sm"
      className="w-full"
    >
      {label ? <Label>{text(label)}</Label> : null}
      {truthy(showValue) || label ? <ProgressBar.Output /> : null}
      <ProgressBar.Track>
        <ProgressBar.Fill />
      </ProgressBar.Track>
    </ProgressBar>
  )
}

export function Spinner({ text: value }: { text?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <HSpinner size="sm" />
      {value ? <span>{text(value)}</span> : null}
    </div>
  )
}

const SKELETON_WIDTHS = ['w-full', 'w-11/12', 'w-4/5', 'w-2/3', 'w-3/4']
export function Skeleton({ lines = 3 }: { lines?: number }) {
  const n = Math.max(1, Math.min(12, Number(lines) || 3))
  return (
    <div className="flex flex-col gap-2.5" aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        <HSkeleton
          key={i}
          className={`h-4 rounded-lg ${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}`}
        />
      ))}
    </div>
  )
}

/* ------------------------------- Navigation -------------------------------- */

export function Breadcrumbs({ items, nodeId, nodeName }: NodeProps & { items?: unknown }) {
  const runtime = useRuntime()
  const crumbs = Array.isArray(items)
    ? items.map((it, i) => {
        const r = (it && typeof it === 'object' ? it : { label: it }) as Record<string, unknown>
        return { id: text(r.id ?? r.page ?? r.label ?? i), label: text(r.label ?? r.title ?? r.id) }
      })
    : []
  return (
    <HBreadcrumbs
      onAction={(key) =>
        runtime.dispatch({ event: 'navigate', nodeId, nodeName, data: { page: String(key) } })
      }
    >
      {crumbs.map((c, i) => (
        <HBreadcrumbs.Item key={`${c.id}-${i}`} id={c.id}>
          {c.label}
        </HBreadcrumbs.Item>
      ))}
    </HBreadcrumbs>
  )
}

/** Page numbers with ellipses: 1 … 4 5 6 … 20 */
function pageWindow(page: number, total: number): Array<number | null> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const out: Array<number | null> = [1]
  const start = Math.max(2, page - 1)
  const end = Math.min(total - 1, page + 1)
  if (start > 2) out.push(null)
  for (let p = start; p <= end; p++) out.push(p)
  if (end < total - 1) out.push(null)
  out.push(total)
  return out
}

export function Pagination({
  page,
  total,
  nodeId,
  nodeName
}: NodeProps & { page?: number; total?: number }) {
  const runtime = useRuntime()
  const { bp } = useLayout()
  const pages = Math.max(1, Number(total) || 1)
  const current = Math.max(1, Math.min(pages, Number(page) || 1))
  const go = (p: number): void =>
    runtime.dispatch({ event: 'page', nodeId, nodeName, data: { page: p } })
  return (
    <HPagination size="sm" className="justify-center" aria-label="Pagination">
      <HPagination.Content>
        <HPagination.Item>
          <HPagination.Previous
            aria-label="Previous page"
            isDisabled={current === 1}
            onPress={() => go(current - 1)}
          >
            <HPagination.PreviousIcon />
            {bp === 'sm' ? null : <span>Previous</span>}
          </HPagination.Previous>
        </HPagination.Item>
        {(bp === 'sm' ? [current] : pageWindow(current, pages)).map((p, i) => (
          <HPagination.Item key={p ?? `gap-${i}`}>
            {p === null ? (
              <HPagination.Ellipsis />
            ) : (
              <HPagination.Link isActive={p === current} onPress={() => go(p)}>
                {bp === 'sm' ? `${p} / ${pages}` : p}
              </HPagination.Link>
            )}
          </HPagination.Item>
        ))}
        <HPagination.Item>
          <HPagination.Next
            aria-label="Next page"
            isDisabled={current === pages}
            onPress={() => go(current + 1)}
          >
            {bp === 'sm' ? null : <span>Next</span>}
            <HPagination.NextIcon />
          </HPagination.Next>
        </HPagination.Item>
      </HPagination.Content>
    </HPagination>
  )
}

/* --------------------------------- Media ---------------------------------- */

export function Image({
  src,
  alt,
  width,
  aspect,
  rounded = true
}: {
  src?: string
  alt?: string
  width?: number | string
  aspect?: string
  rounded?: boolean
}) {
  const [failed, setFailed] = useState(false)
  const shape = truthy(rounded) ? 'rounded-2xl' : ''
  const style = {
    aspectRatio: aspect ? String(aspect).replace(':', '/') : undefined,
    width: width ?? undefined
  }
  if (failed || !src) {
    return (
      <div
        className={`grid min-h-24 place-items-center bg-default text-sm text-muted ${shape}`}
        style={style}
      >
        <span className="flex items-center gap-2">
          <Icon name="image" />
          {text(alt || 'image')}
        </span>
      </div>
    )
  }
  return (
    <img
      className={`max-w-full object-cover ${shape}`}
      style={style}
      src={src}
      alt={text(alt)}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}
