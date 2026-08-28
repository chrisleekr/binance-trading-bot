import { Link } from '@tanstack/react-router';
import { Settings } from 'lucide-react';
import type { ReactNode } from 'react';

import { AccountHealthBar } from '@/app/account-health-bar';
import { BottomNav } from '@/app/bottom-nav';
import { DemoBanner } from '@/app/demo-banner';
import { SETTINGS_ITEM, SideNav } from '@/app/side-nav';
import { StatusBar } from '@/app/status-bar';
import { TopBarStatus } from '@/app/top-bar-status';
import { TopBarTicker, TopBarTickerBar } from '@/app/top-bar-ticker';
import { useDemoMode } from '@/features/auth/api/auth';
import { ThemeToggle } from '@/shared/components/theme-toggle';
import { buttonVariants } from '@/shared/components/ui/button';
import { cn } from '@/shared/lib/cn';
import { visibleInDemo } from '@/shared/lib/demo-visibility';
import { t } from '@/shared/lib/i18n';
import { useScrollAnchor } from '@/shared/lib/use-scroll-anchor';

/*
 * Responsive layout primitive. On desktop the header carries the chrome: the
 * wordmark links Home, a Settings icon sits by the theme toggle, and
 * `headerSlot` holds the Profile Switcher. On mobile (<md) the BottomNav is the
 * primary nav.
 */
export function AppShell({
  children,
  headerSlot,
  disableMainScroll = false,
}: {
  children: ReactNode;
  headerSlot?: ReactNode;
  // The terminal dashboard owns its own per-zone scroll, so the shell must not
  // also scroll <main> or pad it — that would double-scroll and inset the
  // full-bleed grid. Every other route keeps the default scroll+padding.
  disableMainScroll?: boolean;
}) {
  // Public "Live demo": show the persistent banner and drop every entry point whose destination declared itself demo-hidden. Testnet trading stays interactive.
  const demoMode = useDemoMode();
  // WebKit has no scroll anchoring: a polled reflow above the fold bounces a
  // scrolled reader on the next tick. Hold their spot on <main> — the scroller
  // for every normal route. Full-screen routes disable <main>'s scroll and
  // anchor their own inner scroller instead, so skip the ref there.
  const mainScrollRef = useScrollAnchor<HTMLElement>();
  return (
    // h-svh, not h-dvh or min-h-dvh. min-h-dvh lets a tall page push the
    // BottomNav below the fold on mobile, where the nav is the operator's
    // only way to navigate. h-dvh resizes with iOS Safari's URL bar so
    // the nav visually jitters on inertial scroll. h-svh pins the shell
    // to the small (chrome-visible) viewport so the nav never moves.
    // min-h-0 on flex children prevents the default min-height auto from
    // overriding the overflow-y-auto scroll surface on main.
    //
    // relative + overflow-hidden make the shell the containing block for any
    // descendant that is position:absolute with no positioned ancestor —
    // notably Radix Switch's hidden bubble <input>, which Radix renders as a
    // flow-positioned absolute sibling of the toggle. Without this it anchors
    // to the initial containing block and projects its deep in-content Y onto
    // documentElement.scrollHeight, making the whole document scroll behind the
    // fixed nav. Clipping at the shell costs nothing (the bubble is opacity:0)
    // and real overlays portal to document.body, outside the shell, so they
    // are unaffected.
    <div className="relative flex h-svh flex-col overflow-hidden bg-bg text-fg">
      {/* WCAG 2.1 SC 2.4.1 Bypass Blocks. First tab stop on every page, visually hidden until focused, so a keyboard operator skips the sidebar's ten rows instead of tabbing them on every navigation. Anchored to <main>'s id, and <main> takes tabIndex={-1} so the jump moves focus, not just the scroll position. */}
      <a
        href="#main-content"
        data-testid="skip-link"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-bg-elevated focus:px-4 focus:py-3 focus:text-sm focus:font-medium focus:text-fg focus:ring-2 focus:ring-focus focus:outline-none"
      >
        {t('nav.skip_to_content')}
      </a>
      {demoMode && <DemoBanner />}
      {/* Full-width terminal top bar: accent wordmark block, then the profile
          switcher, with the account/theme controls on the right. The 2px
          accent bottom rule is the v2 signature (see DESIGN.md). */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b-2 border-accent bg-bg-elevated pr-4">
        {/* Wordmark doubles as the Home link — no separate Home nav item. Fixed
            to the expanded sidebar width (w-52) so the gold block and the
            sidebar below it read as one aligned left column. (Collapsed-rail
            state mismatches by design; the default expanded state is the one
            that must line up.) */}
        <Link
          to="/"
          className="flex h-full shrink-0 items-center bg-accent px-4 text-xs font-bold tracking-[0.12em] text-accent-fg uppercase md:w-52"
        >
          {t('app.title')}
        </Link>
        {/* Desktop: the profile switcher is md:hidden, so the slot shows the
            ticker marquee. Mobile: the switcher shows plus the ticker's compact
            icon. min-w-0 + overflow-hidden clips the marquee crawl. */}
        <div
          data-testid="profile-switcher-slot"
          className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden"
        >
          {headerSlot}
          <TopBarTicker />
        </div>
        {/* Global status cluster: bot state + P/L snapshot + API health. P/L and
            health are md+; the compact state indicator stays reachable on a
            phone. The middle slot above also carries the desktop trading-summary
            ticker (md+); mobile shows its compact icon instead. The kill switch
            lives on the Account settings page, not here. */}
        <TopBarStatus />
        {/* Settings is a compact icon by the theme toggle on desktop; mobile
            reaches it through the BottomNav. Reads the sidebar's declaration for
            the same destination rather than restating the demo answer. */}
        {visibleInDemo(SETTINGS_ITEM, demoMode) && (
          <Link
            to="/settings"
            aria-label={t('nav.settings')}
            data-testid="header-account"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'icon' }),
              'hidden md:inline-flex',
            )}
            // exact: without it the icon stays lit — and stamped
            // `aria-current="page"` — on /settings/backup-restore, which it does
            // not point at.
            activeOptions={{ exact: true }}
            activeProps={{ className: 'bg-surface-alt text-fg-emphasis' }}
          >
            <Settings className="h-5 w-5" aria-hidden="true" />
          </Link>
        )}
        <ThemeToggle />
      </header>
      {/* Always-visible "is my money OK right now" strip: worker liveness (the
          header status cluster is desktop-only), any active halts, and today's
          realized P/L. Sits above the ticker on every viewport. */}
      <AccountHealthBar />
      {/* Mobile carries the trading ticker as a full-width sub-bar under the
          header; on desktop the same ticker lives in the header's middle slot. */}
      <TopBarTickerBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SideNav className="hidden md:flex" demoMode={demoMode} />
        <main
          id="main-content"
          // Focusable only as a skip-link target: without it the browser scrolls
          // to the anchor but leaves focus on the link, so the next Tab returns
          // to the nav the operator just skipped.
          tabIndex={-1}
          ref={disableMainScroll ? undefined : mainScrollRef}
          className={cn(
            // overscroll-contain, on the scroller itself: overscroll-behavior is
            // NOT inherited, so the `body` rule does nothing for <main>. Without
            // it, a flick past the end of the content chains the scroll out to
            // the document and the whole shell rubber-bands under the fixed
            // header.
            'min-h-0 min-w-0 flex-1 overscroll-contain',
            // The terminal owns its scroll; make <main> a flex column so the
            // terminal frame's `flex-1` fills the height and its bottom dock
            // pins to the viewport instead of floating after the content.
            disableMainScroll ? 'flex flex-col overflow-hidden' : 'overflow-y-scroll p-4',
          )}
        >
          {children}
        </main>
      </div>
      <StatusBar className="hidden md:flex" />
      <BottomNav className="md:hidden" demoMode={demoMode} />
    </div>
  );
}
