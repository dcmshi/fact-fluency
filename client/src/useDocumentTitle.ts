import { useEffect } from 'react';

/**
 * Give a route its own document title (tab clarity + a11y), restoring the
 * previous one on unmount. The pattern HowItWorksPage started, as a hook.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
