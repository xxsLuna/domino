import { Dropdown, Label } from '@heroui/react'
import { Icon } from './icons'
import type { NavItem } from '../spec'

/**
 * Primary navigation for a generated app, in the shape each form factor
 * expects: a labeled sidebar on desktop, an icon rail on tablets (both are
 * `.side-nav`, CSS swaps the look) and a bottom tab bar on phones.
 */

interface AppNavProps {
  items: NavItem[]
  activeId: string | null
  onSelect: (item: NavItem) => void
}

/** Phones fit five tabs; beyond that the last slot becomes "More". */
const MAX_TABS = 5

export function SideNav({ items, activeId, onSelect }: AppNavProps): React.JSX.Element {
  return (
    <nav className="side-nav" aria-label="Primary">
      {items.map((item) => (
        <NavButton key={item.id} item={item} active={item.id === activeId} onSelect={onSelect} />
      ))}
    </nav>
  )
}

export function BottomNav({ items, activeId, onSelect }: AppNavProps): React.JSX.Element {
  const overflow = items.length > MAX_TABS
  const tabs = overflow ? items.slice(0, MAX_TABS - 1) : items
  const more = overflow ? items.slice(MAX_TABS - 1) : []
  const moreActive = more.some((i) => i.id === activeId)

  return (
    <nav className="bottom-nav" aria-label="Primary">
      {tabs.map((item) => (
        <NavButton key={item.id} item={item} active={item.id === activeId} onSelect={onSelect} />
      ))}
      {overflow ? (
        <Dropdown>
          <Dropdown.Trigger className="nav-item" aria-current={moreActive ? 'page' : undefined}>
            <Icon name="more" size={20} />
            <span className="nav-label">More</span>
          </Dropdown.Trigger>
          <Dropdown.Popover placement="top end">
            <Dropdown.Menu
              aria-label="More destinations"
              onAction={(key) => {
                const item = more.find((i) => i.id === key)
                if (item) onSelect(item)
              }}
            >
              {more.map((item) => (
                <Dropdown.Item key={item.id} id={item.id} textValue={item.label}>
                  <Icon name={item.icon} size={16} />
                  <Label>{item.label}</Label>
                  {item.badge !== undefined ? (
                    <span className="nav-badge ml-auto">{item.badge}</span>
                  ) : null}
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : null}
    </nav>
  )
}

function NavButton({
  item,
  active,
  onSelect
}: {
  item: NavItem
  active: boolean
  onSelect: (item: NavItem) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="nav-item"
      aria-current={active ? 'page' : undefined}
      title={item.label}
      onClick={() => onSelect(item)}
    >
      <Icon name={item.icon ?? 'dashboard'} size={20} />
      <span className="nav-label">{item.label}</span>
      {item.badge !== undefined && item.badge !== '' ? (
        <span className="nav-badge">{item.badge}</span>
      ) : null}
    </button>
  )
}
