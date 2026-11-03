import type { ToolDef } from '../llm/types'

/**
 * Spelled out (rather than a bare `type: object`) so models emit the spec as a
 * real object — with a free-form object some stringify it — and in the key
 * order the progressive renderer wants: name, id, grid, then props/children.
 */
const gridParam = {
  type: 'object',
  description: '12-column desktop grid: x 0-11, y row index, w 1-12 (x + w <= 12), h >= 1',
  properties: {
    x: { type: 'integer' },
    y: { type: 'integer' },
    w: { type: 'integer' },
    h: { type: 'integer' }
  },
  required: ['x', 'y', 'w', 'h']
}

const nodeParam = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Component name from the registry' },
    id: { type: 'string', description: 'Unique kebab-case id' },
    grid: gridParam,
    props: { type: 'object', description: 'Component props (see the registry)' },
    children: {
      type: 'array',
      description: 'Child nodes — same shape, without grid',
      items: { type: 'object' }
    }
  },
  required: ['name', 'id']
}

export const renderUiTool: ToolDef = {
  name: 'render_ui',
  description:
    'Render or re-render the current app screen. Call this for the initial screen and after every user interaction to show the next screen (bind known endpoints with {"$data": "api:GET /path.field"} — the runtime fetches them). A valid render ends the turn. Streams progressively.',
  parameters: {
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        description: 'The UiSpec object itself: {version, page, nav, pages}.',
        properties: {
          version: { type: 'integer', enum: [1] },
          page: { type: 'string', description: 'Id of the page being shown' },
          nav: {
            type: 'array',
            description: 'Primary navigation; [] on login/onboarding screens',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Target page id' },
                label: { type: 'string' },
                icon: { type: 'string' },
                badge: {
                  description:
                    'Count or short label, or a live binding {"$data": "<key>.<path>"} / {"$state": "<key>"}'
                }
              },
              required: ['id', 'label']
            }
          },
          pages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                layout: { type: 'array', items: nodeParam }
              },
              required: ['id', 'name', 'layout']
            }
          }
        },
        required: ['version', 'page', 'pages']
      }
    },
    required: ['spec']
  }
}

export const callApiTool: ToolDef = {
  name: 'call_api',
  description:
    'Call the loaded app\'s backend. Only paths in the domino [api] allow list are permitted. Use it for writes (POST/PUT/PATCH/DELETE) and for GET endpoints whose response shape is not known yet — known GET endpoints are bound directly in render_ui instead. Several calls in one response run in parallel.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path like /leads or absolute URL' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      body: { type: 'object', description: 'JSON body for non-GET requests' }
    },
    required: ['path']
  }
}

export const navigateTool: ToolDef = {
  name: 'navigate',
  description:
    'Switch instantly to a page that already exists (an id from the App map page list) whose content does not depend on what was pressed, or restore an earlier screen by passing page "history:<index>" from the Screen history list. Ends the turn — no render_ui after it. An unknown page id is refused.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'string', description: 'Target page id, or "history:<index>" to restore that moment' }
    },
    required: ['page']
  }
}

export const agentTools: ToolDef[] = [renderUiTool, callApiTool, navigateTool]
