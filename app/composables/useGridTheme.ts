// Owner: C ("grid"). AG Grid theme that follows the app's light/dark mode and uses Nuxt UI's colours.
import { colorSchemeDark, themeQuartz } from 'ag-grid-community'

export function useGridTheme() {
  const colorMode = useColorMode()
  return computed(() =>
    (colorMode.value === 'dark' ? themeQuartz.withPart(colorSchemeDark) : themeQuartz).withParams({
      backgroundColor: 'var(--ui-bg)',
      foregroundColor: 'var(--ui-text)',
      headerBackgroundColor: 'var(--ui-bg-muted)',
      borderColor: 'var(--ui-border)',
      accentColor: 'var(--ui-primary)',
      fontFamily: 'inherit',
    }),
  )
}
