import { useEffect } from 'react';

/**
 * Apply an unlockable palette theme to the whole page while a component is
 * mounted, restoring the previous theme on unmount. 'classic' (or undefined)
 * means the default look — no data attribute. See body[data-theme] in index.css.
 */
export function useTheme(theme: string | undefined): void {
  useEffect(() => {
    const prev = document.body.dataset.theme;
    if (theme && theme !== 'classic') document.body.dataset.theme = theme;
    else delete document.body.dataset.theme;
    return () => {
      if (prev) document.body.dataset.theme = prev;
      else delete document.body.dataset.theme;
    };
  }, [theme]);
}
