import { createContext, useContext } from 'react'
import type { ActionEvent } from '../spec'
import type { Breakpoint } from './layout'

/**
 * Runtime context: components dispatch interaction events up to the agent loop.
 */
export interface Runtime {
  dispatch(
    event: Omit<ActionEvent, 'pageId' | 'nodeId' | 'nodeName'> & {
      nodeId?: string
      nodeName?: string
    }
  ): void
}

export const RuntimeContext = createContext<Runtime>({
  dispatch: () => {
    /* noop until an agent is attached */
  }
})

export const useRuntime = (): Runtime => useContext(RuntimeContext)

/** Current grid breakpoint + density, for components that adapt (Table → cards on phones). */
export interface LayoutInfo {
  bp: Breakpoint
  density: 'comfortable' | 'compact'
}

export const LayoutContext = createContext<LayoutInfo>({ bp: 'lg', density: 'comfortable' })

export const useLayout = (): LayoutInfo => useContext(LayoutContext)

/** Per-cell hints from the layout engine. */
export const CellContext = createContext<{ fill: boolean }>({ fill: false })

export const useCell = (): { fill: boolean } => useContext(CellContext)
