-- Make the stored discovery config quote-asset agnostic.
--
-- Three keys carried a meaning that depended on the profile's quote asset, so
-- switching quote (USDT -> BTC) silently emptied the candidate set:
--
--   min24hQuoteVolume  compared against Binance's `quoteVolume`, which is
--                      denominated in the quote asset. 10000000 meant ten
--                      million dollars under USDT and ten million bitcoin under
--                      BTC. Replaced by min24hPairVolumeUsd (executability,
--                      this market's own volume in USD) and min24hAssetVolumeUsd
--                      (activity, the coin's USDT-market volume in USD).
--
--   changeMaxPercent   an absolute blow-off ceiling tuned on the USDT return
--                      distribution. Replaced by a cross-sectional rank band
--                      (rankTopPercent / rankExcludeTopPercent), which is
--                      invariant to the quote asset.
--
--   changeMinPercent   kept, but reset to '0'. Its old value ('5') was the sole
--                      lower bound of an absolute band; it is now a hurdle on
--                      top of the rank band, and 0 is the only value that means
--                      the same thing under every quote ("beat the asset you
--                      hold when flat"). Carrying '5' forward would silently
--                      change what the filter selects.
--
-- Dropped keys are removed rather than translated: there is no correct BTC
-- equivalent of a USDT-denominated floor. The zod schema supplies defaults for
-- the new keys, so a config missing them parses to the balanced posture.
--
-- Idempotent: re-running removes already-absent keys and re-writes the same '0'.
update profiles
set discovery_config =
      (discovery_config - 'min24hQuoteVolume' - 'changeMaxPercent')
      || jsonb_build_object('changeMinPercent', '0')
where discovery_config is not null
  and jsonb_typeof(discovery_config) = 'object';
