import { Toaster as SonnerToaster, type ToasterProps } from 'sonner';

import { useTheme } from '@/shared/hooks/use-theme';

export function Toaster(props: ToasterProps) {
  const { theme } = useTheme();
  return (
    <SonnerToaster
      theme={theme}
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: 'border border-border bg-bg-elevated text-fg',
        },
      }}
      {...props}
    />
  );
}
