import { useEffect, useRef, useState } from 'react'

const hasFiles = (e: DragEvent): boolean => Boolean(e.dataTransfer?.types.includes('Files'))

/**
 * Window-wide file drop: returns whether files are being dragged over the
 * window (to show an overlay) and hands the first dropped file to `onFile`.
 * Default handling is always cancelled for file drags — otherwise Electron
 * navigates the window to the dropped file.
 */
export function useFileDrop(onFile: (file: File) => void): boolean {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const handler = useRef(onFile)
  handler.current = onFile

  useEffect(() => {
    const enter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current += 1
      setDragging(true)
    }
    const over = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const leave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      const file = e.dataTransfer?.files[0]
      if (file) handler.current(file)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  return dragging
}
