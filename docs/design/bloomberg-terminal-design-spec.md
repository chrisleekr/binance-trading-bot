# Bloomberg Terminal design reference

!!! note "Not the current design system"

    The canonical system is **`DESIGN.md`** at the repository root. This page is the
    amber Bloomberg research direction it grew out of, kept for its density, layout,
    and colour-accessibility rules. Nothing here describes the shipped UI.

    Every hex below is a third-party extraction or an interpretation. Bloomberg's
    production values are proprietary and unpublished.

## Colour

Established facts:

- The signature scheme is **amber text on black**. Amber is the default, non-semantic text colour and is treated as protected brand identity.
- Colour carries meaning beyond price: **bright blue and bright orange** mark non-price emphasis such as headlines and labels.
- **Red = down, green = up**, per Western financial convention.
- For colour-vision deficiency (most commonly red-green), Bloomberg ships schemes that swap the semantic pair to **blue up / red down** while **keeping amber non-semantic**. Two schemes (Deuteranopia, Protanomaly) are selectable via `PDFU COLORS`.

Third-party extracted palette:

| Role                        | Hex       | RGB         |
| --------------------------- | --------- | ----------- |
| Background black            | `#000000` | 0,0,0       |
| Brand amber "Sunshade"      | `#FFA028` | 255,160,40  |
| Amber, alternate extraction | `#FB8B1E` | 251,139,30  |
| Amber, alternate extraction | `#F39F41` | 243,159,65  |
| Down red                    | `#FF433D` | 255,67,61   |
| Up green (mint)             | `#4AF6C3` | 74,246,195  |
| Link / info blue            | `#0068FF` | 0,104,255   |
| Text white                  | `#FFFFFF` | 255,255,255 |

Token assignment:

| Token | Hex | Usage |
| --- | --- | --- |
| `bg/base` | `#000000` | App canvas and panel backgrounds. True black. |
| `bg/raised` | `#0A0A0A` | Panel surface one step above canvas. |
| `bg/row-alt` | `#121212` | Zebra rows; active row highlight. |
| `border/grid` | `#1E1E1E` | Hairline panel borders and table gridlines. |
| `text/primary` | `#E8E8E8` | Default body and numeric text. |
| `text/amber` | `#FFA028` | Section headers, labels, key commands, focus, command caret. Use deliberately, not everywhere. |
| `text/amber-dim` | `#B36E1C` | Sub-labels and inactive headers. |
| `text/muted` | `#7C7C7C` | Timestamps, units, de-emphasised metadata. |
| `up/green` | `#4AF6C3` | Price up, positive P/L, buy fills. |
| `down/red` | `#FF433D` | Price down, negative P/L, sell fills, errors. |
| `info/blue` | `#0068FF` | Links, selected ticker, neutral status. |
| `flash/up-bg` | `#0F3D30` | Transient cell background on an upward tick. |
| `flash/down-bg` | `#4A1311` | Transient cell background on a downward tick. |

CVD-safe alternate, mirroring Bloomberg's own choice: up = `#0068FF`, down = `#FF433D`, amber unchanged.

Amber `#FFA028` on `#000000` is ≈ 9.8:1 — passes WCAG AA and AAA for normal text. Verify any final amber against the actual background before shipping.

## Typography

Established facts:

- The original Terminal used a **9×19 monospaced bitmap font**, reproduced pixel by pixel when the Terminal moved to Windows.
- Around 2007 Bloomberg commissioned **Matthew Carter** to draw proportional and monospaced Terminal faces ("Bloomberg Prop Unicode").
- The interface is dense, text-driven, and historically monospaced so numeric columns align.

Rules:

- **Numerics, tables, tickers, command line: monospace.** Required for column alignment. The Bloomberg faces are proprietary; substitute a free tabular monospace. Stack: `"Roboto Mono", "JetBrains Mono", "IBM Plex Mono", "SF Mono", ui-monospace, monospace`. Enable tabular figures and slashed zero: `font-feature-settings: "tnum" 1, "zero" 1;`.
- **Labels, headers, prose: a tight grotesque sans.** Stack: `"Inter", "Roboto", system-ui, -apple-system, "Segoe UI", sans-serif`.
- **ALL CAPS** for panel and section headers, column headers, function-code labels, status-bar text, key glyphs. Add `letter-spacing: 0.04em` to keep caps legible small.
- **Sizes:** body and data 12–13px / line-height 1.25–1.35; dense table rows 11–12px / 1.15; headers and labels 11px caps; command input 13–14px mono; focused instrument price 20–28px mono tabular.
- **Numeric alignment:** right-align all numbers, fixed decimals per column, tabular figures so digits never reflow on tick.

## Layout and density

Established facts:

- **Core Terminal is four panels**, each with its own command line and function, tiled on one monitor or spread across several.
- **Launchpad** is a customisable grid of many small persistent components that stay visible at all times.
- The Terminal is the canonical example of **maximum information density**.
- Navigation is **command-line driven**: type a function into the panel command line and press `<GO>`.

Rules:

- **Persistent full-width top command bar:** monospace input on the left following the `TICKER <SECTOR> FUNCTION <GO>` model, global status and clock on the right, amber caret, always keyboard-focusable.
- **Tiled multi-panel workspace** below the bar, defaulting to a 2×2 grid. Each panel has its own ALL-CAPS amber header with a function code, optional mini command line, and independent scroll. Panels resize; layout is savable.
- **Density:** 4–8px cell padding, not 16–24px. Hairline borders, no drop shadows, no rounded cards, no hero whitespace. One row should hold price, change, %change, volume, and a sparkline without wrapping.
- **Function-code navigation:** every view gets a short mnemonic shown in its header and reachable from the command bar — `WL` watch list, `OB` order book, `POS` positions, `PNL` profit and loss, `CHRT` chart, `BLT` blotter. Typing a code swaps the active panel.

## Components

**Data tables**

- Black background, hairline `#1E1E1E` gridlines, no card chrome.
- ALL-CAPS amber column headers at 11px; numeric columns right-aligned.
- Row height 20–24px. Optional zebra via `#0A0A0A` / `#000000`.
- Selected row: 2px left amber rule plus `#121212` background.
- Numbers monospace and tabular, fixed decimals per column.

**Tickers and live quotes**

- Symbol in white, or blue when selected. Price mono tabular. Δ and %Δ coloured by sign.
- A `▲` / `▼` glyph prefixes the change, so sign is readable without colour.

**Flashing cells**

- On an upward tick, animate the cell background from `flash/up-bg` to transparent over 400–600ms and briefly brighten the text to `up/green`. Mirror for downward ticks.
- Under `prefers-reduced-motion`, replace the animation with a single-frame highlight.
- **Heat colouring:** shade cell backgrounds by magnitude with low-alpha green or red so a column reads as a heatmap.

**Sparklines**

- Inline, about 60×16px, single 1px stroke coloured by the sign of the net change. No fill, or a very low-alpha matching fill. Place in the last table column.

**Headers and status bar**

- Top command bar: amber prompt glyph, mono input, right-aligned UTC and local clock, connection dot (green connected, amber degraded, red disconnected).
- Panel headers: ALL-CAPS amber title, function-code badge, small right-aligned controls.
- Bottom status bar: ALL-CAPS muted live counters, e.g. `WS: LIVE  ORDERS: 3  PNL: +1.42%`.

**Charts**

- Financial: candlesticks, green up and red down, amber crosshair, muted grid. Non-financial metrics: line or area in the same palette.

## Interaction

Established facts:

- **Keyboard-first and command-driven.** A command is `TICKER <MARKET/SECTOR> FUNCTION CODE <GO>` — `VOD LN Equity <GO>` loads Vodafone on the London venue.
- **`<GO>` is the Enter key**, coloured green.
- The keyboard was redesigned for traders with no computer background: memorable names and colours replaced technical key names.
- **Colour-coded market-sector function keys** map F-keys to asset classes: `F2 GOVT`, `F3 CORP`, `F4 MTGE`, `F5 M-Mkt`, `F8 EQUITY`, `F9 COMDTY`, `F10 INDEX`, `F11 CURNCY`.

Rules:

- **Command palette as primary navigation.** Accept `SYMBOL FUNCTION` plus Enter. Style the submit affordance green and label it `GO`. `BTCUSDT OB` focuses the BTC order book.
- **Mnemonic function codes** shown in headers so the vocabulary is learnable.
- **Category colour-coding** in command-bar autocomplete — market data blue, orders and execution amber, analytics green — as the web echo of the coloured keyboard.
- **Full keyboard operability:** `/` or `Ctrl-K` focuses the command bar, `Enter` is GO, `Esc` clears, arrows move row selection, `1`–`4` jump between panels, `g` plus a code works as a chord.
- **Avoid modals.** Prefer in-place panel swaps over dialogs.

## Design tokens

```json
{
  "color": {
    "bg": { "canvas": "#000000", "raised": "#0A0A0A", "rowAlt": "#121212", "rowActive": "#161616" },
    "border": { "grid": "#1E1E1E", "strong": "#2A2A2A" },
    "text": {
      "primary": "#E8E8E8",
      "muted": "#7C7C7C",
      "amber": "#FFA028",
      "amberDim": "#B36E1C",
      "white": "#FFFFFF"
    },
    "semantic": { "up": "#4AF6C3", "down": "#FF433D", "info": "#0068FF", "warn": "#FFA028" },
    "flash": { "upBg": "#0F3D30", "downBg": "#4A1311" },
    "cvdAlt": { "up": "#0068FF", "down": "#FF433D" },
    "status": { "connected": "#4AF6C3", "degraded": "#FFA028", "disconnected": "#FF433D" }
  },
  "font": {
    "mono": "\"Roboto Mono\", \"JetBrains Mono\", \"IBM Plex Mono\", \"SF Mono\", ui-monospace, monospace",
    "sans": "\"Inter\", \"Roboto\", system-ui, -apple-system, \"Segoe UI\", sans-serif",
    "features": "\"tnum\" 1, \"zero\" 1"
  },
  "fontSize": {
    "tableDense": "11px",
    "data": "12px",
    "body": "13px",
    "command": "14px",
    "label": "11px",
    "quoteBig": "24px"
  },
  "lineHeight": { "dense": 1.15, "data": 1.3, "body": 1.4 },
  "letterSpacing": { "caps": "0.04em" },
  "space": { "cellX": "6px", "cellY": "3px", "panelPad": "8px", "gridGap": "1px" },
  "radius": { "none": "0px", "subtle": "2px" },
  "border": { "hairline": "1px solid #1E1E1E" },
  "shadow": { "none": "none" },
  "motion": { "flashMs": 500, "flashEasing": "ease-out" },
  "density": {
    "rowHeight": "22px",
    "headerHeight": "20px",
    "commandBarHeight": "34px",
    "statusBarHeight": "22px"
  }
}
```

## Sources

Bloomberg's own UX articles are paywalled or 403 to automated fetch, so the facts above come from secondary reporting and third-party colour extraction. No hex here is official.

- Bloomberg UX — [Designing the Terminal for color accessibility](https://www.bloomberg.com/ux/2021/10/14/designing-the-terminal-for-color-accessibility/) (paywalled)
- Bloomberg LP — [How Terminal UX designers conceal complexity](https://www.bloomberg.com/company/stories/how-bloomberg-terminal-ux-designers-conceal-complexity/) (403)
- Wikipedia — [Bloomberg Terminal](https://en.wikipedia.org/wiki/Bloomberg_Terminal): keyboard, function codes, Core Terminal four panels, Launchpad
- Hacker News — [amber-on-black is still the default](https://news.ycombinator.com/item?id=34320343); [information-density reference](https://news.ycombinator.com/item?id=19153875)
- [jx22/berg](https://github.com/jx22/berg) — VS Code theme; bright blue/orange beyond red/green, "Bloomberg Prop Unicode N" naming
- [wadetandy/vim-bloomberg](https://github.com/wadetandy/vim-bloomberg/blob/master/colors/bloomberg.vim) — colourscheme
- [color-hex palette 111776](https://www.color-hex.com/color-palette/111776), [Mobbin brand colours](https://mobbin.com/colors/brand/bloomberg), [BrandColorCode](https://www.brandcolorcode.com/bloomberg-l-p) — extracted hex values
