'use client';

import { Toaster as SonnerToaster } from 'sonner';
import { useSettings } from '@/lib/dashboard/settings-context';

/**
 * Toaster — shadcn-style wrapper around sonner.
 *
 * Mounted once in the dashboard layout. Toasts are triggered anywhere via
 * `import { toast } from 'sonner'`. Positioned bottom-right per the document
 * upload UX (unsupported-file errors surface there) and themed from the
 * dashboard settings context.
 */
export function Toaster() {
  const { settings } = useSettings();

  return (
    <SonnerToaster
      position="bottom-right"
      theme={settings.theme}
      richColors
      closeButton
    />
  );
}
