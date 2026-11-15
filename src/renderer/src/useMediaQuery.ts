import { useEffect, useState } from 'react'

/**
 * A live CSS media query — the runtime's one window-width sense. The sheet
 * uses it to pick its shape (a centered card in a wide window, a bottom
 * sheet on a phone). Updates when the window is resized or rotated.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  )

  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = (): void => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])

  return matches
}
