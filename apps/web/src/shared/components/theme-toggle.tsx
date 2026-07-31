import { Moon, Sun } from 'lucide-react';

import { Button } from '@/shared/components/ui/button';
import { useTheme } from '@/shared/hooks/use-theme';
import { t } from '@/shared/lib/i18n';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t(isDark ? 'theme.toggle.to_light' : 'theme.toggle.to_dark')}
      aria-pressed={isDark}
      onClick={toggleTheme}
    >
      {isDark ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
    </Button>
  );
}
