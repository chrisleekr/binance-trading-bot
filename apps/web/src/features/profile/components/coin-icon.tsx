// Coin icon for the balances panel. Curated static import map of
// `cryptocurrency-icons` (CC0-1.0) SVGs — only assets present in the 0.18.1
// package. Vite resolves each import to an asset URL string. Anything unmapped
// (including ENA and WLD, which the 2022 package lacks, plus arbitrary dust)
// renders a neutral monogram chip, so every row still carries a stable
// `coin-icon-${asset}` node regardless of whether a bundled icon exists.

import aaveUrl from 'cryptocurrency-icons/svg/color/aave.svg';
import adaUrl from 'cryptocurrency-icons/svg/color/ada.svg';
import atomUrl from 'cryptocurrency-icons/svg/color/atom.svg';
import avaxUrl from 'cryptocurrency-icons/svg/color/avax.svg';
import bnbUrl from 'cryptocurrency-icons/svg/color/bnb.svg';
import btcUrl from 'cryptocurrency-icons/svg/color/btc.svg';
import dogeUrl from 'cryptocurrency-icons/svg/color/doge.svg';
import dotUrl from 'cryptocurrency-icons/svg/color/dot.svg';
import ethUrl from 'cryptocurrency-icons/svg/color/eth.svg';
import linkUrl from 'cryptocurrency-icons/svg/color/link.svg';
import ltcUrl from 'cryptocurrency-icons/svg/color/ltc.svg';
import maticUrl from 'cryptocurrency-icons/svg/color/matic.svg';
import solUrl from 'cryptocurrency-icons/svg/color/sol.svg';
import trxUrl from 'cryptocurrency-icons/svg/color/trx.svg';
import uniUrl from 'cryptocurrency-icons/svg/color/uni.svg';
import usdcUrl from 'cryptocurrency-icons/svg/color/usdc.svg';
import usdtUrl from 'cryptocurrency-icons/svg/color/usdt.svg';
import xrpUrl from 'cryptocurrency-icons/svg/color/xrp.svg';

import { cn } from '@/shared/lib/cn';

const ICONS: Record<string, string> = {
  AAVE: aaveUrl,
  ADA: adaUrl,
  ATOM: atomUrl,
  AVAX: avaxUrl,
  BNB: bnbUrl,
  BTC: btcUrl,
  DOGE: dogeUrl,
  DOT: dotUrl,
  ETH: ethUrl,
  LINK: linkUrl,
  LTC: ltcUrl,
  MATIC: maticUrl,
  SOL: solUrl,
  TRX: trxUrl,
  UNI: uniUrl,
  USDC: usdcUrl,
  USDT: usdtUrl,
  XRP: xrpUrl,
};

/**
 * Coin icon for an asset ticker. Renders the bundled SVG when one exists,
 * otherwise a neutral monogram chip (first 1-2 characters). Decorative, so it
 * is `aria-hidden` — the row's ticker + full name carry the label.
 */
export function CoinIcon({
  asset,
  className,
}: {
  readonly asset: string;
  readonly className?: string;
}): React.JSX.Element {
  const testId = `coin-icon-${asset}`;
  const url = ICONS[asset];
  if (url) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden
        width={20}
        height={20}
        className={cn('h-5 w-5 shrink-0 rounded-full', className)}
        data-testid={testId}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        'bg-bg-elevated border-border text-muted-fg flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
        className,
      )}
      data-testid={testId}
    >
      {asset.slice(0, 2)}
    </span>
  );
}
