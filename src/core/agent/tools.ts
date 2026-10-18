import type { ToolDef } from '../llm/types'

export const renderUiTool: ToolDef = {
  name: 'render_ui',
  description:
    'Render or re-render the current app screen. Call this for the initial screen and after every user interaction to show the next screen. Streams progressively.',
  parameters: {
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        description:
          'UiSpec: {version: 1, page: "<current page id>", pages: [{id, name, layout: [node...]}]}. node = {name, id, props?, grid?, children?}.',
        required: ['version', 'page', 'pages']
      }
    },
    required: ['spec']
  }
}

export const callApiTool: ToolDef = {
  name: 'call_api',
  description:
    'Call the loaded app\'s backend. Only paths in the domino [api] allow list are permitted. Call it before render_ui when the screen needs live data.',
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
  description: 'Switch to another page defined in the UiSpec (records browser-style history).',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'string', description: 'Target page id' }
    },
    required: ['page']
  }
}

export const agentTools: ToolDef[] = [renderUiTool, callApiTool, navigateTool]
