# PE Economics Interactive Guide

Interactive educational web app for explaining how private market fund economics translate from gross outcomes to net LP outcomes.

## What this app includes
- A full **Private Markets Economics** explainer with linked controls across sections.
- A new **Liquidity Management** page scaffold that separates:
  - normal-course liquidity (organic exits/distributions), and
  - secondary market liquidity (selling fund interests).
- A reusable visual style and component system for building additional education modules.

## Current pages
- `Private Markets Economics`
  - Gross baseline
  - Why this matters
  - Management fees
  - Fee nuances
  - Fund expenses
  - Carry mechanics
  - Waterfalls
  - Underinvesting
  - Fee/carry tradeoff
  - Quarterly schedule
  - Put it together
  - Conclusion
- `Liquidity Management` (scaffold)
  - Liquidity 101
  - Normal-course exits
  - Secondaries
  - Liquidity toolkit
  - To be built

## Run locally
1. Install dependencies:
   - `npm install`
2. Start dev server:
   - `npm run dev -- --host 127.0.0.1 --port 5174`
3. Open:
   - `http://127.0.0.1:5174/pe-economics/`

## Build
- `npm run build`

## Navigation behavior
- Header menu (top-right hamburger) now switches between pages:
  - `Private Markets Economics`
  - `Liquidity Management`
- Side nav updates to the active page sections.
- URL hash is used for section/page targeting.

## Notes
- Core modeling is centralized in `src/App.jsx` through shared quarterly schedule math.
- Baseline assumptions currently anchor around:
  - gross MOIC `2.5x`
  - net TVPI `2.0x`
