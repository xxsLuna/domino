import type { PageSpec } from '../spec'
import { iterateNodes } from '../spec'

/**
 * How a page is presented is the RUNTIME's call, not the model's: short
 * create/edit forms show as a full-screen sheet over the page they came from,
 * anything with more content stays an ordinary page card. The model just
 * designs the form; field count decides the chrome.
 */

const FORM_FIELDS = new Set([
  'Input',
  'Textarea',
  'Select',
  'Checkbox',
  'RadioGroup',
  'Radio',
  'Switch'
])

/** At most this many form fields present as a sheet; more becomes a page card. */
export const MODAL_MAX_FIELDS = 5

/** Editable form controls on the page (SearchField is filtering, not data entry). */
export function formFieldCount(page: PageSpec): number {
  let count = 0
  for (const node of iterateNodes(page.layout)) {
    if (FORM_FIELDS.has(node.name)) count++
  }
  return count
}

/**
 * Full-screen sheet for short forms: the page must hold a Form with 1–5
 * fields. Login is exempt (the entry screen has nothing to sit over), as are
 * forms with no fields and pages without one.
 */
export function isModalPresentation(page: PageSpec): boolean {
  if (page.id === 'login') return false
  let hasForm = false
  for (const node of iterateNodes(page.layout)) {
    if (node.name === 'Form') hasForm = true
  }
  if (!hasForm) return false
  const fields = formFieldCount(page)
  return fields >= 1 && fields <= MODAL_MAX_FIELDS
}
