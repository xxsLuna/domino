import { useEffect, useState } from 'react'

type Theme = 'light' | 'dark'

/**
 * Follows the OS color scheme ("다크모드/라이트모드 자동 인식").
 * Updates live when the user toggles the system preference.
 */
export function useSystemTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setTheme(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return theme
}
