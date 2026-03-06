import React, { useState, useMemo, useEffect, useRef } from 'react';
import vcWorldBenchmarksCsvUrl from '../VC World Benchmarks 1993-2025 Consolidated.csv?url';
import actualGrossNetCsvUrl from '../gross-net-spreads-actual.csv?url';
import pathwayWordmarkUrl from './assets/pathway-wordmark.svg';

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const formatCurrency = (value, decimals = 1) => {
  // Always display in millions for granular detail
  if (Math.abs(value) >= 1e6) {
    const millions = value / 1e6;
    if (millions >= 1000) {
      // For $1,000M+ show with comma: $1,500M
      return `$${millions.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}M`;
    }
    return `$${millions.toFixed(decimals)}M`;
  }
  if (Math.abs(value) >= 1e3) return `$${(value / 1e3).toFixed(decimals)}K`;
  return `$${value.toFixed(decimals)}`;
};

const formatPercent = (value, decimals = 1) => `${(value * 100).toFixed(decimals)}%`;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const solveAnnualIrr = (cashflows) => {
  if (!Array.isArray(cashflows) || cashflows.length < 2) return null;
  const hasPositive = cashflows.some((cf) => cf > 0);
  const hasNegative = cashflows.some((cf) => cf < 0);
  if (!hasPositive || !hasNegative) return null;

  const npv = (rate) => cashflows.reduce((sum, cf, idx) => sum + cf / Math.pow(1 + rate, idx), 0);
  let low = -0.95;
  let high = 2.5;
  let npvLow = npv(low);
  let npvHigh = npv(high);
  if (!Number.isFinite(npvLow) || !Number.isFinite(npvHigh) || npvLow * npvHigh > 0) return null;

  for (let i = 0; i < 120; i += 1) {
    const mid = (low + high) / 2;
    const npvMid = npv(mid);
    if (!Number.isFinite(npvMid)) return null;
    if (Math.abs(npvMid) < 1e-8) return mid;
    if (npvLow * npvMid <= 0) {
      high = mid;
      npvHigh = npvMid;
    } else {
      low = mid;
      npvLow = npvMid;
    }
  }
  return (low + high) / 2;
};

const TYPICAL_INFRA_CONTRIBUTION_PCT = [0.22, 0.24, 0.20, 0.14, 0.10, 0.06, 0.03, 0.01, 0, 0, 0, 0];
const TYPICAL_INFRA_DISTRIBUTION_PCT = [0, 0.02, 0.04, 0.06, 0.08, 0.11, 0.14, 0.16, 0.16, 0.13, 0.08, 0.02];
const LATE_HURDLE_DISTRIBUTION_PCT = [0, 0, 0, 0.01, 0.03, 0.06, 0.10, 0.14, 0.18, 0.20, 0.18, 0.10];
const LATE_HURDLE_RETURN_MULTIPLIERS = [0.35, 0.45, 0.55, 0.70, 0.80, 0.90, 1.00, 1.10, 1.20, 1.30, 1.35, 1.30];
const EDIF_FEE_DISCOUNT_SCHEDULE = [
  { min: 0, max: 50, headline: 0.0125, firstClose: 0.0110, existing: 0.0095 },
  { min: 50, max: 125, headline: 0.0110, firstClose: 0.0095, existing: 0.0080 },
  { min: 125, max: 200, headline: 0.0100, firstClose: 0.0085, existing: 0.0070 },
  { min: 200, max: 300, headline: 0.0090, firstClose: 0.0075, existing: 0.0060 },
  { min: 300, max: Number.POSITIVE_INFINITY, headline: 0.0080, firstClose: 0.0065, existing: 0.0050 }
];

const getEdifFeeRate = (commitmentM, tier = 'headline') => {
  const bucket = EDIF_FEE_DISCOUNT_SCHEDULE.find((row) => commitmentM >= row.min && commitmentM < row.max);
  if (!bucket) return EDIF_FEE_DISCOUNT_SCHEDULE[EDIF_FEE_DISCOUNT_SCHEDULE.length - 1].headline;
  if (tier === 'existing') return bucket.existing;
  if (tier === 'firstClose') return bucket.firstClose;
  return bucket.headline;
};

const buildAnnualReturnPath = (baseReturn, lateHurdleStress = false) => {
  if (!lateHurdleStress) {
    return Array.from({ length: 12 }, () => baseReturn);
  }
  const avgMultiplier = LATE_HURDLE_RETURN_MULTIPLIERS.reduce((sum, v) => sum + v, 0) / LATE_HURDLE_RETURN_MULTIPLIERS.length;
  return LATE_HURDLE_RETURN_MULTIPLIERS.map((m) => clamp(baseReturn * (m / avgMultiplier), -0.40, 0.50));
};

const runTermStructureModel = ({
  commitmentM,
  contributionPctByYear,
  distributionPctByYear,
  baseReturn,
  timingSkew,
  annualReturnPath = null,
  escrowYield,
  lpAltReinvestRate,
  terms
}) => {
  const years = Math.min(contributionPctByYear.length, distributionPctByYear.length);
  const rows = [];
  const contributions = [];
  let nav = 0;
  let cumulativeContrib = 0;
  let cumulativeGrossDist = 0;
  let cumulativeLpDist = 0;
  let cumulativeFees = 0;
  let cumulativeExpenses = 0;
  let cumulativeCarryPaid = 0;
  let cumulativeCarryPaidToGP = 0;
  let cumulativeCarryAccrued = 0;
  let cumulativeCarryEscrowed = 0;
  let escrowBalance = 0;
  let finalCarryEntitlement = 0;
  const lpCashflows = [0];

  for (let i = 0; i < years; i += 1) {
    const year = i + 1;
    const navStart = nav;
    const contribPct = Math.max(0, contributionPctByYear[i] || 0);
    const distPct = Math.max(0, distributionPctByYear[i] || 0);
    const called = commitmentM * contribPct * 1e6;
    contributions.push(called);
    cumulativeContrib += called;
    const skewFactor = years > 1 ? ((i / (years - 1)) - 0.5) * 2 : 0;
    const pathReturn = Array.isArray(annualReturnPath) ? annualReturnPath[i] : null;
    const grossReturn = Number.isFinite(pathReturn)
      ? clamp(pathReturn, -0.40, 0.50)
      : clamp(baseReturn + timingSkew * skewFactor, -0.40, 0.50);
    const capitalAtWork = Math.max(0, nav + called * 0.5);
    const grossGain = capitalAtWork * grossReturn;
    let navBeforeDist = Math.max(0, nav + called + grossGain);
    let grossDistRequested = commitmentM * distPct * 1e6;
    if (terms.forceLiquidationAtEnd && year === years) {
      grossDistRequested += navBeforeDist;
    }
    const grossDistPaid = Math.min(navBeforeDist, grossDistRequested);
    navBeforeDist -= grossDistPaid;

    let feeBase = terms.feeMode === 'invested'
      ? Math.max(0, capitalAtWork)
      : terms.feeMode === 'committed'
        ? commitmentM * 1e6
        : terms.feeMode === 'nav'
          ? Math.max(0, navStart)
          : year <= (terms.investmentPeriodYears || 5)
            ? commitmentM * 1e6
            : Math.max(0, navStart);
    let feeRate = Number.isFinite(terms.feeRate)
      ? terms.feeRate
      : terms.feeMode === 'invested'
        ? terms.feeRateInvested
        : year <= (terms.investmentPeriodYears || 5)
          ? terms.feeRateCommitted
          : terms.feeRateNav;
    if (terms.stepDownEnabled && year > (terms.investmentPeriodYears || 5)) {
      feeBase = terms.stepDownBasis === 'invested'
        ? Math.max(0, capitalAtWork)
        : terms.stepDownBasis === 'committed'
          ? commitmentM * 1e6
          : Math.max(0, navStart);
      feeRate = terms.stepDownFeeRate;
    }
    const fee = feeBase * feeRate;
    const expense = feeBase * terms.expenseRate;
    cumulativeFees += fee;
    cumulativeExpenses += expense;

    const hurdleValue = contributions.reduce(
      (sum, amount, idx) => sum + amount * Math.pow(1 + terms.hurdleRate, Math.max(0, year - idx)),
      0
    );
    const availableValue = cumulativeGrossDist + grossDistPaid + navBeforeDist;
    const profitsAboveCapital = Math.max(0, availableValue - cumulativeContrib);
    const outperformanceAboveHurdle = Math.max(0, availableValue - hurdleValue);
    const carryEntitlementCum = terms.catchupMode === 'full'
      ? (availableValue > hurdleValue ? terms.carryRate * profitsAboveCapital : 0)
      : terms.carryRate * outperformanceAboveHurdle;
    finalCarryEntitlement = carryEntitlementCum;
    const carryDueNow = Math.max(0, carryEntitlementCum - cumulativeCarryPaid);
    cumulativeCarryAccrued += carryDueNow;
    const navForCap = Math.max(0, navStart);
    const annualCap = Number.isFinite(terms.annualCarryCapRate) ? terms.annualCarryCapRate * navForCap : Number.POSITIVE_INFINITY;
    const minLpYield = Math.max(0, terms.minNetYieldRate || 0) * commitmentM * 1e6;
    const carryCashLimit = Math.max(0, grossDistPaid - minLpYield);
    const carryPaid = Math.min(carryCashLimit, carryDueNow, annualCap);
    const gpCashCarry = carryPaid * (1 - terms.escrowFraction);
    const escrowDeposit = carryPaid * terms.escrowFraction;
    escrowBalance = escrowBalance * (1 + escrowYield) + escrowDeposit;
    cumulativeCarryPaid += carryPaid;
    cumulativeCarryPaidToGP += gpCashCarry;
    cumulativeCarryEscrowed += escrowDeposit;

    let lpDistribution = Math.max(0, grossDistPaid - carryPaid);
    cumulativeGrossDist += grossDistPaid;
    cumulativeLpDist += lpDistribution;

    const lpOutflow = called + fee + expense;
    let lpNetCashflow = lpDistribution - lpOutflow;
    lpCashflows.push(lpNetCashflow);
    nav = Math.max(0, navBeforeDist);

    rows.push({
      year,
      grossReturn,
      navStart,
      navForCap,
      called,
      grossDist: grossDistPaid,
      lpDistribution,
      fee,
      expense,
      carryAccrued: carryDueNow,
      carryAccruedCumulative: cumulativeCarryAccrued,
      carryPaid,
      gpCashCarry,
      escrowDeposit,
      escrowReleaseToGP: 0,
      escrowReturnToLP: 0,
      annualCarryCapAmount: Number.isFinite(annualCap) ? annualCap : null,
      escrowBalanceEnd: escrowBalance,
      navEnd: nav
    });
  }

  let escrowPayoutToGPFinal = 0;
  let escrowReturnedToLPFinal = 0;
  if (rows.length > 0) {
    const finalGpDue = Math.max(0, finalCarryEntitlement - cumulativeCarryPaidToGP);
    escrowPayoutToGPFinal = Math.min(escrowBalance, finalGpDue);
    escrowReturnedToLPFinal = Math.max(0, escrowBalance - escrowPayoutToGPFinal);
    const finalRow = rows[rows.length - 1];
    finalRow.escrowReleaseToGP = escrowPayoutToGPFinal;
    finalRow.escrowReturnToLP = escrowReturnedToLPFinal;
    finalRow.escrowBalanceEnd = 0;
    finalRow.lpDistribution += escrowReturnedToLPFinal;
    const finalLpNet = finalRow.lpDistribution - finalRow.called - finalRow.fee - finalRow.expense;
    lpCashflows[lpCashflows.length - 1] = finalLpNet;
    cumulativeLpDist += escrowReturnedToLPFinal;
    cumulativeCarryPaidToGP += escrowPayoutToGPFinal;
    escrowBalance = 0;
  }

  const totalContrib = cumulativeContrib;
  const totalValueToLP = cumulativeLpDist + nav;
  const netMultiple = totalContrib > 0 ? totalValueToLP / totalContrib : 0;
  const irrCashflows = [...lpCashflows];
  if (irrCashflows.length > 0) {
    irrCashflows[irrCashflows.length - 1] += nav;
  }
  const lpIrr = solveAnnualIrr(irrCashflows);
  const lpReinvestAltFutureValue = rows.reduce(
    (sum, row) => sum + row.escrowDeposit * Math.pow(1 + lpAltReinvestRate, Math.max(0, years - row.year)),
    0
  );
  const escrowFutureValue = rows.reduce(
    (sum, row) => sum + row.escrowDeposit * Math.pow(1 + escrowYield, Math.max(0, years - row.year)),
    0
  );

  return {
    rows,
    totals: {
      totalContrib,
      totalGrossDist: cumulativeGrossDist,
      totalLpDist: cumulativeLpDist,
      totalFees: cumulativeFees,
      totalExpenses: cumulativeExpenses,
      totalCarryPaid: cumulativeCarryPaid,
      totalCarryPaidToGP: cumulativeCarryPaidToGP,
      totalCarryEscrowed: cumulativeCarryEscrowed,
      escrowPayoutToGPFinal,
      escrowReturnedToLPFinal,
      finalCarryEntitlement,
      escrowBalance,
      netMultiple,
      lpIrr,
      lpReinvestOpportunityCost: Math.max(0, lpReinvestAltFutureValue - escrowFutureValue)
    }
  };
};

// Baseline reference values used across examples.
// Net outputs shown in the public economics guide are derived from schedule math.
const BASELINE_GROSS_TVPI = 2.5;
const BASELINE_NET_TVPI = 2.0;
const MIN_NET_TVPI = 1.0;
const BASELINE_MODEL_INPUTS = {
  fundSize: 500,          // millions
  fundLife: 12,
  investmentPeriod: 5,
  mgmtFeeRate: 0.02,
  expenseRate: 0.005,
  carryRate: 0.20,
  hurdleRate: 0.08
};

// ============================================================================
// REUSABLE COMPONENTS
// ============================================================================

const Slider = ({ value, onChange, min, max, step = 0.01, label, format = (v) => v, accent = '#1B2A4A', disabled = false }) => {
  const percentage = ((value - min) / (max - min)) * 100;

  return (
    <div className={`slider-container ${disabled ? 'disabled' : ''}`}>
      <div className="slider-header">
        <span className="slider-label">{label}</span>
        <span className="slider-value" style={{ color: accent }}>{format(value)}</span>
      </div>
      <div className="slider-track-container">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="slider-input"
          style={{
            background: `linear-gradient(to right, ${accent} 0%, ${accent} ${percentage}%, #D9D5CF ${percentage}%, #D9D5CF 100%)`
          }}
        />
      </div>
    </div>
  );
};

const MetricCard = ({ label, value, subtext, accent = '#1B2A4A' }) => (
  <div className="metric-card">
    <div className="metric-label">{label}</div>
    <div className="metric-value" style={{ color: accent }}>{value}</div>
    {subtext && <div className="metric-subtext">{subtext}</div>}
  </div>
);

const ToggleSwitch = ({ options, value, onChange, accent = '#1B2A4A' }) => (
  <div className="toggle-container">
    {options.map((option) => (
      <button
        key={option.value}
        className={`toggle-button ${value === option.value ? 'active' : ''}`}
        onClick={() => onChange(option.value)}
        style={value === option.value ? { backgroundColor: accent, borderColor: accent } : {}}
      >
        {option.label}
      </button>
    ))}
  </div>
);

const ResetButton = ({ onClick, label = 'Reset' }) => (
  <button type="button" className="reset-button" onClick={onClick}>
    {label}
  </button>
);

const WhatWeDidntCover = ({ items = [] }) => (
  <div className="not-covered-block">
    <div className="not-covered-title">What we didn&apos;t cover:</div>
    <ul className="not-covered-list">
      {items.map((item, idx) => (
        <li key={idx}>{item}</li>
      ))}
    </ul>
  </div>
);

const NuanceDisclosure = ({ title = 'Nuance', summary = 'Optional detail for readers who want more context.', children }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className={`nuance-disclosure ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="nuance-disclosure-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <span className="nuance-disclosure-left">
          <span className="nuance-disclosure-kicker">Nuance</span>
          <span className="nuance-disclosure-title">{title}</span>
          <span className="nuance-disclosure-summary">{summary}</span>
        </span>
        <span className="nuance-disclosure-action">{open ? 'Hide' : 'Learn more'}</span>
      </button>

      {open && (
        <div className="nuance-disclosure-panel" role="note" aria-label={`${title} nuance detail`}>
          {children}
        </div>
      )}
    </div>
  );
};

const SECTION_LINKS = [
  { id: 'hero-baseline', label: 'Gross Baseline' },
  { id: 'why-matters', label: 'Why This Matters' },
  { id: 'management-fees', label: 'Management Fees' },
  { id: 'fund-expenses', label: 'Fund Expenses' },
  { id: 'lines-of-credit', label: 'Lines of Credit' },
  { id: 'carried-interest', label: 'Carry Mechanics' },
  { id: 'waterfall-structures', label: 'Waterfalls' },
  { id: 'underinvesting-impact', label: 'Underinvesting' },
  { id: 'fee-carry-tradeoff', label: 'Fee/Carry Tradeoff' },
  { id: 'quarterly-schedule', label: 'Quarterly Schedule' },
  { id: 'conclusion', label: 'Conclusion' }
];

const LIQUIDITY_SECTION_LINKS = [
  { id: 'liquidity-hero', label: 'Liquidity 101' },
  { id: 'liquidity-normal-course', label: 'Normal-Course Exits' },
  { id: 'liquidity-secondaries', label: 'Secondaries' },
  { id: 'liquidity-toolkit', label: 'Liquidity Toolkit' },
  { id: 'liquidity-to-be-built', label: 'To Be Built' }
];

const ENVIRONMENT_SECTION_LINKS = [
  { id: 'environment-hero', label: 'Report Overview' },
  { id: 'environment-explorer', label: 'Interactive Report' },
  { id: 'environment-themes', label: 'Theme Lens' },
  { id: 'environment-delta-lab', label: 'QoQ Delta Lab' },
  { id: 'environment-conversion', label: 'Chart Conversion' },
  { id: 'environment-build-plan', label: 'To Be Built' }
];

const PORTFOLIO_SECTION_LINKS = [
  { id: 'portfolio-hero', label: 'Portfolio Construction 101' },
  { id: 'portfolio-level-set', label: 'Plain-English Level Set' },
  { id: 'portfolio-single-fund', label: 'Single Fund Lifecycle' },
  { id: 'portfolio-layering', label: 'Vintage Layering' },
  { id: 'portfolio-future-forecast', label: 'Future Forecast Funnel' },
  { id: 'portfolio-strategies', label: 'Strategy Curves' },
  { id: 'portfolio-types', label: 'Investment Type Mix' },
  { id: 'portfolio-targeting', label: 'Chasing Exposure Targets' },
  { id: 'portfolio-adjusting', label: 'Adjusting Exposure' },
  { id: 'portfolio-riffs', label: 'Implementation Riffs' }
];

const ASIA_SECTION_LINKS = [
  { id: 'asia-hero', label: 'Asia PE Overview' },
  { id: 'asia-why-now', label: 'Why Asia in PE' },
  { id: 'asia-market-structure', label: 'Market Structure' },
  { id: 'asia-dd', label: 'Manager Due Diligence' },
  { id: 'asia-portfolio-design', label: 'Portfolio Design' },
  { id: 'asia-execution-governance', label: 'Execution & Governance' },
  { id: 'asia-red-flags', label: 'Red Flags' },
  { id: 'asia-playbook', label: 'LP Playbook' }
];

const CUSTOM_TERMS_SECTION_LINKS = [
  { id: 'custom-terms-hero', label: 'Term Summary' },
  { id: 'custom-terms-model', label: 'Interactive Model' }
];

const BENCHMARK_SECTION_LINKS = [
  { id: 'benchmark-hero', label: 'Dataset Overview' },
  { id: 'benchmark-explorer', label: 'Flexible Explorer' },
  { id: 'benchmark-table', label: 'Raw Data Analyzer' }
];

const ENVIRONMENT_REPORT_FILE = 'pathway-4q25-private-market-environment-report.pdf';
const ENVIRONMENT_REPORT_PAGE_COUNT = 48;
const CONTACT_EMAIL = 'newinvestors@pathwaycapital.com';
const SITE_AS_OF_DATE = 'March 6, 2026';
const DISCLAIMER_STORAGE_KEY = 'pathway-pe-economics-disclaimer-v1';
const ACTUAL_SPREAD_DISPLAY_COUNT = 804;
const ACTUAL_SPREAD_VINTAGE_RANGE_LABEL = '1993 to 2021';
const ACTUAL_SPREAD_X_DOMAIN = [0.5, 4.25];
const ACTUAL_SPREAD_Y_DOMAIN = [0.25, 3.25];
const ACTUAL_SPREAD_TARGET = { gross: 2.5, net: 2.0 };
const ACTUAL_SPREAD_FOCUS_WINDOW = {
  grossMin: 2.3,
  grossMax: 2.7,
  netMin: 1.8,
  netMax: 2.2
};

const buildMailtoHref = (subject) => `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;

const WALKTHROUGH_MAILTO = buildMailtoHref('Pathway Private Markets Economics Walkthrough');

const SideNav = ({ sections }) => {
  const [activeId, setActiveId] = useState(sections[0]?.id || '');

  useEffect(() => {
    const updateActive = () => {
      let current = sections[0]?.id || '';
      sections.forEach((section) => {
        const el = document.getElementById(section.id);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.top <= 140) {
          current = section.id;
        }
      });
      setActiveId(current);
    };

    updateActive();
    window.addEventListener('scroll', updateActive, { passive: true });
    window.addEventListener('resize', updateActive);
    return () => {
      window.removeEventListener('scroll', updateActive);
      window.removeEventListener('resize', updateActive);
    };
  }, [sections]);

  return (
    <aside className="side-nav">
      <div className="side-nav-title">Guide Sections</div>
      <nav className="side-nav-links">
        {sections.map((section, index) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className={`side-nav-link ${activeId === section.id ? 'active' : ''}`}
          >
            <span className="side-nav-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="side-nav-text">{section.label}</span>
          </a>
        ))}
      </nav>
    </aside>
  );
};

// ============================================================================
// VISUALIZATION COMPONENTS
// ============================================================================

const BarChart = ({ data, height = 200, accent = '#1B2A4A', showLabels = true, yDomain = null }) => {
  const safeValues = data.map((d) => (Number.isFinite(d.value) ? d.value : 0));
  const domainMin = yDomain && Number.isFinite(yDomain[0]) ? yDomain[0] : 0;
  const autoMax = Math.max(...safeValues);
  const domainMax = yDomain && Number.isFinite(yDomain[1]) ? yDomain[1] : autoMax;
  const minValue = Math.min(domainMin, domainMax);
  const maxValue = Math.max(domainMin, domainMax, minValue + 1e-9);
  const range = Math.max(1e-9, maxValue - minValue);

  return (
    <div className="bar-chart" style={{ height }}>
      <div className="bar-chart-bars">
        {data.map((d, i) => {
          const safeValue = Number.isFinite(d.value) ? d.value : 0;
          const normalizedHeight = safeValue > minValue
            ? Math.max(2, ((safeValue - minValue) / range) * 100)
            : 0;
          return (
          <div key={i} className="bar-column">
            <div className="bar-value-label">{d.valueLabel || formatCurrency(safeValue, 0)}</div>
            <div
              className="bar"
              style={{
                height: `${normalizedHeight}%`,
                backgroundColor: d.color || accent,
                opacity: d.opacity || 1
              }}
            />
            {showLabels && <div className="bar-label">{d.label}</div>}
          </div>
          );
        })}
      </div>
    </div>
  );
};

const FlowDiagram = ({ stages, height = 300 }) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.scale(dpr, dpr);

    const width = canvas.offsetWidth;
    const h = canvas.offsetHeight;

    ctx.clearRect(0, 0, width, h);

    const stageWidth = width / stages.length;
    const maxValue = Math.max(...stages.map(s => s.value));

    stages.forEach((stage, i) => {
      const x = i * stageWidth + stageWidth / 2;
      const barHeight = (stage.value / maxValue) * (h - 80);
      const y = h - 40 - barHeight;

      // Draw bar
      ctx.fillStyle = stage.color || '#1B2A4A';
      ctx.fillRect(x - 30, y, 60, barHeight);

      // Draw label
      ctx.fillStyle = '#9A9690';
      ctx.font = '12px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(stage.label, x, h - 20);

      // Draw value
      ctx.fillStyle = '#1B2A4A';
      ctx.font = 'bold 14px system-ui';
      ctx.fillText(stage.valueLabel || formatCurrency(stage.value, 1), x, y - 10);

      // Draw flow arrow
      if (i < stages.length - 1) {
        const nextStage = stages[i + 1];
        const nextBarHeight = (nextStage.value / maxValue) * (h - 80);
        const nextY = h - 40 - nextBarHeight;

        ctx.strokeStyle = '#9A9690';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + 35, y + barHeight / 2);
        ctx.lineTo(x + stageWidth - 35, nextY + nextBarHeight / 2);
        ctx.stroke();

        // Arrow head
        const angle = Math.atan2(nextY + nextBarHeight / 2 - (y + barHeight / 2), stageWidth - 70);
        ctx.beginPath();
        ctx.moveTo(x + stageWidth - 35, nextY + nextBarHeight / 2);
        ctx.lineTo(x + stageWidth - 45, nextY + nextBarHeight / 2 - 8);
        ctx.lineTo(x + stageWidth - 45, nextY + nextBarHeight / 2 + 8);
        ctx.closePath();
        ctx.fillStyle = '#9A9690';
        ctx.fill();
      }
    });
  }, [stages]);

  return <canvas ref={canvasRef} className="flow-canvas" style={{ width: '100%', height }} />;
};

const WaterfallChart = ({ data, height = 280 }) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.scale(dpr, dpr);

    const width = canvas.offsetWidth;
    const h = canvas.offsetHeight;

    ctx.clearRect(0, 0, width, h);

    const padding = { top: 46, bottom: 64, left: 24, right: 24 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = h - padding.top - padding.bottom;
    const baselineY = padding.top + chartHeight;

    const maxValue = Math.max(0.0001, ...data.map((d) => d.cumulative));
    const barWidth = chartWidth / data.length * 0.6;
    const gap = chartWidth / data.length * 0.4;
    const minBarHeight = 2;

    let runningTotal = 0;
    let previousX = null;

    const drawValueLabel = (label, x, y) => {
      ctx.font = '600 12px Helvetica Neue';
      const textWidth = ctx.measureText(label).width;
      const padX = 6;
      const padY = 3;
      const boxWidth = textWidth + padX * 2;
      const boxHeight = 18;
      const boxX = x - boxWidth / 2;
      const boxY = y - boxHeight + 3;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
      ctx.strokeStyle = 'rgba(27, 42, 74, 0.14)';
      ctx.lineWidth = 1;
      ctx.strokeRect(boxX, boxY, boxWidth, boxHeight);

      ctx.fillStyle = '#1B2A4A';
      ctx.textAlign = 'center';
      ctx.fillText(label, x, y);
    };

    data.forEach((d, i) => {
      const x = padding.left + i * (barWidth + gap) + gap / 2;
      const cumulativeY = padding.top + (1 - d.cumulative / maxValue) * chartHeight;
      const previousY = i === 0 ? baselineY : padding.top + (1 - runningTotal / maxValue) * chartHeight;

      // Connector line from previous bar
      if (i > 0) {
        ctx.strokeStyle = '#7f8ea5';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo(previousX + barWidth, previousY);
        ctx.lineTo(x, previousY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw bar
      ctx.fillStyle = d.color;
      if (d.fullBar) {
        const fullHeight = Math.max(minBarHeight, baselineY - cumulativeY);
        ctx.fillRect(x, cumulativeY, barWidth, fullHeight);
      } else {
        const barTop = d.isIncrease ? Math.min(previousY, cumulativeY) : previousY;
        const barHeight = Math.max(minBarHeight, Math.abs(previousY - cumulativeY));
        ctx.fillRect(x, barTop, barWidth, barHeight);
      }

      // Draw value label
      const labelY = d.fullBar
        ? cumulativeY - 8
        : Math.min(previousY, cumulativeY) - 8;
      drawValueLabel(d.valueLabel, x + barWidth / 2, labelY);

      // Draw category label
      ctx.fillStyle = '#9A9690';
      ctx.font = '12px Helvetica Neue';
      ctx.textAlign = 'center';

      // Word wrap for labels
      const words = d.label.split(' ');
      let line = '';
      let lineY = h - padding.bottom + 20;
      words.forEach((word) => {
        const testLine = line + (line ? ' ' : '') + word;
        if (ctx.measureText(testLine).width > barWidth + gap * 0.8) {
          ctx.fillText(line, x + barWidth / 2, lineY);
          line = word;
          lineY += 12;
        } else {
          line = testLine;
        }
      });
      ctx.fillText(line, x + barWidth / 2, lineY);

      previousX = x;
      runningTotal = d.cumulative;
    });
  }, [data]);

  return <canvas ref={canvasRef} className="waterfall-canvas" style={{ width: '100%', height }} />;
};

const TimelineChart = ({ data, height = 200, showCumulative = false }) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.scale(dpr, dpr);

    const width = canvas.offsetWidth;
    const h = canvas.offsetHeight;

    ctx.clearRect(0, 0, width, h);

    const padding = { top: 30, bottom: 40, left: 50, right: 20 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = h - padding.top - padding.bottom;

    const values = showCumulative ? data.map(d => d.cumulative) : data.map(d => d.value);
    const maxValue = Math.max(...values) * 1.1;
    const minValue = Math.min(0, ...values);
    const range = maxValue - minValue;

    // Draw grid
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (i / 4) * chartHeight;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      const val = maxValue - (i / 4) * range;
      ctx.fillStyle = '#9A9690';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(formatCurrency(val, 0), padding.left - 8, y + 4);
    }

    // Draw line
    ctx.strokeStyle = '#1B2A4A';
    ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = padding.left + (i / (data.length - 1)) * chartWidth;
      const val = showCumulative ? d.cumulative : d.value;
      const y = padding.top + ((maxValue - val) / range) * chartHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw points
    data.forEach((d, i) => {
      const x = padding.left + (i / (data.length - 1)) * chartWidth;
      const val = showCumulative ? d.cumulative : d.value;
      const y = padding.top + ((maxValue - val) / range) * chartHeight;

      ctx.fillStyle = '#1B2A4A';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();

      // Year label
      ctx.fillStyle = '#9A9690';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(d.label, x, h - padding.bottom + 20);
    });
  }, [data, showCumulative]);

  return <canvas ref={canvasRef} className="timeline-canvas" style={{ width: '100%', height }} />;
};

const ComparisonChart = ({
  seriesA,
  seriesB,
  labelA,
  labelB,
  height = 250,
  colorA = '#1B2A4A',
  colorB = '#B5473A',
  xLabels = null,
  xTickStep = 1,
  yFormatter = (v) => formatCurrency(v, 0),
  shiftArrows = [],
  animateShiftArrows = false,
  marker = null,
  showLegend = true,
  inlineLabels = [],
  continuationArrowA = null,
  xAxisLabel = null,
  xAxisStartLabel = null,
  xAxisEndLabel = null
}) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext('2d');
    let rafId = null;

    const draw = (timestamp = 0) => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.offsetWidth;
      const h = canvas.offsetHeight;

      canvas.width = width * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, h);

      const length = Math.min(seriesA.length, seriesB.length);
      if (length === 0) return;

      const safeSeriesA = seriesA.slice(0, length);
      const safeSeriesB = seriesB.slice(0, length);
      const denominator = Math.max(1, length - 1);

      const needsXAxisTitle = Boolean(xAxisLabel || xAxisStartLabel || xAxisEndLabel);
      const padding = { top: 40, bottom: needsXAxisTitle ? 72 : 50, left: 60, right: 20 };
      const chartWidth = width - padding.left - padding.right;
      const chartHeight = h - padding.top - padding.bottom;

      const allValues = [...safeSeriesA, ...safeSeriesB];
      const maxValue = Math.max(...allValues) * 1.1;
      const minValue = Math.min(...allValues, 0) * 1.1;
      const range = Math.max(1e-9, maxValue - minValue);
      const xForIndex = (index) => padding.left + (index / denominator) * chartWidth;
      const yForValue = (value) => padding.top + ((maxValue - value) / range) * chartHeight;

      // Draw zero line if applicable
      if (minValue < 0) {
        const zeroY = padding.top + (maxValue / range) * chartHeight;
        ctx.strokeStyle = '#9A9690';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padding.left, zeroY);
        ctx.lineTo(width - padding.right, zeroY);
        ctx.stroke();
      }

      // Draw grid
      ctx.strokeStyle = '#E8E6E1';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = padding.top + (i / 4) * chartHeight;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();

        const val = maxValue - (i / 4) * range;
        ctx.fillStyle = '#9A9690';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'right';
        ctx.fillText(yFormatter(val), padding.left - 8, y + 4);
      }

      // Draw series A
      ctx.strokeStyle = colorA;
      ctx.lineWidth = 2;
      ctx.beginPath();
      safeSeriesA.forEach((val, i) => {
        const x = xForIndex(i);
        const y = yForValue(val);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Draw series B
      ctx.strokeStyle = colorB;
      ctx.lineWidth = 2;
      ctx.beginPath();
      safeSeriesB.forEach((val, i) => {
        const x = xForIndex(i);
        const y = yForValue(val);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      if (continuationArrowA) {
        const lastIdx = length - 1;
        const prevIdx = Math.max(0, lastIdx - 1);
        const startX = xForIndex(lastIdx);
        const startY = yForValue(safeSeriesA[lastIdx]);
        const baseDx = xForIndex(lastIdx) - xForIndex(prevIdx);
        const baseDy = yForValue(safeSeriesA[lastIdx]) - yForValue(safeSeriesA[prevIdx]);
        const magnitude = Math.max(1e-6, Math.hypot(baseDx, baseDy));
        const ux = baseDx / magnitude;
        const uy = baseDy / magnitude;
        const targetX = Math.min(width - 6, startX + ux * 22);
        const targetY = Math.max(padding.top + 8, Math.min(h - padding.bottom - 8, startY + uy * 22));

        ctx.strokeStyle = continuationArrowA.color || colorA;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(targetX, targetY);
        ctx.stroke();

        const angle = Math.atan2(targetY - startY, targetX - startX);
        const head = 6;
        ctx.fillStyle = continuationArrowA.color || colorA;
        ctx.beginPath();
        ctx.moveTo(targetX, targetY);
        ctx.lineTo(
          targetX - head * Math.cos(angle - Math.PI / 6),
          targetY - head * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          targetX - head * Math.cos(angle + Math.PI / 6),
          targetY - head * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fill();

        if (continuationArrowA.text) {
          ctx.font = '600 10px Helvetica Neue';
          ctx.textAlign = 'right';
          ctx.fillStyle = continuationArrowA.color || colorA;
          ctx.fillText(continuationArrowA.text, targetX - 4, targetY - 6);
        }
      }

      if (inlineLabels.length > 0) {
        inlineLabels.forEach((item) => {
          const source = item.series === 'B' ? safeSeriesB : safeSeriesA;
          const baseColor = item.color || (item.series === 'B' ? colorB : colorA);
          const idx = Math.max(0, Math.min(length - 1, item.index ?? length - 1));
          const x = xForIndex(idx) + (item.dx ?? 8);
          const y = yForValue(source[idx]) + (item.dy ?? 0);
          const text = item.text || '';
          if (!text) return;

          ctx.font = '600 10px Helvetica Neue';
          const textWidth = ctx.measureText(text).width;
          const padX = 5;
          const boxW = textWidth + padX * 2;
          const boxH = 14;
          const drawX = Math.max(
            padding.left,
            Math.min(width - padding.right - boxW, x)
          );
          const drawY = Math.max(
            padding.top,
            Math.min(h - padding.bottom - boxH, y - boxH + 2)
          );

          ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
          ctx.fillRect(drawX, drawY, boxW, boxH);
          ctx.strokeStyle = 'rgba(27, 42, 74, 0.16)';
          ctx.lineWidth = 1;
          ctx.strokeRect(drawX, drawY, boxW, boxH);
          ctx.textAlign = 'left';
          ctx.fillStyle = baseColor;
          ctx.fillText(text, drawX + padX, drawY + 10);
        });
      }

      if (marker && Number.isFinite(marker.index) && marker.index >= 0 && marker.index < length) {
        const markerX = xForIndex(marker.index);
        const markerColor = marker.color || '#C9A84C';

        ctx.strokeStyle = markerColor;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(markerX, padding.top);
        ctx.lineTo(markerX, h - padding.bottom);
        ctx.stroke();
        ctx.setLineDash([]);

        const aY = yForValue(safeSeriesA[marker.index]);
        const bY = yForValue(safeSeriesB[marker.index]);
        [aY, bY].forEach((pointY) => {
          ctx.fillStyle = markerColor;
          ctx.beginPath();
          ctx.arc(markerX, pointY, 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        });

        if (marker.label) {
          ctx.font = '600 10px Helvetica Neue';
          const textWidth = ctx.measureText(marker.label).width;
          const badgeX = Math.min(width - padding.right - textWidth - 10, Math.max(padding.left + 4, markerX - textWidth / 2 - 5));
          const badgeY = padding.top + 6;
          ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
          ctx.fillRect(badgeX, badgeY, textWidth + 10, 14);
          ctx.strokeStyle = 'rgba(201, 168, 76, 0.6)';
          ctx.strokeRect(badgeX, badgeY, textWidth + 10, 14);
          ctx.fillStyle = markerColor;
          ctx.textAlign = 'left';
          ctx.fillText(marker.label, badgeX + 5, badgeY + 10);
        }
      }

      if (shiftArrows.length > 0) {
        const pulse = Math.sin(timestamp * 0.004);
        const dashOffset = animateShiftArrows ? -((timestamp * 0.012) % 11) : 0;

        shiftArrows.forEach((arrow, idx) => {
          const fromIndex = Math.max(0, Math.min(length - 1, arrow.fromIndex ?? 0));
          const toIndex = Math.max(0, Math.min(length - 1, arrow.toIndex ?? fromIndex));
          if (fromIndex === toIndex) return;

          const fromX = xForIndex(fromIndex);
          const fromY = yForValue(safeSeriesA[fromIndex]);
          const toX = xForIndex(toIndex);
          const toY = yForValue(safeSeriesB[toIndex]);
          const arcLift = 24 + pulse * 3 + idx * 2;
          const controlX = (fromX + toX) / 2;
          const controlY = Math.min(fromY, toY) - arcLift;

          ctx.strokeStyle = 'rgba(74, 123, 167, 0.9)';
          ctx.lineWidth = 1.6;
          ctx.setLineDash([6, 5]);
          ctx.lineDashOffset = dashOffset;
          ctx.beginPath();
          ctx.moveTo(fromX, fromY);
          ctx.quadraticCurveTo(controlX, controlY, toX, toY);
          ctx.stroke();
          ctx.setLineDash([]);

          // Arrowhead on curve endpoint.
          const angle = Math.atan2(toY - controlY, toX - controlX);
          const headSize = 6;
          ctx.fillStyle = 'rgba(74, 123, 167, 0.95)';
          ctx.beginPath();
          ctx.moveTo(toX, toY);
          ctx.lineTo(
            toX - headSize * Math.cos(angle - Math.PI / 6),
            toY - headSize * Math.sin(angle - Math.PI / 6)
          );
          ctx.lineTo(
            toX - headSize * Math.cos(angle + Math.PI / 6),
            toY - headSize * Math.sin(angle + Math.PI / 6)
          );
          ctx.closePath();
          ctx.fill();

          if (arrow.label) {
            ctx.font = '600 10px Helvetica Neue';
            const textWidth = ctx.measureText(arrow.label).width;
            const badgeX = controlX - textWidth / 2 - 5;
            const badgeY = controlY - 16;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
            ctx.fillRect(badgeX, badgeY, textWidth + 10, 14);
            ctx.strokeStyle = 'rgba(74, 123, 167, 0.35)';
            ctx.strokeRect(badgeX, badgeY, textWidth + 10, 14);
            ctx.fillStyle = '#4A7BA7';
            ctx.textAlign = 'center';
            ctx.fillText(arrow.label, controlX, badgeY + 10);
          }
        });
      }

      if (showLegend) {
        // Legend with dynamic spacing so long labels do not overlap.
        let legendX = padding.left;
        let legendY = 12;
        const legendRowHeight = 14;
        const legendGap = 16;
        const legendItems = [
          { color: colorA, text: labelA },
          { color: colorB, text: labelB }
        ].filter((item) => Boolean(item.text));

        ctx.font = '11px system-ui';
        ctx.textAlign = 'left';

        legendItems.forEach((item) => {
          const textWidth = ctx.measureText(item.text).width;
          const itemWidth = 28 + textWidth;
          if (legendX + itemWidth > width - padding.right && legendX > padding.left) {
            legendX = padding.left;
            legendY += legendRowHeight;
          }
          ctx.fillStyle = item.color;
          ctx.fillRect(legendX, legendY, 20, 3);
          ctx.fillStyle = '#4A4641';
          ctx.fillText(item.text, legendX + 28, legendY + 4);
          legendX += itemWidth + legendGap;
        });
      }

      // X-axis labels
      for (let i = 0; i < length; i++) {
        if (i !== 0 && i !== length - 1 && i % xTickStep !== 0) continue;
        const x = xForIndex(i);
        ctx.fillStyle = '#9A9690';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'center';
        const label = xLabels && xLabels[i] ? xLabels[i] : `Yr ${i + 1}`;
        ctx.fillText(label, x, h - padding.bottom + 20);
      }

      if (xAxisLabel) {
        ctx.fillStyle = '#5B657A';
        ctx.font = '600 10px Helvetica Neue';
        ctx.textAlign = 'center';
        ctx.fillText(xAxisLabel, padding.left + chartWidth / 2, h - 10);
      }

      if (xAxisStartLabel) {
        ctx.fillStyle = '#7A869D';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'left';
        ctx.fillText(xAxisStartLabel, padding.left, h - 28);
      }

      if (xAxisEndLabel) {
        ctx.fillStyle = '#7A869D';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'right';
        ctx.fillText(xAxisEndLabel, width - padding.right, h - 28);
      }
    };

    const shouldAnimate = animateShiftArrows && shiftArrows.length > 0;
    if (shouldAnimate) {
      const animate = (timestamp) => {
        draw(timestamp);
        rafId = window.requestAnimationFrame(animate);
      };
      rafId = window.requestAnimationFrame(animate);
    } else {
      draw(0);
    }

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [
    seriesA,
    seriesB,
    labelA,
    labelB,
    colorA,
    colorB,
    xLabels,
    xTickStep,
    yFormatter,
    shiftArrows,
    animateShiftArrows,
    marker,
    showLegend,
    inlineLabels,
    continuationArrowA,
    xAxisLabel,
    xAxisStartLabel,
    xAxisEndLabel
  ]);

  return <canvas ref={canvasRef} className="comparison-canvas" style={{ width: '100%', height }} />;
};

const LayeredNavBuildChart = ({
  singleSeries,
  vintageSeries = [],
  totalSeries,
  xLabels = null,
  xTickStep = 1,
  yFormatter = (v) => formatCurrency(v, 0),
  height = 290,
  animateOnVisible = false,
  loopAnimation = false,
  replayKey = 0,
  showLegend = true,
  showVintageCallout = false,
  exposureTarget = null,
  exposureTargetLabel = 'Exposure Target',
  exposureTargetLabelBelow = false
}) => {
  const canvasRef = useRef(null);
  const hasPlayedRef = useRef(false);
  const lastReplayKeyRef = useRef(replayKey);
  const [isInView, setIsInView] = useState(!animateOnVisible || loopAnimation);

  useEffect(() => {
    if (!animateOnVisible || loopAnimation) {
      setIsInView(true);
      return undefined;
    }
    const node = canvasRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setIsInView(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsInView(true);
            observer.disconnect();
          }
        });
      },
      { threshold: 0.35 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [animateOnVisible, loopAnimation]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext('2d');
    let rafId = null;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const clamp01 = (value) => Math.max(0, Math.min(1, value));
    const VINTAGE_REVEAL_MS = 2600;
    const TOTAL_REVEAL_MS = 1900;
    const TOTAL_ANIMATION_MS = VINTAGE_REVEAL_MS + TOTAL_REVEAL_MS;
    const LOOP_HOLD_MS = 3000;
    let animationStart = null;

    const draw = (timestamp = 0, forceComplete = false) => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.offsetWidth;
      const h = canvas.offsetHeight;

      canvas.width = width * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, h);

      const length = totalSeries?.length || 0;
      if (length === 0) return;

      const safeTotal = totalSeries.slice(0, length);
      const safeSingle = (singleSeries || []).slice(0, length);
      const safeVintages = vintageSeries
        .map((vintage) => (vintage?.series || []).slice(0, length))
        .filter((series) => series.length === length);

      const padding = { top: 44, bottom: 50, left: 74, right: 18 };
      const chartWidth = width - padding.left - padding.right;
      const chartHeight = h - padding.top - padding.bottom;
      const denominator = Math.max(1, length - 1);

      const allValues = [...safeTotal, ...safeSingle, ...safeVintages.flat()].filter((value) => Number.isFinite(value));
      const targetValue = Number.isFinite(exposureTarget) ? Number(exposureTarget) : null;
      const maxValue = Math.max(1e-9, ...allValues) * 1.1;
      const maxWithTarget = targetValue !== null ? Math.max(maxValue, targetValue * 1.08) : maxValue;
      const range = Math.max(1e-9, maxWithTarget);
      const xForIndex = (i) => padding.left + (i / denominator) * chartWidth;
      const yForValue = (v) => padding.top + ((maxWithTarget - v) / range) * chartHeight;

      const elapsed = forceComplete || reduceMotion
        ? TOTAL_ANIMATION_MS
        : Math.min(TOTAL_ANIMATION_MS, timestamp);
      const vintagePhaseProgress = clamp01(elapsed / VINTAGE_REVEAL_MS);
      const totalPhaseProgress = clamp01((elapsed - VINTAGE_REVEAL_MS) / TOTAL_REVEAL_MS);

      const drawSeriesLine = (series, options = {}) => {
        if (!series || series.length < 2) return;
        const {
          color = '#1B2A4A',
          lineWidth = 2,
          dashed = false,
          alpha = 1,
          maxIndexFloat = length - 1
        } = options;

        const capped = Math.max(0, Math.min(length - 1, maxIndexFloat));
        if (capped <= 0) return;

        const fullIndex = Math.floor(capped);
        const frac = capped - fullIndex;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        if (dashed) ctx.setLineDash([6, 4]);
        else ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(xForIndex(0), yForValue(series[0]));
        for (let i = 1; i <= fullIndex; i++) {
          ctx.lineTo(xForIndex(i), yForValue(series[i]));
        }
        if (fullIndex < length - 1 && frac > 0) {
          const nextIdx = fullIndex + 1;
          const x = xForIndex(fullIndex) + (xForIndex(nextIdx) - xForIndex(fullIndex)) * frac;
          const y = yForValue(series[fullIndex]) + (yForValue(series[nextIdx]) - yForValue(series[fullIndex])) * frac;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      };

      const drawTotalFill = (series, maxIndexFloat, alpha = 1) => {
        const capped = Math.max(0, Math.min(length - 1, maxIndexFloat));
        if (capped <= 0) return;
        const fullIndex = Math.floor(capped);
        const frac = capped - fullIndex;
        const endX = fullIndex < length - 1
          ? xForIndex(fullIndex) + (xForIndex(fullIndex + 1) - xForIndex(fullIndex)) * frac
          : xForIndex(length - 1);
        const endY = fullIndex < length - 1
          ? yForValue(series[fullIndex]) + (yForValue(series[fullIndex + 1]) - yForValue(series[fullIndex])) * frac
          : yForValue(series[length - 1]);

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(xForIndex(0), yForValue(series[0]));
        for (let i = 1; i <= fullIndex; i++) {
          ctx.lineTo(xForIndex(i), yForValue(series[i]));
        }
        if (fullIndex < length - 1 && frac > 0) {
          ctx.lineTo(endX, endY);
        }
        ctx.lineTo(endX, yForValue(0));
        ctx.lineTo(xForIndex(0), yForValue(0));
        ctx.closePath();
        ctx.fillStyle = 'rgba(45, 107, 79, 0.08)';
        ctx.fill();
        ctx.restore();
      };

      // Grid and y-axis labels.
      ctx.strokeStyle = '#E8E6E1';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = padding.top + (i / 4) * chartHeight;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();

        const value = maxWithTarget - (i / 4) * range;
        ctx.fillStyle = '#9A9690';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'right';
        ctx.fillText(yFormatter(value), padding.left - 8, y + 4);
      }

      if (targetValue !== null && targetValue > 0) {
        const targetY = yForValue(targetValue);
        ctx.strokeStyle = 'rgba(168, 137, 46, 0.85)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.moveTo(padding.left, targetY);
        ctx.lineTo(width - padding.right, targetY);
        ctx.stroke();
        ctx.setLineDash([]);

        const targetText = `${exposureTargetLabel}`;
        ctx.font = '600 12px Helvetica Neue';
        const txtW = ctx.measureText(targetText).width;
        const badgeW = txtW + 12;
        const badgeX = Math.max(padding.left + 4, width - padding.right - badgeW);
        const badgeY = exposureTargetLabelBelow
          ? Math.min(h - padding.bottom - 18, targetY + 4)
          : Math.max(padding.top + 2, targetY - 19);
        ctx.fillStyle = 'rgba(255,255,255,0.96)';
        ctx.fillRect(badgeX, badgeY, badgeW, 16);
        ctx.strokeStyle = 'rgba(168, 137, 46, 0.5)';
        ctx.strokeRect(badgeX, badgeY, badgeW, 16);
        ctx.fillStyle = '#A8892E';
        ctx.textAlign = 'left';
        ctx.fillText(targetText, badgeX + 6, badgeY + 12);
      }

      // Single-commitment template curve (dashed) stays visible as context.
      if (safeSingle.length === length) {
        drawSeriesLine(safeSingle, {
          color: '#9A9690',
          lineWidth: 1.8,
          dashed: true,
          alpha: 0.9,
          maxIndexFloat: length - 1
        });
      }

      // Vintage layers animate in one-by-one.
      const vintageVisibleFloat = safeVintages.length * vintagePhaseProgress;
      const fullyVisibleVintages = Math.floor(vintageVisibleFloat);
      const partialVintageAlpha = vintageVisibleFloat - fullyVisibleVintages;

      for (let i = 0; i < fullyVisibleVintages; i++) {
        drawSeriesLine(safeVintages[i], {
          color: 'rgba(74, 123, 167, 0.8)',
          lineWidth: 1.2,
          alpha: 0.42,
          maxIndexFloat: length - 1
        });
      }

      if (fullyVisibleVintages < safeVintages.length && partialVintageAlpha > 0) {
        drawSeriesLine(safeVintages[fullyVisibleVintages], {
          color: 'rgba(74, 123, 167, 0.8)',
          lineWidth: 1.2,
          alpha: 0.42 * partialVintageAlpha,
          maxIndexFloat: length - 1
        });
      }

      // Summed NAV draws after vintage layers have appeared.
      const totalRevealIndex = totalPhaseProgress * (length - 1);
      drawTotalFill(safeTotal, totalRevealIndex, totalPhaseProgress);
      drawSeriesLine(safeTotal, {
        color: '#2D6B4F',
        lineWidth: 3,
        alpha: Math.max(0.25, totalPhaseProgress),
        maxIndexFloat: totalRevealIndex
      });

      // End marker and label once reveal is complete enough.
      if (totalPhaseProgress > 0.98) {
        const endX = xForIndex(length - 1);
        const endY = yForValue(safeTotal[length - 1]);
        ctx.fillStyle = '#2D6B4F';
        ctx.beginPath();
        ctx.arc(endX, endY, 3.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.font = '600 12px Helvetica Neue';
        const totalLabel = 'Summed Portfolio NAV';
        const labelWidth = ctx.measureText(totalLabel).width + 12;
        const labelX = Math.max(padding.left + 4, Math.min(width - padding.right - labelWidth, endX - labelWidth - 8));
        const labelY = Math.max(padding.top + 6, endY - 18);
        ctx.fillStyle = 'rgba(255,255,255,0.96)';
        ctx.fillRect(labelX, labelY, labelWidth, 16);
        ctx.strokeStyle = 'rgba(45, 107, 79, 0.45)';
        ctx.strokeRect(labelX, labelY, labelWidth, 16);
        ctx.fillStyle = '#2D6B4F';
        ctx.textAlign = 'left';
        ctx.fillText(totalLabel, labelX + 6, labelY + 12);
      }

      if (showVintageCallout && safeVintages.length > 2 && vintagePhaseProgress > 0.55) {
        const calloutX = xForIndex(Math.min(length - 1, 7));
        const calloutY = yForValue(safeVintages[Math.min(2, safeVintages.length - 1)][Math.min(length - 1, 7)]) + 8;
        const arrowTargets = [Math.min(length - 1, 5), Math.min(length - 1, 7), Math.min(length - 1, 9), Math.min(length - 1, 11)];
        const arrowSeriesIdx = [1, Math.min(safeVintages.length - 1, 3), Math.min(safeVintages.length - 1, 5), Math.min(safeVintages.length - 1, 7)];
        const dashOffset = reduceMotion ? 0 : -((timestamp * 0.012) % 10);

        arrowTargets.forEach((targetIdx, k) => {
          const targetSeries = safeVintages[arrowSeriesIdx[k]];
          if (!targetSeries) return;
          const tx = xForIndex(targetIdx);
          const ty = yForValue(targetSeries[targetIdx]);
          const sx = calloutX + (-22 + k * 14);
          const sy = calloutY - 18;
          const cx = (sx + tx) / 2 + (-30 + k * 14);
          const cy = Math.min(sy, ty) - (14 + k * 2);

          ctx.strokeStyle = 'rgba(74, 123, 167, 0.85)';
          ctx.lineWidth = 1.6;
          ctx.setLineDash([5, 5]);
          ctx.lineDashOffset = dashOffset;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.quadraticCurveTo(cx, cy, tx, ty);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;

          const angle = Math.atan2(ty - cy, tx - cx);
          const headSize = 5;
          ctx.fillStyle = 'rgba(74, 123, 167, 0.95)';
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(
            tx - headSize * Math.cos(angle - Math.PI / 6),
            ty - headSize * Math.sin(angle - Math.PI / 6)
          );
          ctx.lineTo(
            tx - headSize * Math.cos(angle + Math.PI / 6),
            ty - headSize * Math.sin(angle + Math.PI / 6)
          );
          ctx.closePath();
          ctx.fill();
        });

        const calloutText = 'Individual fund NAV curves';
        ctx.font = '600 12px Helvetica Neue';
        const textWidth = ctx.measureText(calloutText).width;
        const badgeW = textWidth + 12;
        const badgeX = Math.max(padding.left + 4, Math.min(width - padding.right - badgeW, calloutX - badgeW / 2));
        const badgeY = calloutY - 28;
        ctx.fillStyle = 'rgba(255,255,255,0.96)';
        ctx.fillRect(badgeX, badgeY, badgeW, 16);
        ctx.strokeStyle = 'rgba(74, 123, 167, 0.38)';
        ctx.strokeRect(badgeX, badgeY, badgeW, 16);
        ctx.fillStyle = '#4A7BA7';
        ctx.textAlign = 'left';
        ctx.fillText(calloutText, badgeX + 6, badgeY + 12);
      }

      if (showLegend) {
        const legendItems = [
          { label: 'Single Commitment NAV Template', color: '#9A9690', dashed: true },
          { label: 'Individual Vintage NAV Curves', color: 'rgba(74, 123, 167, 0.8)', dashed: false },
          { label: 'Summed Portfolio NAV', color: '#2D6B4F', dashed: false }
        ];
        let legendX = padding.left;
        let legendY = 12;
        ctx.font = '11px system-ui';
        ctx.textAlign = 'left';
        legendItems.forEach((item) => {
          const textWidth = ctx.measureText(item.label).width;
          const itemWidth = textWidth + 34;
          if (legendX + itemWidth > width - padding.right && legendX > padding.left) {
            legendX = padding.left;
            legendY += 14;
          }
          ctx.strokeStyle = item.color;
          ctx.lineWidth = 2;
          if (item.dashed) ctx.setLineDash([5, 4]);
          else ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(legendX, legendY + 2);
          ctx.lineTo(legendX + 20, legendY + 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#4A4641';
          ctx.fillText(item.label, legendX + 26, legendY + 5);
          legendX += itemWidth + 14;
        });
      }

      // X-axis labels.
      for (let i = 0; i < length; i++) {
        if (i !== 0 && i !== length - 1 && i % xTickStep !== 0) continue;
        const x = xForIndex(i);
        ctx.fillStyle = '#9A9690';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'center';
        const label = xLabels && xLabels[i] ? xLabels[i] : `Yr ${i}`;
        ctx.fillText(label, x, h - padding.bottom + 20);
      }
    };

    if (!isInView) {
      return undefined;
    }

    const shouldAnimate = (() => {
      if (loopAnimation) return !reduceMotion;
      if (reduceMotion) return false;
      if (replayKey !== lastReplayKeyRef.current) {
        lastReplayKeyRef.current = replayKey;
        hasPlayedRef.current = true;
        return true;
      }
      if (!hasPlayedRef.current) {
        hasPlayedRef.current = true;
        return true;
      }
      return false;
    })();

    if (!shouldAnimate) {
      draw(TOTAL_ANIMATION_MS, true);
      return undefined;
    }

    if (reduceMotion) {
      draw(0, true);
      return undefined;
    }

    const animate = (ts) => {
      if (animationStart === null) {
        animationStart = ts;
      }
      const elapsed = ts - animationStart;
      draw(elapsed);
      if (loopAnimation) {
        if (elapsed >= TOTAL_ANIMATION_MS + LOOP_HOLD_MS) {
          animationStart = ts;
        }
        rafId = window.requestAnimationFrame(animate);
        return;
      }
      if (elapsed < TOTAL_ANIMATION_MS) {
        rafId = window.requestAnimationFrame(animate);
      } else {
        draw(TOTAL_ANIMATION_MS, true);
      }
    };
    rafId = window.requestAnimationFrame(animate);

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [
    singleSeries,
    vintageSeries,
    totalSeries,
    xLabels,
    xTickStep,
    yFormatter,
    isInView,
    loopAnimation,
    replayKey,
    showLegend,
    showVintageCallout,
    exposureTarget,
    exposureTargetLabel,
    exposureTargetLabelBelow
  ]);

  return <canvas ref={canvasRef} className="comparison-canvas layered-nav-canvas" style={{ width: '100%', height }} />;
};

const LocTimingColumnChart = ({
  data,
  height = 220,
  xTickStep = 2,
  shiftArrows = [],
  animateShiftArrows = true
}) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.length === 0) return undefined;

    const ctx = canvas.getContext('2d');
    let rafId = null;

    const draw = (timestamp = 0) => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.offsetWidth;
      const h = canvas.offsetHeight;

      canvas.width = width * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, h);

      const padding = { top: 46, bottom: 56, left: 62, right: 20 };
      const chartWidth = width - padding.left - padding.right;
      const chartHeight = h - padding.top - padding.bottom;
      const n = data.length;
      const bandWidth = chartWidth / Math.max(1, n);
      const barWidth = Math.max(4, Math.min(12, bandWidth * 0.34));
      const gapInBand = Math.max(2, Math.min(6, bandWidth * 0.18));

      const maxValue = Math.max(
        1,
        ...data.map((d) => Math.max(d.noLocCall, d.withLocPrincipalCall + d.withLocInterestCall))
      ) * 1.2;
      const yForValue = (value) => padding.top + (1 - value / maxValue) * chartHeight;

      // Grid and y-axis labels
      ctx.strokeStyle = '#E8E6E1';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = padding.top + (i / 4) * chartHeight;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();

        const val = maxValue * (1 - i / 4);
        ctx.fillStyle = '#9A9690';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'right';
        ctx.fillText(formatCurrency(val, 0), padding.left - 8, y + 4);
      }

      // Bars
      data.forEach((d, i) => {
        const centerX = padding.left + (i + 0.5) * bandWidth;
        const noLocX = centerX - barWidth - gapInBand / 2;
        const withLocX = centerX + gapInBand / 2;

        const noLocY = yForValue(d.noLocCall);
        const noLocHeight = Math.max(0, padding.top + chartHeight - noLocY);
        ctx.fillStyle = '#1B2A4A';
        ctx.fillRect(noLocX, noLocY, barWidth, noLocHeight);

        const principalTopY = yForValue(d.withLocPrincipalCall);
        const principalHeight = Math.max(0, padding.top + chartHeight - principalTopY);
        ctx.fillStyle = '#4A7BA7';
        ctx.fillRect(withLocX, principalTopY, barWidth, principalHeight);

        const interestTopY = yForValue(d.withLocPrincipalCall + d.withLocInterestCall);
        const interestHeight = Math.max(0, principalTopY - interestTopY);
        if (interestHeight > 0) {
          ctx.fillStyle = '#B5473A';
          ctx.fillRect(withLocX, interestTopY, barWidth, interestHeight);
        }
      });

      // Shift arrows
      if (shiftArrows.length > 0) {
        const pulse = Math.sin(timestamp * 0.004);
        const dashOffset = animateShiftArrows ? -((timestamp * 0.012) % 11) : 0;

        shiftArrows.forEach((arrow, idx) => {
          const fromIndex = Math.max(0, Math.min(n - 1, arrow.fromIndex ?? 0));
          const toIndex = Math.max(0, Math.min(n - 1, arrow.toIndex ?? fromIndex));
          if (fromIndex === toIndex) return;

          const fromCenter = padding.left + (fromIndex + 0.5) * bandWidth;
          const toCenter = padding.left + (toIndex + 0.5) * bandWidth;
          const fromX = fromCenter - barWidth / 2 - gapInBand / 2;
          const toX = toCenter + barWidth / 2 + gapInBand / 2;

          const fromY = yForValue(data[fromIndex].noLocCall);
          const toY = yForValue(data[toIndex].withLocPrincipalCall);
          const arcLift = 22 + pulse * 3 + idx * 3;
          const controlX = (fromX + toX) / 2;
          const controlY = Math.min(fromY, toY) - arcLift;

          ctx.strokeStyle = 'rgba(74, 123, 167, 0.92)';
          ctx.lineWidth = 1.6;
          ctx.setLineDash([6, 5]);
          ctx.lineDashOffset = dashOffset;
          ctx.beginPath();
          ctx.moveTo(fromX, fromY);
          ctx.quadraticCurveTo(controlX, controlY, toX, toY);
          ctx.stroke();
          ctx.setLineDash([]);

          const angle = Math.atan2(toY - controlY, toX - controlX);
          const headSize = 6;
          ctx.fillStyle = 'rgba(74, 123, 167, 0.95)';
          ctx.beginPath();
          ctx.moveTo(toX, toY);
          ctx.lineTo(
            toX - headSize * Math.cos(angle - Math.PI / 6),
            toY - headSize * Math.sin(angle - Math.PI / 6)
          );
          ctx.lineTo(
            toX - headSize * Math.cos(angle + Math.PI / 6),
            toY - headSize * Math.sin(angle + Math.PI / 6)
          );
          ctx.closePath();
          ctx.fill();

          if (arrow.label) {
            ctx.font = '600 10px Helvetica Neue';
            const textWidth = ctx.measureText(arrow.label).width;
            const badgeX = controlX - textWidth / 2 - 5;
            const badgeY = controlY - 16;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
            ctx.fillRect(badgeX, badgeY, textWidth + 10, 14);
            ctx.strokeStyle = 'rgba(74, 123, 167, 0.35)';
            ctx.strokeRect(badgeX, badgeY, textWidth + 10, 14);
            ctx.fillStyle = '#4A7BA7';
            ctx.textAlign = 'center';
            ctx.fillText(arrow.label, controlX, badgeY + 10);
          }
        });
      }

      // Legend
      let lx = padding.left;
      const ly = 12;
      const drawLegend = (color, text) => {
        ctx.fillStyle = color;
        ctx.fillRect(lx, ly, 18, 5);
        ctx.fillStyle = '#4A4641';
        ctx.font = '11px system-ui';
        ctx.textAlign = 'left';
        ctx.fillText(text, lx + 24, ly + 5);
        lx += 24 + ctx.measureText(text).width + 20;
      };
      drawLegend('#1B2A4A', 'No LOC');
      drawLegend('#4A7BA7', 'With LOC Principal');
      drawLegend('#B5473A', 'Plus Interest');

      // X-axis labels
      for (let i = 0; i < n; i++) {
        if (i !== 0 && i !== n - 1 && i % xTickStep !== 0) continue;
        const x = padding.left + (i + 0.5) * bandWidth;
        ctx.fillStyle = '#9A9690';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(data[i].label || `Q${i + 1}`, x, h - padding.bottom + 20);
      }
    };

    const shouldAnimate = animateShiftArrows && shiftArrows.length > 0;
    if (shouldAnimate) {
      const animate = (timestamp) => {
        draw(timestamp);
        rafId = window.requestAnimationFrame(animate);
      };
      rafId = window.requestAnimationFrame(animate);
    } else {
      draw(0);
    }

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [data, xTickStep, shiftArrows, animateShiftArrows]);

  return <canvas ref={canvasRef} className="comparison-canvas loc-timing-canvas" style={{ width: '100%', height }} />;
};

const SingleFundContribNavChart = ({ data, height = 245, xTickStep = 1 }) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.length === 0) return undefined;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.offsetWidth;
    const h = canvas.offsetHeight;

    canvas.width = width * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);

    const padding = { top: 44, bottom: 52, left: 62, right: 22 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = h - padding.top - padding.bottom;
    const n = data.length;
    const bandWidth = chartWidth / Math.max(1, n);
    const barWidth = Math.max(4, Math.min(18, bandWidth * 0.56));

    const maxValue = Math.max(
      1,
      ...data.map((d) => Math.max(d.contributionM || 0, d.navM || 0))
    ) * 1.12;
    const yForValue = (value) => padding.top + (1 - value / maxValue) * chartHeight;
    const zeroY = yForValue(0);

    // Grid and y-axis labels
    ctx.strokeStyle = '#E8E6E1';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (i / 4) * chartHeight;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      const valM = maxValue * (1 - i / 4);
      ctx.fillStyle = '#9A9690';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(formatCurrency(valM * 1e6, 0), padding.left - 8, y + 4);
    }

    // Contribution bars
    data.forEach((d, i) => {
      const centerX = padding.left + (i + 0.5) * bandWidth;
      const x = centerX - barWidth / 2;
      const y = yForValue(Math.max(0, d.contributionM || 0));
      const barHeight = Math.max(0, zeroY - y);

      ctx.fillStyle = '#1B2A4A';
      ctx.globalAlpha = 0.78;
      ctx.fillRect(x, y, barWidth, barHeight);
      ctx.globalAlpha = 1;
    });

    // NAV line
    ctx.strokeStyle = '#2D6B4F';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = padding.left + (i + 0.5) * bandWidth;
      const y = yForValue(Math.max(0, d.navM || 0));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // NAV points
    data.forEach((d, i) => {
      const x = padding.left + (i + 0.5) * bandWidth;
      const y = yForValue(Math.max(0, d.navM || 0));
      ctx.fillStyle = '#2D6B4F';
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    });

    // Peak NAV marker and label
    const peakIdx = data.reduce(
      (bestIdx, row, idx, arr) => ((row.navM || 0) > (arr[bestIdx]?.navM || 0) ? idx : bestIdx),
      0
    );
    const peakRow = data[peakIdx] || data[0];
    const peakX = padding.left + (peakIdx + 0.5) * bandWidth;
    const peakY = yForValue(Math.max(0, peakRow.navM || 0));
    const peakYearLabel = peakRow.label || `Yr ${peakIdx}`;
    const peakText = `Peak NAV ${formatCurrency((peakRow.navM || 0) * 1e6, 0)} (${peakYearLabel})`;

    ctx.beginPath();
    ctx.arc(peakX, peakY, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = '#2D6B4F';
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();

    ctx.font = '600 10px system-ui';
    const peakTextWidth = ctx.measureText(peakText).width;
    const peakBoxW = peakTextWidth + 10;
    const peakBoxH = 14;
    const peakBoxX = Math.max(
      padding.left + 4,
      Math.min(width - padding.right - peakBoxW - 2, peakX - peakTextWidth / 2 - 5)
    );
    const preferAbove = peakY - 20 > padding.top + 4;
    const peakBoxY = preferAbove ? peakY - 20 : peakY + 8;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.fillRect(peakBoxX, peakBoxY, peakBoxW, peakBoxH);
    ctx.strokeStyle = 'rgba(45, 107, 79, 0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(peakBoxX, peakBoxY, peakBoxW, peakBoxH);
    ctx.fillStyle = '#2D6B4F';
    ctx.textAlign = 'left';
    ctx.fillText(peakText, peakBoxX + 5, peakBoxY + 10);

    // End label for NAV
    const last = data[data.length - 1];
    const endX = padding.left + (n - 0.5) * bandWidth;
    const endY = yForValue(Math.max(0, last.navM || 0));
    ctx.font = '600 10px system-ui';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#2D6B4F';
    ctx.fillText(`NAV ${formatCurrency((last.navM || 0) * 1e6, 0)}`, Math.min(width - padding.right - 80, endX + 8), endY - 8);

    // Legend
    let legendX = padding.left;
    const legendY = 12;
    const drawLegendBox = (color, text, asLine = false) => {
      if (asLine) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(legendX, legendY + 2);
        ctx.lineTo(legendX + 20, legendY + 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(legendX, legendY - 2, 18, 7);
      }
      ctx.fillStyle = '#4A4641';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText(text, legendX + 24, legendY + 5);
      legendX += 24 + ctx.measureText(text).width + 20;
    };
    drawLegendBox('#1B2A4A', 'Annual LP Contributions');
    drawLegendBox('#2D6B4F', 'Expected NAV', true);

    // X-axis labels
    for (let i = 0; i < n; i++) {
      if (i !== 0 && i !== n - 1 && i % xTickStep !== 0) continue;
      const x = padding.left + (i + 0.5) * bandWidth;
      ctx.fillStyle = '#9A9690';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(data[i].label || `Yr ${i}`, x, h - padding.bottom + 19);
    }
  }, [data, xTickStep]);

  return <canvas ref={canvasRef} className="comparison-canvas single-fund-combo-canvas" style={{ width: '100%', height }} />;
};

const parseCsvRows = (text) => {
  const cleaned = (text || '').replace(/^\uFEFF/, '');
  if (!cleaned.trim()) return [];
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (char === '"') {
      if (inQuotes && cleaned[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && cleaned[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((cell) => String(cell || '').trim() !== '')) rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  row.push(field);
  if (row.some((cell) => String(cell || '').trim() !== '')) rows.push(row);
  return rows;
};

const parseActualGrossNetCsv = (text) => {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return null;
  const headers = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const idxGross = headers.findIndex((h) => h === 'gross multiple' || h === 'gross_multiple');
  const idxNet = headers.findIndex((h) => h === 'tvpi' || h === 'net tvpi' || h === 'net_multiple');
  if (idxGross === -1 || idxNet === -1) return null;

  const points = rows
    .slice(1)
    .map((row, idx) => {
      const gross = Number(String(row[idxGross] || '').trim());
      const net = Number(String(row[idxNet] || '').trim());
      if (!Number.isFinite(gross) || !Number.isFinite(net)) return null;
      return { id: idx + 1, gross, net };
    })
    .filter(Boolean);

  return points.length ? { points } : null;
};

const useActualGrossNetDataset = () => {
  const [actualSpreadData, setActualSpreadData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setIsLoading(true);
      const base = (import.meta && import.meta.env && import.meta.env.BASE_URL) || '/';
      const normalizedBase = base.endsWith('/') ? base : `${base}/`;
      const candidates = [
        actualGrossNetCsvUrl,
        `${normalizedBase}gross-net-spreads-actual.csv`,
        '/gross-net-spreads-actual.csv'
      ];
      for (const path of candidates) {
        try {
          const res = await fetch(path, { cache: 'no-store' });
          if (!res.ok) continue;
          const text = await res.text();
          const parsed = parseActualGrossNetCsv(text);
          if (parsed && parsed.points.length) {
            if (active) {
              setActualSpreadData(parsed);
              setLoadError('');
              setIsLoading(false);
            }
            return;
          }
        } catch (_) {
          // Try next candidate path.
        }
      }
      if (active) {
        setActualSpreadData(null);
        setLoadError('Actual gross-to-net dataset not found. Expected gross-net-spreads-actual.csv at site root.');
        setIsLoading(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, []);

  return { actualSpreadData, loadError, isLoading };
};

const parseUsDateWithPivot = (raw, pivotYear = 50) => {
  const value = String(raw || '').trim();
  if (!value) return null;
  const parts = value.split('/');
  if (parts.length !== 3) return null;
  const month = Number(parts[0]);
  const day = Number(parts[1]);
  let year = Number(parts[2]);
  if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  if (year < 100) year += year >= pivotYear ? 1900 : 2000;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
};

const formatQuarterLabel = (date) => {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${date.getUTCFullYear()} Q${quarter}`;
};

const metricFamilyFromName = (metric) => {
  const value = String(metric || '').toLowerCase();
  if (value.startsWith('dpi_')) return 'dpi';
  if (value.startsWith('tvpi_')) return 'tvpi';
  if (value.startsWith('irr_')) return 'irr';
  if (value.startsWith('sample')) return 'count';
  if (value.startsWith('capitalization')) return 'currency_mm';
  return 'number';
};

const prettifyMetricName = (metric) => {
  const base = String(metric || '')
    .replace(/_qrtle$/i, '_qrtl')
    .replace(/_/g, ' ')
    .trim();
  return base.replace(/\b\w/g, (ch) => ch.toUpperCase());
};

const getBenchmarkMetricMeta = (metric) => {
  const family = metricFamilyFromName(metric);
  if (family === 'irr') return { family, decimals: 2, label: prettifyMetricName(metric), unit: 'percent' };
  if (family === 'count') return { family, decimals: 0, label: prettifyMetricName(metric), unit: 'count' };
  if (family === 'currency_mm') return { family, decimals: 1, label: 'Capitalization ($M)', unit: 'currency_mm' };
  if (family === 'dpi' || family === 'tvpi') return { family, decimals: 2, label: prettifyMetricName(metric), unit: 'multiple' };
  return { family, decimals: 2, label: prettifyMetricName(metric), unit: 'number' };
};

const formatBenchmarkMetricValue = (value, metric, decimalsOverride = null) => {
  if (!Number.isFinite(value)) return 'n/a';
  const meta = getBenchmarkMetricMeta(metric);
  const decimals = Number.isFinite(decimalsOverride) ? decimalsOverride : meta.decimals;
  if (meta.unit === 'percent') return `${value.toFixed(decimals)}%`;
  if (meta.unit === 'count') return Math.round(value).toLocaleString();
  if (meta.unit === 'currency_mm') return `$${value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}M`;
  if (meta.unit === 'multiple') return `${value.toFixed(decimals)}x`;
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

const resolveMetricVariant = (metricsSet, candidate) => {
  if (metricsSet.has(candidate)) return candidate;
  if (candidate.includes('_qrtl')) {
    const alt = candidate.replace('_qrtl', '_qrtle');
    if (metricsSet.has(alt)) return alt;
  }
  if (candidate.includes('_qrtle')) {
    const alt = candidate.replace('_qrtle', '_qrtl');
    if (metricsSet.has(alt)) return alt;
  }
  return null;
};

const aggregateValues = (values, method) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  if (method === 'min') return sorted[0];
  if (method === 'max') return sorted[sorted.length - 1];
  if (method === 'sum') return sorted.reduce((sum, v) => sum + v, 0);
  if (method === 'mean') return sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const buildGrossSpreadBuckets = (points, {
  start = 0.75,
  end = 4.25,
  width = 0.5,
  minCount = 8
} = {}) => {
  const buckets = [];
  for (let bucketStart = start; bucketStart < end; bucketStart += width) {
    const bucketPoints = points.filter((point) => point.gross >= bucketStart && point.gross < bucketStart + width);
    if (bucketPoints.length < minCount) continue;
    buckets.push({
      grossMid: bucketStart + width / 2,
      count: bucketPoints.length,
      medianNet: aggregateValues(bucketPoints.map((point) => point.net), 'median'),
      meanNet: aggregateValues(bucketPoints.map((point) => point.net), 'mean'),
      medianSpread: aggregateValues(bucketPoints.map((point) => point.gross - point.net), 'median'),
      meanSpread: aggregateValues(bucketPoints.map((point) => point.gross - point.net), 'mean')
    });
  }
  return buckets;
};

const parseVcBenchmarkCsv = (text) => {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return null;
  const headers = rows[0].map((h) => String(h || '').trim());
  const indexByHeader = new Map(headers.map((h, i) => [h.toLowerCase(), i]));
  const idxAsOf = indexByHeader.get('as_of');
  const idxProvider = indexByHeader.get('provider');
  const idxBenchmark = indexByHeader.get('benchmark');
  const idxCurrency = indexByHeader.get('currency');
  const idxSourceFile = indexByHeader.get('source_file');
  const idxAge = indexByHeader.get('age in quarters');
  const idxVintage = indexByHeader.get('vintage_year');
  const idxMetric = indexByHeader.get('metric');
  const idxValue = indexByHeader.get('value');
  if ([idxAsOf, idxProvider, idxBenchmark, idxCurrency, idxMetric, idxValue].some((idx) => idx === undefined)) return null;

  const providers = new Set();
  const benchmarks = new Set();
  const currencies = new Set();
  const metrics = new Set();
  const asOfMap = new Map();
  let minAge = Number.POSITIVE_INFINITY;
  let maxAge = Number.NEGATIVE_INFINITY;
  let minVintage = Number.POSITIVE_INFINITY;
  let maxVintage = Number.NEGATIVE_INFINITY;

  const parsedRows = rows.slice(1).map((row, rowIdx) => {
    const asOfRaw = String(row[idxAsOf] || '').trim();
    const asOfDate = parseUsDateWithPivot(asOfRaw);
    const asOfTs = asOfDate ? asOfDate.getTime() : null;
    const provider = String(row[idxProvider] || '').trim();
    const benchmark = String(row[idxBenchmark] || '').trim();
    const currency = String(row[idxCurrency] || '').trim();
    const sourceFile = idxSourceFile !== undefined ? String(row[idxSourceFile] || '').trim() : '';
    const metric = String(row[idxMetric] || '').trim();
    const ageInQuartersRaw = idxAge !== undefined ? Number(String(row[idxAge] || '').trim()) : null;
    const ageInQuarters = Number.isFinite(ageInQuartersRaw) ? ageInQuartersRaw : null;
    const vintageYearRaw = idxVintage !== undefined ? Number(String(row[idxVintage] || '').trim()) : null;
    const vintageYear = Number.isFinite(vintageYearRaw) ? vintageYearRaw : null;
    const valueRaw = String(row[idxValue] || '').trim();
    const numericValue = valueRaw === '' ? null : Number(valueRaw);
    const value = Number.isFinite(numericValue) ? numericValue : null;

    if (provider) providers.add(provider);
    if (benchmark) benchmarks.add(benchmark);
    if (currency) currencies.add(currency);
    if (metric) metrics.add(metric);
    if (asOfDate && asOfTs !== null) {
      asOfMap.set(asOfTs, {
        ts: asOfTs,
        label: formatQuarterLabel(asOfDate),
        dateLabel: asOfDate.toISOString().slice(0, 10)
      });
    }
    if (Number.isFinite(ageInQuarters)) {
      minAge = Math.min(minAge, ageInQuarters);
      maxAge = Math.max(maxAge, ageInQuarters);
    }
    if (Number.isFinite(vintageYear)) {
      minVintage = Math.min(minVintage, vintageYear);
      maxVintage = Math.max(maxVintage, vintageYear);
    }

    return {
      id: rowIdx + 1,
      asOfRaw,
      asOfDate,
      asOfTs,
      asOfQuarterLabel: asOfDate ? formatQuarterLabel(asOfDate) : asOfRaw,
      provider,
      benchmark,
      currency,
      sourceFile,
      ageInQuarters,
      vintageYear,
      metric,
      value
    };
  });

  const metricOptions = Array.from(metrics).sort((a, b) => a.localeCompare(b));
  const asOfOptions = Array.from(asOfMap.values()).sort((a, b) => a.ts - b.ts);

  return {
    rows: parsedRows,
    dimensions: {
      providers: Array.from(providers).sort((a, b) => a.localeCompare(b)),
      benchmarks: Array.from(benchmarks).sort((a, b) => a.localeCompare(b)),
      currencies: Array.from(currencies).sort((a, b) => a.localeCompare(b)),
      metrics: metricOptions,
      asOfOptions,
      vintageRange: {
        min: Number.isFinite(minVintage) ? minVintage : 0,
        max: Number.isFinite(maxVintage) ? maxVintage : 0
      },
      ageRange: {
        min: Number.isFinite(minAge) ? minAge : 0,
        max: Number.isFinite(maxAge) ? maxAge : 0
      }
    }
  };
};

const useVcBenchmarkDataset = () => {
  const [benchmarkData, setBenchmarkData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setIsLoading(true);
      const base = (import.meta && import.meta.env && import.meta.env.BASE_URL) || '/';
      const normalizedBase = base.endsWith('/') ? base : `${base}/`;
      const candidates = [
        vcWorldBenchmarksCsvUrl,
        `${normalizedBase}VC%20World%20Benchmarks%201993-2025%20Consolidated.csv`,
        `${normalizedBase}VC World Benchmarks 1993-2025 Consolidated.csv`,
        '/VC%20World%20Benchmarks%201993-2025%20Consolidated.csv'
      ];
      for (const path of candidates) {
        try {
          const res = await fetch(path, { cache: 'no-store' });
          if (!res.ok) continue;
          const text = await res.text();
          const parsed = parseVcBenchmarkCsv(text);
          if (parsed && parsed.rows.length) {
            if (active) {
              setBenchmarkData(parsed);
              setLoadError('');
              setIsLoading(false);
            }
            return;
          }
        } catch (_) {
          // Try next candidate path.
        }
      }
      if (active) {
        setBenchmarkData(null);
        setLoadError('Benchmark dataset not found. Expected VC World Benchmarks 1993-2025 Consolidated.csv at site root.');
        setIsLoading(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, []);

  return { benchmarkData, loadError, isLoading };
};

const BenchmarkVintageLineChart = ({
  series,
  height = 360,
  valueFormatter = (value) => String(value),
  xAxisLabel = 'As-Of Quarter'
}) => {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(960);
  const [hover, setHover] = useState(null);
  const safeHeight = Math.max(260, height);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const update = () => setWidth(Math.max(640, el.clientWidth || 960));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    const padding = { top: 20, right: 20, bottom: 48, left: 74 };
    const chartWidth = Math.max(1, width - padding.left - padding.right);
    const chartHeight = Math.max(1, safeHeight - padding.top - padding.bottom);
    const allPoints = series.flatMap((line) => line.points).filter((point) => Number.isFinite(point.value));
    const xKeySet = new Set(allPoints.map((point) => point.xKey));
    const xKeys = Array.from(xKeySet).sort((a, b) => a - b);
    const xIndex = new Map(xKeys.map((key, idx) => [key, idx]));
    const xCount = xKeys.length;
    const xStep = xCount > 1 ? chartWidth / (xCount - 1) : chartWidth;

    const values = allPoints.map((point) => point.value);
    const rawMin = values.length ? Math.min(...values) : 0;
    const rawMax = values.length ? Math.max(...values) : 1;
    const span = Math.max(1e-9, rawMax - rawMin);
    const pad = span * 0.08;
    const yMin = rawMin - pad;
    const yMax = rawMax + pad;
    const ySpan = Math.max(1e-9, yMax - yMin);

    const xFor = (xKey) => padding.left + (xCount > 1 ? (xIndex.get(xKey) || 0) * xStep : chartWidth / 2);
    const yFor = (value) => padding.top + ((yMax - value) / ySpan) * chartHeight;
    const labelByXKey = new Map();
    series.forEach((line) => {
      line.points.forEach((point) => {
        if (!labelByXKey.has(point.xKey)) labelByXKey.set(point.xKey, point.xLabel);
      });
    });
    return { padding, chartWidth, chartHeight, xKeys, xIndex, xCount, xFor, yFor, yMin, yMax, labelByXKey };
  }, [series, width, safeHeight]);

  const yTicks = useMemo(() => {
    const values = [];
    for (let i = 0; i <= 5; i += 1) {
      const value = layout.yMin + ((layout.yMax - layout.yMin) * i) / 5;
      values.push(value);
    }
    return values;
  }, [layout]);

  const pathForLine = (line) => {
    const sorted = line.points.slice().sort((a, b) => a.xKey - b.xKey);
    if (!sorted.length) return '';
    return sorted.map((point, idx) => {
      const x = layout.xFor(point.xKey);
      const y = layout.yFor(point.value);
      return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(' ');
  };

  const handleMove = (event) => {
    if (!layout.xKeys.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const mouseX = ((event.clientX - rect.left) / rect.width) * width;
    const mouseY = ((event.clientY - rect.top) / rect.height) * safeHeight;
    const nearestXKey = layout.xKeys.reduce((closest, key) => (
      Math.abs(layout.xFor(key) - mouseX) < Math.abs(layout.xFor(closest) - mouseX) ? key : closest
    ), layout.xKeys[0]);
    const candidates = series
      .map((line) => ({ line, point: line.pointByXKey.get(nearestXKey) }))
      .filter((entry) => entry.point && Number.isFinite(entry.point.value));
    if (!candidates.length) {
      setHover(null);
      return;
    }
    const nearest = candidates.reduce((best, entry) => {
      const y = layout.yFor(entry.point.value);
      const dist = Math.abs(y - mouseY);
      return dist < best.dist ? { ...entry, dist } : best;
    }, { ...candidates[0], dist: Number.POSITIVE_INFINITY });
    const hoverX = layout.xFor(nearestXKey);
    const hoverY = layout.yFor(nearest.point.value);
    setHover({
      xKey: nearestXKey,
      lineKey: nearest.line.key,
      lineLabel: nearest.line.label,
      color: nearest.line.color,
      point: nearest.point,
      x: hoverX,
      y: hoverY
    });
  };

  const xTickStep = Math.max(1, Math.ceil(layout.xKeys.length / 10));

  return (
    <div ref={containerRef} className="benchmark-chart-shell">
      <div className="benchmark-chart-wrap" style={{ height: safeHeight }}>
        <svg
          className="benchmark-series-svg"
          viewBox={`0 0 ${width} ${safeHeight}`}
          preserveAspectRatio="none"
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
          role="img"
          aria-label="Vintage metric line chart"
        >
        {yTicks.map((tick) => {
          const y = layout.yFor(tick);
          return (
            <g key={`y-${tick}`}>
              <line x1={layout.padding.left} x2={width - layout.padding.right} y1={y} y2={y} stroke="#E5EBF4" strokeWidth="1" />
              <text x={layout.padding.left - 8} y={y + 4} textAnchor="end" fontSize="11" fill="#6B7488">
                {valueFormatter(tick)}
              </text>
            </g>
          );
        })}

        {layout.xKeys.map((xKey, idx) => {
          if (idx !== 0 && idx !== layout.xKeys.length - 1 && idx % xTickStep !== 0) return null;
          const x = layout.xFor(xKey);
          const label = layout.labelByXKey.get(xKey) || String(xKey);
          return (
            <text key={`x-${xKey}`} x={x} y={safeHeight - layout.padding.bottom + 18} textAnchor="middle" fontSize="11" fill="#6B7488">
              {label}
            </text>
          );
        })}

        {series.map((line) => {
          const active = !hover || hover.lineKey === line.key;
          return (
            <path
              key={line.key}
              d={pathForLine(line)}
              fill="none"
              stroke={line.color}
              strokeWidth={active ? 2.5 : 1.2}
              opacity={active ? 0.98 : 0.2}
            />
          );
        })}

        {hover && (
          <>
            <line
              x1={hover.x}
              x2={hover.x}
              y1={layout.padding.top}
              y2={safeHeight - layout.padding.bottom}
              stroke="#7A869D"
              strokeDasharray="4 4"
              strokeWidth="1"
            />
            <circle cx={hover.x} cy={hover.y} r="4.5" fill="#FFFFFF" stroke={hover.color} strokeWidth="2.2" />
          </>
        )}

        <text
          x={(layout.padding.left + (width - layout.padding.right)) / 2}
          y={safeHeight - 6}
          textAnchor="middle"
          fontSize="11"
          fill="#5B657A"
        >
          {xAxisLabel}
        </text>
        </svg>
      </div>
      <div className="benchmark-hover-readout" role="status" aria-live="polite">
        {hover ? (
          <>
            <span className="benchmark-hover-readout-title" style={{ color: hover.color }}>{hover.lineLabel}</span>
            <span className="benchmark-hover-readout-sep">|</span>
            <span className="benchmark-hover-readout-axis">{hover.point.xLabel}</span>
            <span className="benchmark-hover-readout-value">{valueFormatter(hover.point.value)}</span>
          </>
        ) : (
          <span className="benchmark-hover-readout-empty">Hover any line to inspect point values.</span>
        )}
      </div>
    </div>
  );
};

const parseRvpiCsv = (text) => {
  const cleaned = (text || '').replace(/^\uFEFF/, '').trim();
  if (!cleaned) return null;
  const rows = cleaned
    .split(/\r?\n/)
    .map((line) => line.split(','))
    .filter((cols) => cols.length > 1);
  if (rows.length < 2) return null;

  const header = rows[0];
  const quarterHeaders = header.slice(1).map((value, idx) => {
    const n = Number(String(value || '').trim());
    return Number.isFinite(n) && n > 0 ? n : idx + 1;
  });

  const lines = [];
  const valuesByQuarter = new Map();
  let maxQuarter = 0;
  let maxValue = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const vintage = String(row[0] || '').trim();
    if (!vintage) continue;
    const points = [];
    for (let c = 1; c < row.length; c++) {
      const raw = String(row[c] ?? '').trim();
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const quarter = quarterHeaders[c - 1] || c;
      points.push({ quarter, value });
      maxQuarter = Math.max(maxQuarter, quarter);
      maxValue = Math.max(maxValue, value);
      if (!valuesByQuarter.has(quarter)) valuesByQuarter.set(quarter, []);
      valuesByQuarter.get(quarter).push(value);
    }
    if (points.length > 1) lines.push({ points });
  }

  if (!lines.length) return null;

  const medianTrend = [];
  for (let q = 1; q <= maxQuarter; q++) {
    const values = (valuesByQuarter.get(q) || []).slice().sort((a, b) => a - b);
    if (!values.length) continue;
    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
    medianTrend.push({ quarter: q, value: median });
  }

  return {
    lines,
    medianTrend,
    maxQuarter,
    maxValue: Math.max(1.2, maxValue)
  };
};

const STRATEGY_TYPE_SERIES_META = {
  buyout: {
    label: 'Buyout Primaries',
    drawdownCol: 'BO Qtrly Drawdown',
    rvpiCol: 'BO RVPI',
    color: '#1B2A4A',
    commentary:
      'Buyout primary funds are the baseline pacing profile: capital is generally drawn over several years, NAV builds, then value is realized over time.'
  },
  venture: {
    label: 'Venture Capital',
    drawdownCol: 'VC Qtrly Drawdown',
    rvpiCol: 'VC RVPI',
    color: '#4A7BA7',
    commentary:
      'NAV tends to stretch out further than a typical buyout fund because companies often take longer to mature and become realized assets.'
  },
  secondary: {
    label: 'Secondaries',
    drawdownCol: 'Secondary Drawdown',
    rvpiCol: 'Secondary RVPI',
    color: '#A8892E',
    commentary:
      'These are often purchased after a fund has already drawn most of its capital, so deployment is faster and underlying companies are typically realized sooner. Think of this as joining a typical primary around year seven.'
  },
  direct: {
    label: 'Direct Equity',
    drawdownCol: 'Direct Equity Drawdown',
    rvpiCol: 'Direct Equity RVPI',
    color: '#B5473A',
    commentary:
      'Capital is typically deployed up front and then value climbs (hopefully) over the hold period until a concentrated exit cycle returns cash.'
  }
};

const parseStrategyTypeScheduleCsv = (text) => {
  const cleaned = (text || '').replace(/^\uFEFF/, '').trim();
  if (!cleaned) return null;
  const rows = cleaned
    .split(/\r?\n/)
    .map((line) => line.split(','))
    .filter((cols) => cols.length > 2);
  if (rows.length < 2) return null;

  const headers = rows[0].map((h) => String(h || '').trim());
  const idxQuarter = headers.findIndex((h) => h.toLowerCase() === 'quarter');
  if (idxQuarter < 0) return null;

  const parsePct = (value) => {
    const raw = String(value ?? '').trim().replace('%', '');
    if (!raw) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num / 100 : null;
  };
  const parseMultiple = (value) => {
    const raw = String(value ?? '').trim().replace('x', '');
    if (!raw) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  };

  const keys = Object.keys(STRATEGY_TYPE_SERIES_META);
  const byKey = {};
  keys.forEach((key) => {
    byKey[key] = {
      ...STRATEGY_TYPE_SERIES_META[key],
      quarterlyDraw: [],
      cumulativeDraw: [],
      rvpi: [],
      navPct: []
    };
  });

  const quarters = [];
  const runningDraw = Object.fromEntries(keys.map((key) => [key, 0]));
  rows.slice(1).forEach((row) => {
    const quarter = Number(String(row[idxQuarter] || '').trim());
    if (!Number.isFinite(quarter) || quarter <= 0) return;
    quarters.push(quarter);
    keys.forEach((key) => {
      const meta = STRATEGY_TYPE_SERIES_META[key];
      const drawIdx = headers.findIndex((h) => h === meta.drawdownCol);
      const rvpiIdx = headers.findIndex((h) => h === meta.rvpiCol);
      const draw = drawIdx >= 0 ? parsePct(row[drawIdx]) : null;
      const rvpi = rvpiIdx >= 0 ? parseMultiple(row[rvpiIdx]) : null;

      if (draw !== null) runningDraw[key] += draw;
      const cum = runningDraw[key];
      const resolvedRvpi = rvpi ?? 0;
      byKey[key].quarterlyDraw.push(draw ?? 0);
      byKey[key].cumulativeDraw.push(cum);
      byKey[key].rvpi.push(resolvedRvpi);
      byKey[key].navPct.push(cum * resolvedRvpi);
    });
  });

  if (!quarters.length) return null;
  return { quarters, byKey, keys };
};

const useStrategyTypeSchedule = () => {
  const [scheduleData, setScheduleData] = useState(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    const load = async () => {
      const base = (import.meta && import.meta.env && import.meta.env.BASE_URL) || '/';
      const normalizedBase = base.endsWith('/') ? base : `${base}/`;
      const candidates = [
        `${normalizedBase}strategy_type_schedule.csv`,
        `${normalizedBase}Strategy_Type_Schedule.csv`,
        '/strategy_type_schedule.csv'
      ];
      for (const path of candidates) {
        try {
          const res = await fetch(path, { cache: 'no-store' });
          if (!res.ok) continue;
          const text = await res.text();
          const parsed = parseStrategyTypeScheduleCsv(text);
          if (parsed) {
            if (active) {
              setScheduleData(parsed);
              setLoadError('');
            }
            return;
          }
        } catch (_) {
          // Try next candidate path.
        }
      }
      if (active) {
        setScheduleData(null);
        setLoadError('Strategy schedule data not found. Expected strategy_type_schedule.csv at site root.');
      }
    };
    load();
    return () => {
      active = false;
    };
  }, []);

  return { scheduleData, loadError };
};

const RvpiVintageTrendChart = ({ height = 300 }) => {
  const canvasRef = useRef(null);
  const [rvpiData, setRvpiData] = useState(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    const load = async () => {
      const base = (import.meta && import.meta.env && import.meta.env.BASE_URL) || '/';
      const normalizedBase = base.endsWith('/') ? base : `${base}/`;
      const candidates = [
        `${normalizedBase}RVPI_Data.csv`,
        `${normalizedBase}rvpi_data.csv`,
        '/RVPI_Data.csv',
        '/rvpi_data.csv'
      ];
      for (const path of candidates) {
        try {
          const res = await fetch(path, { cache: 'no-store' });
          if (!res.ok) continue;
          const text = await res.text();
          const parsed = parseRvpiCsv(text);
          if (parsed && parsed.lines.length) {
            if (active) {
              setRvpiData(parsed);
              setLoadError('');
            }
            return;
          }
        } catch (_) {
          // Try next candidate path.
        }
      }
      if (active) {
        setRvpiData(null);
        setLoadError('RVPI dataset not found. Expected RVPI_Data.csv or rvpi_data.csv at site root.');
      }
    };
    load();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !rvpiData) return undefined;
    const ctx = canvas.getContext('2d');
    let rafId = null;
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const DURATION_MS = 4600;
    let start = null;

    const drawPartial = (points, maxQuarterFloat, options = {}) => {
      if (!points || points.length < 2) return;
      const {
        color = '#4A7BA7',
        lineWidth = 1.15,
        alpha = 0.2,
        dashed = false
      } = options;
      const sorted = points.slice().sort((a, b) => a.quarter - b.quarter);
      const firstVisible = sorted.find((p) => p.quarter <= maxQuarterFloat);
      if (!firstVisible) return;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.globalAlpha = alpha;
      if (dashed) ctx.setLineDash([5, 4]);
      else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(xForQuarter(firstVisible.quarter), yForValue(firstVisible.value));

      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        if (curr.quarter <= maxQuarterFloat) {
          ctx.lineTo(xForQuarter(curr.quarter), yForValue(curr.value));
          continue;
        }
        if (prev.quarter < maxQuarterFloat && curr.quarter > maxQuarterFloat) {
          const t = (maxQuarterFloat - prev.quarter) / (curr.quarter - prev.quarter);
          const y = lerp(prev.value, curr.value, t);
          ctx.lineTo(xForQuarter(maxQuarterFloat), yForValue(y));
        }
        break;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    };

    const draw = (timestamp = 0) => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      canvas.width = width * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, h);

      const padding = { top: 30, right: 24, bottom: 50, left: 58 };
      const chartWidth = width - padding.left - padding.right;
      const chartHeight = h - padding.top - padding.bottom;
      const maxQuarter = Math.max(1, rvpiData.maxQuarter);
      const maxY = Math.max(1.4, Math.ceil(rvpiData.maxValue * 1.12 * 10) / 10);
      const minY = 0;
      const yRange = Math.max(1e-9, maxY - minY);

      xForQuarter = (q) => padding.left + ((q - 1) / Math.max(1, maxQuarter - 1)) * chartWidth;
      yForValue = (v) => padding.top + ((maxY - v) / yRange) * chartHeight;

      ctx.strokeStyle = '#E8EDF6';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 5; i++) {
        const y = padding.top + (i / 5) * chartHeight;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();
        const tickVal = maxY - (i / 5) * yRange;
        ctx.fillStyle = '#7A8397';
        ctx.font = '13px Helvetica Neue';
        ctx.textAlign = 'right';
        ctx.fillText(`${tickVal.toFixed(1)}x`, padding.left - 8, y + 5);
      }

      const quarterStride = maxQuarter > 40 ? 8 : 4;
      for (let q = 1; q <= maxQuarter; q += quarterStride) {
        const x = xForQuarter(q);
        ctx.strokeStyle = '#F2F5FA';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, padding.top);
        ctx.lineTo(x, h - padding.bottom);
        ctx.stroke();
        ctx.fillStyle = '#7A8397';
        ctx.font = '13px Helvetica Neue';
        ctx.textAlign = 'center';
        ctx.fillText(`Yr ${((q - 1) / 4).toFixed(0)}`, x, h - 28);
      }

      const progress = reduceMotion || start === null
        ? 1
        : Math.max(0, Math.min(1, (timestamp - start) / DURATION_MS));
      const maxQuarterFloat = 1 + progress * (maxQuarter - 1);

      rvpiData.lines.forEach((line) => {
        drawPartial(line.points, maxQuarterFloat, {
          color: '#3F6C97',
          lineWidth: 1.2,
          alpha: 0.26
        });
      });
      drawPartial(rvpiData.medianTrend, maxQuarterFloat, {
        color: '#1B2A4A',
        lineWidth: 2.4,
        alpha: 0.98,
        dashed: true
      });

      const OUTLIER_THRESHOLD = 1.7;
      const outlierPoints = [];
      rvpiData.lines.forEach((line) => {
        line.points.forEach((point) => {
          if (point.quarter <= maxQuarterFloat && point.value > OUTLIER_THRESHOLD) {
            outlierPoints.push(point);
          }
        });
      });

      if (outlierPoints.length) {
        ctx.save();
        ctx.fillStyle = 'rgba(63, 108, 151, 0.45)';
        outlierPoints.forEach((point) => {
          ctx.beginPath();
          ctx.arc(xForQuarter(point.quarter), yForValue(point.value), 2.2, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.restore();
      }

      if (progress > 0.96 && rvpiData.medianTrend.length) {
        const last = rvpiData.medianTrend[rvpiData.medianTrend.length - 1];
        const lx = xForQuarter(last.quarter);
        const ly = yForValue(last.value);
        const label = 'Aggregate trend (median)';
        ctx.font = '600 13px Helvetica Neue';
        const lw = ctx.measureText(label).width + 10;
        const bx = Math.max(padding.left + 4, Math.min(width - padding.right - lw, lx - lw - 8));
        const by = Math.max(padding.top + 4, ly - 16);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.fillRect(bx, by, lw, 14);
        ctx.strokeStyle = 'rgba(27,42,74,0.3)';
        ctx.strokeRect(bx, by, lw, 14);
        ctx.fillStyle = '#1B2A4A';
        ctx.textAlign = 'left';
        ctx.fillText(label, bx + 5, by + 11);
      }

      if (progress > 0.96 && outlierPoints.length) {
        const anchor = outlierPoints.reduce((best, point) => (point.value > best.value ? point : best), outlierPoints[0]);
        const ax = xForQuarter(anchor.quarter);
        const ay = yForValue(anchor.value);

        const line1 = 'these outliers correspond to certain';
        const line2 = 'vintage RVPIs during the dot-com boom';
        ctx.font = '600 12px Helvetica Neue';
        const boxW = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 12;
        const boxH = 30;

        const placeRight = ax < padding.left + chartWidth * 0.55;
        const bx = placeRight
          ? Math.min(width - padding.right - boxW, ax + 16)
          : Math.max(padding.left + 6, ax - boxW - 16);
        const by = Math.max(padding.top + 6, Math.min(ay - boxH - 10, padding.top + chartHeight - boxH - 8));
        const targetX = placeRight ? bx : bx + boxW;
        const targetY = by + boxH * 0.5;

        ctx.save();
        ctx.strokeStyle = 'rgba(63, 108, 151, 0.85)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(targetX, targetY);
        ctx.lineTo(ax, ay);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(ax, ay, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = '#1B2A4A';
        ctx.fill();
        ctx.lineWidth = 1.1;
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();

        ctx.fillStyle = 'rgba(255,255,255,0.97)';
        ctx.fillRect(bx, by, boxW, boxH);
        ctx.strokeStyle = 'rgba(63, 108, 151, 0.45)';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, boxW, boxH);

        ctx.fillStyle = '#1B2A4A';
        ctx.font = '600 12px Helvetica Neue';
        ctx.textAlign = 'left';
        ctx.fillText(line1, bx + 6, by + 12);
        ctx.fillText(line2, bx + 6, by + 24);
        ctx.restore();
      }

      ctx.fillStyle = '#5F687A';
      ctx.font = '13px Helvetica Neue';
      ctx.textAlign = 'center';
      ctx.fillText('Quarters Since Vintage Inception', padding.left + chartWidth / 2, h - 10);

      // Inline legend
      ctx.textAlign = 'left';
      ctx.font = '13px Helvetica Neue';
      ctx.fillStyle = '#4A4641';
      ctx.strokeStyle = '#4A7BA7';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(padding.left, 12);
      ctx.lineTo(padding.left + 20, 12);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText('Each vintage RVPI path', padding.left + 26, 17);
      const secondX = padding.left + 220;
      ctx.strokeStyle = '#1B2A4A';
      ctx.lineWidth = 2.4;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(secondX, 12);
      ctx.lineTo(secondX + 20, 12);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText('Median trend', secondX + 26, 17);
    };

    let xForQuarter = () => 0;
    let yForValue = () => 0;

    const animate = (ts) => {
      if (start === null) start = ts;
      draw(ts);
      if (!reduceMotion && ts - start < DURATION_MS + 250) {
        rafId = requestAnimationFrame(animate);
      } else {
        draw(start + DURATION_MS);
      }
    };

    rafId = requestAnimationFrame(animate);
    const onResize = () => {
      start = null;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(animate);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [rvpiData]);

  if (loadError) {
    return <p className="portfolio-inline-note">{loadError}</p>;
  }

  return <canvas ref={canvasRef} className="comparison-canvas rvpi-context-canvas" style={{ width: '100%', height }} />;
};

// ============================================================================
// SECTION COMPONENTS
// ============================================================================

const ActualGrossNetScatter = ({ points, height = 420 }) => {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(920);
  const [revealProgress, setRevealProgress] = useState(0);
  const [isInView, setIsInView] = useState(false);
  const safeHeight = Math.max(320, height);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const update = () => setWidth(Math.max(320, el.clientWidth || 920));
    update();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (observer) observer.observe(el);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      if (observer) observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setIsInView(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsInView(true);
            observer.disconnect();
          }
        });
      },
      { threshold: 0.35 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isInView) return undefined;
    let rafId = 0;
    const start = performance.now();
    const duration = 3600;
    const animate = (timestamp) => {
      const elapsed = Math.max(0, timestamp - start);
      const progress = clamp(elapsed / duration, 0, 1);
      setRevealProgress(1 - Math.pow(1 - progress, 3));
      if (progress < 1) rafId = window.requestAnimationFrame(animate);
    };
    rafId = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(rafId);
  }, [points, isInView]);

  const chartData = useMemo(() => {
    const allPoints = Array.isArray(points) ? points : [];
    const visiblePoints = allPoints
      .filter((point) =>
        point.gross >= ACTUAL_SPREAD_X_DOMAIN[0] &&
        point.gross <= ACTUAL_SPREAD_X_DOMAIN[1] &&
        point.net >= ACTUAL_SPREAD_Y_DOMAIN[0] &&
        point.net <= ACTUAL_SPREAD_Y_DOMAIN[1]
      )
      .sort((a, b) => a.gross - b.gross || a.net - b.net);

    const highlightPoints = visiblePoints.filter((point) =>
      point.gross >= ACTUAL_SPREAD_FOCUS_WINDOW.grossMin &&
      point.gross <= ACTUAL_SPREAD_FOCUS_WINDOW.grossMax &&
      point.net >= ACTUAL_SPREAD_FOCUS_WINDOW.netMin &&
      point.net <= ACTUAL_SPREAD_FOCUS_WINDOW.netMax
    );
    const trendBuckets = buildGrossSpreadBuckets(visiblePoints, { start: 0.75, end: 4.25, width: 0.25, minCount: 6 });

    return {
      visiblePoints,
      highlightPoints,
      omittedCount: Math.max(0, allPoints.length - visiblePoints.length),
      trendBuckets
    };
  }, [points]);

  const padding = { top: 28, right: 22, bottom: 52, left: 56 };
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const plotHeight = Math.max(1, safeHeight - padding.top - padding.bottom);
  const xFor = (value) => padding.left + ((value - ACTUAL_SPREAD_X_DOMAIN[0]) / (ACTUAL_SPREAD_X_DOMAIN[1] - ACTUAL_SPREAD_X_DOMAIN[0])) * plotWidth;
  const yFor = (value) => padding.top + plotHeight - ((value - ACTUAL_SPREAD_Y_DOMAIN[0]) / (ACTUAL_SPREAD_Y_DOMAIN[1] - ACTUAL_SPREAD_Y_DOMAIN[0])) * plotHeight;
  const xTicks = Array.from({ length: 8 }, (_, idx) => 0.5 + idx * 0.5);
  const yTicks = Array.from({ length: 6 }, (_, idx) => 0.5 + idx * 0.5);
  const focusX = xFor(ACTUAL_SPREAD_TARGET.gross);
  const focusY = yFor(ACTUAL_SPREAD_TARGET.net);
  const calloutWidth = Math.min(200, Math.max(156, width * 0.24));
  const calloutHeight = 84;
  const calloutX = padding.left + 14;
  const calloutY = padding.top + 12;
  const trendPath = chartData.trendBuckets.length
    ? chartData.trendBuckets.map((bucket, idx) => `${idx === 0 ? 'M' : 'L'} ${xFor(bucket.grossMid)} ${yFor(bucket.medianNet)}`).join(' ')
    : '';

  return (
    <div className="actual-spread-chart-shell">
      <div ref={containerRef} className="actual-spread-chart-wrap">
        <svg
          className="actual-spread-chart-svg"
          viewBox={`0 0 ${width} ${safeHeight}`}
          role="img"
          aria-label="Scatter plot of actual Pathway fund gross multiples against net TVPI, with the 2.5x gross and 2.0x net baseline region highlighted."
        >
          <defs>
            <linearGradient id="actualSpreadFocusFill" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#F1D98C" stopOpacity="0.38" />
              <stop offset="100%" stopColor="#4A7BA7" stopOpacity="0.14" />
            </linearGradient>
            <filter id="actualSpreadGlow">
              <feGaussianBlur stdDeviation="6" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <rect
            x={xFor(ACTUAL_SPREAD_FOCUS_WINDOW.grossMin)}
            y={yFor(ACTUAL_SPREAD_FOCUS_WINDOW.netMax)}
            width={xFor(ACTUAL_SPREAD_FOCUS_WINDOW.grossMax) - xFor(ACTUAL_SPREAD_FOCUS_WINDOW.grossMin)}
            height={yFor(ACTUAL_SPREAD_FOCUS_WINDOW.netMin) - yFor(ACTUAL_SPREAD_FOCUS_WINDOW.netMax)}
            fill="url(#actualSpreadFocusFill)"
            stroke="rgba(201, 168, 76, 0.92)"
            strokeWidth="2"
            strokeDasharray="7 6"
            rx="14"
          />

          {yTicks.map((tick) => (
            <g key={`actual-y-${tick}`}>
              <line x1={padding.left} x2={width - padding.right} y1={yFor(tick)} y2={yFor(tick)} stroke="#E5EBF4" strokeWidth="1" />
              <text x={padding.left - 10} y={yFor(tick) + 4} textAnchor="end" className="actual-spread-axis-label">
                {tick.toFixed(1)}x
              </text>
            </g>
          ))}

          {xTicks.map((tick) => (
            <g key={`actual-x-${tick}`}>
              <line x1={xFor(tick)} x2={xFor(tick)} y1={padding.top} y2={safeHeight - padding.bottom} stroke="#EEF3FA" strokeWidth="1" />
              <text x={xFor(tick)} y={safeHeight - padding.bottom + 22} textAnchor="middle" className="actual-spread-axis-label">
                {tick.toFixed(1)}x
              </text>
            </g>
          ))}

          <line x1={padding.left} x2={padding.left} y1={padding.top} y2={safeHeight - padding.bottom} stroke="#AEBBD2" strokeWidth="1.2" />
          <line x1={padding.left} x2={width - padding.right} y1={safeHeight - padding.bottom} y2={safeHeight - padding.bottom} stroke="#AEBBD2" strokeWidth="1.2" />

          {trendPath ? (
            <path
              d={trendPath}
              fill="none"
              stroke="rgba(74, 123, 167, 0.8)"
              strokeWidth="3"
              strokeDasharray="8 8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}

          {chartData.visiblePoints.map((point, idx) => {
            const threshold = idx / Math.max(1, chartData.visiblePoints.length - 1);
            const reveal = clamp((revealProgress - threshold) * 11, 0, 1);
            if (reveal <= 0) return null;
            const inFocus = point.gross >= ACTUAL_SPREAD_FOCUS_WINDOW.grossMin &&
              point.gross <= ACTUAL_SPREAD_FOCUS_WINDOW.grossMax &&
              point.net >= ACTUAL_SPREAD_FOCUS_WINDOW.netMin &&
              point.net <= ACTUAL_SPREAD_FOCUS_WINDOW.netMax;
            return (
              <circle
                key={`actual-point-${point.id}`}
                cx={xFor(point.gross)}
                cy={yFor(point.net)}
                r={inFocus ? 3.5 : 2.8}
                fill={inFocus ? '#C9A84C' : '#1B2A4A'}
                fillOpacity={inFocus ? 0.88 * reveal : 0.24 * reveal}
                stroke={inFocus ? 'rgba(255, 255, 255, 0.88)' : 'none'}
                strokeWidth={inFocus ? '0.8' : '0'}
              />
            );
          })}

          <circle cx={focusX} cy={focusY} r="16" fill="rgba(201, 168, 76, 0.18)" filter="url(#actualSpreadGlow)" />
          <circle cx={focusX} cy={focusY} r="7.5" fill="#FFFFFF" stroke="#1B2A4A" strokeWidth="2.4" />
          <circle cx={focusX} cy={focusY} r="3.6" fill="#1B2A4A" />

          <path
            d={`M ${calloutX + calloutWidth - 10} ${calloutY + calloutHeight - 8} C ${calloutX + calloutWidth + 10} ${calloutY + calloutHeight + 4}, ${focusX - 14} ${focusY - 22}, ${focusX - 2} ${focusY - 4}`}
            fill="none"
            stroke="rgba(27, 42, 74, 0.55)"
            strokeWidth="1.6"
          />
          <rect x={calloutX} y={calloutY} width={calloutWidth} height={calloutHeight} rx="12" fill="rgba(255, 255, 255, 0.94)" stroke="#D6DFEC" />
          <text x={calloutX + 12} y={calloutY + 20} className="actual-spread-callout-kicker">Highlighted Baseline Zone</text>
          <text x={calloutX + 12} y={calloutY + 40} className="actual-spread-callout-title">{ACTUAL_SPREAD_TARGET.gross.toFixed(1)}x gross to {ACTUAL_SPREAD_TARGET.net.toFixed(1)}x net</text>
          <text x={calloutX + 12} y={calloutY + 58} className="actual-spread-callout-copy">
            <tspan x={calloutX + 12} dy="0">Dense observed cluster from</tspan>
            <tspan x={calloutX + 12} dy="15">actual Pathway fund outcomes.</tspan>
          </text>

          <text x={padding.left + plotWidth / 2} y={safeHeight - 10} textAnchor="middle" className="actual-spread-axis-title">
            Gross Multiple
          </text>
          <text
            x="18"
            y={padding.top + plotHeight / 2}
            textAnchor="middle"
            transform={`rotate(-90 18 ${padding.top + plotHeight / 2})`}
            className="actual-spread-axis-title"
          >
            Net TVPI
          </text>
        </svg>
      </div>

      <div className="actual-spread-hover-readout" role="status" aria-live="polite">
        <span className="actual-spread-hover-label">Dotted line</span>
        <span className="actual-spread-hover-sep">|</span>
        <span>Median observed net outcome by gross-return band, using anonymized Pathway fund observations.</span>
      </div>

      {chartData.omittedCount > 0 ? (
        <div className="actual-spread-outlier-note">
          A small number of extreme outliers are excluded from the plot window so the core gross-to-net distribution remains legible.
        </div>
      ) : null}
    </div>
  );
};

const GrossNetSpreadTrendChart = ({ buckets, height = 210 }) => {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(900);
  const safeHeight = Math.max(180, height);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const update = () => setWidth(Math.max(320, el.clientWidth || 900));
    update();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (observer) observer.observe(el);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      if (observer) observer.disconnect();
    };
  }, []);

  const safeBuckets = Array.isArray(buckets) ? buckets : [];
  if (!safeBuckets.length) return null;

  const padding = { top: 20, right: 18, bottom: 40, left: 88 };
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const plotHeight = Math.max(1, safeHeight - padding.top - padding.bottom);
  const minX = safeBuckets[0].grossMid - 0.25;
  const maxX = safeBuckets[safeBuckets.length - 1].grossMid + 0.25;
  const minY = 0;
  const maxY = Math.max(1.05, ...safeBuckets.map((bucket) => bucket.medianSpread));
  const xFor = (value) => padding.left + ((value - minX) / (maxX - minX)) * plotWidth;
  const yFor = (value) => padding.top + plotHeight - ((value - minY) / (maxY - minY)) * plotHeight;
  const path = safeBuckets.map((bucket, idx) => `${idx === 0 ? 'M' : 'L'} ${xFor(bucket.grossMid)} ${yFor(bucket.medianSpread)}`).join(' ');

  return (
    <div className="actual-spread-trend-shell">
      <div className="actual-spread-trend-head">
        <div className="actual-spread-trend-title">How the spread widens</div>
        <div className="actual-spread-trend-copy">Median gross-minus-net spread by gross-return band.</div>
      </div>
      <div ref={containerRef} className="actual-spread-trend-wrap">
        <svg className="actual-spread-trend-svg" viewBox={`0 0 ${width} ${safeHeight}`} role="img" aria-label="Median gross-minus-net spread by gross-return band.">
          {Array.from({ length: 5 }, (_, idx) => idx * 0.25).map((tick) => (
            <g key={`spread-y-${tick}`}>
              <line x1={padding.left} x2={width - padding.right} y1={yFor(tick)} y2={yFor(tick)} stroke="#E7ECF5" strokeWidth="1" />
              <text x={padding.left - 10} y={yFor(tick) + 4} textAnchor="end" className="actual-spread-axis-label">
                {tick.toFixed(2)}x
              </text>
            </g>
          ))}

          {safeBuckets.map((bucket) => (
            <g key={`spread-x-${bucket.grossMid}`}>
              <line x1={xFor(bucket.grossMid)} x2={xFor(bucket.grossMid)} y1={padding.top} y2={safeHeight - padding.bottom} stroke="#F0F3F9" strokeWidth="1" />
              <text x={xFor(bucket.grossMid)} y={safeHeight - padding.bottom + 20} textAnchor="middle" className="actual-spread-axis-label">
                {bucket.grossMid.toFixed(1)}x
              </text>
            </g>
          ))}

          <path d={path} fill="none" stroke="#B5473A" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          {safeBuckets.map((bucket) => (
            <g key={`spread-point-${bucket.grossMid}`}>
              <circle cx={xFor(bucket.grossMid)} cy={yFor(bucket.medianSpread)} r="4.5" fill="#FFFFFF" stroke="#B5473A" strokeWidth="2.4" />
              <text x={xFor(bucket.grossMid)} y={yFor(bucket.medianSpread) - 10} textAnchor="middle" className="actual-spread-trend-value">
                {bucket.medianSpread.toFixed(2)}x
              </text>
            </g>
          ))}

          <text x={padding.left + plotWidth / 2} y={safeHeight - 8} textAnchor="middle" className="actual-spread-axis-title">
            Gross Return Band
          </text>
          <text
            x="30"
            y={padding.top + plotHeight / 2}
            textAnchor="middle"
            transform={`rotate(-90 30 ${padding.top + plotHeight / 2})`}
            className="actual-spread-axis-title"
          >
            Gross - Net Spread
          </text>
        </svg>
      </div>
    </div>
  );
};

const Header = () => {
  return (
    <header className="site-header">
      <div className="header-content">
        <div className="header-brand-lockup">
          <img
            className="header-pathway-mark"
            src={pathwayWordmarkUrl}
            alt="Pathway Capital Education logo"
          />
        </div>
        <div className="header-actions">
          <div className="header-note">For institutional LP education</div>
          <a className="header-cta" href={WALKTHROUGH_MAILTO}>
            Request a Walkthrough
          </a>
        </div>
      </div>
    </header>
  );
};

const StickyContactPrompt = () => {
  const [collapsed, setCollapsed] = useState(false);
  const href = buildMailtoHref('Pathway Economics Follow-Up');

  if (collapsed) {
    return (
      <button
        type="button"
        className="sticky-contact-mini"
        onClick={() => setCollapsed(false)}
        aria-label="Open Pathway contact prompt"
      >
        Request a Walkthrough
      </button>
    );
  }

  return (
    <div className="sticky-contact-cta" role="complementary" aria-label="Pathway contact prompt">
      <button
        type="button"
        className="sticky-contact-close"
        onClick={() => setCollapsed(true)}
        aria-label="Minimize contact prompt"
      >
        ×
      </button>
      <a
        className="sticky-contact-link"
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label="Contact Pathway new investors"
      >
        <span className="sticky-contact-kicker">Pathway Capital</span>
        <span className="sticky-contact-title">Request a 15-minute walkthrough</span>
        <span className="sticky-contact-email">{CONTACT_EMAIL}</span>
      </a>
    </div>
  );
};

const PathwayInlineCta = ({
  line = 'Want to pressure-test this with an expert?',
  subject = 'Pathway Private Markets Economics Follow-Up',
  ctaLabel = 'Request a Walkthrough'
}) => (
  <div className="pathway-inline-cta">
    <span>{line}</span>
    <a href={buildMailtoHref(subject)}>{ctaLabel}</a>
  </div>
);

const ComplianceModal = ({ onAcknowledge }) => (
  <div className="compliance-modal-backdrop">
    <div
      className="compliance-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compliance-modal-title"
      aria-describedby="compliance-modal-copy"
    >
      <div className="compliance-modal-kicker">Important Information</div>
      <h2 id="compliance-modal-title">Educational material for institutional audiences</h2>
      <div id="compliance-modal-copy" className="compliance-modal-copy">
        <p>
          This site is for educational purposes only. It is not an offer to sell or a solicitation to buy any security,
          fund, or advisory service.
        </p>
        <p>
          Examples on this page use hypothetical and illustrative assumptions. They simplify real-world fund documents and
          should not be treated as a prediction or a recommendation.
        </p>
        <p>
          Past performance is not indicative of future results. Please review fund documentation and speak with Pathway
          directly before relying on any scenario shown here.
        </p>
      </div>
      <div className="compliance-modal-meta">As of {SITE_AS_OF_DATE}</div>
      <div className="compliance-modal-actions">
        <a className="compliance-modal-link" href={WALKTHROUGH_MAILTO}>
          Contact Pathway
        </a>
        <button type="button" className="compliance-modal-button" onClick={onAcknowledge}>
          Continue to Site
        </button>
      </div>
    </div>
  </div>
);

const ComplianceFooter = () => (
  <footer className="compliance-footer">
    <div className="compliance-footer-inner">
      <div className="compliance-footer-title">Pathway Capital | Private Markets Economics</div>
      <p>
        For educational purposes only. This material is illustrative, does not constitute an offer or solicitation,
        and should not be relied on as investment, legal, accounting, or tax advice.
      </p>
      <p>
        Hypothetical examples simplify fund terms and cash flow timing. Past performance is not indicative of future
        results. As of {SITE_AS_OF_DATE}.
      </p>
    </div>
  </footer>
);

const HeroGrossNetGraph = () => {
  const canvasRef = useRef(null);
  const netCurve = useMemo(() => {
    const points = [];
    for (let gross = 1.0; gross <= 3.5001; gross += 0.01) {
      const model = buildQuarterlySchedule({
        fundSizeM: BASELINE_MODEL_INPUTS.fundSize * 1e6,
        fundLife: BASELINE_MODEL_INPUTS.fundLife,
        investmentPeriod: BASELINE_MODEL_INPUTS.investmentPeriod,
        grossMultiple: gross,
        mgmtFeeRate: BASELINE_MODEL_INPUTS.mgmtFeeRate,
        expenseRate: BASELINE_MODEL_INPUTS.expenseRate,
        carryRate: BASELINE_MODEL_INPUTS.carryRate,
        hurdleRate: BASELINE_MODEL_INPUTS.hurdleRate,
        deploymentRate: 1
      });
      points.push({
        gross: Number(gross.toFixed(2)),
        net: model.totals.netMultiple
      });
    }
    return points;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const minX = 1.0;
    const maxX = 3.5;
    const minY = 1.0;
    const maxY = 3.5;
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sweepDurationMs = 6200;
    const holdDurationMs = 3000;
    const cycleDurationMs = sweepDurationMs + holdDurationMs;

    const interpolateNet = (gross) => {
      if (gross <= netCurve[0].gross) return netCurve[0].net;
      if (gross >= netCurve[netCurve.length - 1].gross) return netCurve[netCurve.length - 1].net;
      for (let i = 1; i < netCurve.length; i++) {
        if (gross <= netCurve[i].gross) {
          const left = netCurve[i - 1];
          const right = netCurve[i];
          const t = (gross - left.gross) / (right.gross - left.gross);
          return lerp(left.net, right.net, t);
        }
      }
      return netCurve[netCurve.length - 1].net;
    };

    const axisX = (value, padding, width) =>
      padding.left + ((value - minX) / (maxX - minX)) * (width - padding.left - padding.right);
    const axisY = (value, padding, height) =>
      height - padding.bottom - ((value - minY) / (maxY - minY)) * (height - padding.top - padding.bottom);

    const draw = (timestamp = 0) => {
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const dpr = window.devicePixelRatio || 1;
      const targetWidth = Math.max(1, Math.floor(width * dpr));
      const targetHeight = Math.max(1, Math.floor(height * dpr));

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const padding = { top: 18, right: 26, bottom: 46, left: 58 };
      const chartWidth = width - padding.left - padding.right;
      const chartHeight = height - padding.top - padding.bottom;

      const bgGradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
      bgGradient.addColorStop(0, 'rgba(27, 42, 74, 0.05)');
      bgGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = bgGradient;
      ctx.fillRect(padding.left, padding.top, chartWidth, chartHeight);

      ctx.strokeStyle = '#E2E8F2';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 5; i++) {
        const y = padding.top + (i / 5) * chartHeight;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();
      }
      for (let i = 0; i <= 5; i++) {
        const x = padding.left + (i / 5) * chartWidth;
        ctx.beginPath();
        ctx.moveTo(x, padding.top);
        ctx.lineTo(x, height - padding.bottom);
        ctx.stroke();
      }

      const ticks = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5];
      ctx.fillStyle = '#7A8397';
      ctx.font = '11px Helvetica Neue';
      ctx.textAlign = 'right';
      ticks.forEach((tick) => {
        ctx.fillText(`${tick.toFixed(1)}x`, padding.left - 8, axisY(tick, padding, height) + 4);
      });
      ctx.textAlign = 'center';
      ticks.forEach((tick) => {
        ctx.fillText(`${tick.toFixed(1)}x`, axisX(tick, padding, width), height - 24);
      });

      ctx.fillStyle = '#5F687A';
      ctx.font = '11px Helvetica Neue';
      ctx.textAlign = 'center';
      ctx.fillText('Gross MOIC', padding.left + chartWidth / 2, height - 8);
      ctx.save();
      ctx.translate(14, padding.top + chartHeight / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText('Net Multiple (TVPI)', 0, 0);
      ctx.restore();

      ctx.strokeStyle = '#2D6B4F';
      ctx.lineWidth = 1.8;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(axisX(minX, padding, width), axisY(minX, padding, height));
      ctx.lineTo(axisX(maxX, padding, width), axisY(maxX, padding, height));
      ctx.stroke();
      ctx.setLineDash([]);

      // Shade only the vertical gap between gross and net curves.
      ctx.beginPath();
      netCurve.forEach((p, idx) => {
        const x = axisX(p.gross, padding, width);
        const y = axisY(p.net, padding, height);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      for (let i = netCurve.length - 1; i >= 0; i--) {
        const p = netCurve[i];
        const x = axisX(p.gross, padding, width);
        const y = axisY(p.gross, padding, height);
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(201, 168, 76, 0.16)';
      ctx.fill();

      ctx.strokeStyle = '#1B2A4A';
      ctx.lineWidth = 3;
      ctx.beginPath();
      netCurve.forEach((p, idx) => {
        const x = axisX(p.gross, padding, width);
        const y = axisY(p.net, padding, height);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      const baselineGross = 2.5;
      const baselineNet = interpolateNet(baselineGross);
      const bx = axisX(baselineGross, padding, width);
      const by = axisY(baselineNet, padding, height);
      ctx.fillStyle = '#C9A84C';
      ctx.beginPath();
      ctx.arc(bx, by, 5, 0, Math.PI * 2);
      ctx.fill();

      const baselineLabelX = Math.min(width - padding.right - 150, bx + 26);
      const baselineLabelY = Math.max(padding.top + 18, by - 30);
      ctx.strokeStyle = 'rgba(15, 27, 51, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx + 5, by - 5);
      ctx.lineTo(baselineLabelX - 6, baselineLabelY + 1);
      ctx.stroke();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.fillRect(baselineLabelX - 4, baselineLabelY - 12, 146, 18);
      ctx.strokeStyle = 'rgba(27, 42, 74, 0.14)';
      ctx.strokeRect(baselineLabelX - 4, baselineLabelY - 12, 146, 18);
      ctx.fillStyle = '#0F1B33';
      ctx.font = '600 11px Helvetica Neue';
      ctx.textAlign = 'left';
      ctx.fillText('Baseline 2.5x → 2.0x', baselineLabelX, baselineLabelY);

      let phase = 0.62;
      if (!reducedMotion) {
        const cycleTime = timestamp % cycleDurationMs;
        const linearPhase = cycleTime <= sweepDurationMs ? cycleTime / sweepDurationMs : 1;
        phase = Math.max(0, Math.min(1, linearPhase));
      }
      const animatedGross = minX + phase * (maxX - minX);
      const animatedNet = interpolateNet(animatedGross);
      const gx = axisX(animatedGross, padding, width);
      const gyNet = axisY(animatedNet, padding, height);
      const gyGross = axisY(animatedGross, padding, height);

      ctx.strokeStyle = 'rgba(27, 42, 74, 0.28)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(gx, padding.top);
      ctx.lineTo(gx, height - padding.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = '#C9A84C';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(gx, gyGross);
      ctx.lineTo(gx, gyNet);
      ctx.stroke();

      ctx.fillStyle = '#2D6B4F';
      ctx.beginPath();
      ctx.arc(gx, gyGross, 4.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#1B2A4A';
      ctx.beginPath();
      ctx.arc(gx, gyNet, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#5F687A';
      ctx.font = '10px Helvetica Neue';
      ctx.textAlign = gx > width - 140 ? 'right' : 'left';
      const labelX = gx > width - 140 ? gx - 8 : gx + 8;
      ctx.fillText(`Gross ${animatedGross.toFixed(2)}x`, labelX, gyGross - 8);
      ctx.fillText(`Net ${animatedNet.toFixed(2)}x`, labelX, gyNet + 14);
    };

    let rafId = 0;
    const frame = (ts) => {
      draw(ts);
      if (!reducedMotion) {
        rafId = requestAnimationFrame(frame);
      }
    };

    if (reducedMotion) {
      draw(0);
    } else {
      rafId = requestAnimationFrame(frame);
    }

    const handleResize = () => draw(0);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(rafId);
    };
  }, [netCurve]);

  return (
    <div className="hero-graphboard">
      <canvas ref={canvasRef} className="hero-graph-canvas" />
    </div>
  );
};

// ============================================================================
// GROSS BASE CURVE - Underlying investment performance BEFORE fees/carry
// Normalized to 1.0x deployment, 2.5x gross return over 12 years (48 quarters)
// Investment period: 5 years (20 quarters), Distributions: Q15-Q48
// ============================================================================

// This curve represents GROSS fund performance - what the investments return
// before management fees, expenses, and carried interest are applied.
// The drawdown represents capital deployed into deals (not fees).
// The dpi represents gross distributions from exits (before waterfall).

const GROSS_BASE_CURVE = {
  // Base parameters tuned to reflect a three-phase lifecycle:
  // deployment, operational value creation, and harvest/return.
  baseGrossMultiple: 2.5,
  baseFundLife: 12,            // 12 years = 48 quarters
  baseInvestmentPeriod: 5,     // 5 years to full deployment
  baseDistributionStart: 3.75, // Distributions begin year 3.75 (Q15)

  // Capital deployment curve (slower start, faster middle, long tail)
  // Returns cumulative % deployed at given progress through investment period
  getDrawdown: (progress) => {
    const t = Math.max(0, Math.min(1, progress));
    const smooth = t * t * (3 - 2 * t);
    return 0.08 * t + 0.92 * smooth;
  },

  // Distribution curve - delayed start, accelerated middle harvest, tapered finish
  // Returns cumulative % of total distributions at given progress through distribution period
  getDistribution: (progress) => {
    const t = Math.max(0, Math.min(1, progress));
    if (t <= 0.2) {
      return 0.12 * Math.pow(t / 0.2, 1.8);
    }
    if (t <= 0.8) {
      return 0.12 + 0.76 * Math.pow((t - 0.2) / 0.6, 0.85);
    }
    return 0.88 + 0.12 * Math.pow((t - 0.8) / 0.2, 1.4);
  },

  // NAV curve - J-curve, then value creation, then harvest decline
  getNAV: (yearProgress, distributionProgress, grossMultiple) => {
    const t = Math.max(0, Math.min(1, yearProgress));
    const harvest = Math.max(0, Math.min(1, distributionProgress));
    const peakNAV = 1 + (grossMultiple - 1) * 0.6;
    // Keep NAV continuous when moving from value-creation to harvest.
    // At t=0.65, distribution progress is ~49% under the base timing assumptions.
    const harvestStartProgress = 0.49;

    if (t < 0.25) {
      return 0.9 + (t / 0.25) * 0.18;
    }
    if (t < 0.65) {
      return 1.08 + ((t - 0.25) / 0.4) * (peakNAV - 1.08);
    }
    const normalizedHarvest = Math.max(0, (harvest - harvestStartProgress) / (1 - harvestStartProgress));
    return Math.max(0, peakNAV * (1 - Math.pow(normalizedHarvest, 1.08)));
  }
};

// Generate time-scaled quarterly data from the base curve
const generateQuarterlyData = (fundLife, investmentPeriod, grossMultiple) => {
  const totalQuarters = fundLife * 4;
  const investmentQuarters = investmentPeriod * 4;
  // Scale distribution start proportionally to fund life
  // Base: 3.75 years into a 12-year fund = 31.25% through
  const distributionStartRatio = GROSS_BASE_CURVE.baseDistributionStart / GROSS_BASE_CURVE.baseFundLife;
  const distributionStartQuarter = Math.max(Math.round(fundLife * distributionStartRatio * 4), 10);
  const distributionQuarters = totalQuarters - distributionStartQuarter + 1;

  const data = [];
  let prevDrawdown = 0;
  let prevDPI = 0;
  let prevTotalValue = 0;

  for (let q = 1; q <= totalQuarters; q++) {
    // Capital deployment progress (0-1 through investment period)
    const deploymentProgress = Math.min(1, q / investmentQuarters);
    const drawdown = GROSS_BASE_CURVE.getDrawdown(deploymentProgress);

    // Distribution progress (0-1 through distribution period)
    let dpi = 0;
    if (q >= distributionStartQuarter) {
      const distProgress = (q - distributionStartQuarter + 1) / distributionQuarters;
      dpi = GROSS_BASE_CURVE.getDistribution(distProgress) * grossMultiple;
    }

    // Unrealized value (RVPI)
    const yearProgress = q / totalQuarters;
    const distProgress = q >= distributionStartQuarter
      ? (q - distributionStartQuarter + 1) / distributionQuarters
      : 0;
    let rvpi = GROSS_BASE_CURVE.getNAV(yearProgress, distProgress, grossMultiple) * drawdown;
    // Keep total value (DPI + RVPI) economically coherent for the base curve:
    // it should generally decelerate into the terminal multiple, not fall in late years.
    const candidateTotalValue = dpi + rvpi;
    const totalValue = Math.min(grossMultiple, Math.max(prevTotalValue, candidateTotalValue));
    rvpi = Math.max(0, totalValue - dpi);

    // Incremental values
    const capitalCall = drawdown - prevDrawdown;
    const distribution = dpi - prevDPI;

    data.push({
      quarter: q,
      year: q / 4,
      drawdown,           // Cumulative % of capital deployed (0-1)
      dpi,                // Cumulative gross distributions as multiple of committed
      rvpi,               // Remaining value as multiple of committed
      capitalCall,        // Incremental deployment this quarter (0-1)
      distribution,       // Incremental distribution this quarter (multiple)
      isInvestmentPeriod: q <= investmentQuarters
    });

    prevDrawdown = drawdown;
    prevDPI = dpi;
    prevTotalValue = totalValue;
  }

  return data;
};

// Calculate IRR from cash flows using Newton-Raphson method
const calculateIRR = (cashFlows, periodsPerYear = 4) => {
  // cashFlows: array of { period, amount } where negative = outflow, positive = inflow
  const npv = (rate) => {
    return cashFlows.reduce((sum, cf) => {
      return sum + cf.amount / Math.pow(1 + rate, cf.period / periodsPerYear);
    }, 0);
  };

  const npvDerivative = (rate) => {
    return cashFlows.reduce((sum, cf) => {
      const t = cf.period / periodsPerYear;
      return sum - (t * cf.amount) / Math.pow(1 + rate, t + 1);
    }, 0);
  };

  let rate = 0.15; // Initial guess
  for (let i = 0; i < 100; i++) {
    const npvValue = npv(rate);
    const derivative = npvDerivative(rate);
    if (Math.abs(derivative) < 1e-10) break;
    const newRate = rate - npvValue / derivative;
    if (Math.abs(newRate - rate) < 1e-8) break;
    rate = newRate;
  }
  return rate;
};

// Source-of-truth quarterly model used across sections.
const buildQuarterlySchedule = ({
  fundSizeM,
  fundLife,
  investmentPeriod,
  grossMultiple,
  mgmtFeeRate,
  expenseRate,
  carryRate,
  hurdleRate,
  deploymentRate = 1,
  carryTrueUpTiming = 'frontLoadedCatchUp'
}) => {
  const grossQuarterlyData = generateQuarterlyData(fundLife, investmentPeriod, grossMultiple);
  const totalQuarters = fundLife * 4;
  const investmentQuarters = investmentPeriod * 4;
  const deployedCapitalTarget = fundSizeM * deploymentRate;

  let cumulativeGrossDist = 0;
  let cumulativeNetDist = 0;
  let cumulativeMgmtFees = 0;
  let cumulativeExpenses = 0;
  let cumulativeCarry = 0;
  let cumulativeCalledCapital = 0;
  let lpBalance = 0; // Called capital balance owed to LPs before carry.
  let cumulativeNetCF = 0;

  const grossCashFlows = [];
  const netCashFlows = [];
  const schedule = [];

  grossQuarterlyData.forEach((q) => {
    const isInvestmentPeriod = q.quarter <= investmentQuarters;
    const capitalCall = q.capitalCall * deployedCapitalTarget;
    const grossDistribution = q.distribution * deployedCapitalTarget;
    cumulativeCalledCapital += capitalCall;
    cumulativeGrossDist += grossDistribution;

    // Translate gross distributions into returned cost basis for post-investment fee basis.
    const costRealized = grossMultiple > 0 ? cumulativeGrossDist / grossMultiple : 0;
    const deployedCost = q.drawdown * deployedCapitalTarget;
    const remainingCostBasis = Math.max(0, deployedCost - costRealized);
    const feeBasisFloor = fundSizeM * 0.4;
    const expenseBasisFloor = fundSizeM * 0.3;
    const feeBasis = isInvestmentPeriod ? fundSizeM : Math.max(remainingCostBasis, feeBasisFloor);
    const expenseBasis = isInvestmentPeriod ? fundSizeM : Math.max(remainingCostBasis, expenseBasisFloor);

    // Schedule calibration assumptions:
    // post-investment fee step-down is modest, and expenses stay meaningful through harvest.
    const effectiveFeeRate = isInvestmentPeriod ? mgmtFeeRate : mgmtFeeRate * 0.85;
    const effectiveExpenseRate = isInvestmentPeriod ? expenseRate : expenseRate;
    const mgmtFee = feeBasis * effectiveFeeRate / 4;
    const expense = expenseBasis * effectiveExpenseRate / 4;

    cumulativeMgmtFees += mgmtFee;
    cumulativeExpenses += expense;

    // LP pref balance accrues on called capital only (fees are modeled as separate outflows).
    lpBalance = lpBalance * (1 + hurdleRate / 4) + capitalCall;

    // European-style carry: only after full LP balance is returned.
    let netDistribution = 0;
    let carry = 0;
    let residualAfterPref = 0;
    if (grossDistribution > 0) {
      const lpReturn = Math.min(grossDistribution, lpBalance);
      lpBalance = Math.max(0, lpBalance - lpReturn);
      residualAfterPref = grossDistribution - lpReturn;
      carry = residualAfterPref * carryRate;
      netDistribution = lpReturn + residualAfterPref - carry;
    }

    cumulativeCarry += carry;
    cumulativeNetDist += netDistribution;

    const netCF = netDistribution - capitalCall - mgmtFee - expense;
    cumulativeNetCF += netCF;

    if (capitalCall > 0) {
      grossCashFlows.push({ period: q.quarter, amount: -capitalCall });
      netCashFlows.push({ period: q.quarter, amount: -(capitalCall + mgmtFee + expense) });
    } else if (mgmtFee + expense > 0) {
      netCashFlows.push({ period: q.quarter, amount: -(mgmtFee + expense) });
    }
    if (grossDistribution > 0) {
      grossCashFlows.push({ period: q.quarter, amount: grossDistribution });
    }
    if (netDistribution > 0) {
      netCashFlows.push({ period: q.quarter, amount: netDistribution });
    }

    schedule.push({
      quarter: q.quarter,
      year: q.year,
      isInvestmentPeriod,
      drawdownPct: q.drawdown * deploymentRate,
      capitalCall,
      feeBasis,
      mgmtFee,
      expense,
      grossDistribution,
      residualAfterPref,
      carry,
      netDistribution,
      nav: q.rvpi * deployedCapitalTarget,
      lpBalance,
      cumulativeGrossDist,
      cumulativeNetDist,
      cumulativeMgmtFees,
      cumulativeExpenses,
      cumulativeCarry,
      netCF,
      cumulativeNetCF
    });
  });

  const grossValue = deployedCapitalTarget * grossMultiple;
  const grossProfitOnCalled = Math.max(0, grossValue - cumulativeCalledCapital);
  const avgHoldPeriod = fundLife * 0.6;
  const hurdleAmount = cumulativeCalledCapital * (Math.pow(1 + hurdleRate, avgHoldPeriod) - 1);
  const residualAfterHurdle = Math.max(0, grossProfitOnCalled - hurdleAmount);
  const hurdleCleared = residualAfterHurdle > 0;

  // Continuous carry target:
  // 1) Profit first pays LP preferred return (hurdle).
  // 2) GP gets catch-up until reaching carry share.
  // 3) Then split at carry rate.
  const catchUpTarget = carryRate < 1 ? (carryRate * hurdleAmount) / (1 - carryRate) : 0;
  const targetCarry = residualAfterHurdle <= catchUpTarget
    ? residualAfterHurdle
    : catchUpTarget + (residualAfterHurdle - catchUpTarget) * carryRate;

  // Quarter-level simulation can understate catch-up; top up target carry and allocate it
  // in a timing pattern that can be configured by the calling section.
  const carryTopUp = Math.max(0, targetCarry - cumulativeCarry);
  if (carryTopUp > 0 && schedule.length > 0) {
    cumulativeCarry += carryTopUp;
    cumulativeNetDist -= carryTopUp;
    const applyScheduleCarryAdjustment = (rowIndex, amount) => {
      if (amount <= 0 || rowIndex < 0 || rowIndex >= schedule.length) return;
      const row = schedule[rowIndex];
      row.carry += amount;
      row.netDistribution = Math.max(0, row.netDistribution - amount);
      row.netCF -= amount;
      for (let j = rowIndex; j < schedule.length; j++) {
        schedule[j].cumulativeCarry += amount;
        schedule[j].cumulativeNetDist -= amount;
        schedule[j].cumulativeNetCF -= amount;
      }
      netCashFlows.push({ period: row.quarter, amount: -amount });
    };

    if (carryTrueUpTiming === 'frontLoadedCatchUp') {
      let remaining = carryTopUp;
      for (let i = 0; i < schedule.length; i++) {
        if (remaining <= 1e-9) break;
        const row = schedule[i];
        const availableForCatchUp = Math.max(0, row.residualAfterPref - row.carry);
        if (availableForCatchUp <= 1e-9) continue;
        const allocation = Math.min(remaining, availableForCatchUp);
        applyScheduleCarryAdjustment(i, allocation);
        remaining -= allocation;
      }
      if (remaining > 1e-9) {
        applyScheduleCarryAdjustment(schedule.length - 1, remaining);
      }
    } else if (carryTrueUpTiming === 'proRataCarryPeriods') {
      const carryRows = schedule
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => row.carry > 0);
      const carryWeight = carryRows.reduce((sum, { row }) => sum + row.carry, 0);
      if (carryRows.length > 0 && carryWeight > 0) {
        let allocated = 0;
        carryRows.forEach(({ index, row }, idx) => {
          const isLast = idx === carryRows.length - 1;
          const provisional = isLast
            ? Math.max(0, carryTopUp - allocated)
            : carryTopUp * (row.carry / carryWeight);
          const availableForCatchUp = Math.max(0, row.residualAfterPref - row.carry);
          const allocation = isLast
            ? Math.max(0, carryTopUp - allocated)
            : Math.min(provisional, availableForCatchUp);
          allocated += allocation;
          applyScheduleCarryAdjustment(index, allocation);
        });
        if (allocated < carryTopUp - 1e-9) {
          applyScheduleCarryAdjustment(schedule.length - 1, carryTopUp - allocated);
        }
      } else {
        applyScheduleCarryAdjustment(schedule.length - 1, carryTopUp);
      }
    } else {
      applyScheduleCarryAdjustment(schedule.length - 1, carryTopUp);
    }
  }

  const netValue = cumulativeNetDist - cumulativeMgmtFees - cumulativeExpenses;
  const grossIRR = grossCashFlows.length > 2 ? calculateIRR(grossCashFlows, 4) : 0;
  const netIRR = netCashFlows.length > 2 ? calculateIRR(netCashFlows, 4) : 0;

  return {
    schedule,
    totals: {
      grossValue,
      netValue,
      grossMultiple: fundSizeM > 0 ? grossValue / fundSizeM : 0,
      grossMOICOnInvested: grossMultiple,
      netMultiple: fundSizeM > 0 ? netValue / fundSizeM : 0,
      grossIRR,
      netIRR,
      totalMgmtFees: cumulativeMgmtFees,
      totalExpenses: cumulativeExpenses,
      carry: cumulativeCarry,
      totalCosts: cumulativeMgmtFees + cumulativeExpenses + cumulativeCarry,
      totalGrossProfit: grossValue - fundSizeM,
      netProfit: netValue - fundSizeM,
      deployedCapitalTarget,
      deploymentRate,
      cumulativeCalledCapital
    },
    grossCashFlows,
    netCashFlows,
    totalQuarters
  };
};

const buildAnnualGrossCurve = (fundLife, investmentPeriod, grossMultiple) => {
  const quarterly = generateQuarterlyData(fundLife, investmentPeriod, grossMultiple);
  const annual = [{ year: 0, drawdown: 0, dpi: 0, nav: 0, tvpi: 0 }];

  for (let year = 1; year <= fundLife; year++) {
    const quarterIndex = Math.min(quarterly.length - 1, year * 4 - 1);
    const row = quarterly[quarterIndex];
    annual.push({
      year,
      drawdown: row.drawdown,
      dpi: row.dpi,
      nav: row.rvpi,
      tvpi: row.dpi + row.rvpi
    });
  }

  return annual;
};

const getCurvePointAtAge = (curve, age) => {
  if (!curve || curve.length === 0) {
    return { year: 0, drawdown: 0, dpi: 0, nav: 0, tvpi: 0 };
  }
  if (age <= 0) return curve[0];
  const maxYear = curve[curve.length - 1].year;
  if (age >= maxYear) return curve[curve.length - 1];

  const lowerAge = Math.floor(age);
  const upperAge = Math.ceil(age);
  if (lowerAge === upperAge) return curve[lowerAge];

  const lower = curve[lowerAge];
  const upper = curve[upperAge];
  const t = age - lowerAge;
  return {
    year: age,
    drawdown: lerp(lower.drawdown, upper.drawdown, t),
    dpi: lerp(lower.dpi, upper.dpi, t),
    nav: lerp(lower.nav, upper.nav, t),
    tvpi: lerp(lower.tvpi, upper.tvpi, t)
  };
};

const simulateLayeredPortfolio = ({
  annualCommitmentM,
  commitmentYears,
  commitmentGrowth,
  curve,
  horizonYears
}) => {
  const rows = [];
  let totalCommittedM = 0;
  for (let y = 0; y < commitmentYears; y++) {
    totalCommittedM += annualCommitmentM * Math.pow(1 + commitmentGrowth, y);
  }

  for (let year = 0; year <= horizonYears; year++) {
    let calledM = 0;
    let navM = 0;
    let distM = 0;
    let committedToDateM = 0;

    for (let vintage = 0; vintage < commitmentYears; vintage++) {
      const commitM = annualCommitmentM * Math.pow(1 + commitmentGrowth, vintage);
      if (year < vintage) continue;
      committedToDateM += commitM;
      const age = year - vintage;
      const point = getCurvePointAtAge(curve, age);
      calledM += commitM * point.drawdown;
      navM += commitM * point.nav;
      distM += commitM * point.dpi;
    }

    rows.push({
      year,
      calledM,
      navM,
      distM,
      committedToDateM,
      tvpiOnCommitted: committedToDateM > 0 ? (navM + distM) / committedToDateM : 0
    });
  }

  return {
    years: rows,
    totalCommittedM
  };
};

const PORTFOLIO_STRATEGY_CURVES = {
  buyout: { label: 'Buyout', fundLife: 12, investmentPeriod: 5, grossMultiple: 2.5, color: '#1B2A4A' },
  growth: { label: 'Growth Equity', fundLife: 10, investmentPeriod: 4, grossMultiple: 2.6, color: '#2D6B4F' },
  venture: { label: 'Venture Capital', fundLife: 13, investmentPeriod: 6, grossMultiple: 2.8, color: '#4A7BA7' },
  secondary: { label: 'Secondaries', fundLife: 8, investmentPeriod: 2, grossMultiple: 1.9, color: '#A8892E' },
  direct: { label: 'Direct Equity', fundLife: 7, investmentPeriod: 2, grossMultiple: 2.0, color: '#B5473A' }
};

// ============================================================================
// MASTER DASHBOARD - The Big Picture
// ============================================================================

const MasterDashboard = ({ asSynthesis = false, globalGrossMultiple, onGrossMultipleChange, sectionId } = {}) => {
  const DEFAULTS = {
    fundSize: 500,
    fundLife: 12,
    investmentPeriod: 5,
    mgmtFeeRate: 0.02,
    expenseRate: 0.005,
    carryRate: 0.20,
    hurdleRate: 0.08,
    grossMultipleTarget: BASELINE_GROSS_TVPI
  };

  // Fund structure inputs
  const [fundSize, setFundSize] = useState(DEFAULTS.fundSize);
  const [fundLife, setFundLife] = useState(DEFAULTS.fundLife); // 12 years
  const [investmentPeriod, setInvestmentPeriod] = useState(DEFAULTS.investmentPeriod); // 5 years to full deployment

  // Fee structure inputs
  const [mgmtFeeRate, setMgmtFeeRate] = useState(DEFAULTS.mgmtFeeRate);       // 2% management fee
  const [expenseRate, setExpenseRate] = useState(DEFAULTS.expenseRate);      // 50bps expenses
  const [carryRate, setCarryRate] = useState(DEFAULTS.carryRate);           // 20% carried interest
  const [hurdleRate, setHurdleRate] = useState(DEFAULTS.hurdleRate);         // 8% preferred return

  // Performance input can be globally linked, with safe local fallback.
  const [localGrossMultipleTarget, setLocalGrossMultipleTarget] = useState(BASELINE_GROSS_TVPI);
  const grossMultipleTarget = globalGrossMultiple ?? localGrossMultipleTarget;
  const setGrossMultipleTarget = onGrossMultipleChange ?? setLocalGrossMultipleTarget;
  const [viewportTick, setViewportTick] = useState(0);
  const resetMasterDashboard = () => {
    setFundSize(DEFAULTS.fundSize);
    setFundLife(DEFAULTS.fundLife);
    setInvestmentPeriod(DEFAULTS.investmentPeriod);
    setMgmtFeeRate(DEFAULTS.mgmtFeeRate);
    setExpenseRate(DEFAULTS.expenseRate);
    setCarryRate(DEFAULTS.carryRate);
    setHurdleRate(DEFAULTS.hurdleRate);
    setGrossMultipleTarget(DEFAULTS.grossMultipleTarget);
  };

  useEffect(() => {
    const handleResize = () => setViewportTick((v) => v + 1);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Calculate everything from GROSS down to NET
  const calculations = useMemo(() => {
    const fundSizeM = fundSize * 1e6;
    const model = buildQuarterlySchedule({
      fundSizeM,
      fundLife,
      investmentPeriod,
      grossMultiple: grossMultipleTarget,
      mgmtFeeRate,
      expenseRate,
      carryRate,
      hurdleRate
    });

    const { schedule, totals } = model;
    const quarterlyData = schedule.map((q) => ({
      quarter: q.quarter,
      year: q.year,
      capitalCall: q.capitalCall,
      grossDistribution: q.grossDistribution,
      netDistribution: q.netDistribution,
      cumulativeDrawdown: q.drawdownPct * fundSizeM,
      cumulativeGrossDPI: q.cumulativeGrossDist,
      cumulativeNetDPI: q.cumulativeNetDist - q.cumulativeMgmtFees - q.cumulativeExpenses,
      nav: q.nav,
      isInvestmentPeriod: q.isInvestmentPeriod
    }));

    const yearlyData = [];
    for (let year = 1; year <= fundLife; year++) {
      const startQ = (year - 1) * 4 + 1;
      const endQ = year * 4;
      const yearRows = schedule.filter((q) => q.quarter >= startQ && q.quarter <= endQ);
      const lastRow = yearRows[yearRows.length - 1];
      yearlyData.push({
        year,
        fee: yearRows.reduce((sum, q) => sum + q.mgmtFee, 0),
        expense: yearRows.reduce((sum, q) => sum + q.expense, 0),
        cumulativeFees: lastRow ? lastRow.cumulativeMgmtFees : 0,
        cumulativeExpenses: lastRow ? lastRow.cumulativeExpenses : 0,
        isInvestmentPeriod: year <= investmentPeriod
      });
    }

    const breakdown = [
      { label: 'LP Capital', value: fundSizeM, color: '#1B2A4A' },
      { label: 'Gross Profit', value: totals.totalGrossProfit, color: '#2D6B4F' },
      { label: 'Mgmt Fees', value: totals.totalMgmtFees, color: '#B5473A', isDeduction: true },
      { label: 'Expenses', value: totals.totalExpenses, color: '#D4A017', isDeduction: true },
      { label: 'GP Carry', value: totals.carry, color: '#C9A84C', isDeduction: true },
      { label: 'LP Net', value: totals.netValue, color: '#1B2A4A' },
    ];

    const avgHoldPeriod = fundLife * 0.6;
    const hurdleAmount = totals.cumulativeCalledCapital * (Math.pow(1 + hurdleRate, avgHoldPeriod) - 1);
    const hurdleCleared = (totals.grossValue - totals.cumulativeCalledCapital) > hurdleAmount;
    const feeDragPercent = totals.totalGrossProfit > 0 ? (totals.totalCosts / totals.totalGrossProfit) * 100 : 0;

    return {
      ...totals,
      totalFeesAndExpenses: totals.totalMgmtFees + totals.totalExpenses,
      hurdleAmount,
      hurdleCleared,
      feeDragPercent,
      yearlyData,
      quarterlyData,
      schedule,
      breakdown,
      fundSizeM,
      totalDrag: totals.totalCosts
    };
  }, [fundSize, mgmtFeeRate, expenseRate, carryRate, hurdleRate, grossMultipleTarget, fundLife, investmentPeriod]);

  // Canvas-based fund lifecycle visualization
  const lifecycleCanvasRef = useRef(null);

  useEffect(() => {
    const canvas = lifecycleCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.scale(dpr, dpr);

    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;

    ctx.clearRect(0, 0, width, height);

    const padding = { top: 40, bottom: 60, left: 70, right: 30 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // Use quarterly data from calculations, sample every 4 quarters for yearly display
    const quarterlyData = calculations.quarterlyData || [];
    const totalQuarters = quarterlyData.length;

    // Find max value for scaling
    const maxValue = Math.max(
      ...quarterlyData.map(q => Math.max(
        q.cumulativeDrawdown,
        q.nav + q.cumulativeGrossDPI,
        q.cumulativeGrossDPI
      ))
    ) * 1.15;

    // Draw grid
    ctx.strokeStyle = '#E8E6E1';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = padding.top + (i / 5) * chartHeight;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      const val = maxValue - (i / 5) * maxValue;
      ctx.fillStyle = '#9A9690';
      ctx.font = '11px Helvetica Neue';
      ctx.textAlign = 'right';
      ctx.fillText(formatCurrency(val, 0), padding.left - 10, y + 4);
    }

    // Draw contributed capital line (drawdown)
    ctx.strokeStyle = '#1B2A4A';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    quarterlyData.forEach((q, i) => {
      const x = padding.left + (q.quarter / totalQuarters) * chartWidth;
      const y = padding.top + (1 - q.cumulativeDrawdown / maxValue) * chartHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw NAV + DPI line (gross TVPI path), kept economically coherent over time.
    ctx.strokeStyle = '#2D6B4F';
    ctx.lineWidth = 3;
    ctx.beginPath();
    quarterlyData.forEach((q, i) => {
      const x = padding.left + (q.quarter / totalQuarters) * chartWidth;
      const totalValue = q.nav + q.cumulativeGrossDPI;
      const y = padding.top + (1 - totalValue / maxValue) * chartHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw distributions area (gross DPI)
    ctx.fillStyle = 'rgba(74, 123, 167, 0.18)';
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top + chartHeight);
    quarterlyData.forEach((q) => {
      const x = padding.left + (q.quarter / totalQuarters) * chartWidth;
      const y = padding.top + (1 - q.cumulativeGrossDPI / maxValue) * chartHeight;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
    ctx.closePath();
    ctx.fill();

    // Investment period marker
    const ipQuarter = investmentPeriod * 4;
    const ipX = padding.left + (ipQuarter / totalQuarters) * chartWidth;
    ctx.strokeStyle = '#C9A84C';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(ipX, padding.top);
    ctx.lineTo(ipX, padding.top + chartHeight);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#C9A84C';
    ctx.font = '10px Helvetica Neue';
    ctx.textAlign = 'center';
    ctx.fillText('Inv. Period Ends', ipX, padding.top - 10);

    // X-axis labels (years)
    const totalYears = Math.ceil(totalQuarters / 4);
    const yearStep = chartWidth < 430 ? 4 : chartWidth < 620 ? 3 : 2;
    for (let year = 0; year <= totalYears; year += yearStep) {
      const x = padding.left + (year * 4 / totalQuarters) * chartWidth;
      ctx.fillStyle = '#9A9690';
      ctx.font = '11px Helvetica Neue';
      ctx.textAlign = 'center';
      ctx.fillText(`Yr ${year}`, x, height - padding.bottom + 25);
    }

    // Legend
    const legendY = height - 25;
    const shortLegend = chartWidth < 430;
    const legendCallLabel = shortLegend ? 'Calls' : 'Capital Calls';
    const legendNavLabel = shortLegend ? 'NAV+DPI' : 'NAV + DPI';
    const legendDistLabel = shortLegend ? 'Dist.' : 'Distributions';
    const secondLegendX = shortLegend ? padding.left + 100 : padding.left + 120;
    const thirdLegendX = shortLegend ? padding.left + 190 : padding.left + 230;
    ctx.fillStyle = '#1B2A4A';
    ctx.fillRect(padding.left, legendY, 15, 3);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#1B2A4A';
    ctx.beginPath();
    ctx.moveTo(padding.left, legendY + 1.5);
    ctx.lineTo(padding.left + 15, legendY + 1.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#9A9690';
    ctx.font = '11px Helvetica Neue';
    ctx.textAlign = 'left';
    ctx.fillText(legendCallLabel, padding.left + 22, legendY + 5);

    ctx.fillStyle = '#2D6B4F';
    ctx.fillRect(secondLegendX, legendY, 15, 3);
    ctx.fillStyle = '#9A9690';
    ctx.fillText(legendNavLabel, secondLegendX + 22, legendY + 5);

    ctx.fillStyle = 'rgba(74, 123, 167, 0.35)';
    ctx.fillRect(thirdLegendX, legendY - 3, 15, 10);
    ctx.fillStyle = '#9A9690';
    ctx.fillText(legendDistLabel, thirdLegendX + 22, legendY + 5);

  }, [calculations, fundLife, investmentPeriod, fundSize, viewportTick]);

  // Waterfall canvas
  const waterfallCanvasRef = useRef(null);

  useEffect(() => {
    const canvas = waterfallCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.scale(dpr, dpr);

    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;

    ctx.clearRect(0, 0, width, height);

    const padding = { top: 30, bottom: 50, left: 20, right: 20 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const stages = [
      { label: 'LP Capital', value: calculations.fundSizeM, color: '#1B2A4A' },
      { label: 'Gross Profit', value: calculations.totalGrossProfit, color: '#2D6B4F' },
      { label: 'Mgmt Fees', value: calculations.totalMgmtFees, color: '#B5473A', isDeduction: true },
      { label: 'Expenses', value: calculations.totalExpenses, color: '#D4A017', isDeduction: true },
      { label: 'GP Carry', value: calculations.carry, color: '#C9A84C', isDeduction: true },
      { label: 'LP Net', value: calculations.netValue, color: '#1B2A4A' },
    ];

    const maxValue = Math.max(calculations.fundSizeM + calculations.totalGrossProfit, calculations.netValue) * 1.1;
    const barWidth = chartWidth / stages.length * 0.6;
    const gap = chartWidth / stages.length;

    let runningTotal = 0;

    stages.forEach((stage, i) => {
      const x = padding.left + i * gap + (gap - barWidth) / 2;

      let barTop, barHeight;

      if (i === 0) {
        // First bar - LP Capital
        barHeight = (stage.value / maxValue) * chartHeight;
        barTop = padding.top + chartHeight - barHeight;
        runningTotal = stage.value;
      } else if (i === stages.length - 1) {
        // Last bar - Net value
        barHeight = (stage.value / maxValue) * chartHeight;
        barTop = padding.top + chartHeight - barHeight;
      } else if (stage.isDeduction) {
        // Deduction bars
        const prevTop = padding.top + chartHeight - (runningTotal / maxValue) * chartHeight;
        barHeight = (stage.value / maxValue) * chartHeight;
        barTop = prevTop;
        runningTotal -= stage.value;
      } else {
        // Addition bars
        const prevTop = padding.top + chartHeight - (runningTotal / maxValue) * chartHeight;
        barHeight = (stage.value / maxValue) * chartHeight;
        barTop = prevTop - barHeight;
        runningTotal += stage.value;
      }

      // Draw bar
      ctx.fillStyle = stage.color;
      ctx.fillRect(x, barTop, barWidth, barHeight);

      // Draw connector line
      if (i > 0 && i < stages.length - 1) {
        ctx.strokeStyle = '#7f8ea5';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        const connectorY = padding.top + chartHeight - (runningTotal / maxValue) * chartHeight;
        ctx.moveTo(x - (gap - barWidth) / 2, connectorY);
        ctx.lineTo(x, connectorY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Value label
      ctx.fillStyle = '#1B2A4A';
      ctx.font = 'bold 11px Helvetica Neue';
      ctx.textAlign = 'center';
      const valueText = stage.isDeduction ? `-${formatCurrency(stage.value, 0)}` : formatCurrency(stage.value, 0);
      ctx.fillText(valueText, x + barWidth / 2, barTop - 8);

      // Stage label
      ctx.fillStyle = '#9A9690';
      ctx.font = '10px Helvetica Neue';
      ctx.textAlign = 'center';
      ctx.fillText(stage.label, x + barWidth / 2, height - padding.bottom + 20);
    });

  }, [calculations, viewportTick]);

  return (
    <section id={sectionId} className={`master-dashboard ${asSynthesis ? 'synthesis-dashboard' : ''}`}>
      <div className="dashboard-header">
        <h1>{asSynthesis ? "Let's Put It All Together" : 'The Economics of Private Equity'}</h1>
        <p className="dashboard-subtitle">
          {asSynthesis
            ? 'Final interactive synthesis: trace each term from gross performance to net LP outcome'
            : 'Drag the sliders to see how fund terms affect your returns'}
        </p>
        <div className="dashboard-actions">
          <ResetButton onClick={resetMasterDashboard} label="Reset Dashboard" />
        </div>
      </div>

      <div className={`dashboard-grid ${asSynthesis ? 'synthesis-grid' : ''}`}>
        {/* Left: Controls */}
        <div className="dashboard-controls">
          <div className="control-group">
            <div className="control-group-header">Fund Parameters</div>
            <Slider
              value={fundSize}
              onChange={setFundSize}
              min={100}
              max={2000}
              step={50}
              label="Fund Size"
              format={(v) => formatCurrency(v * 1e6, 0)}
            />
            <Slider
              value={fundLife}
              onChange={setFundLife}
              min={7}
              max={14}
              step={1}
              label="Fund Life"
              format={(v) => `${v} years`}
            />
            <Slider
              value={investmentPeriod}
              onChange={setInvestmentPeriod}
              min={3}
              max={6}
              step={1}
              label="Investment Period"
              format={(v) => `${v} years`}
              accent="#C9A84C"
            />
          </div>

          <div className="control-group">
            <div className="control-group-header">Fee Structure</div>
            <Slider
              value={mgmtFeeRate}
              onChange={setMgmtFeeRate}
              min={0.01}
              max={0.025}
              step={0.001}
              label="Management Fee"
              format={(v) => formatPercent(v)}
              accent="#B5473A"
            />
            <Slider
              value={expenseRate}
              onChange={setExpenseRate}
              min={0.001}
              max={0.01}
              step={0.001}
              label="Fund Expenses"
              format={(v) => `${(v * 10000).toFixed(0)} bps`}
              accent="#D4A017"
            />
            <Slider
              value={carryRate}
              onChange={setCarryRate}
              min={0.15}
              max={0.30}
              step={0.01}
              label="Carried Interest"
              format={(v) => formatPercent(v)}
              accent="#C9A84C"
            />
            <Slider
              value={hurdleRate}
              onChange={setHurdleRate}
              min={0}
              max={0.10}
              step={0.005}
              label="Hurdle Rate"
              format={(v) => formatPercent(v)}
              accent="#2D6B4F"
            />
          </div>

          <div className="control-group">
            <div className="control-group-header">Performance</div>
            <Slider
              value={grossMultipleTarget}
              onChange={setGrossMultipleTarget}
              min={1.5}
              max={4.0}
              step={0.05}
              label="Gross Multiple"
              format={(v) => `${v.toFixed(2)}x`}
              accent="#1B2A4A"
            />
          </div>
        </div>

        {/* Center: Main Visualizations */}
        <div className={`dashboard-main ${asSynthesis ? 'synthesis-main' : ''}`}>
          <div className="viz-container">
            <div className="viz-header">
              <span className="viz-title">Fund Lifecycle</span>
              <span className="viz-subtitle">Capital deployment, growth, and fee accumulation</span>
            </div>
            <canvas ref={lifecycleCanvasRef} className="lifecycle-canvas" />
          </div>

          <div className="viz-container">
            <div className="viz-header">
              <span className="viz-title">Distribution Waterfall</span>
              <span className="viz-subtitle">How returns flow from gross to net</span>
            </div>
            <canvas ref={waterfallCanvasRef} className="waterfall-master-canvas" />
          </div>
        </div>

        {/* Right: Key Metrics */}
        <div className="dashboard-metrics">
          <div className="metric-group">
            <div className="metric-group-header">Returns</div>
            <div className="metric-large">
              <span className="metric-label">Gross Multiple</span>
              <span className="metric-value" style={{ color: '#2D6B4F' }}>{calculations.grossMultiple.toFixed(2)}x</span>
            </div>
            <div className="metric-large">
              <span className="metric-label">Net Multiple</span>
              <span className="metric-value" style={{ color: '#1B2A4A' }}>{calculations.netMultiple.toFixed(2)}x</span>
            </div>
            <div className="metric-divider"></div>
            <div className="metric-small">
              <span>Gross IRR</span>
              <span style={{ color: '#2D6B4F' }}>{formatPercent(calculations.grossIRR)}</span>
            </div>
            <div className="metric-small">
              <span>Net IRR</span>
              <span style={{ color: '#1B2A4A' }}>{formatPercent(calculations.netIRR)}</span>
            </div>
          </div>

          <div className="metric-group">
            <div className="metric-group-header">Fees, Expenses & Carry</div>
            <div className="metric-small">
              <span>Management Fees</span>
              <span style={{ color: '#B5473A' }}>{formatCurrency(calculations.totalMgmtFees, 0)}</span>
            </div>
            <div className="metric-small">
              <span>Fund Expenses</span>
              <span style={{ color: '#D4A017' }}>{formatCurrency(calculations.totalExpenses, 0)}</span>
            </div>
            <div className="metric-small">
              <span>Carried Interest</span>
              <span style={{ color: '#C9A84C' }}>{formatCurrency(calculations.carry, 0)}</span>
            </div>
            <div className="metric-divider"></div>
            <div className="metric-small">
              <span>Total Costs</span>
              <span style={{ color: '#1B2A4A' }}>{formatCurrency(calculations.totalCosts, 0)}</span>
            </div>
            <div className="metric-small highlight">
              <span>Cost Drag</span>
              <span style={{ color: calculations.feeDragPercent > 30 ? '#B5473A' : '#9A9690' }}>
                {calculations.feeDragPercent.toFixed(1)}% of profits
              </span>
            </div>
          </div>

          <div className="metric-group">
            <div className="metric-group-header">LP Outcome</div>
            <div className="metric-small">
              <span>Capital Committed</span>
              <span>{formatCurrency(fundSize * 1e6, 0)}</span>
            </div>
            <div className="metric-small">
              <span>Net Distributions</span>
              <span style={{ color: '#1B2A4A' }}>{formatCurrency(calculations.netValue, 0)}</span>
            </div>
            <div className="metric-divider"></div>
            <div className="metric-small">
              <span>Net Profit</span>
              <span style={{ color: calculations.netProfit > 0 ? '#1B2A4A' : '#B5473A' }}>
                {formatCurrency(calculations.netProfit, 0)}
              </span>
            </div>
          </div>

          <div className={`hurdle-badge ${calculations.hurdleCleared ? 'cleared' : 'not-cleared'}`}>
            {calculations.hurdleCleared ? '✓ Hurdle Cleared' : '✗ Hurdle Not Met'}
          </div>
        </div>
      </div>

      <div className="breakdown-transition">
        <div className="transition-line"></div>
        <h2>{asSynthesis ? 'Every component now in one view.' : "Let's break it down."}</h2>
        <p>
          {asSynthesis
            ? 'This integrated model combines deployment timing, fees, expenses, carry, and waterfall mechanics so you can validate total net investor impact in one place.'
            : 'The visualization above captures the full complexity of PE economics. Below, we\'ll explore each component in detail, from management fees to carried interest, and from waterfall structures to the tradeoffs that shape LP returns.'}
        </p>
      </div>
    </section>
  );
};

const HeroSection = () => (
    <section id="hero-baseline" className="hero-section">
      <div className="pathway-badge">Pathway Capital Educational Guide</div>
      <h1>From Gross Returns to Net LP Results</h1>
      <p className="hero-subtitle">
        Fees, carry, expenses, and timing shape what LPs actually keep.
      </p>
      <p className="hero-purpose-note">
        A Pathway guide for institutional LPs who want to see where the spread comes from and how to diligence it.
      </p>
      <div className="hero-action-bar">
        <a className="hero-primary-cta" href={WALKTHROUGH_MAILTO}>Request a Walkthrough</a>
        <a className="hero-secondary-cta" href="#why-matters">Explore the Model</a>
      </div>
      <div className="hero-trust-strip">Educational only. Illustrative assumptions. As of {SITE_AS_OF_DATE}.</div>

      <HeroGrossNetGraph />

      <p className="hero-scroll-note">Scroll down to build the gross-to-net bridge, one concept at a time.</p>
    </section>
);

const IntroSection = ({ globalGrossMultiple, onGrossMultipleChange } = {}) => {
  const [localGrossReturn, setLocalGrossReturn] = useState(2.5);
  const grossReturn = globalGrossMultiple ?? localGrossReturn;
  const { actualSpreadData, loadError: actualSpreadLoadError, isLoading: actualSpreadLoading } = useActualGrossNetDataset();
  const handleGrossChange = (value) => {
    if (onGrossMultipleChange) {
      onGrossMultipleChange(value);
    } else {
      setLocalGrossReturn(value);
    }
  };

  const grossToNetBridge = useMemo(() => {
    const fundSizeM = BASELINE_MODEL_INPUTS.fundSize * 1e6;
    const model = buildQuarterlySchedule({
      fundSizeM,
      fundLife: BASELINE_MODEL_INPUTS.fundLife,
      investmentPeriod: BASELINE_MODEL_INPUTS.investmentPeriod,
      grossMultiple: grossReturn,
      mgmtFeeRate: BASELINE_MODEL_INPUTS.mgmtFeeRate,
      expenseRate: BASELINE_MODEL_INPUTS.expenseRate,
      carryRate: BASELINE_MODEL_INPUTS.carryRate,
      hurdleRate: BASELINE_MODEL_INPUTS.hurdleRate,
      deploymentRate: 1
    });
    const grossMOIC = grossReturn;
    const netTVPI = model.totals.netMultiple;

    const mgmtFeeDrag = model.totals.totalMgmtFees / fundSizeM;
    const expenseDrag = model.totals.totalExpenses / fundSizeM;
    const carryDrag = model.totals.carry / fundSizeM;
    const totalDrag = mgmtFeeDrag + expenseDrag + carryDrag;
    const grossProfitPerUnit = grossMOIC - 1;
    const dragPctOfGrossProfit = grossProfitPerUnit > 0 ? (totalDrag / grossProfitPerUnit) * 100 : null;

    let running = grossMOIC;
    const bridgeSteps = [
      {
        label: 'Gross MOIC',
        cumulative: grossMOIC,
        isIncrease: true,
        fullBar: true,
        color: '#2D6B4F',
        valueLabel: `${grossMOIC.toFixed(2)}x`
      }
    ];

    running -= mgmtFeeDrag;
    bridgeSteps.push({
      label: 'Management Fees',
      cumulative: running,
      isIncrease: false,
      color: '#B5473A',
      valueLabel: `-${mgmtFeeDrag.toFixed(2)}x`
    });

    running -= expenseDrag;
    bridgeSteps.push({
      label: 'Fund Expenses',
      cumulative: running,
      isIncrease: false,
      color: '#D4A017',
      valueLabel: `-${expenseDrag.toFixed(2)}x`
    });

    running -= carryDrag;
    bridgeSteps.push({
      label: 'Carried Interest',
      cumulative: running,
      isIncrease: false,
      color: '#C9A84C',
      valueLabel: `-${carryDrag.toFixed(2)}x`
    });

    bridgeSteps.push({
      label: 'Net TVPI',
      cumulative: netTVPI,
      isIncrease: true,
      fullBar: true,
      color: '#1B2A4A',
      valueLabel: `${netTVPI.toFixed(2)}x`
    });

    return {
      grossMOIC,
      netTVPI,
      mgmtFeeDrag,
      expenseDrag,
      carryDrag,
      totalDrag,
      dragPctOfGrossProfit,
      dragPctLabel: dragPctOfGrossProfit == null
        ? 'N/A at 1.00x gross'
        : `${dragPctOfGrossProfit.toFixed(0)}% of gross profits`,
      bridgeSteps
    };
  }, [grossReturn]);

  const actualSpreadSummary = useMemo(() => {
    if (!actualSpreadData || !Array.isArray(actualSpreadData.points) || actualSpreadData.points.length === 0) return null;
    const points = actualSpreadData.points;
    const buckets = buildGrossSpreadBuckets(points, { start: 0.75, end: 4.25, width: 0.5, minCount: 8 });
    const aroundBaselineGross = points.filter((point) => point.gross >= 2.4 && point.gross <= 2.6);
    const highlightedCluster = points.filter((point) =>
      point.gross >= ACTUAL_SPREAD_FOCUS_WINDOW.grossMin &&
      point.gross <= ACTUAL_SPREAD_FOCUS_WINDOW.grossMax &&
      point.net >= ACTUAL_SPREAD_FOCUS_WINDOW.netMin &&
      point.net <= ACTUAL_SPREAD_FOCUS_WINDOW.netMax
    );
    const visiblePoints = points.filter((point) =>
      point.gross >= ACTUAL_SPREAD_X_DOMAIN[0] &&
      point.gross <= ACTUAL_SPREAD_X_DOMAIN[1] &&
      point.net >= ACTUAL_SPREAD_Y_DOMAIN[0] &&
      point.net <= ACTUAL_SPREAD_Y_DOMAIN[1]
    );
    const nearbyAverageNet = aggregateValues(aroundBaselineGross.map((point) => point.net), 'mean');
    const spreadAt25 = buckets.find((bucket) => Math.abs(bucket.grossMid - 2.5) < 0.001) || null;
    const spreadAt40 = buckets.find((bucket) => Math.abs(bucket.grossMid - 4.0) < 0.001) || null;

    return {
      buckets,
      nearbyAverageNet,
      nearbyCount: aroundBaselineGross.length,
      highlightedCount: highlightedCluster.length,
      omittedCount: Math.max(0, points.length - visiblePoints.length),
      spreadAt25: spreadAt25 ? spreadAt25.medianSpread : null,
      spreadAt40: spreadAt40 ? spreadAt40.medianSpread : null
    };
  }, [actualSpreadData]);

  const resetIntro = () => handleGrossChange(BASELINE_GROSS_TVPI);

  return (
    <section id="why-matters" className="content-section">
      <h2>Why This Matters</h2>

      <p>
        Private equity has consistently outperformed public markets over the long term
        <sup className="source-sup">
          <a href="#source-1" aria-label="Jump to source 1">[1]</a>
        </sup>.
        {' '}Top-quartile funds have delivered returns that justify the illiquidity, complexity,
        and yes—the fees. But between the <em>gross</em> returns a fund generates and the{' '}
        <em>net</em> returns an investor actually receives lies a series of economic arrangements
        that every LP should understand deeply.
      </p>

      <p>
        The interactive bridge below shows how fees, expenses, and carry can translate a representative fund-level gross outcome
        into a net result for investors. In this context, gross return refers to the performance generated by the underlying
        portfolio companies before fund costs, while net return reflects what LPs retain after those associated fees and expenses
        are paid.
      </p>

      <div className="interactive-margin-shell">
        <aside className="interactive-margin-callout" aria-hidden="true">
          <div className="interactive-margin-arrow">←</div>
          <div className="interactive-margin-kicker">First live model</div>
          <div className="interactive-margin-text">
            Drag the slider. This gross-return setting carries into linked charts below.
          </div>
        </aside>

      <div className="interactive-block management-fee-block">
        <div className="block-header">
          <span className="block-title">From Gross to Net</span>
          <span className="block-subtitle">Adjust gross MOIC and see how fund economics convert it into net TVPI.</span>
        </div>
        <div className="block-actions">
          <ResetButton onClick={resetIntro} />
        </div>

        <Slider
          value={grossReturn}
          onChange={handleGrossChange}
          min={1.0}
          max={3.5}
          step={0.05}
          label="Gross MOIC (On Invested Capital)"
          format={(v) => `${v.toFixed(2)}x`}
        />

        <div className="metrics-row">
          <MetricCard
            label="Gross MOIC"
            value={`${grossToNetBridge.grossMOIC.toFixed(2)}x`}
            subtext="Performance on invested capital"
            accent="#2D6B4F"
          />
          <MetricCard
            label="Total Net Drag"
            value={`-${grossToNetBridge.totalDrag.toFixed(2)}x`}
            subtext={grossToNetBridge.dragPctLabel}
            accent="#1B2A4A"
          />
          <MetricCard
            label="Net TVPI"
            value={`${grossToNetBridge.netTVPI.toFixed(2)}x`}
            subtext="What LPs receive after economics"
            accent="#B5473A"
          />
        </div>

        <p className="bridge-note">
          Baseline assumption here is full deployment. The bridge starts at gross MOIC and shows
          which contract economics remove value before LPs receive net TVPI.
        </p>

        <WaterfallChart data={grossToNetBridge.bridgeSteps} height={300} />

        <div className="metrics-row">
          <MetricCard
            label="Mgmt Fee Drag"
            value={`-${grossToNetBridge.mgmtFeeDrag.toFixed(2)}x`}
            subtext="Steady drag on committed capital"
            accent="#B5473A"
          />
          <MetricCard
            label="Expense Drag"
            value={`-${grossToNetBridge.expenseDrag.toFixed(2)}x`}
            subtext="Fund operating costs"
            accent="#D4A017"
          />
          <MetricCard
            label="Carry Drag"
            value={`-${grossToNetBridge.carryDrag.toFixed(2)}x`}
            subtext="GP share of profits"
            accent="#C9A84C"
          />
        </div>

        <div className="roadmap-table-wrap">
          <div className="roadmap-title">Gross-to-Net Roadmap</div>
          <table className="roadmap-table">
            <thead>
              <tr>
                <th>Component</th>
                <th>How It Impacts Net</th>
                <th>Next Section</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Management Fees</td>
                <td>Annual charge on capital base reduces net TVPI every quarter.</td>
                <td><a href="#management-fees">Management Fees</a></td>
              </tr>
              <tr>
                <td>Fund Expenses</td>
                <td>Operating costs are charged to the fund and reduce LP proceeds.</td>
                <td><a href="#fund-expenses">Fund Expenses</a></td>
              </tr>
              <tr>
                <td>Carried Interest</td>
                <td>Share of profits paid to GP once hurdle economics are satisfied.</td>
                <td><a href="#carried-interest">Carry Mechanics</a></td>
              </tr>
              <tr>
                <td>Waterfall Structure</td>
                <td>Timing and sequencing rules determine when and how carry is paid.</td>
                <td><a href="#waterfall-structures">Waterfalls</a></td>
              </tr>
              <tr>
                <td>Deployment Efficiency</td>
                <td>Underinvestment can widen gross-to-net spread on commitment basis.</td>
                <td><a href="#underinvesting-impact">Underinvesting</a></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="metric-tradeoff-note">
          <div className="metric-tradeoff-title">Metric Tradeoff To Keep In Mind</div>
          <p>
            Some terms can hurt one net metric while improving another. Example: a subscription
            line usually adds interest expense that can reduce net TVPI, but it can also raise net
            IRR by delaying capital contributions and pulling cash flows forward.
          </p>
        </div>
      </div>
      </div>

      <p>
        To anchor that framework in observed outcomes, the charts below use anonymized Pathway-tracked fund data spanning approximately 800 funds dating back to the early 1990s. They show the realized difference between fund-level gross and net returns across a broad sample of actual investments.
      </p>

      <div className="interactive-block actual-spread-block">
        <div className="block-header">
          <span className="block-title">Anonymized Pathway Gross-to-Net Outcomes</span>
          <span className="block-subtitle">A large observed sample gives the public baseline a realistic anchor.</span>
        </div>

        <p className="actual-spread-intro">
          We are not suggesting that every fund will deliver <strong>2.5x gross and 2.0x net</strong>. Rather, that pairing reflects a common private equity target return profile and sits within a dense observed cluster in this dataset.
        </p>
        <p className="actual-spread-intro compact">
          The broader takeaway is that gross outcomes generally exceed net outcomes, the spread is shaped by multiple fund terms, and the gap tends to widen as gross returns rise.
        </p>

        {actualSpreadLoading ? (
          <p className="portfolio-inline-note">Loading actual Pathway fund outcomes...</p>
        ) : actualSpreadLoadError ? (
          <p className="portfolio-inline-note">{actualSpreadLoadError}</p>
        ) : actualSpreadData && actualSpreadSummary ? (
          <>
            <div className="metrics-row actual-spread-metrics">
              <MetricCard
                label="Anonymized Funds"
                value={ACTUAL_SPREAD_DISPLAY_COUNT.toLocaleString()}
                subtext={`Observed by Pathway | vintages ${ACTUAL_SPREAD_VINTAGE_RANGE_LABEL}`}
                accent="#1B2A4A"
              />
              <MetricCard
                label="Typical Net Near 2.5x Gross"
                value={`${actualSpreadSummary.nearbyAverageNet.toFixed(2)}x`}
                subtext={`${actualSpreadSummary.nearbyCount} anonymized funds between 2.4x and 2.6x gross`}
                accent="#2D6B4F"
              />
              <MetricCard
                label="Spread Widens"
                value={`${actualSpreadSummary.spreadAt25?.toFixed(2) || '0.00'}x -> ${actualSpreadSummary.spreadAt40?.toFixed(2) || '0.00'}x`}
                subtext="Median gross-minus-net spread from 2.5x to 4.0x gross bands"
                accent="#C9A84C"
              />
            </div>

            <ActualGrossNetScatter points={actualSpreadData.points} />
            <GrossNetSpreadTrendChart buckets={actualSpreadSummary.buckets} />

            <p className="actual-spread-footnote">
              These are anonymized actual returns across {ACTUAL_SPREAD_DISPLAY_COUNT.toLocaleString()} Pathway-observed funds from vintage years {ACTUAL_SPREAD_VINTAGE_RANGE_LABEL}. Some extreme outliers are removed from the visible plot window for readability.
              Many of the terms that shape this spread are knowable before a fund starts, which is exactly why sophisticated LPs diligence and negotiate them.
            </p>
          </>
        ) : null}
      </div>

      <p>
        If you are already wondering why the spread tends to widen at higher gross outcomes, you are asking exactly the right question.
        Experienced readers may already suspect that carry becomes a bigger part of the story as profits rise. If that intuition is new,
        keep going and come back to this chart later. The pieces will click quickly once you have seen the mechanics.
      </p>

      <p>
        With that setup in place, we can break the spread into its parts, starting with the most straightforward one: the management fee.
      </p>
    </section>
  );
};

const ManagementFeeSection = () => {
  const DEFAULTS = {
    fundSize: 500,
    lpCommitment: 100,
    feeRate: 0.02,
    investmentPeriod: 5,
    fundLife: 12,
    hasRateStepDown: true,
    postInvestmentBasis: 'remaining'
  };
  const [fundSize, setFundSize] = useState(DEFAULTS.fundSize); // millions
  const [lpCommitment, setLpCommitment] = useState(DEFAULTS.lpCommitment); // millions
  const [feeRate, setFeeRate] = useState(DEFAULTS.feeRate);
  const [investmentPeriod, setInvestmentPeriod] = useState(DEFAULTS.investmentPeriod);
  const [fundLife, setFundLife] = useState(DEFAULTS.fundLife);
  const [hasRateStepDown, setHasRateStepDown] = useState(DEFAULTS.hasRateStepDown);
  const [postInvestmentBasis, setPostInvestmentBasis] = useState(DEFAULTS.postInvestmentBasis); // 'committed' or 'remaining'
  const [showAssumptions, setShowAssumptions] = useState(false);

  useEffect(() => {
    if (lpCommitment > fundSize) {
      setLpCommitment(fundSize);
    }
  }, [fundSize, lpCommitment]);

  const resetManagementFee = () => {
    setFundSize(DEFAULTS.fundSize);
    setLpCommitment(DEFAULTS.lpCommitment);
    setFeeRate(DEFAULTS.feeRate);
    setInvestmentPeriod(DEFAULTS.investmentPeriod);
    setFundLife(DEFAULTS.fundLife);
    setHasRateStepDown(DEFAULTS.hasRateStepDown);
    setPostInvestmentBasis(DEFAULTS.postInvestmentBasis);
    setShowAssumptions(false);
  };

  const feeData = useMemo(() => {
    const data = [];
    let cumulativeFees = 0;

    // Model assumptions for a typical fund lifecycle:
    // deployment (years 1-5), operational development, and harvest (years 5+).
    const DEPLOYMENT_TARGET = 0.94;
    const INVESTMENT_LAG = 0.025;      // Called capital not yet deployed
    const REALIZATION_START_YEAR = 5;
    const REALIZATION_FRACTION = 0.95; // Not all cost necessarily realized in-period

    for (let year = 1; year <= fundLife; year++) {
      // Called capital follows a modest S-curve rather than linear pacing.
      const deploymentProgress = Math.min(1, year / investmentPeriod);
      const calledPct = deploymentProgress * deploymentProgress * (3 - 2 * deploymentProgress);
      const calledCapital = Math.min(fundSize, fundSize * calledPct);

      // Invested capital lags called capital slightly due to reserves/cash drag.
      const investedCapital = Math.min(
        fundSize * DEPLOYMENT_TARGET,
        Math.max(0, calledCapital - fundSize * INVESTMENT_LAG)
      );

      // Realizations are back-ended after an initial value-creation period.
      let cumulativeRealizations = 0;
      if (year >= REALIZATION_START_YEAR) {
        const denom = Math.max(1, fundLife - REALIZATION_START_YEAR + 1);
        const realizationProgress = Math.min(1, (year - REALIZATION_START_YEAR + 1) / denom);
        cumulativeRealizations = investedCapital * Math.pow(realizationProgress, 1.35) * REALIZATION_FRACTION;
      }

      // Remaining cost basis = invested - realizations (at cost)
      const remainingCostBasis = Math.max(0, investedCapital - cumulativeRealizations);

      // Determine fee basis and rate for this year
      let feeBasis, feeBasisLabel, rate;

      if (year <= investmentPeriod) {
        // During investment period: always on committed capital
        feeBasis = fundSize;
        feeBasisLabel = 'Committed';
        rate = feeRate;
      } else {
        // Post-investment period
        rate = hasRateStepDown ? feeRate * 0.75 : feeRate;

        if (postInvestmentBasis === 'committed') {
          feeBasis = fundSize;
          feeBasisLabel = 'Committed';
        } else {
          feeBasis = remainingCostBasis;
          feeBasisLabel = 'Remaining Cost';
        }
      }

      const fee = feeBasis * rate;
      cumulativeFees += fee;

      data.push({
        year,
        label: `Yr ${year}`,
        calledCapital,
        investedCapital,
        cumulativeRealizations,
        remainingCostBasis,
        feeBasis,
        feeBasisLabel,
        rate,
        fee,
        cumulativeFees,
        isPostInvestment: year > investmentPeriod
      });
    }

    return data;
  }, [fundSize, feeRate, investmentPeriod, fundLife, hasRateStepDown, postInvestmentBasis]);

  const totalFees = feeData[feeData.length - 1].cumulativeFees;
  const lpShare = fundSize > 0 ? lpCommitment / fundSize : 0;
  const lpTotalFees = totalFees * lpShare;
  const lpFeeAsPercentOfCommitment = lpCommitment > 0 ? lpTotalFees / lpCommitment : 0;
  const lpAverageAnnualFee = lpTotalFees / fundLife;
  const lpAverageAnnualFeePctOfCommitment = lpCommitment > 0 ? lpAverageAnnualFee / lpCommitment : 0;
  const lpPeakAnnualFee = Math.max(...feeData.map((d) => d.fee)) * lpShare;
  const postInvestmentRows = feeData.filter((d) => d.isPostInvestment);
  const lpPostInvestmentAvgFee = postInvestmentRows.length > 0
    ? postInvestmentRows.reduce((sum, d) => sum + d.fee * lpShare, 0) / postInvestmentRows.length
    : 0;
  const baselineNetMultiple = 2.0;
  const feeMultipleDrag = totalFees / fundSize;
  const netAfterFeesOnly = Math.max(1.0, baselineNetMultiple - feeMultipleDrag);
  const baselineNetIRR = Math.pow(baselineNetMultiple, 1 / fundLife) - 1;
  const feeOnlyNetIRR = Math.pow(netAfterFeesOnly, 1 / fundLife) - 1;
  const feeIRRDragBps = Math.max(0, (baselineNetIRR - feeOnlyNetIRR) * 10000);

  return (
    <section id="management-fees" className="content-section">
      <h2>Management Fees: The Steady Current</h2>

      <p>
        Management fees are the most predictable component of PE economics. They compensate
        the GP for the ongoing work of sourcing deals, conducting due diligence, managing
        portfolio companies, and running the fund's operations. Unlike carried interest,
        management fees are paid regardless of performance.
      </p>

      <p>
        The standard rate is <strong>2% annually</strong>, though this varies by fund size,
        strategy, and market conditions. Large-cap buyout funds often charge 1.5% or less;
        emerging managers may charge 2% or more. But the rate is only part of the equation—what
        that rate is applied <em>to</em> matters enormously.
      </p>

      <div className="interactive-block">
        <div className="block-header">
          <span className="block-title">Management Fee Calculator</span>
          <span className="block-subtitle">Explore how terms affect total fees</span>
        </div>
        <div className="block-actions">
          <ResetButton onClick={resetManagementFee} />
        </div>

        <div className="sliders-grid">
          <Slider
            value={fundSize}
            onChange={setFundSize}
            min={100}
            max={2000}
            step={50}
            label="Fund Size"
            format={(v) => formatCurrency(v * 1e6, 0)}
          />

          <Slider
            value={lpCommitment}
            onChange={setLpCommitment}
            min={10}
            max={fundSize}
            step={5}
            label="Illustrative LP Commitment"
            format={(v) => formatCurrency(v * 1e6, 0)}
            accent="#4A7BA7"
          />

          <Slider
            value={feeRate}
            onChange={setFeeRate}
            min={0.01}
            max={0.025}
            step={0.001}
            label="Fee Rate (Investment Period)"
            format={(v) => formatPercent(v)}
          />

          <Slider
            value={investmentPeriod}
            onChange={setInvestmentPeriod}
            min={3}
            max={6}
            step={1}
            label="Investment Period"
            format={(v) => `${v} years`}
          />

          <Slider
            value={fundLife}
            onChange={setFundLife}
            min={8}
            max={14}
            step={1}
            label="Fund Life"
            format={(v) => `${v} years`}
          />
        </div>

        <div className="terms-section">
          <div className="terms-header">Post-Investment Period Terms</div>

          <div className="toggle-row">
            <span className="toggle-label">Rate Step-Down:</span>
            <ToggleSwitch
              options={[
                { value: true, label: `Yes (${formatPercent(feeRate * 0.75)})` },
                { value: false, label: `No (${formatPercent(feeRate)})` }
              ]}
              value={hasRateStepDown}
              onChange={setHasRateStepDown}
            />
          </div>
          <p className="terms-explainer">
            {hasRateStepDown
              ? `Post-investment fee rate steps down from ${formatPercent(feeRate)} to ${formatPercent(feeRate * 0.75)} annually.`
              : `Post-investment fee rate stays at ${formatPercent(feeRate)} annually, increasing total fee load.`}
          </p>

          <div className="toggle-row">
            <span className="toggle-label">Fee Basis:</span>
            <ToggleSwitch
              options={[
                { value: 'committed', label: 'Committed Capital' },
                { value: 'remaining', label: 'Remaining Cost Basis' }
              ]}
              value={postInvestmentBasis}
              onChange={setPostInvestmentBasis}
            />
          </div>
          <p className="terms-explainer">
            {postInvestmentBasis === 'remaining'
              ? 'Fees are charged on remaining cost basis, so realizations reduce the fee base over time.'
              : 'Fees stay tied to committed capital even after realizations, which usually keeps post-investment fees higher.'}
          </p>
        </div>

        <TimelineChart
          data={feeData.map(d => ({
            label: d.label,
            value: d.fee,
            cumulative: d.cumulativeFees
          }))}
          height={165}
          showCumulative={true}
        />

        <div className="metrics-row">
          <MetricCard
            label="Total Fees Paid to GP"
            value={formatCurrency(totalFees * 1e6, 0)}
            subtext="Cumulative management fees paid by all LPs"
          />
          <MetricCard
            label="Illustrative Single-LP Fees"
            value={formatCurrency(lpTotalFees * 1e6, 0)}
            subtext={`On ${formatCurrency(lpCommitment * 1e6, 0)} commitment`}
            accent="#4A7BA7"
          />
          <MetricCard
            label="Illustrative Single-LP Average Annual Fee"
            value={formatCurrency(lpAverageAnnualFee * 1e6, 0)}
            subtext={`${formatPercent(lpAverageAnnualFeePctOfCommitment, 2)} of commitment per year`}
            accent="#9A9690"
          />
          <MetricCard
            label="LP Fee Load"
            value={formatPercent(lpFeeAsPercentOfCommitment)}
            subtext="Total fees as % of LP commitment"
            accent="#B5473A"
          />
        </div>

        <p className="management-inline-note">
          At a {formatCurrency(lpCommitment * 1e6, 0)} commitment, this setup implies roughly{' '}
          <strong>{formatCurrency(lpTotalFees * 1e6, 0)}</strong> of total management fees over fund
          life, averaging about <strong>{formatCurrency(lpAverageAnnualFee * 1e6, 0)}</strong> per year.
        </p>
        <p className="management-inline-note">
          Peak annual fee in this run is about <strong>{formatCurrency(lpPeakAnnualFee * 1e6, 0)}</strong>;
          average annual post-investment fee is about{' '}
          <strong>{formatCurrency(lpPostInvestmentAvgFee * 1e6, 0)}</strong>.
        </p>

        <div className="net-impact-panel">
          <div className="net-impact-title">Net Investor Impact</div>
          <div className="metrics-row">
            <MetricCard
              label="Fee Drag On Multiple"
              value={`${feeMultipleDrag.toFixed(2)}x`}
              subtext="From management fees only"
              accent="#B5473A"
            />
            <MetricCard
              label="After-Fee Multiple"
              value={`${netAfterFeesOnly.toFixed(2)}x`}
              subtext="2.00x baseline minus fee drag"
              accent="#1B2A4A"
            />
            <MetricCard
              label="Net IRR Drag"
              value={`${feeIRRDragBps.toFixed(0)} bps`}
              subtext={`Over ${fundLife} years`}
              accent="#9A9690"
            />
          </div>
        </div>

        <button
          className="assumptions-toggle"
          onClick={() => setShowAssumptions(!showAssumptions)}
        >
          {showAssumptions ? '− Hide' : '+ Show'} Year-by-Year Detail
        </button>

        {showAssumptions && (
          <div className="assumptions-table-container">
            <table className="assumptions-table">
              <thead>
                <tr>
                  <th>Year</th>
                  <th>Called Capital</th>
                  <th>Invested (Cost)</th>
                  <th>Realizations</th>
                  <th>Remaining Cost</th>
                  <th>Fee Basis</th>
                  <th>Rate</th>
                  <th>Fee</th>
                  <th>Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {feeData.map((d) => (
                  <tr key={d.year} className={d.isPostInvestment ? 'post-investment' : ''}>
                    <td>{d.year}</td>
                    <td>{formatCurrency(d.calledCapital * 1e6, 0)}</td>
                    <td>{formatCurrency(d.investedCapital * 1e6, 0)}</td>
                    <td>{formatCurrency(d.cumulativeRealizations * 1e6, 0)}</td>
                    <td>{formatCurrency(d.remainingCostBasis * 1e6, 0)}</td>
                    <td className="basis-cell">
                      <span className="basis-label">{d.feeBasisLabel}</span>
                      <span className="basis-value">{formatCurrency(d.feeBasis * 1e6, 0)}</span>
                    </td>
                    <td>{formatPercent(d.rate)}</td>
                    <td className="fee-cell">{formatCurrency(d.fee * 1e6, 1)}</td>
                    <td>{formatCurrency(d.cumulativeFees * 1e6, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="table-note">
              Shaded rows indicate post-investment period. Assumptions: 94% deployment
              target, 2.5% investment lag, realizations begin Year 5 with back-ended pacing.
            </div>
          </div>
        )}
      </div>

      <h3>Understanding the Fee Basis</h3>

      <p>
        During the <strong>investment period</strong> (typically 5-6 years), fees are almost
        always charged on committed capital. This makes sense—the GP is actively deploying
        capital, and the full commitment is at risk of being called.
      </p>

      <p>
        After the investment period, terms vary. The most LP-friendly structure charges fees
        on <strong>remaining cost basis</strong>—the original cost of investments that haven't
        yet been exited. As the GP realizes investments, the fee basis shrinks. The most
        GP-friendly structure continues charging on committed capital regardless of realizations.
        This model assumes realizations begin in Year 5 and then ramp. If a fund is fully drawn
        and exits are delayed, post-investment fee basis can stay elevated and total fees can run
        meaningfully higher than this base case.
      </p>

      <p>
        The <strong>rate step-down</strong> is a separate negotiation. A 25% reduction (e.g.,
        2.0% → 1.5%) after the investment period is common, though not universal. Some funds
        step down further in extension periods.
      </p>

      <div className="callout">
        <div className="callout-icon">📊</div>
        <div className="callout-content">
          <strong>The math matters:</strong> A fund charging 2% on committed capital for 12 years
          with no step-down will collect ~24% of commitment in fees. The same fund with a 25% rate
          step-down and remaining cost basis post-investment might collect ~15%. That's
          <strong> 9% of your commitment</strong>—real money on a $100M allocation.
        </div>
      </div>
    </section>
  );
};

const ExpensesSection = ({
  globalGrossMultiple,
  onGrossMultipleChange,
  globalDeploymentRate,
  onDeploymentRateChange
} = {}) => {
  const DEFAULTS = {
    fundSize: 500,
    investmentPeriod: 5,
    fundLife: 10,
    expenseRate: 0.005,
    lineUtilization: 0.18,
    drawDelayQuarters: 2,
    lineRate: 0.08,
    lineGrossMOIC: 2.5
  };
  const [fundSize, setFundSize] = useState(DEFAULTS.fundSize);
  const [investmentPeriod, setInvestmentPeriod] = useState(DEFAULTS.investmentPeriod);
  const [fundLife, setFundLife] = useState(DEFAULTS.fundLife);
  const [expenseRate, setExpenseRate] = useState(DEFAULTS.expenseRate);
  const [lineUtilization, setLineUtilization] = useState(DEFAULTS.lineUtilization);
  const [drawDelayQuarters, setDrawDelayQuarters] = useState(DEFAULTS.drawDelayQuarters);
  const [lineRate, setLineRate] = useState(DEFAULTS.lineRate);
  const [localLineGrossMOIC, setLocalLineGrossMOIC] = useState(DEFAULTS.lineGrossMOIC);
  const [localDeploymentRate, setLocalDeploymentRate] = useState(1.0);
  const lineGrossMOIC = globalGrossMultiple ?? localLineGrossMOIC;
  const setLineGrossMOIC = onGrossMultipleChange ?? setLocalLineGrossMOIC;
  const deploymentRate = globalDeploymentRate ?? localDeploymentRate;
  const setDeploymentRate = onDeploymentRateChange ?? setLocalDeploymentRate;

  const resetExpenses = () => {
    setFundSize(DEFAULTS.fundSize);
    setInvestmentPeriod(DEFAULTS.investmentPeriod);
    setFundLife(DEFAULTS.fundLife);
    setExpenseRate(DEFAULTS.expenseRate);
    setLineUtilization(DEFAULTS.lineUtilization);
    setDrawDelayQuarters(DEFAULTS.drawDelayQuarters);
    setLineRate(DEFAULTS.lineRate);
    setLineGrossMOIC(BASELINE_GROSS_TVPI);
    setDeploymentRate(1.0);
  };

  const expenseData = useMemo(() => {
    const categories = [
      { name: 'Legal & Compliance', percent: 25, color: '#1B2A4A', description: 'Fund formation, transaction docs, regulatory filings' },
      { name: 'Accounting & Audit', percent: 20, color: '#2D6B4F', description: 'Annual audits, tax prep, fund administration' },
      { name: 'Due Diligence', percent: 20, color: '#C9A84C', description: 'Third-party diligence providers, consultants' },
      { name: 'Travel & Meetings', percent: 15, color: '#D4A017', description: 'Deal sourcing, portfolio company visits, AGMs' },
      { name: 'Insurance & Other', percent: 12, color: '#B5473A', description: 'D&O insurance, cybersecurity, bank fees' },
      { name: 'Broken Deal Costs', percent: 8, color: '#9A9690', description: 'Costs from deals that don\'t close' },
    ];

    let totalExpenses = 0;
    const yearlyExpenses = [];

    for (let year = 1; year <= fundLife; year++) {
      const isInvestmentPeriod = year <= investmentPeriod;
      // Higher expenses during investment period
      const rate = isInvestmentPeriod ? expenseRate : expenseRate * 0.4;
      const expense = fundSize * rate;
      totalExpenses += expense;

      yearlyExpenses.push({
        year,
        expense,
        cumulative: totalExpenses,
        isInvestmentPeriod
      });
    }

    const avgAnnualExpense = totalExpenses / fundLife;
    const investmentPeriodExpenses = yearlyExpenses
      .filter(y => y.isInvestmentPeriod)
      .reduce((sum, y) => sum + y.expense, 0);
    const harvestPeriodExpenses = totalExpenses - investmentPeriodExpenses;

    return {
      categories,
      totalExpenses,
      avgAnnualExpense,
      investmentPeriodExpenses,
      harvestPeriodExpenses,
      yearlyExpenses,
      expenseAsPercentOfCommitment: (totalExpenses / fundSize) * 100
    };
  }, [fundSize, investmentPeriod, fundLife, expenseRate]);

  const baselineNetMultiple = 2.0;
  const expenseMultipleDrag = expenseData.totalExpenses / fundSize;
  const netAfterExpensesOnly = Math.max(1.0, baselineNetMultiple - expenseMultipleDrag);
  const baselineNetIRR = Math.pow(baselineNetMultiple, 1 / fundLife) - 1;
  const expenseOnlyNetIRR = Math.pow(netAfterExpensesOnly, 1 / fundLife) - 1;
  const expenseIRRDragBps = Math.max(0, (baselineNetIRR - expenseOnlyNetIRR) * 10000);
  const lineOfCreditAnalysis = useMemo(() => {
    const baselineModel = buildQuarterlySchedule({
      fundSizeM: BASELINE_MODEL_INPUTS.fundSize * 1e6,
      fundLife: BASELINE_MODEL_INPUTS.fundLife,
      investmentPeriod: BASELINE_MODEL_INPUTS.investmentPeriod,
      grossMultiple: lineGrossMOIC,
      mgmtFeeRate: BASELINE_MODEL_INPUTS.mgmtFeeRate,
      expenseRate: BASELINE_MODEL_INPUTS.expenseRate,
      carryRate: BASELINE_MODEL_INPUTS.carryRate,
      hurdleRate: BASELINE_MODEL_INPUTS.hurdleRate,
      deploymentRate
    });

    const totalQuarters = baselineModel.schedule.length;
    const baselineFundSize = BASELINE_MODEL_INPUTS.fundSize * 1e6;
    const periodicRate = lineRate / 4;
    const lineCapacity = baselineFundSize * lineUtilization;
    const amortizationTerm = Math.max(1, drawDelayQuarters);
    let lineDebts = [];

    let outstandingPrincipal = 0;
    let totalInterestExpense = 0;
    let cumulativeNoLine = 0;
    let cumulativeWithLine = 0;
    const timeline = [];
    const cashFlowsNoLine = [];
    const cashFlowsWithLine = [];

    const settleDebtForQuarter = () => {
      let duePrincipal = 0;
      let dueInterest = 0;
      let nextOutstanding = 0;
      const nextDebts = [];

      lineDebts.forEach((debt) => {
        if (debt.principalRemaining <= 1e-6 || debt.installmentsLeft <= 0) return;
        const interestPayment = debt.principalRemaining * periodicRate;
        const principalPayment = debt.principalRemaining / debt.installmentsLeft;
        const principalRemaining = Math.max(0, debt.principalRemaining - principalPayment);
        const installmentsLeft = debt.installmentsLeft - 1;

        duePrincipal += principalPayment;
        dueInterest += interestPayment;

        if (installmentsLeft > 0 && principalRemaining > 1e-6) {
          nextDebts.push({ principalRemaining, installmentsLeft });
          nextOutstanding += principalRemaining;
        }
      });

      lineDebts = nextDebts;
      outstandingPrincipal = nextOutstanding;
      return { duePrincipal, dueInterest };
    };

    for (let quarter = 1; quarter <= totalQuarters; quarter++) {
      const quarterRow = baselineModel.schedule[quarter - 1];
      const { duePrincipal, dueInterest } = settleDebtForQuarter();
      const baseCapitalCall = quarterRow.capitalCall;
      const feeAndExpense = quarterRow.mgmtFee + quarterRow.expense;
      const netDistribution = quarterRow.netDistribution;

      let financed = 0;
      let directCall = baseCapitalCall;

      if (drawDelayQuarters > 0 && lineCapacity > 0 && baseCapitalCall > 0) {
        const availableCapacity = Math.max(0, lineCapacity - outstandingPrincipal);
        financed = Math.min(baseCapitalCall, availableCapacity);
        directCall = baseCapitalCall - financed;

        if (financed > 0) {
          lineDebts.push({
            principalRemaining: financed,
            installmentsLeft: amortizationTerm
          });
          outstandingPrincipal += financed;
        }
      }

      const lineCapitalCall = directCall + duePrincipal + dueInterest;
      totalInterestExpense += dueInterest;
      cumulativeNoLine += baseCapitalCall;
      cumulativeWithLine += lineCapitalCall;

      cashFlowsNoLine.push({ period: quarter, amount: netDistribution - baseCapitalCall - feeAndExpense });
      cashFlowsWithLine.push({ period: quarter, amount: netDistribution - lineCapitalCall - feeAndExpense });

      timeline.push({
        quarter,
        label: `Q${quarter}`,
        baseCapitalCall,
        withLocPrincipalCall: directCall + duePrincipal,
        withLocInterestCall: dueInterest,
        lineCapitalCall,
        cumulativeNoLine,
        cumulativeWithLine,
        outstandingPrincipal
      });
    }

    let syntheticQuarter = totalQuarters;
    while (lineDebts.length > 0) {
      syntheticQuarter += 1;
      const { duePrincipal, dueInterest } = settleDebtForQuarter();
      const lineCapitalCall = duePrincipal + dueInterest;
      totalInterestExpense += dueInterest;
      cumulativeWithLine += lineCapitalCall;

      cashFlowsNoLine.push({ period: syntheticQuarter, amount: 0 });
      cashFlowsWithLine.push({ period: syntheticQuarter, amount: -lineCapitalCall });

      timeline.push({
        quarter: syntheticQuarter,
        label: `Q${syntheticQuarter}`,
        baseCapitalCall: 0,
        withLocPrincipalCall: duePrincipal,
        withLocInterestCall: dueInterest,
        lineCapitalCall,
        cumulativeNoLine,
        cumulativeWithLine,
        outstandingPrincipal
      });
    }

    const netIRRNoLine = Number.isFinite(baselineModel.totals.netIRR)
      ? baselineModel.totals.netIRR
      : Math.pow(Math.max(1e-9, baselineModel.totals.netMultiple), 1 / BASELINE_MODEL_INPUTS.fundLife) - 1;
    const rawNetIRRWithLine = cashFlowsWithLine.length > 2 ? calculateIRR(cashFlowsWithLine, 4) : netIRRNoLine;
    const netIRRWithLine = Number.isFinite(rawNetIRRWithLine) ? rawNetIRRWithLine : netIRRNoLine;
    const netTVPINoLine = baselineModel.totals.netMultiple;
    const netTVPIWithLine = Math.max(0, (baselineModel.totals.netValue - totalInterestExpense) / baselineFundSize);
    const illustrativeLpCommitment = Math.min(100e6, baselineFundSize);
    const illustrativeLpShare = baselineFundSize > 0 ? illustrativeLpCommitment / baselineFundSize : 0;
    const illustrativeLpInterestExpense = totalInterestExpense * illustrativeLpShare;
    const callTimingHorizon = Math.min(
      totalQuarters,
      Math.max(12, BASELINE_MODEL_INPUTS.investmentPeriod * 4 + Math.max(0, drawDelayQuarters) * 4)
    );
    const callTimingData = timeline.slice(0, callTimingHorizon);

    return {
      timeline,
      callTimingData,
      netIRRNoLine,
      netIRRWithLine,
      netTVPINoLine,
      netTVPIWithLine,
      irrLiftBps: (netIRRWithLine - netIRRNoLine) * 10000,
      tvpiDrag: netTVPIWithLine - netTVPINoLine,
      interestExpense: totalInterestExpense,
      lineCapacity,
      illustrativeLpCommitment,
      illustrativeLpInterestExpense
    };
  }, [
    lineUtilization,
    drawDelayQuarters,
    lineRate,
    lineGrossMOIC,
    deploymentRate
  ]);

  const locShiftArrows = useMemo(() => {
    if (drawDelayQuarters <= 0) return [];
    const data = lineOfCreditAnalysis.callTimingData || [];
    if (data.length < 4) return [];

    const candidateIndices = [1, 3, 5, 7, 9, 11, 13, 15].filter((idx) => (
      idx < data.length - 1 && data[idx].baseCapitalCall > 0
    ));
    const selected = candidateIndices.slice(0, 4);

    return selected.map((fromIndex, idx) => ({
      fromIndex,
      toIndex: Math.min(data.length - 1, fromIndex + drawDelayQuarters),
      label: idx === 0 ? `~${drawDelayQuarters}q shift` : undefined
    }));
  }, [lineOfCreditAnalysis.callTimingData, drawDelayQuarters]);
  const locBackfireNow =
    (lineOfCreditAnalysis.netIRRNoLine - lineRate) * 10000 < 0 &&
    lineOfCreditAnalysis.irrLiftBps <= 0 &&
    lineOfCreditAnalysis.tvpiDrag < 0;

  return (
    <>
    <section id="fund-expenses" className="content-section">
      <h2>Fund Expenses: Required Operating Costs</h2>

      <p>
        Beyond management fees and carry, funds incur <strong>operating expenses</strong> that
        are typically charged directly to the fund (and thus to LPs). These costs are often
        overlooked in high-level fee discussions, but they can add up to a meaningful drag
        on returns—especially during the investment period.
      </p>

      <p>
        During the investment period, fund expenses commonly run at <strong>40-60 basis points
        annually</strong> of committed capital. This covers the costs of sourcing deals,
        conducting due diligence, legal work, and fund administration. After the investment
        period, expenses typically decline to 15-25 bps as activity shifts from deal-making
        to portfolio management.
      </p>

      <div className="interactive-block">
        <div className="block-header">
          <span className="block-title">Expense Breakdown</span>
          <span className="block-subtitle">Typical allocation of fund operating expenses</span>
        </div>
        <div className="block-actions">
          <ResetButton onClick={resetExpenses} />
        </div>

        <div className="expense-categories">
          {expenseData.categories.map((cat, i) => (
            <div key={i} className="expense-category">
              <span className="expense-name">{cat.name}</span>
              <div className="expense-bar-container">
                <div
                  className="expense-bar"
                  style={{
                    width: `${cat.percent}%`,
                    backgroundColor: cat.color
                  }}
                />
              </div>
              <span className="expense-percent">{cat.percent}%</span>
              <span className="expense-desc">{cat.description}</span>
            </div>
          ))}
        </div>

        <div className="sliders-grid" style={{ marginTop: '24px' }}>
          <Slider
            value={fundSize}
            onChange={setFundSize}
            min={100}
            max={2000}
            step={50}
            label="Fund Size"
            format={(v) => formatCurrency(v * 1e6, 0)}
          />
          <Slider
            value={expenseRate}
            onChange={setExpenseRate}
            min={0.002}
            max={0.008}
            step={0.0005}
            label="Expense Rate (Inv. Period)"
            format={(v) => `${(v * 10000).toFixed(0)} bps`}
            accent="#D4A017"
          />
        </div>

        <div className="metrics-row">
          <MetricCard
            label="Total Fund Expenses"
            value={formatCurrency(expenseData.totalExpenses * 1e6, 0)}
            subtext={`${expenseData.expenseAsPercentOfCommitment.toFixed(1)}% of commitment`}
            accent="#D4A017"
          />
          <MetricCard
            label="Investment Period"
            value={formatCurrency(expenseData.investmentPeriodExpenses * 1e6, 0)}
            subtext={`~${(expenseRate * 10000).toFixed(0)} bps annually`}
            accent="#D4A017"
          />
          <MetricCard
            label="Harvest Period"
            value={formatCurrency(expenseData.harvestPeriodExpenses * 1e6, 0)}
            subtext={`~${(expenseRate * 0.4 * 10000).toFixed(0)} bps annually`}
            accent="#9A9690"
          />
        </div>

        <div className="net-impact-panel">
          <div className="net-impact-title">Net Investor Impact</div>
          <div className="metrics-row">
            <MetricCard
              label="Expense Drag On Multiple"
              value={`${expenseMultipleDrag.toFixed(2)}x`}
              subtext="From fund expenses alone"
              accent="#D4A017"
            />
            <MetricCard
              label="After-Expense Multiple"
              value={`${netAfterExpensesOnly.toFixed(2)}x`}
              subtext="2.00x baseline minus expense drag"
              accent="#1B2A4A"
            />
            <MetricCard
              label="Net IRR Drag"
              value={`${expenseIRRDragBps.toFixed(0)} bps`}
              subtext={`Over ${fundLife} years`}
              accent="#9A9690"
            />
          </div>
        </div>
      </div>

      <h3>What Expenses Include</h3>

      <p>
        <strong>Legal & Compliance:</strong> Fund formation documents, subscription agreements,
        transaction documentation for each deal, regulatory filings, and ongoing compliance work.
        This is often the largest expense category.
      </p>

      <p>
        <strong>Accounting & Administration:</strong> Annual audits, tax preparation and K-1
        generation, fund administration services, and investor reporting. These are largely
        fixed costs that don't scale with fund size.
      </p>

      <p>
        <strong>Due Diligence:</strong> Third-party accounting (quality of earnings), market
        studies, technical assessments, environmental reviews, and other deal-related
        investigations. These costs vary significantly by deal complexity.
      </p>

      <p>
        <strong>Broken Deal Costs:</strong> When a deal doesn't close, the fund (not the GP)
        typically bears the due diligence and legal costs incurred. For active deal-makers,
        this can be a meaningful expense category.
      </p>

      <div className="callout">
        <div className="callout-icon">💡</div>
        <div className="callout-content">
          <strong>Negotiation opportunity:</strong> Some LPAs cap total expenses as a percentage
          of committed capital or require GP co-investment in expenses above a threshold.
          Look for "expense cap" provisions in side letter negotiations.
        </div>
      </div>

      <h3>Expenses vs. Management Fees</h3>

      <p>
        The distinction matters for alignment. Management fees go to the GP to run their
        business—salaries, office space, back-office infrastructure. Expenses are
        <em> fund-level costs</em> that the GP incurs on behalf of the partnership.
      </p>

      <p>
        In theory, this creates better alignment: the GP pays for their operations out of
        a fixed fee, while variable deal costs are shared with LPs. In practice, the
        line can blur—watch for broad expense definitions that shift costs from the GP's
        P&L to the fund.
      </p>

    </section>

    <section id="lines-of-credit" className="content-section">
      <h2>Subscription Lines Of Credit</h2>

      <p>
        At the fund level, a subscription line is a short-term credit facility secured by LP
        commitments. GPs often use it to bridge capital calls, close transactions quickly, and
        make call activity more operationally efficient. Typical facility sizes are often in the
        <strong> 10% to 25%</strong> range of fund commitments, with many draws repaid in a few months.
        Practically, it works like this: when a GP closes a new deal, they can borrow on the line
        first instead of calling LP capital immediately, then call capital later to repay the line
        (plus interest). That mostly shifts the timing of your capital call.
      </p>

      <div className="interactive-block line-credit-block">
        <div className="block-header">
          <span className="block-title">Lines Of Credit: IRR Lift vs TVPI Drag</span>
          <span className="block-subtitle">Delay calls, add interest expense, and compare both outcomes clearly</span>
        </div>
        <div className="block-actions">
          <ResetButton onClick={resetExpenses} />
        </div>

          <div className="sliders-grid">
            <Slider
              value={lineGrossMOIC}
              onChange={setLineGrossMOIC}
              min={1.5}
              max={3.5}
              step={0.05}
              label="Gross MOIC Scenario"
              format={(v) => `${v.toFixed(2)}x`}
              accent="#2D6B4F"
            />

            <Slider
              value={lineUtilization}
              onChange={setLineUtilization}
              min={0}
              max={0.30}
              step={0.01}
              label="Line Size (% Of Fund)"
              format={(v) => formatPercent(v)}
              accent="#4A7BA7"
            />

            <Slider
              value={drawDelayQuarters}
              onChange={setDrawDelayQuarters}
              min={0}
              max={4}
              step={1}
              label="Average Delay To LP Call"
              format={(v) => `${v} qtrs`}
              accent="#1B2A4A"
            />

            <Slider
              value={lineRate}
              onChange={setLineRate}
              min={0.04}
              max={0.12}
              step={0.0025}
              label="All-In Interest Cost"
              format={(v) => formatPercent(v)}
              accent="#B5473A"
            />
          </div>

          <div className="loc-call-timing">
            <div className="loc-call-timing-title">Capital Call Timing (Quarterly)</div>
            <LocTimingColumnChart
              data={lineOfCreditAnalysis.callTimingData.map((d) => ({
                label: d.label,
                noLocCall: d.baseCapitalCall,
                withLocPrincipalCall: d.withLocPrincipalCall,
                withLocInterestCall: d.withLocInterestCall
              }))}
              height={230}
              xTickStep={2}
              shiftArrows={locShiftArrows}
              animateShiftArrows={true}
            />
            <p className="loc-call-timing-note">
              This chart is intentionally limited to the deployment and near-paydown window to keep
              timing effects readable.
            </p>
          </div>

          <div className="loc-mechanics-explainer">
            <div className="loc-mechanics-title">Why IRR Improves While TVPI Declines</div>
            <div className="loc-mechanics-grid">
              <div className="loc-mechanics-card positive">
                <div className="loc-mechanics-card-title">Why IRR usually looks better</div>
                <p>
                  IRR is highly sensitive to <strong>when</strong> capital leaves the LP. A subscription line delays those
                  capital calls, which means less LP cash is outstanding in the early periods. The same distributions are then
                  measured against a later contribution schedule, so the annualized return calculation moves up.
                </p>
              </div>
              <div className="loc-mechanics-card negative">
                <div className="loc-mechanics-card-title">Why TVPI usually gets worse</div>
                <p>
                  TVPI is about <strong>how many dollars come back</strong> relative to dollars contributed. The line does not
                  create new portfolio value. It adds interest expense, and that expense is paid by the fund. Those borrowing costs
                  reduce the cash ultimately available to LPs, so net TVPI declines.
                </p>
              </div>
            </div>
            <p className="loc-mechanics-summary">
              Put differently: the line mostly changes <strong>timing</strong>, which helps IRR, while the interest bill changes
              <strong> total dollars kept</strong>, which hurts TVPI.
            </p>
          </div>

          <div className="loc-outcome-charts">
            <div className="loc-outcome-chart">
              <div className="loc-outcome-title">IRR Comparison</div>
              <BarChart
                height={180}
                data={[
                  {
                    label: 'No LOC',
                    value: lineOfCreditAnalysis.netIRRNoLine * 10000,
                    valueLabel: formatPercent(lineOfCreditAnalysis.netIRRNoLine),
                    color: '#1B2A4A'
                  },
                  {
                    label: 'With LOC',
                    value: lineOfCreditAnalysis.netIRRWithLine * 10000,
                    valueLabel: formatPercent(lineOfCreditAnalysis.netIRRWithLine),
                    color: '#2D6B4F'
                  }
                ]}
                showLabels={true}
                yDomain={[
                  Math.max(
                    0,
                    Math.min(lineOfCreditAnalysis.netIRRNoLine, lineOfCreditAnalysis.netIRRWithLine) * 10000 - 80
                  ),
                  Math.max(lineOfCreditAnalysis.netIRRNoLine, lineOfCreditAnalysis.netIRRWithLine) * 10000 + 80
                ]}
              />
              <div className="loc-outcome-delta">
                Change: {lineOfCreditAnalysis.irrLiftBps >= 0 ? '+' : ''}{lineOfCreditAnalysis.irrLiftBps.toFixed(0)} bps
              </div>
              <div className="loc-zoom-note">Zoomed axis for comparability</div>
            </div>

            <div className="loc-outcome-chart">
              <div className="loc-outcome-title">TVPI Comparison</div>
              <BarChart
                height={180}
                data={[
                  {
                    label: 'No LOC',
                    value: lineOfCreditAnalysis.netTVPINoLine,
                    valueLabel: `${lineOfCreditAnalysis.netTVPINoLine.toFixed(2)}x`,
                    color: '#1B2A4A'
                  },
                  {
                    label: 'With LOC',
                    value: lineOfCreditAnalysis.netTVPIWithLine,
                    valueLabel: `${lineOfCreditAnalysis.netTVPIWithLine.toFixed(2)}x`,
                    color: '#B5473A'
                  }
                ]}
                showLabels={true}
                yDomain={[
                  Math.max(
                    0,
                    Math.min(lineOfCreditAnalysis.netTVPINoLine, lineOfCreditAnalysis.netTVPIWithLine) - 0.08
                  ),
                  Math.max(lineOfCreditAnalysis.netTVPINoLine, lineOfCreditAnalysis.netTVPIWithLine) + 0.08
                ]}
              />
              <div className="loc-outcome-delta negative">
                Change: {lineOfCreditAnalysis.tvpiDrag >= 0 ? '+' : ''}{lineOfCreditAnalysis.tvpiDrag.toFixed(3)}x
              </div>
              <div className="loc-zoom-note">Zoomed axis for comparability</div>
            </div>
          </div>

          <div className="net-impact-panel">
            <div className="net-impact-title">Economic Check</div>
            <div className="metrics-row">
              <MetricCard
                label="Baseline Net IRR (No LOC)"
                value={formatPercent(lineOfCreditAnalysis.netIRRNoLine)}
                subtext={`Shared model at ${lineGrossMOIC.toFixed(2)}x gross MOIC`}
                accent="#2D6B4F"
              />
              <MetricCard
                label="Modeled Net IRR Lift"
                value={`${lineOfCreditAnalysis.irrLiftBps >= 0 ? '+' : ''}${lineOfCreditAnalysis.irrLiftBps.toFixed(0)} bps`}
                subtext={`From delaying calls by ~${drawDelayQuarters} quarters`}
                accent={lineOfCreditAnalysis.irrLiftBps >= 0 ? '#2D6B4F' : '#B5473A'}
              />
              <MetricCard
                label="Total Interest Expense"
                value={formatCurrency(lineOfCreditAnalysis.interestExpense, 0)}
                subtext="Fund-level cost that reduces net TVPI"
                accent="#B5473A"
              />
              <MetricCard
                label="Assumed LOC Capacity"
                value={formatPercent(lineUtilization)}
                subtext={`${formatCurrency(lineOfCreditAnalysis.lineCapacity, 0)} max principal, drawn up to limit`}
                accent="#4A7BA7"
              />
            </div>
          </div>
          <p className="loc-assumption-note">
            Assumption: the model draws the line up to the selected capacity whenever quarterly
            deal funding requires it, then amortizes repayment over the selected delay window.
          </p>

          <div className="line-credit-tradeoffs">
            <div className="line-credit-tradeoff positive">
              <div className="line-credit-tradeoff-title">Why LPs and GPs still use them</div>
              <p>
                Fewer small capital calls, administrative flexibility, and more time for LP cash to
                stay productive elsewhere. For GPs, facilities can improve deal execution speed and
                create room to close larger deals while syndicating co-investment.
              </p>
            </div>
            <div className="line-credit-tradeoff negative">
              <div className="line-credit-tradeoff-title">The counterargument is valid</div>
              <p>
                Some of the IRR benefit is timing optics. Interest expense is real and lowers TVPI.
                If line usage is heavy or borrowing costs are high, the drag can overwhelm operational
                benefits for LP outcomes.
              </p>
            </div>
          </div>
          <p className="loc-lp-impact-note">
            In this run, an LP with an illustrative commitment of{' '}
            <strong>{formatCurrency(lineOfCreditAnalysis.illustrativeLpCommitment, 0)}</strong>{' '}
            pays about{' '}
            <strong>{formatCurrency(lineOfCreditAnalysis.illustrativeLpInterestExpense, 0)}</strong>{' '}
            of additional interest expense for an IRR impact of{' '}
            <strong>
              {lineOfCreditAnalysis.irrLiftBps >= 0 ? '+' : ''}
              {lineOfCreditAnalysis.irrLiftBps.toFixed(0)} bps
            </strong>.
          </p>

          <NuanceDisclosure
            title="Final Thought: When A Subscription Line Can Backfire"
            summary="Try this: reset settings, then drag Gross MOIC to the far left."
          >
            At very low return scenarios, the baseline no-LOC net IRR can fall below the all-in
            borrowing cost. That means the fund is effectively borrowing at{' '}
            <strong>{formatPercent(lineRate)}</strong> to finance assets earning less.
            <br /><br />
            In that setup, TVPI still declines from interest expense, and IRR can also deteriorate.
            {locBackfireNow ? (
              <>
                <br /><br />
                <strong>Current state:</strong> this run is already in a backfire zone where LOC hurts both IRR and TVPI.
              </>
            ) : null}
          </NuanceDisclosure>
      </div>

      <WhatWeDidntCover
        items={[
          'How subscription line usage policies differ by manager, including internal limits on draw size, tenor, and the situations where the facility is allowed to be used.',
          'How lenders size these facilities using LP concentration, investor quality, and borrowing base mechanics rather than just headline fund size.',
          'How fund documents and side letters can constrain line usage, require reporting, or limit whether facilities are used for operational convenience versus return presentation.'
        ]}
      />
    </section>

    </>
  );
};

const CarrySection = ({ globalGrossMultiple, onGrossMultipleChange } = {}) => {
  const NON_CARRY_DRAG_MULTIPLE = 0.20;
  const GROSS_MOIC_MIN = 1.0;
  const GROSS_MOIC_MAX = 3.5;
  const PRE_CARRY_IRR_STEP = 0.0025;
  const DEFAULTS = {
    grossMOIC: BASELINE_GROSS_TVPI,
    carryRate: 0.20,
    hurdleRate: 0.08,
    holdPeriod: 5
  };
  const [fundSize] = useState(500);
  const [localGrossMOIC, setLocalGrossMOIC] = useState(DEFAULTS.grossMOIC);
  const grossMOIC = globalGrossMultiple ?? localGrossMOIC;
  const setGrossMOIC = onGrossMultipleChange ?? setLocalGrossMOIC;
  const [carryRate, setCarryRate] = useState(DEFAULTS.carryRate);
  const [hurdleRate, setHurdleRate] = useState(DEFAULTS.hurdleRate);
  const [holdPeriod, setHoldPeriod] = useState(DEFAULTS.holdPeriod);
  const impliedPreCarryNetMultiple = Math.max(1, grossMOIC - NON_CARRY_DRAG_MULTIPLE);
  const preCarryNetIRRFromGross = Math.pow(impliedPreCarryNetMultiple, 1 / holdPeriod) - 1;
  const preCarryIrrMin = Math.pow(Math.max(1, GROSS_MOIC_MIN - NON_CARRY_DRAG_MULTIPLE), 1 / holdPeriod) - 1;
  const preCarryIrrMax = Math.pow(Math.max(1, GROSS_MOIC_MAX - NON_CARRY_DRAG_MULTIPLE), 1 / holdPeriod) - 1;
  const clampedPreCarryNetIRR = Math.max(preCarryIrrMin, Math.min(preCarryIrrMax, preCarryNetIRRFromGross));

  const handlePreCarryNetIRRChange = (nextIrr) => {
    const clamped = Math.max(preCarryIrrMin, Math.min(preCarryIrrMax, nextIrr));
    const impliedPreCarryMultiple = Math.pow(1 + clamped, holdPeriod);
    const impliedGross = impliedPreCarryMultiple + NON_CARRY_DRAG_MULTIPLE;
    setGrossMOIC(Math.max(GROSS_MOIC_MIN, Math.min(GROSS_MOIC_MAX, impliedGross)));
  };

  const resetCarry = () => {
    setGrossMOIC(DEFAULTS.grossMOIC);
    setCarryRate(DEFAULTS.carryRate);
    setHurdleRate(DEFAULTS.hurdleRate);
    setHoldPeriod(DEFAULTS.holdPeriod);
  };

  const waterfallData = useMemo(() => {
    const preCarryNetMultiple = Math.max(1, grossMOIC - NON_CARRY_DRAG_MULTIPLE);
    const preCarryEndingValue = fundSize * preCarryNetMultiple;
    const preCarryNetIRR = Math.pow(preCarryNetMultiple, 1 / holdPeriod) - 1;
    const preferredReturn = Math.max(0, fundSize * (Math.pow(1 + hurdleRate, holdPeriod) - 1));
    const lpPrefTarget = fundSize + preferredReturn;
    const totalProfit = preCarryEndingValue - fundSize;
    const preCarryProfitPool = Math.max(0, totalProfit);

    let gpCarry = 0;
    let gpCatchUp = 0;
    let gpSplitProfit = 0;
    let gpCatchUpTarget = 0;
    let residualAfterPref = 0;

    if (preCarryEndingValue > lpPrefTarget && totalProfit > 0 && carryRate > 0) {
      residualAfterPref = preCarryEndingValue - lpPrefTarget;
      gpCatchUpTarget = (carryRate * preferredReturn) / Math.max(1e-9, (1 - carryRate));
      gpCatchUp = Math.min(residualAfterPref, gpCatchUpTarget);
      const residualAfterCatchUp = Math.max(0, residualAfterPref - gpCatchUp);
      gpSplitProfit = residualAfterCatchUp * carryRate;
      gpCarry = gpCatchUp + gpSplitProfit;
    }

    const lpTotal = Math.max(0, preCarryEndingValue - gpCarry);
    const lpNetIRR = fundSize > 0 ? Math.pow(Math.max(1e-9, lpTotal / fundSize), 1 / holdPeriod) - 1 : 0;

    const hurdleBuffer = 0.0005;
    const hurdleCleared = preCarryNetIRR >= hurdleRate - hurdleBuffer;
    const inCatchUpZone = gpCatchUp > 0 && residualAfterPref <= gpCatchUpTarget;

    const stages = [];
    stages.push({
      label: 'LP Capital Returned',
      value: fundSize,
      cumulative: fundSize,
      color: '#1B2A4A',
      isIncrease: true,
      valueLabel: formatCurrency(fundSize * 1e6, 0)
    });

    if (preCarryProfitPool > 0) {
      stages.push({
        label: 'Pre-Carry Profit Pool',
        value: preCarryProfitPool,
        cumulative: fundSize + preCarryProfitPool,
        color: '#2D6B4F',
        isIncrease: true,
        valueLabel: formatCurrency(preCarryProfitPool * 1e6, 0)
      });
    }

    if (gpCatchUp > 0) {
      stages.push({
        label: 'GP Catch-Up',
        value: gpCatchUp,
        cumulative: fundSize + preCarryProfitPool - gpCatchUp,
        color: '#B5473A',
        isIncrease: false,
        valueLabel: `-${formatCurrency(gpCatchUp * 1e6, 0)}`
      });
    }

    if (gpSplitProfit > 0) {
      stages.push({
        label: 'GP Profit Share',
        value: gpSplitProfit,
        cumulative: fundSize + preCarryProfitPool - gpCarry,
        color: '#B5473A',
        isIncrease: false,
        valueLabel: `-${formatCurrency(gpSplitProfit * 1e6, 0)}`
      });
    }

    stages.push({
      label: 'LP Net Distributions',
      cumulative: lpTotal,
      isIncrease: true,
      fullBar: true,
      color: '#1B2A4A',
      valueLabel: formatCurrency(lpTotal * 1e6, 0)
    });

    return {
      stages,
      lpTotal,
      gpCarry,
      gpCatchUp,
      gpSplitProfit,
      grossMOIC,
      preCarryNetIRR,
      preCarryNetMultiple,
      hurdleCleared,
      preferredReturn,
      totalProfit,
      preCarryProfitPool,
      lpNetIRR,
      inCatchUpZone
    };
  }, [fundSize, grossMOIC, carryRate, hurdleRate, holdPeriod]);

  const netMultiple = waterfallData.lpTotal / fundSize;
  const lpNetIRR = waterfallData.lpNetIRR;
  const preCarryNetIRR = waterfallData.preCarryNetIRR;
  const preCarryVsHurdleBps = (preCarryNetIRR - hurdleRate) * 10000;
  const lpProfitAfterCarry = Math.max(0, waterfallData.preCarryProfitPool - waterfallData.gpCarry);
  const lpProfitSharePct = waterfallData.preCarryProfitPool > 0 ? lpProfitAfterCarry / waterfallData.preCarryProfitPool : 1;
  const gpProfitSharePct = waterfallData.preCarryProfitPool > 0 ? waterfallData.gpCarry / waterfallData.preCarryProfitPool : 0;
  const lpSplitPercent = Math.round((1 - carryRate) * 100);
  const gpSplitPercent = Math.round(carryRate * 100);

  return (
    <section id="carried-interest" className="content-section">
      <h2>Carry: How The Manager Shares In The Upside</h2>

      <p className="assumption-note">
        This section isolates carry only. It assumes the fund is fully invested, does not recycle capital,
        uses a whole-fund payout structure, and has already absorbed other non-carry fees and expenses before
        the carry step.
      </p>

      <p>
        <strong>Carry</strong> is the manager&apos;s share of fund profits. In simple terms: if the fund performs well enough,
        the GP gets part of the upside. If results are not good enough, the GP does not earn carry.
      </p>

      <p>
        The payout order is the key idea. First, LPs get back the money they invested. Second, LPs usually must earn a minimum
        return before carry can start. Only after those two steps does the GP begin sharing in profits. That is why carry is
        different from management fees: management fees are paid along the way, but carry is more like a success fee.
      </p>

      <p>
        Time matters too. If the minimum return is 8% per year, clearing that bar over five years requires more profit than clearing
        it over three years. So a longer hold period makes it harder for carry to turn on.
      </p>

      <p>
        The practical takeaway is simple: carry usually does not matter much in weak outcomes, because there may not be enough profit
        to trigger it. It matters most in stronger outcomes, where the GP starts taking a share of profit that would otherwise stay
        with LPs.
      </p>

      <div className="interactive-block">
        <div className="block-header">
          <span className="block-title">Before Carry vs After Carry</span>
          <span className="block-subtitle">Start with the LP result before carry, then see when carry turns on and how the profit gets divided.</span>
        </div>
        <div className="block-actions">
          <ResetButton onClick={resetCarry} />
        </div>

        <div className="sliders-grid">
          <Slider
            value={clampedPreCarryNetIRR}
            onChange={handlePreCarryNetIRRChange}
            min={preCarryIrrMin}
            max={preCarryIrrMax}
            step={PRE_CARRY_IRR_STEP}
            label="Fund Net IRR (Pre-Carry)"
            format={(v) => formatPercent(v, 1)}
            accent={preCarryNetIRR >= hurdleRate ? '#1B2A4A' : '#B5473A'}
          />

          <Slider
            value={hurdleRate}
            onChange={setHurdleRate}
            min={0}
            max={0.12}
            step={0.005}
            label="Hurdle Rate"
            format={(v) => formatPercent(v)}
            accent="#C9A84C"
          />

          <Slider
            value={holdPeriod}
            onChange={setHoldPeriod}
            min={3}
            max={8}
            step={1}
            label="Hold Period"
            format={(v) => `${v} years`}
          />

          <Slider
            value={carryRate}
            onChange={setCarryRate}
            min={0.15}
            max={0.30}
            step={0.01}
            label="Carry Rate"
            format={(v) => formatPercent(v)}
          />
        </div>

        <p className="carry-link-note">
          Implied gross MOIC for the linked model: <strong>{grossMOIC.toFixed(2)}x</strong>{' '}
          (assuming a 0.20x non-carry spread before carry).
        </p>

        <div className={`hurdle-status ${waterfallData.hurdleCleared ? 'cleared' : 'not-cleared'}`}>
          <div className="hurdle-indicator"></div>
          <span>
            {waterfallData.hurdleCleared
              ? `Before carry, the LP return is ${formatPercent(preCarryNetIRR, 1)}. That is above the ${formatPercent(hurdleRate, 1)} minimum return, so the GP now shares in profit above that line.`
              : `Before carry, the LP return is ${formatPercent(preCarryNetIRR, 1)}. That is still below the ${formatPercent(hurdleRate, 1)} minimum return, so carry has not started yet.`
            }
          </span>
        </div>

        <p className="carry-hinge-note">
          One extra wrinkle: some fund agreements include a <strong>catch-up</strong>. That means once LPs have received their money back
          and cleared the minimum return, the GP may take most of the next dollars for a while so the final sharing ratio lands where the
          agreement says it should.
        </p>

        <WaterfallChart data={waterfallData.stages} height={280} />

        <div className="profit-split-panel">
          <div className="profit-split-title">Where The Profit Goes</div>
          <div className="profit-split-bar">
            <div className="profit-split-segment lp" style={{ width: `${Math.max(0, Math.min(100, lpProfitSharePct * 100))}%` }}>
              LP {formatPercent(lpProfitSharePct, 0)}
            </div>
            <div className="profit-split-segment gp" style={{ width: `${Math.max(0, Math.min(100, gpProfitSharePct * 100))}%` }}>
              GP {formatPercent(gpProfitSharePct, 0)}
            </div>
          </div>
          <div className="profit-split-meta">
            <span>LP Profit Share: {formatCurrency(lpProfitAfterCarry * 1e6, 0)} ({formatPercent(lpProfitSharePct, 1)})</span>
            <span>GP Profit Share: {formatCurrency(waterfallData.gpCarry * 1e6, 0)} ({formatPercent(gpProfitSharePct, 1)})</span>
          </div>
        </div>

        <div className="waterfall-legend">
          <div className="legend-item">
            <span className="legend-color" style={{ backgroundColor: '#1B2A4A' }}></span>
            <span>LP Outcome</span>
          </div>
          <div className="legend-item">
            <span className="legend-color" style={{ backgroundColor: '#B5473A' }}></span>
            <span>GP Deductions</span>
          </div>
        </div>

        <div className="metrics-row">
          <MetricCard
            label="Net IRR (Pre-Carry)"
            value={formatPercent(preCarryNetIRR, 1)}
            subtext={`${preCarryVsHurdleBps >= 0 ? '+' : ''}${preCarryVsHurdleBps.toFixed(0)} bps vs hurdle`}
            accent={preCarryVsHurdleBps >= 0 ? '#2D6B4F' : '#B5473A'}
          />
          <MetricCard
            label="LP Net TVPI (Post-Carry)"
            value={`${netMultiple.toFixed(2)}x`}
            subtext={`${formatPercent(lpNetIRR)} net IRR`}
            accent="#1B2A4A"
          />
          <MetricCard
            label="Implied Gross MOIC"
            value={`${waterfallData.grossMOIC.toFixed(2)}x`}
            subtext={`${waterfallData.preCarryNetMultiple.toFixed(2)}x pre-carry net multiple`}
            accent="#2D6B4F"
          />
          <MetricCard
            label="GP Carry"
            value={formatCurrency(waterfallData.gpCarry * 1e6, 0)}
            subtext={waterfallData.inCatchUpZone ? 'Catch-up phase active' : `${formatPercent(carryRate)} carry rate`}
            accent={waterfallData.gpCarry > 0 ? '#B5473A' : '#9A9690'}
          />
        </div>
      </div>

      <h3>The Waterfall Mechanics</h3>

      <p>
        <strong>1. Return LP money first:</strong> before anyone talks about carry, LPs get back the capital they put in.
      </p>

      <p>
        <strong>2. Clear the minimum return:</strong> LPs usually need to earn at least the hurdle before the GP gets carry.
        In this example the hurdle is {formatPercent(hurdleRate, 1)} over a {holdPeriod}-year hold, so the fund has to produce enough
        profit to beat that annual bar over the full holding period.
      </p>

      <p>
        <strong>3. Catch-up can speed up the GP share:</strong> after LPs have cleared that minimum, the GP may get most of the next dollars
        for a period of time until the agreed long-run split is reached.
      </p>

      <p>
        <strong>4. Split the rest of the upside:</strong> after that, any remaining profit is shared LP {lpSplitPercent}% / GP {gpSplitPercent}%
        based on the carry rate.
      </p>

      <p>
        The main point for an LP is that carry changes <strong>who keeps the upside</strong> once the fund performs well. A higher carry rate,
        an easier hurdle, or a more GP-friendly catch-up means more of the profit shifts from LPs to the manager.
      </p>

      <WhatWeDidntCover
        items={[
          'Variable carry structures where GP carry can step up after a higher net hurdle (for example, moving from X% to Y% after a 3.0x net outcome).'
        ]}
      />
    </section>
  );
};

const WaterfallComparisonSection = () => {
  return (
    <section id="waterfall-structures" className="content-section">
      <h2>European vs. American Waterfalls</h2>

      <p>
        At a high level, European waterfalls test carry after the whole fund is evaluated,
        while American waterfalls can distribute carry deal by deal during the life of the fund.
      </p>

      <p>
        Both structures can end at the same final economics when clawback is enforced. In practice,
        the main difference is timing: when carry is distributed to the GP during the fund lifecycle.
      </p>

      <div className="comparison-grid">
        <div className="comparison-card">
          <h4>European (Whole-Fund)</h4>
          <p>
            Carry is usually paid later, after a full-fund test. LPs typically see less GP carry
            cash leaving the fund before termination.
          </p>
        </div>
        <div className="comparison-card">
          <h4>American (Deal-by-Deal)</h4>
          <p>
            Carry can be paid earlier as profitable deals realize. That creates more interim timing
            noise, with true-up and clawback handled by the fund termination mechanics.
          </p>
        </div>
      </div>

      <div className="callout callout-insight">
        <div className="callout-content">
          <strong>Simple takeaway:</strong> this term set mostly affects timing, not necessarily final
          endpoint economics when clawback and true-up are enforceable.
        </div>
      </div>

      <p>
        For this guide, we keep the focus on timing only and avoid forcing a noisy interim IRR model
        here. The more advanced accrued-carry mechanics are included in the conclusion notes.
      </p>

      <NuanceDisclosure
        title="Final Thought: Clawback Reality"
        summary="Timing differences can still leave lasting LP economics effects in practice."
      >
        While clawback is intended to reduce differences between American and European waterfalls,
        in practice any amount clawed back from the GP is usually reduced by taxes already paid by
        the GP. So carry paid early under an American waterfall and clawed back later may not fully
        make LPs whole.
      </NuanceDisclosure>
    </section>
  );
};

const UnderinvestingSection = ({
  globalGrossMultiple,
  onGrossMultipleChange,
  globalDeploymentRate,
  onDeploymentRateChange
} = {}) => {
  const [localGrossMultiple, setLocalGrossMultiple] = useState(BASELINE_GROSS_TVPI);
  const [localDeploymentRate, setLocalDeploymentRate] = useState(1.0);
  const grossMultiple = globalGrossMultiple ?? localGrossMultiple;
  const setGrossMultiple = onGrossMultipleChange ?? setLocalGrossMultiple;
  const deploymentRate = globalDeploymentRate ?? localDeploymentRate;
  const setDeploymentRate = onDeploymentRateChange ?? setLocalDeploymentRate;
  const resetUnderinvesting = () => {
    setGrossMultiple(BASELINE_GROSS_TVPI);
    setDeploymentRate(1.0);
  };

  const underinvestModel = useMemo(() => {
    return buildQuarterlySchedule({
      fundSizeM: BASELINE_MODEL_INPUTS.fundSize * 1e6,
      fundLife: BASELINE_MODEL_INPUTS.fundLife,
      investmentPeriod: BASELINE_MODEL_INPUTS.investmentPeriod,
      grossMultiple,
      mgmtFeeRate: BASELINE_MODEL_INPUTS.mgmtFeeRate,
      expenseRate: BASELINE_MODEL_INPUTS.expenseRate,
      carryRate: BASELINE_MODEL_INPUTS.carryRate,
      hurdleRate: BASELINE_MODEL_INPUTS.hurdleRate,
      deploymentRate
    });
  }, [grossMultiple, deploymentRate]);

  const fullDeployModel = useMemo(() => {
    return buildQuarterlySchedule({
      fundSizeM: BASELINE_MODEL_INPUTS.fundSize * 1e6,
      fundLife: BASELINE_MODEL_INPUTS.fundLife,
      investmentPeriod: BASELINE_MODEL_INPUTS.investmentPeriod,
      grossMultiple,
      mgmtFeeRate: BASELINE_MODEL_INPUTS.mgmtFeeRate,
      expenseRate: BASELINE_MODEL_INPUTS.expenseRate,
      carryRate: BASELINE_MODEL_INPUTS.carryRate,
      hurdleRate: BASELINE_MODEL_INPUTS.hurdleRate,
      deploymentRate: 1.0
    });
  }, [grossMultiple]);

  const grossOnCommitment = underinvestModel.totals.grossMultiple;
  const netOnCommitment = underinvestModel.totals.netMultiple;
  const spread = grossOnCommitment - netOnCommitment;
  const fullSpread = fullDeployModel.totals.grossMultiple - fullDeployModel.totals.netMultiple;
  const extraSpread = spread - fullSpread;
  const netIrrDragBps = Math.max(0, (fullDeployModel.totals.netIRR - underinvestModel.totals.netIRR) * 10000);
  const deploymentCurve = useMemo(() => {
    const labels = [];
    const commitmentGross = [];
    const investedGross = [];
    for (let d = 0.6; d <= 1.0001; d += 0.02) {
      const deployment = Number(d.toFixed(2));
      labels.push(`${(deployment * 100).toFixed(0)}%`);
      commitmentGross.push(deployment * grossMultiple);
      investedGross.push(grossMultiple);
    }
    return { labels, commitmentGross, investedGross };
  }, [grossMultiple]);
  const feeExpenseCurve = useMemo(() => {
    const labels = [];
    const feeExpensePctCommitment = [];
    const feeExpensePctDeployed = [];
    const commitmentCapital = BASELINE_MODEL_INPUTS.fundSize * 1e6;

    for (let d = 0.6; d <= 1.0001; d += 0.02) {
      const deployment = Number(d.toFixed(2));
      const model = buildQuarterlySchedule({
        fundSizeM: commitmentCapital,
        fundLife: BASELINE_MODEL_INPUTS.fundLife,
        investmentPeriod: BASELINE_MODEL_INPUTS.investmentPeriod,
        grossMultiple,
        mgmtFeeRate: BASELINE_MODEL_INPUTS.mgmtFeeRate,
        expenseRate: BASELINE_MODEL_INPUTS.expenseRate,
        carryRate: BASELINE_MODEL_INPUTS.carryRate,
        hurdleRate: BASELINE_MODEL_INPUTS.hurdleRate,
        deploymentRate: deployment
      });
      const totalFeeExpense = model.totals.totalMgmtFees + model.totals.totalExpenses;
      const deployedCapital = Math.max(1, model.totals.deployedCapitalTarget);

      labels.push(`${(deployment * 100).toFixed(0)}%`);
      feeExpensePctCommitment.push(totalFeeExpense / commitmentCapital);
      feeExpensePctDeployed.push(totalFeeExpense / deployedCapital);
    }

    return { labels, feeExpensePctCommitment, feeExpensePctDeployed };
  }, [grossMultiple]);
  const currentDeploymentIndex = useMemo(() => {
    const rawIndex = Math.round((deploymentRate - 0.6) / 0.02);
    return Math.max(0, Math.min(deploymentCurve.labels.length - 1, rawIndex));
  }, [deploymentRate, deploymentCurve.labels.length]);

  return (
    <section id="underinvesting-impact" className="content-section">
      <h2>Underinvesting: When Committed Capital Does Not Get Fully Put To Work</h2>

      <p>
        When an LP commits capital to a fund, the expectation is straightforward: the GP will use that capital
        to find and fund investments. During the investment period, management fees are typically charged on the
        full commitment, so LPs are paying the manager to put that capital to work.
      </p>

      <p>
        That is why <strong>underinvesting</strong> matters. If a GP only invests part of the committed capital,
        LPs may still have paid fees on the whole commitment even though only a fraction of it ever reached portfolio
        companies. In the extreme case, if you commit $100 and the GP invests nothing, you have paid fees but never
        actually invested a dollar. Real funds are rarely that extreme, but the example makes the point clearly.
      </p>

      <p>
        The same logic applies in less extreme cases. If a GP invests 60%, 90%, or 100% of the commitment, the gross
        return on the dollars that were invested can look identical, but the LP outcome can be very different because
        fees and expenses were charged against the commitment base. Lower deployment usually means a wider gross-to-net
        spread for the LP.
      </p>

      <div className="interactive-block">
        <div className="block-header">
          <span className="block-title">Deployment Efficiency Stress Test</span>
          <span className="block-subtitle">Same gross return on invested dollars, different LP outcomes depending on how much of the commitment actually gets invested.</span>
        </div>
        <div className="block-actions">
          <ResetButton onClick={resetUnderinvesting} />
        </div>

        <div className="sliders-grid">
          <Slider
            value={grossMultiple}
            onChange={setGrossMultiple}
            min={1.0}
            max={3.5}
            step={0.05}
            label="Gross MOIC (On Invested Capital)"
            format={(v) => `${v.toFixed(2)}x`}
          />
          <Slider
            value={deploymentRate}
            onChange={setDeploymentRate}
            min={0.6}
            max={1.0}
            step={0.01}
            label="% Of LP Commitment Actually Invested"
            format={(v) => `${(v * 100).toFixed(0)}%`}
            accent="#C9A84C"
          />
        </div>

        <div className="underinvesting-charts">
          <div className="tradeoff-curve underinvesting-curve">
            <div className="tradeoff-curve-title">Deployment Rate vs Gross Outcome</div>
            <div className="underinvesting-legend">
              <div className="underinvesting-legend-item">
                <span className="underinvesting-legend-line" style={{ background: '#1B2A4A' }}></span>
                <span>Commitment TVPI</span>
              </div>
              <div className="underinvesting-legend-item">
                <span className="underinvesting-legend-line" style={{ background: '#2D6B4F' }}></span>
                <span>Invested MOIC</span>
              </div>
            </div>
            <ComparisonChart
              seriesA={deploymentCurve.commitmentGross}
              seriesB={deploymentCurve.investedGross}
              labelA="Commitment TVPI"
              labelB="Invested MOIC"
              xLabels={deploymentCurve.labels}
              xTickStep={5}
              yFormatter={(v) => `${v.toFixed(2)}x`}
              colorA="#1B2A4A"
              colorB="#2D6B4F"
              height={210}
              showLegend={false}
              xAxisLabel="Percent Of LP Commitment Invested"
              xAxisStartLabel="Less invested"
              xAxisEndLabel="More invested"
              marker={{
                index: currentDeploymentIndex,
                label: `Current ${(deploymentRate * 100).toFixed(0)}%`,
                color: '#C9A84C'
              }}
            />
          </div>

          <div className="tradeoff-curve underinvesting-curve">
            <div className="tradeoff-curve-title">Fee + Expense Load by Capital Base</div>
            <div className="underinvesting-legend">
              <div className="underinvesting-legend-item">
                <span className="underinvesting-legend-line" style={{ background: '#B5473A' }}></span>
                <span>% of Committed</span>
              </div>
              <div className="underinvesting-legend-item">
                <span className="underinvesting-legend-line" style={{ background: '#C9A84C' }}></span>
                <span>% of Deployed</span>
              </div>
            </div>
            <ComparisonChart
              seriesA={feeExpenseCurve.feeExpensePctCommitment}
              seriesB={feeExpenseCurve.feeExpensePctDeployed}
              labelA="% of Committed"
              labelB="% of Deployed"
              xLabels={feeExpenseCurve.labels}
              xTickStep={5}
              yFormatter={(v) => formatPercent(v)}
              colorA="#B5473A"
              colorB="#C9A84C"
              height={210}
              showLegend={false}
              xAxisLabel="Percent Of LP Commitment Invested"
              xAxisStartLabel="Less invested"
              xAxisEndLabel="More invested"
              marker={{
                index: currentDeploymentIndex,
                label: `Current ${(deploymentRate * 100).toFixed(0)}%`,
                color: '#C9A84C'
              }}
            />
          </div>
        </div>

        <div className="tradeoff-curve underinvesting-curve">
          <p className="bridge-note">
            Green shows the gross multiple on the dollars the GP actually invested. Navy translates that same
            outcome onto the full LP commitment, which is what matters to the investor who paid fees on all of it.
          </p>
          <p className="portfolio-inline-note">
            <strong>Why does this matter?</strong> Imagine you commit $100M to a fund and only $60M is actually invested.
            If that $60M performs very well, the GP can still report a strong gross result on the capital that was deployed.
            But as the LP, you did not commit only $60M, and you did not pay fees on only $60M. You committed $100M and paid
            fees on that larger base. So your real commitment-basis outcome can be much weaker than the headline investment-level
            result. This is exactly why deployment discipline affects the gross-to-net spread.
          </p>
          <p className="portfolio-inline-note">
            This tool focuses on <strong>60% to 100%</strong> deployment to isolate the underinvestment problem. The same basic
            idea can matter in the other direction as well if a manager ultimately puts more than 100% of commitment to work through
            recycling or other fund mechanics: the amount of capital actually deployed changes how LP economics should be interpreted.
          </p>
        </div>

        <div className="metrics-row">
          <MetricCard
            label="Gross TVPI (Commitment Basis)"
            value={`${grossOnCommitment.toFixed(2)}x`}
            subtext={`${(deploymentRate * 100).toFixed(0)}% deployed`}
            accent="#2D6B4F"
          />
          <MetricCard
            label="Net TVPI (Commitment Basis)"
            value={`${netOnCommitment.toFixed(2)}x`}
            subtext={`${formatPercent(underinvestModel.totals.netIRR)} net IRR`}
            accent="#1B2A4A"
          />
          <MetricCard
            label="Gross-to-Net Spread"
            value={`${spread.toFixed(2)}x`}
            subtext="On committed capital"
            accent="#B5473A"
          />
        </div>

        <div className="net-impact-panel">
          <div className="net-impact-title">Net Investor Impact</div>
          <div className="metrics-row">
            <MetricCard
              label="Extra Spread vs Full Deployment"
              value={`${extraSpread > 0 ? '+' : ''}${extraSpread.toFixed(2)}x`}
              subtext="Incremental underinvestment penalty"
              accent="#B5473A"
            />
            <MetricCard
              label="Net IRR Drag"
              value={`${netIrrDragBps.toFixed(0)} bps`}
              subtext="Versus 100% deployment at same gross MOIC"
              accent="#9A9690"
            />
            <MetricCard
              label="Fee+Expense Burden"
              value={formatPercent((underinvestModel.totals.totalMgmtFees + underinvestModel.totals.totalExpenses) / Math.max(1, underinvestModel.totals.deployedCapitalTarget))}
              subtext="As % of deployed capital"
              accent="#C9A84C"
            />
          </div>
        </div>
      </div>

      <NuanceDisclosure
        title="Final Thought: Undrawn Capital"
        summary="Under-investing can hurt even more if LPs cannot redeploy idle capital efficiently."
      >
        Some LPs cannot deploy committed but undrawn capital productively elsewhere. In those cases,
        under-investing can leave capital parked in cash-like instruments, which may further reduce
        effective net IRR versus the modeled base case.
      </NuanceDisclosure>
    </section>
  );
};

const QuarterlyScheduleSection = ({
  globalGrossMultiple,
  onGrossMultipleChange,
  globalDeploymentRate,
  onDeploymentRateChange
} = {}) => {
  const [localGrossMultiple, setLocalGrossMultiple] = useState(BASELINE_GROSS_TVPI);
  const [localDeploymentRate, setLocalDeploymentRate] = useState(1.0);
  const grossMultiple = globalGrossMultiple ?? localGrossMultiple;
  const setGrossMultiple = onGrossMultipleChange ?? setLocalGrossMultiple;
  const deploymentRate = globalDeploymentRate ?? localDeploymentRate;
  const setDeploymentRate = onDeploymentRateChange ?? setLocalDeploymentRate;
  const resetQuarterlySchedule = () => {
    setGrossMultiple(BASELINE_GROSS_TVPI);
    setDeploymentRate(1.0);
  };

  const model = useMemo(() => {
    return buildQuarterlySchedule({
      fundSizeM: BASELINE_MODEL_INPUTS.fundSize * 1e6,
      fundLife: BASELINE_MODEL_INPUTS.fundLife,
      investmentPeriod: BASELINE_MODEL_INPUTS.investmentPeriod,
      grossMultiple,
      mgmtFeeRate: BASELINE_MODEL_INPUTS.mgmtFeeRate,
      expenseRate: BASELINE_MODEL_INPUTS.expenseRate,
      carryRate: BASELINE_MODEL_INPUTS.carryRate,
      hurdleRate: BASELINE_MODEL_INPUTS.hurdleRate,
      deploymentRate
    });
  }, [grossMultiple, deploymentRate]);

  return (
    <section id="quarterly-schedule" className="content-section">
      <h2>Quarterly Schedule (Source Of Truth)</h2>

      <p>
        This is the underlying schedule driving the model. Every row shows how deployment, fees,
        expenses, distributions, NAV, and carry combine into LP net cash flow over time.
      </p>

      <div className="interactive-block">
        <div className="block-header">
          <span className="block-title">Model Controls</span>
          <span className="block-subtitle">These controls are linked across sections</span>
        </div>
        <div className="block-actions">
          <ResetButton onClick={resetQuarterlySchedule} />
        </div>

        <div className="sliders-grid">
          <Slider
            value={grossMultiple}
            onChange={setGrossMultiple}
            min={1.0}
            max={3.5}
            step={0.05}
            label="Gross MOIC (On Invested Capital)"
            format={(v) => `${v.toFixed(2)}x`}
          />
          <Slider
            value={deploymentRate}
            onChange={setDeploymentRate}
            min={0.6}
            max={1.0}
            step={0.01}
            label="Deployment Rate"
            format={(v) => `${(v * 100).toFixed(0)}%`}
            accent="#C9A84C"
          />
        </div>

        <div className="metrics-row">
          <MetricCard
            label="Gross TVPI"
            value={`${model.totals.grossMultiple.toFixed(2)}x`}
            subtext="Commitment basis"
            accent="#2D6B4F"
          />
          <MetricCard
            label="Net TVPI"
            value={`${model.totals.netMultiple.toFixed(2)}x`}
            subtext="After fees, expenses, and carry"
            accent="#1B2A4A"
          />
          <MetricCard
            label="Net IRR"
            value={formatPercent(model.totals.netIRR)}
            subtext="Quarterly cash-flow based"
            accent="#C9A84C"
          />
        </div>

        <div className="assumptions-table-container schedule-table-container">
          <table className="assumptions-table schedule-table">
            <thead>
              <tr>
                <th>Q</th>
                <th>Yr</th>
                <th>Drawdown</th>
                <th>Capital Call</th>
                <th>Fee Basis</th>
                <th>Mgmt Fee</th>
                <th>Expense</th>
                <th>Gross Dist</th>
                <th>Carry</th>
                <th>Net Dist</th>
                <th>NAV</th>
                <th>Net CF</th>
                <th>Cum Net CF</th>
              </tr>
            </thead>
            <tbody>
              {model.schedule.map((q) => (
                <tr key={q.quarter} className={q.isInvestmentPeriod ? '' : 'post-investment'}>
                  <td>{q.quarter}</td>
                  <td>{q.year.toFixed(2)}</td>
                  <td>{formatPercent(q.drawdownPct, 1)}</td>
                  <td>{formatCurrency(q.capitalCall, 0)}</td>
                  <td>{formatCurrency(q.feeBasis, 0)}</td>
                  <td>{formatCurrency(q.mgmtFee, 1)}</td>
                  <td>{formatCurrency(q.expense, 1)}</td>
                  <td>{formatCurrency(q.grossDistribution, 0)}</td>
                  <td>{formatCurrency(q.carry, 1)}</td>
                  <td>{formatCurrency(q.netDistribution, 0)}</td>
                  <td>{formatCurrency(q.nav, 0)}</td>
                  <td>{formatCurrency(q.netCF, 0)}</td>
                  <td>{formatCurrency(q.cumulativeNetCF, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};

const FeeTradeoffSection = ({ globalGrossMultiple, onGrossMultipleChange } = {}) => {
  const DEFAULT_FUND_LIFE = BASELINE_MODEL_INPUTS.fundLife;
  const CURVE_STEP = 0.05;
  const [localGrossMultiple, setLocalGrossMultiple] = useState(BASELINE_GROSS_TVPI);
  const grossMultiple = globalGrossMultiple ?? localGrossMultiple;
  const setGrossMultiple = onGrossMultipleChange ?? setLocalGrossMultiple;
  const [fundLife, setFundLife] = useState(DEFAULT_FUND_LIFE);
  const resetFeeTradeoff = () => {
    setGrossMultiple(BASELINE_GROSS_TVPI);
    setFundLife(DEFAULT_FUND_LIFE);
  };

  const calcNetOutcome = (grossMOIC, mgmtFee, carryRate) => {
    const model = buildQuarterlySchedule({
      fundSizeM: BASELINE_MODEL_INPUTS.fundSize * 1e6,
      fundLife,
      investmentPeriod: Math.min(BASELINE_MODEL_INPUTS.investmentPeriod, Math.max(1, fundLife - 1)),
      grossMultiple: grossMOIC,
      mgmtFeeRate: mgmtFee,
      expenseRate: BASELINE_MODEL_INPUTS.expenseRate,
      carryRate,
      hurdleRate: BASELINE_MODEL_INPUTS.hurdleRate,
      deploymentRate: 1,
      carryTrueUpTiming: 'frontLoadedCatchUp'
    });
    const netIRR = Number.isFinite(model.totals.netIRR)
      ? model.totals.netIRR
      : (model.totals.netMultiple > 0 ? Math.pow(model.totals.netMultiple, 1 / fundLife) - 1 : -1);

    return {
      mgmtFees: model.totals.totalMgmtFees,
      carry: model.totals.carry,
      netValue: model.totals.netValue,
      netMultiple: model.totals.netMultiple,
      netIRR
    };
  };

  // Compare 2/20 vs 1/30
  const structures = useMemo(() => {
    return {
      twoTwenty: { ...calcNetOutcome(grossMultiple, 0.02, 0.20), label: '2% / 20%', color: '#1B2A4A' },
      oneThirty: { ...calcNetOutcome(grossMultiple, 0.01, 0.30), label: '1% / 30%', color: '#B5473A' }
    };
  }, [grossMultiple, fundLife]);

  const curveData = useMemo(() => {
    const labels = [];
    const twoTwentyTVPI = [];
    const oneThirtyTVPI = [];
    const twoTwentyIRR = [];
    const oneThirtyIRR = [];
    for (let m = 1.0; m <= 3.5001; m += CURVE_STEP) {
      const gross = Number(m.toFixed(2));
      const twoTwenty = calcNetOutcome(gross, 0.02, 0.20);
      const oneThirty = calcNetOutcome(gross, 0.01, 0.30);
      labels.push(`${gross.toFixed(2)}x`);
      twoTwentyTVPI.push(twoTwenty.netMultiple);
      oneThirtyTVPI.push(oneThirty.netMultiple);
      twoTwentyIRR.push(twoTwenty.netIRR * 100);
      oneThirtyIRR.push(oneThirty.netIRR * 100);
    }
    return { labels, twoTwentyTVPI, oneThirtyTVPI, twoTwentyIRR, oneThirtyIRR };
  }, [fundLife]);

  const findCrossover = (seriesA, seriesB, eps) => {
    const points = curveData.labels
      .map((label, i) => ({
        multiple: parseFloat(label),
        diff: seriesA[i] - seriesB[i]
      }))
      .filter((p) => Number.isFinite(p.multiple) && Number.isFinite(p.diff));

    if (points.length < 2) {
      return { hasCrossover: false, multiple: 2.5 };
    }

    const upwardCandidates = [];
    for (let i = 1; i < points.length; i++) {
      const left = points[i - 1];
      const right = points[i];
      const leftDiff = left.diff;
      const rightDiff = right.diff;

      if (Math.abs(leftDiff) <= eps) {
        const tailDiffs = points.slice(i - 1).map((p) => p.diff);
        const tailMin = Math.min(...tailDiffs);
        upwardCandidates.push({
          multiple: left.multiple,
          sustained: tailMin >= -eps
        });
        continue;
      }

      const isUpwardCross = leftDiff < -eps && rightDiff > eps;
      if (!isUpwardCross) continue;

      const denom = rightDiff - leftDiff;
      const t = Math.abs(denom) < 1e-9 ? 0 : (0 - leftDiff) / denom;
      const clampedT = Math.max(0, Math.min(1, t));
      const x = left.multiple + (right.multiple - left.multiple) * clampedT;
      const tailDiffs = points.slice(i).map((p) => p.diff);
      const tailMin = Math.min(...tailDiffs);
      upwardCandidates.push({
        multiple: x,
        sustained: tailMin >= -eps
      });
    }

    if (upwardCandidates.length === 0) {
      const nearest = points.reduce(
        (best, p) => (Math.abs(p.diff) < best.absDiff ? { multiple: p.multiple, absDiff: Math.abs(p.diff) } : best),
        { multiple: points[0].multiple, absDiff: Math.abs(points[0].diff) }
      );
      return { hasCrossover: false, multiple: nearest.multiple };
    }

    const sustained = upwardCandidates.find((c) => c.sustained);
    const selected = sustained ? sustained.multiple : upwardCandidates[0].multiple;

    return { hasCrossover: true, multiple: selected };
  };

  const tvpiCrossoverResult = useMemo(
    () => findCrossover(curveData.twoTwentyTVPI, curveData.oneThirtyTVPI, 0.001),
    [curveData]
  );
  const irrCrossoverResult = useMemo(
    () => findCrossover(curveData.twoTwentyIRR, curveData.oneThirtyIRR, 0.01),
    [curveData]
  );

  const tvpiCrossoverMultiple = tvpiCrossoverResult.multiple;
  const tvpiCrossoverIndex = useMemo(() => {
    const rawIndex = Math.round((tvpiCrossoverMultiple - 1.0) / CURVE_STEP);
    return Math.max(0, Math.min(curveData.labels.length - 1, rawIndex));
  }, [tvpiCrossoverMultiple, curveData.labels.length]);

  const irrOutcomes = Object.values(structures).map((s) => s.netIRR);
  const bestNetIRR = Math.max(...irrOutcomes);
  const worstNetIRR = Math.min(...irrOutcomes);
  const irrSpreadBps = (bestNetIRR - worstNetIRR) * 10000;
  const tvpiOutcomes = Object.values(structures).map((s) => s.netMultiple);
  const bestNetTVPI = Math.max(...tvpiOutcomes);
  const worstNetTVPI = Math.min(...tvpiOutcomes);
  const tvpiSpread = bestNetTVPI - worstNetTVPI;
  const currentTvpiSpread = structures.twoTwenty.netMultiple - structures.oneThirty.netMultiple;
  const currentIrrSpreadBps = (structures.twoTwenty.netIRR - structures.oneThirty.netIRR) * 10000;
  const betterTvpiStructure = currentTvpiSpread >= 0 ? '2% / 20%' : '1% / 30%';
  const betterIrrStructure = currentIrrSpreadBps >= 0 ? '2% / 20%' : '1% / 30%';

  return (
    <section id="fee-carry-tradeoff" className="content-section compact-controls fee-tradeoff-section">
      <h2>The Fee/Carry Tradeoff</h2>

      <p>
        Some funds offer alternative fee structures that trade lower management fees for
        higher carried interest—or vice versa. Understanding when each structure is
        advantageous requires thinking through the math.
      </p>

      <p>
        Consider two options: the traditional <strong>2% management fee / 20% carry</strong>,
        versus a "performance-oriented" <strong>1% management fee / 30% carry</strong>.
        Which is better for LPs?
      </p>

      <div className="interactive-block">
        <div className="block-header">
          <span className="block-title">Fee Structure Comparison</span>
          <span className="block-subtitle">Finding the crossover point</span>
        </div>
        <div className="block-actions">
          <ResetButton onClick={resetFeeTradeoff} />
        </div>

        <div className="sliders-grid">
          <Slider
            value={grossMultiple}
            onChange={setGrossMultiple}
            min={1.0}
            max={3.5}
            step={0.05}
            label="Gross Multiple"
            format={(v) => `${v.toFixed(2)}x`}
          />

          <Slider
            value={fundLife}
            onChange={setFundLife}
            min={8}
            max={14}
            step={1}
            label="Fund Life"
            format={(v) => `${v} years`}
          />
        </div>

        <div className="structure-comparison">
          {Object.entries(structures).map(([key, data]) => (
            <div key={key} className="structure-card" style={{ borderColor: data.color }}>
              <div className="structure-label" style={{ color: data.color }}>{data.label}</div>
              <div className="structure-net structure-tvpi">{data.netMultiple.toFixed(2)}x net TVPI</div>
              <div className="structure-secondary">{formatPercent(data.netIRR, 1)} net IRR</div>
              <div className="structure-breakdown">
                <span>Mgmt: {formatCurrency(data.mgmtFees, 0)}</span>
                <span>Carry: {formatCurrency(data.carry, 0)}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="tradeoff-curve">
          <div className="tradeoff-curve-head">
            <div>
              <div className="tradeoff-curve-kicker">Net TVPI Comparison</div>
              <div className="tradeoff-curve-title">Where The Two Fee Structures Cross</div>
              <div className="tradeoff-curve-subtitle">X-axis shows gross fund return before fees and carry.</div>
            </div>
            <div className="tvpi-crossover-pill">
              {tvpiCrossoverResult.hasCrossover ? (
                <>
                  <div className="tvpi-crossover-pill-label">TVPI crossover</div>
                  <div className="tvpi-crossover-pill-value">{tvpiCrossoverMultiple.toFixed(2)}x gross MOIC</div>
                </>
              ) : (
                <>
                  <div className="tvpi-crossover-pill-label">TVPI crossover</div>
                  <div className="tvpi-crossover-pill-value">No crossover in range</div>
                </>
              )}
            </div>
          </div>
          <ComparisonChart
            seriesA={curveData.twoTwentyTVPI}
            seriesB={curveData.oneThirtyTVPI}
            labelA="2% / 20%"
            labelB="1% / 30%"
            xLabels={curveData.labels}
            xTickStep={10}
            yFormatter={(v) => `${v.toFixed(2)}x`}
            colorA="#1B2A4A"
            colorB="#B5473A"
            height={220}
            xAxisLabel="Gross Fund Return Before Fees And Carry (MOIC)"
            marker={tvpiCrossoverResult.hasCrossover ? {
              index: tvpiCrossoverIndex,
              label: `TVPI Cross ${tvpiCrossoverMultiple.toFixed(2)}x`,
              color: '#C9A84C'
            } : null}
          />
          <p className="tradeoff-curve-note">
            At the crossover point, both structures land on roughly the same net TVPI. To the left, lower fees tend to help more.
            To the right, higher carry can give back that advantage.
          </p>
        </div>

        <p className="assumption-note">
          Model note: carry catch-up is allocated across carry-paying periods once LP capital and
          pref are cleared, rather than as a single terminal-only carry lump.
        </p>

        <div className="net-impact-panel">
          <div className="net-impact-title">Current View And Crossover Snapshot</div>
          <div className="metrics-row">
            <MetricCard
              label="TVPI Spread (Current Gross)"
              value={`${Math.abs(currentTvpiSpread).toFixed(2)}x`}
              subtext={`${betterTvpiStructure} currently ahead on TVPI`}
              accent="#1B2A4A"
            />
            <MetricCard
              label="IRR Spread (Current Gross)"
              value={`${Math.abs(currentIrrSpreadBps).toFixed(0)} bps`}
              subtext={`${betterIrrStructure} currently ahead on IRR`}
              accent="#B5473A"
            />
            <MetricCard
              label="IRR Crossover (Secondary)"
              value={irrCrossoverResult.hasCrossover ? `${irrCrossoverResult.multiple.toFixed(2)}x` : 'N/A'}
              subtext="Shown for context; TVPI crossover is primary"
              accent="#9A9690"
            />
            <MetricCard
              label="TVPI Range At Current Gross"
              value={`${worstNetTVPI.toFixed(2)}x-${bestNetTVPI.toFixed(2)}x`}
              subtext="Across 2/20 and 1/30 terms"
              accent="#2D6B4F"
            />
          </div>
        </div>
      </div>

      <h3>The Intuition</h3>

      <p>
        Management fees are paid on committed capital regardless of performance. They're a
        <strong> fixed cost</strong>. Carried interest is paid only on profits above the
        hurdle. It's a <strong>variable cost</strong>.
      </p>

      <p>
        At low returns, the fixed cost dominates. A fund returning 1.5x gross hasn't generated
        much profit to share—so the lower management fee structure wins. At high returns, the
        variable cost dominates. A fund returning 3x has massive profits—and you'd rather give
        up 20% than 30% of them.
      </p>

      <div className="callout callout-insight">
        <div className="callout-icon">🎯</div>
        <div className="callout-content">
          {tvpiCrossoverResult.hasCrossover ? (
            <>
              TVPI crossover is around <strong>{tvpiCrossoverMultiple.toFixed(2)}x gross</strong>.
              Below that point, lower fees tend to dominate; above it, lower carry tends to dominate.
              {irrCrossoverResult.hasCrossover && (
                <> IRR crossover in this run is around <strong>{irrCrossoverResult.multiple.toFixed(2)}x gross</strong>.</>
              )}
            </>
          ) : (
            <>
              No TVPI crossover appears in the displayed range (1.0x to 3.5x gross).
              In this range, one structure stays ahead on net multiple.
            </>
          )}
        </div>
      </div>
    </section>
  );
};

const AccruedCarrySection = () => {
  const DEFAULT_YEARLY_RETURNS = [0.15, 0.20, -0.10, 0.25, 0.15];
  const [yearlyReturns, setYearlyReturns] = useState(DEFAULT_YEARLY_RETURNS);
  const resetAccruedCarry = () => setYearlyReturns([...DEFAULT_YEARLY_RETURNS]);

  const updateReturn = (index, value) => {
    const newReturns = [...yearlyReturns];
    newReturns[index] = value;
    setYearlyReturns(newReturns);
  };

  const carryData = useMemo(() => {
    let nav = 100;
    let lpContributed = 100;
    const data = [{ year: 0, nav: 100, accruedCarry: 0, lpValue: 100 }];

    yearlyReturns.forEach((ret, i) => {
      nav = nav * (1 + ret);
      const profit = Math.max(0, nav - lpContributed);
      const accruedCarry = profit * 0.20;
      const lpValue = nav - accruedCarry;

      data.push({
        year: i + 1,
        nav,
        return: ret,
        accruedCarry,
        lpValue
      });
    });

    return data;
  }, [yearlyReturns]);

  const finalData = carryData[carryData.length - 1];
  const lpNetMultiple = finalData.lpValue / 100;
  const navMultiple = finalData.nav / 100;
  const carryDragMultiple = Math.max(0, navMultiple - lpNetMultiple);

  return (
    <section id="accrued-carry" className="content-section">
      <h2>Accrued Carry and Down Years</h2>

      <p>
        Here's a counterintuitive truth: <strong>a down year in a fund hurts the GP more
        than the LP</strong>—at least in terms of carried interest economics.
      </p>

      <p>
        Carry is calculated on profits above a baseline. When a fund's NAV declines, the
        <strong> accrued carry</strong> (the carry the GP would receive if the fund liquidated
        today) declines faster than the LP's share of value. The GP's upside is leveraged to
        performance in both directions.
      </p>

      <div className="interactive-block">
        <div className="block-header">
          <span className="block-title">The Asymmetry of Accrued Carry</span>
          <span className="block-subtitle">Adjust annual returns to see the effect</span>
        </div>
        <div className="block-actions">
          <ResetButton onClick={resetAccruedCarry} />
        </div>

        <div className="returns-grid">
          {yearlyReturns.map((ret, i) => (
            <div key={i} className="return-input">
              <label>Year {i + 1}</label>
              <Slider
                value={ret}
                onChange={(v) => updateReturn(i, v)}
                min={-0.30}
                max={0.40}
                step={0.05}
                label=""
                format={(v) => `${(v * 100).toFixed(0)}%`}
                accent={ret >= 0 ? '#1B2A4A' : '#B5473A'}
              />
            </div>
          ))}
        </div>

        <ComparisonChart
          seriesA={carryData.map(d => d.lpValue)}
          seriesB={carryData.map(d => d.accruedCarry)}
          labelA="LP Value"
          labelB="Accrued Carry"
          height={220}
          colorA="#1B2A4A"
          colorB="#B5473A"
        />

        <div className="metrics-row">
          <MetricCard
            label="Final NAV"
            value={formatCurrency(finalData.nav * 1e6, 0)}
          />
          <MetricCard
            label="LP Net Multiple"
            value={`${lpNetMultiple.toFixed(2)}x`}
            subtext="Value after accrued carry"
            accent="#1B2A4A"
          />
          <MetricCard
            label="Accrued Carry"
            value={formatCurrency(finalData.accruedCarry * 1e6, 0)}
            accent="#B5473A"
          />
        </div>

        <div className="net-impact-panel">
          <div className="net-impact-title">Net Investor Impact</div>
          <div className="metrics-row">
            <MetricCard
              label="Gross NAV Multiple"
              value={`${navMultiple.toFixed(2)}x`}
              subtext="Before carry accrual"
              accent="#2D6B4F"
            />
            <MetricCard
              label="Net LP Multiple"
              value={`${lpNetMultiple.toFixed(2)}x`}
              subtext="After carry accrual"
              accent="#1B2A4A"
            />
            <MetricCard
              label="Carry Drag"
              value={`${carryDragMultiple.toFixed(2)}x`}
              subtext="Current gross-to-net gap"
              accent="#B5473A"
            />
          </div>
        </div>
      </div>

      <p>
        Try setting Year 3 to a significant loss (say, -25%). Watch how the accrued carry
        drops dramatically—potentially to zero if NAV falls below contributed capital. The
        GP's potential payout is highly sensitive to these swings; the LP's value, while
        still affected, retains the full NAV minus carry.
      </p>

      <div className="callout">
        <div className="callout-icon">📉</div>
        <div className="callout-content">
          This asymmetry is a feature, not a bug. It means GPs have strong incentives to
          protect against downside, not just swing for the fences. Their compensation is
          convex to performance—they share in the upside but bear concentrated pain on
          the downside (at least in terms of forgone carry).
        </div>
      </div>
    </section>
  );
};

const ConclusionSection = () => (
  <section id="conclusion" className="content-section conclusion">
    <h2>The Complete Picture</h2>

    <p>
      Private equity fees are not hidden—they're disclosed in hundreds of pages of fund
      documents. But between disclosure and understanding lies a gap that separates
      sophisticated LPs from those who simply accept terms at face value.
    </p>

    <p>
      The journey from gross to net involves management fees that accumulate steadily,
      carried interest that rewards performance, waterfalls that determine who gets paid
      when, and structural choices that can meaningfully shift economics between GPs and LPs.
    </p>

    <p>
      None of this makes PE a bad investment. The asset class continues to outperform
      over long horizons, and the alignment created by carry—where GPs only get rich when
      LPs get richer—remains powerful. But understanding these mechanics makes you a
      better negotiator, a better evaluator, and ultimately a better investor.
    </p>

    <WhatWeDidntCover
      items={[
        'Accrued carry through interim valuation periods, including how down years can compress GP carry accrual before fund termination.',
        'Recycling mechanics and how recycled capital can change fee load and measured net outcomes.',
        'Term-level interactions like variable carry tiers, offset formulas, and expense sharing that can shift gross-to-net economics over time.',
        'Strategies to reduce management fees and carried interest, such as secondaries and direct equity investments.'
      ]}
    />
    <PathwayInlineCta line="Want an expert review of your current PE terms and net-outcome assumptions?" />

    <div className="pathway-footer">
      <div className="pathway-logo">Pathway Capital</div>
      <p>Institutional Private Equity Investment</p>
    </div>

    <div className="sources-footer">
      <div className="sources-title">Sources</div>
      <ol className="sources-list">
        <li id="source-1">
          Harris, Jenkinson, Kaplan, and Stucke (2014), "Has Private Equity Outperformed Public
          Equities?" NBER Working Paper 17874.{' '}
          <a href="https://www.nber.org/papers/w17874" target="_blank" rel="noreferrer">
            Read paper
          </a>
        </li>
      </ol>
    </div>
  </section>
);

const LiquidityHeroSection = () => (
  <section id="liquidity-hero" className="hero-section liquidity-hero">
    <div className="draft-hero-banner">DRAFT - NOT FINAL</div>
    <div className="pathway-badge">Pathway Capital Education</div>
    <h1>Liquidity Management in Private Markets</h1>
    <p className="hero-subtitle">Two liquidity engines drive outcomes: normal-course exits and secondary market execution.</p>
    <p className="hero-purpose-note">
      This page is the new liquidity module scaffold. It separates operating cash return
      dynamics from secondary sale decisions so teams can discuss both with the same vocabulary.
    </p>
    <div className="hero-scroll-note">Scroll to compare cash timing vs value trade-offs</div>
  </section>
);

const LiquidityNormalCourseSection = ({ globalGrossMultiple, onGrossMultipleChange }) => {
  const DEFAULT_REALIZATION_PACE = 1.0;
  const [realizationPace, setRealizationPace] = useState(DEFAULT_REALIZATION_PACE);
  const grossMultiple = globalGrossMultiple ?? BASELINE_GROSS_TVPI;
  const commitment = BASELINE_MODEL_INPUTS.fundSize * 1e6;
  const fundLife = BASELINE_MODEL_INPUTS.fundLife;
  const yearLabels = Array.from({ length: fundLife + 1 }, (_, i) => `Yr ${i}`);

  const model = useMemo(() => {
    return buildQuarterlySchedule({
      fundSizeM: commitment,
      fundLife: BASELINE_MODEL_INPUTS.fundLife,
      investmentPeriod: BASELINE_MODEL_INPUTS.investmentPeriod,
      grossMultiple,
      mgmtFeeRate: BASELINE_MODEL_INPUTS.mgmtFeeRate,
      expenseRate: BASELINE_MODEL_INPUTS.expenseRate,
      carryRate: BASELINE_MODEL_INPUTS.carryRate,
      hurdleRate: BASELINE_MODEL_INPUTS.hurdleRate,
      deploymentRate: 1
    });
  }, [grossMultiple, commitment]);

  const curveData = useMemo(() => {
    const finalNetDist = model.schedule[model.schedule.length - 1]?.cumulativeNetDist || 0;
    const startYear = 3;
    const cumulativeFromPace = (year, pace) => {
      if (year <= startYear) return 0;
      const t = Math.max(0, Math.min(1, (year - startYear) / Math.max(1, fundLife - startYear)));
      return finalNetDist * Math.pow(t, 1 / pace);
    };

    const baseSeries = yearLabels.map((_, year) => cumulativeFromPace(year, 1.0) / commitment);
    const selectedSeries = yearLabels.map((_, year) => cumulativeFromPace(year, realizationPace) / commitment);

    const year8 = Math.min(8, fundLife);
    const dpiByYear8 = selectedSeries[year8] || 0;
    const cashByYear8 = dpiByYear8 * commitment;

    return { baseSeries, selectedSeries, dpiByYear8, cashByYear8 };
  }, [model.schedule, commitment, fundLife, yearLabels, realizationPace]);

  const resetSection = () => {
    setRealizationPace(DEFAULT_REALIZATION_PACE);
    if (onGrossMultipleChange) onGrossMultipleChange(BASELINE_GROSS_TVPI);
  };

  return (
    <section id="liquidity-normal-course" className="content-section">
      <h2>Normal-Course Liquidity (Exits Over Time)</h2>
      <p>
        The first liquidity engine is ordinary exits. Companies are sold, recapitalized,
        or listed over time, and cash flows back through DPI. Faster realization usually
        improves liquidity timing, but it can pressure price if exits are rushed.
      </p>

      <div className="interactive-block">
        <div className="block-actions">
          <ResetButton onClick={resetSection} />
        </div>
        <div className="sliders-grid two-up">
          <Slider
            label="Gross MOIC Assumption"
            value={grossMultiple}
            min={1.0}
            max={3.5}
            step={0.05}
            format={(v) => `${v.toFixed(2)}x`}
            onChange={onGrossMultipleChange || (() => {})}
            accent="#1B2A4A"
          />
          <Slider
            label="Realization Pace"
            value={realizationPace}
            min={0.7}
            max={1.3}
            step={0.01}
            format={(v) => `${v.toFixed(2)}x`}
            onChange={setRealizationPace}
            accent="#2D6B4F"
          />
        </div>

        <div className="metrics-row">
          <MetricCard
            label="Modeled Net TVPI"
            value={`${model.totals.netMultiple.toFixed(2)}x`}
            subtext="Economics held constant"
            accent="#1B2A4A"
          />
          <MetricCard
            label="Selected DPI by Year 8"
            value={`${curveData.dpiByYear8.toFixed(2)}x`}
            subtext="Timing view only"
            accent="#2D6B4F"
          />
          <MetricCard
            label="Cash Returned by Year 8"
            value={formatCurrency(curveData.cashByYear8, 0)}
            subtext={`On ${formatCurrency(commitment, 0)} commitment`}
            accent="#2D6B4F"
          />
        </div>

        <h3 className="chart-title">Cumulative DPI Timing Curve</h3>
        <ComparisonChart
          seriesA={curveData.baseSeries}
          seriesB={curveData.selectedSeries}
          labelA="Base realization pace"
          labelB="Selected realization pace"
          xLabels={yearLabels}
          xTickStep={2}
          yFormatter={(v) => `${v.toFixed(2)}x`}
          colorA="#1B2A4A"
          colorB="#2D6B4F"
          height={250}
        />
      </div>
    </section>
  );
};

const LiquiditySecondariesSection = ({ globalGrossMultiple }) => {
  const [saleYear, setSaleYear] = useState(6);
  const [saleShare, setSaleShare] = useState(0.25);
  const [secondaryDiscount, setSecondaryDiscount] = useState(0.12);
  const grossMultiple = globalGrossMultiple ?? BASELINE_GROSS_TVPI;
  const commitment = BASELINE_MODEL_INPUTS.fundSize * 1e6;
  const fundLife = BASELINE_MODEL_INPUTS.fundLife;
  const yearLabels = Array.from({ length: fundLife + 1 }, (_, i) => `Yr ${i}`);

  const model = useMemo(() => {
    return buildQuarterlySchedule({
      fundSizeM: commitment,
      fundLife: BASELINE_MODEL_INPUTS.fundLife,
      investmentPeriod: BASELINE_MODEL_INPUTS.investmentPeriod,
      grossMultiple,
      mgmtFeeRate: BASELINE_MODEL_INPUTS.mgmtFeeRate,
      expenseRate: BASELINE_MODEL_INPUTS.expenseRate,
      carryRate: BASELINE_MODEL_INPUTS.carryRate,
      hurdleRate: BASELINE_MODEL_INPUTS.hurdleRate,
      deploymentRate: 1
    });
  }, [grossMultiple, commitment]);

  const secondaryData = useMemo(() => {
    const annualCumulative = new Array(fundLife + 1).fill(0);
    model.schedule.forEach((row) => {
      annualCumulative[row.year] = Math.max(annualCumulative[row.year], row.cumulativeNetDist);
    });
    for (let y = 1; y <= fundLife; y++) {
      annualCumulative[y] = Math.max(annualCumulative[y], annualCumulative[y - 1]);
    }

    const boundedSaleYear = Math.min(fundLife - 1, Math.max(3, saleYear));
    const distAtSale = annualCumulative[boundedSaleYear] || 0;
    const finalNatural = annualCumulative[fundLife] || 0;
    const remainingAtSale = Math.max(0, finalNatural - distAtSale);
    const soldAmount = remainingAtSale * saleShare;
    const secondaryProceeds = soldAmount * (1 - secondaryDiscount);

    const adjustedCumulative = annualCumulative.map((value, year) => {
      if (year < boundedSaleYear) return value;
      if (year === boundedSaleYear) return value + secondaryProceeds;
      const postSaleNatural = Math.max(0, value - distAtSale);
      return distAtSale + secondaryProceeds + postSaleNatural * (1 - saleShare);
    });

    const naturalSeries = annualCumulative.map((value) => value / commitment);
    const adjustedSeries = adjustedCumulative.map((value) => value / commitment);
    const tvpiCost = (annualCumulative[fundLife] - adjustedCumulative[fundLife]) / commitment;
    const liquidityPulledForward = secondaryProceeds;

    return {
      naturalSeries,
      adjustedSeries,
      boundedSaleYear,
      tvpiCost,
      liquidityPulledForward
    };
  }, [commitment, fundLife, model.schedule, saleYear, saleShare, secondaryDiscount]);

  const resetSection = () => {
    setSaleYear(6);
    setSaleShare(0.25);
    setSecondaryDiscount(0.12);
  };

  return (
    <section id="liquidity-secondaries" className="content-section">
      <h2>Secondary Liquidity (Portfolio Sales)</h2>
      <p>
        The second liquidity engine is market-based: selling fund interests. This can
        accelerate distributions to LPs, but it usually comes with a price concession.
        The trade-off is timing versus terminal value.
      </p>

      <div className="interactive-block">
        <div className="block-actions">
          <ResetButton onClick={resetSection} />
        </div>
        <div className="sliders-grid three-up">
          <Slider
            label="Secondary Sale Year"
            value={saleYear}
            min={3}
            max={10}
            step={1}
            format={(v) => `Yr ${Math.round(v)}`}
            onChange={(v) => setSaleYear(Math.round(v))}
            accent="#1B2A4A"
          />
          <Slider
            label="Percent of Remaining NAV Sold"
            value={saleShare}
            min={0.1}
            max={0.6}
            step={0.01}
            format={(v) => formatPercent(v, 0)}
            onChange={setSaleShare}
            accent="#B5473A"
          />
          <Slider
            label="Secondary Discount"
            value={secondaryDiscount}
            min={0.03}
            max={0.3}
            step={0.005}
            format={(v) => formatPercent(v, 1)}
            onChange={setSecondaryDiscount}
            accent="#C9A84C"
          />
        </div>

        <div className="metrics-row">
          <MetricCard
            label="Liquidity Pulled Forward"
            value={formatCurrency(secondaryData.liquidityPulledForward, 0)}
            subtext={`Immediate cash in year ${secondaryData.boundedSaleYear}`}
            accent="#2D6B4F"
          />
          <MetricCard
            label="Final TVPI Impact"
            value={`${secondaryData.tvpiCost.toFixed(2)}x`}
            subtext="Discount cost to terminal value"
            accent="#B5473A"
          />
          <MetricCard
            label="Scenario Lens"
            value={secondaryData.tvpiCost > 0 ? 'Timing > Value' : 'Value > Timing'}
            subtext="Use when liquidity need is explicit"
            accent="#1B2A4A"
          />
        </div>

        <h3 className="chart-title">Natural DPI vs Secondary-Assisted DPI</h3>
        <ComparisonChart
          seriesA={secondaryData.naturalSeries}
          seriesB={secondaryData.adjustedSeries}
          labelA="Natural pace"
          labelB="With secondary sale"
          xLabels={yearLabels}
          xTickStep={2}
          yFormatter={(v) => `${v.toFixed(2)}x`}
          marker={{
            index: secondaryData.boundedSaleYear,
            label: `Sale Yr ${secondaryData.boundedSaleYear}`,
            color: '#C9A84C'
          }}
          colorA="#1B2A4A"
          colorB="#B5473A"
          height={250}
        />
      </div>
    </section>
  );
};

const LiquidityToolkitSection = () => (
  <section id="liquidity-toolkit" className="content-section">
    <h2>Liquidity Toolkit for LPs</h2>
    <p>
      In practice, most programs blend both engines: they underwrite normal-course exits
      and keep secondaries as an active portfolio management tool for pacing, concentration,
      and denominator management.
    </p>

    <div className="liquidity-callout-grid">
      <div className="liquidity-callout">
        <h3>Normal-Course Focus</h3>
        <p>Manager selection, portfolio construction, and vintage diversification improve predictable distributions.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Secondary Focus</h3>
        <p>Use secondaries when liquidity is needed, exposures are concentrated, or strategic rebalancing is required.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Program-Level View</h3>
        <p>Model liquidity as a system-level decision: cash timing, pricing, and reinvestment capacity should be optimized together.</p>
      </div>
    </div>
    <PathwayInlineCta line="Want to review liquidity options with a specialized private markets team?" />
  </section>
);

const LiquidityToBeBuiltSection = () => (
  <section id="liquidity-to-be-built" className="content-section">
    <h2>To Be Built</h2>
    <p>
      Next modules for this liquidity guide are scoped below. This keeps the roadmap visible while
      we ship section-by-section with real Pathway data and practical LP use cases.
    </p>

    <div className="liquidity-callout-grid">
      <div className="liquidity-callout">
        <h3>Cash Forecasting Engine</h3>
        <p>
          Interactive pacing model for calls and distributions, with downside scenarios and
          denominator-shock overlays.
        </p>
      </div>
      <div className="liquidity-callout">
        <h3>Secondary Pricing Lens</h3>
        <p>
          NAV discount/premium analyzer by vintage, strategy, and quality bucket to quantify
          the cost of immediate liquidity.
        </p>
      </div>
      <div className="liquidity-callout">
        <h3>Portfolio Rebalancing Playbook</h3>
        <p>
          Decision framework for when to pace new commitments, sell secondaries, or lean into
          co-investments during stressed markets.
        </p>
      </div>
    </div>
  </section>
);

const EnvironmentHeroSection = () => (
  <section id="environment-hero" className="hero-section environment-hero">
    <div className="draft-hero-banner">DRAFT - NOT FINAL</div>
    <div className="pathway-badge">Pathway Research</div>
    <h1>Private Market Environment</h1>
    <p className="hero-subtitle">Fourth Quarter 2025</p>
    <p className="hero-purpose-note">
      This interactive edition preserves the source report and adds a navigator for faster review,
      thematic filtering, and chart-by-chart conversion planning.
    </p>
    <div className="hero-scroll-note">Explore the PDF and jump directly to sections below</div>
  </section>
);

const EnvironmentExplorerSection = () => {
  const chapters = [
    { id: 'all', label: 'Full Report', start: 1, end: ENVIRONMENT_REPORT_PAGE_COUNT },
    { id: 'cover', label: 'Cover + Intro', start: 1, end: 3 },
    { id: 'market', label: 'Market Backdrop', start: 4, end: 14 },
    { id: 'performance', label: 'Performance + Valuation', start: 15, end: 28 },
    { id: 'liquidity', label: 'Liquidity + Exits', start: 29, end: 40 },
    { id: 'appendix', label: 'Appendix', start: 41, end: ENVIRONMENT_REPORT_PAGE_COUNT }
  ];

  const [chapterId, setChapterId] = useState('all');
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(110);
  const activeChapter = chapters.find((chapter) => chapter.id === chapterId) || chapters[0];
  const pdfBaseUrl = `${import.meta.env.BASE_URL || '/'}${ENVIRONMENT_REPORT_FILE}`;
  const pdfUrl = `${pdfBaseUrl}#page=${page}&zoom=${zoom}`;

  useEffect(() => {
    if (page < activeChapter.start || page > activeChapter.end) {
      setPage(activeChapter.start);
    }
  }, [activeChapter, page]);

  return (
    <section id="environment-explorer" className="content-section">
      <h2>Interactive Report Explorer</h2>
      <p>
        Source PDF is embedded directly for fidelity. Use the controls to jump by chapter,
        scrub page-by-page, and zoom without losing context.
      </p>

      <div className="interactive-block environment-explorer-block">
        <div className="environment-toolbar">
          <div className="environment-toolbar-group">
            <span className="environment-toolbar-label">Chapter</span>
            <select
              className="environment-select"
              value={chapterId}
              onChange={(e) => setChapterId(e.target.value)}
            >
              {chapters.map((chapter) => (
                <option key={chapter.id} value={chapter.id}>
                  {chapter.label}
                </option>
              ))}
            </select>
          </div>

          <div className="environment-toolbar-group environment-toolbar-range">
            <span className="environment-toolbar-label">Page</span>
            <div className="environment-page-controls">
              <button
                type="button"
                className="environment-page-btn"
                onClick={() => setPage((prev) => Math.max(activeChapter.start, prev - 1))}
              >
                Prev
              </button>
              <input
                type="range"
                min={activeChapter.start}
                max={activeChapter.end}
                step={1}
                value={page}
                onChange={(e) => setPage(parseInt(e.target.value, 10))}
                className="environment-page-slider"
              />
              <button
                type="button"
                className="environment-page-btn"
                onClick={() => setPage((prev) => Math.min(activeChapter.end, prev + 1))}
              >
                Next
              </button>
            </div>
          </div>

          <div className="environment-toolbar-group">
            <span className="environment-toolbar-label">Zoom</span>
            <select
              className="environment-select"
              value={zoom}
              onChange={(e) => setZoom(parseInt(e.target.value, 10))}
            >
              {[90, 100, 110, 125, 150].map((z) => (
                <option key={z} value={z}>
                  {z}%
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="environment-page-meta">
          <div><strong>Viewing:</strong> Page {page} of {ENVIRONMENT_REPORT_PAGE_COUNT}</div>
          <div>
            <a className="environment-open-link" href={pdfBaseUrl} target="_blank" rel="noreferrer">
              Open full PDF in new tab
            </a>
          </div>
        </div>

        <div className="environment-frame-wrap">
          <iframe
            title="Pathway 4Q25 Private Market Environment Report"
            src={pdfUrl}
            className="environment-pdf-frame"
          />
        </div>
      </div>
    </section>
  );
};

const EnvironmentThemesSection = () => {
  const themes = [
    {
      id: 'macro',
      label: 'Macro Regime',
      pages: 'pp. 4-10',
      text: 'How rates, inflation, and policy volatility are framing private market entry and exit conditions.'
    },
    {
      id: 'valuations',
      label: 'Valuations',
      pages: 'pp. 11-19',
      text: 'Where valuation resets have already happened versus where multiples remain sticky by strategy.'
    },
    {
      id: 'liquidity',
      label: 'Liquidity',
      pages: 'pp. 20-33',
      text: 'Signals on realizations, distributions, and the pace of normalization in LP cash return cycles.'
    },
    {
      id: 'secondaries',
      label: 'Secondaries',
      pages: 'pp. 34-40',
      text: 'Secondary market depth, pricing dispersion, and how transaction activity is evolving.'
    },
    {
      id: 'positioning',
      label: 'LP Positioning',
      pages: 'pp. 41-48',
      text: 'Portfolio construction implications and where conviction can be highest given current market conditions.'
    }
  ];
  const [activeTheme, setActiveTheme] = useState(themes[0].id);
  const current = themes.find((theme) => theme.id === activeTheme) || themes[0];

  return (
    <section id="environment-themes" className="content-section">
      <h2>Theme Lens</h2>
      <p>
        The report is primarily data-driven. This lens helps users triage by topic first,
        then jump to relevant pages in the source report.
      </p>
      <div className="interactive-block">
        <div className="environment-theme-pills">
          {themes.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`environment-theme-pill ${theme.id === activeTheme ? 'active' : ''}`}
              onClick={() => setActiveTheme(theme.id)}
            >
              {theme.label}
            </button>
          ))}
        </div>
        <div className="environment-theme-detail">
          <div className="environment-theme-pages">{current.pages}</div>
          <p>{current.text}</p>
        </div>
      </div>
    </section>
  );
};

const EnvironmentDeltaLabSection = () => {
  const deltaDatasets = {
    '2q-to-3q': {
      label: '2Q25 to 3Q25',
      metrics: [
        { id: 'fundraising', name: 'Fundraising Activity', unit: 'idx', prev: 92, curr: 89, higherIsBetter: true, pages: 'pp. 6-8' },
        { id: 'dealflow', name: 'Deal Activity', unit: 'idx', prev: 95, curr: 101, higherIsBetter: true, pages: 'pp. 9-12' },
        { id: 'exitflow', name: 'Exit Activity', unit: 'idx', prev: 83, curr: 88, higherIsBetter: true, pages: 'pp. 27-31' },
        { id: 'secondarydisc', name: 'Secondary Discount', unit: 'bps', prev: 1320, curr: 1190, higherIsBetter: false, pages: 'pp. 34-37' },
        { id: 'distyield', name: 'Distribution Yield', unit: '%', prev: 5.8, curr: 6.1, higherIsBetter: true, pages: 'pp. 29-33' }
      ]
    },
    '3q-to-4q': {
      label: '3Q25 to 4Q25',
      metrics: [
        { id: 'fundraising', name: 'Fundraising Activity', unit: 'idx', prev: 89, curr: 93, higherIsBetter: true, pages: 'pp. 6-8' },
        { id: 'dealflow', name: 'Deal Activity', unit: 'idx', prev: 101, curr: 104, higherIsBetter: true, pages: 'pp. 9-12' },
        { id: 'exitflow', name: 'Exit Activity', unit: 'idx', prev: 88, curr: 96, higherIsBetter: true, pages: 'pp. 27-31' },
        { id: 'secondarydisc', name: 'Secondary Discount', unit: 'bps', prev: 1190, curr: 1090, higherIsBetter: false, pages: 'pp. 34-37' },
        { id: 'distyield', name: 'Distribution Yield', unit: '%', prev: 6.1, curr: 6.6, higherIsBetter: true, pages: 'pp. 29-33' }
      ]
    }
  };

  const [selectedPair, setSelectedPair] = useState('3q-to-4q');
  const [themeFilter, setThemeFilter] = useState('all');
  const selectedData = deltaDatasets[selectedPair];

  const filteredMetrics = useMemo(() => {
    if (themeFilter === 'all') return selectedData.metrics;
    const byTheme = {
      liquidity: ['exitflow', 'secondarydisc', 'distyield'],
      activity: ['fundraising', 'dealflow'],
      pricing: ['secondarydisc']
    };
    const ids = new Set(byTheme[themeFilter] || []);
    return selectedData.metrics.filter((metric) => ids.has(metric.id));
  }, [selectedData, themeFilter]);

  const maxAbsDelta = Math.max(
    1,
    ...filteredMetrics.map((metric) => Math.abs(metric.curr - metric.prev))
  );

  const formatMetricValue = (metric, value) => {
    if (metric.unit === '%') return `${value.toFixed(1)}%`;
    if (metric.unit === 'bps') return `${Math.round(value).toLocaleString()} bps`;
    return `${value.toFixed(0)} idx`;
  };

  return (
    <section id="environment-delta-lab" className="content-section">
      <h2>Quarter-on-Quarter Delta Lab</h2>
      <p>
        First live build from the roadmap: a delta workspace for comparing selected report metrics
        quarter-over-quarter. This is where trend callouts can be generated before writing commentary.
      </p>
      <div className="interactive-block">
        <div className="environment-toolbar">
          <div className="environment-toolbar-group">
            <span className="environment-toolbar-label">Quarter Pair</span>
            <select
              className="environment-select"
              value={selectedPair}
              onChange={(e) => setSelectedPair(e.target.value)}
            >
              {Object.entries(deltaDatasets).map(([key, dataset]) => (
                <option key={key} value={key}>{dataset.label}</option>
              ))}
            </select>
          </div>
          <div className="environment-toolbar-group">
            <span className="environment-toolbar-label">Theme Filter</span>
            <div className="environment-theme-pills compact">
              {[
                { value: 'all', label: 'All' },
                { value: 'liquidity', label: 'Liquidity' },
                { value: 'activity', label: 'Activity' },
                { value: 'pricing', label: 'Pricing' }
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`environment-theme-pill ${themeFilter === opt.value ? 'active' : ''}`}
                  onClick={() => setThemeFilter(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="environment-toolbar-group">
            <span className="environment-toolbar-label">Coverage</span>
            <div className="environment-kpi-inline">
              {filteredMetrics.length} metrics
            </div>
          </div>
        </div>

        <div className="environment-delta-grid">
          {filteredMetrics.map((metric) => {
            const delta = metric.curr - metric.prev;
            const goodDirection = metric.higherIsBetter ? delta >= 0 : delta <= 0;
            const magnitudePct = Math.max(6, (Math.abs(delta) / maxAbsDelta) * 100);
            return (
              <div key={metric.id} className="environment-delta-card">
                <div className="environment-delta-head">
                  <span>{metric.name}</span>
                  <span className="environment-delta-pages">{metric.pages}</span>
                </div>
                <div className="environment-delta-values">
                  <span>{formatMetricValue(metric, metric.prev)}</span>
                  <span className={`environment-delta-change ${goodDirection ? 'good' : 'bad'}`}>
                    {delta >= 0 ? '+' : ''}{formatMetricValue(metric, delta)}
                  </span>
                  <span>{formatMetricValue(metric, metric.curr)}</span>
                </div>
                <div className="environment-delta-bar-track">
                  <div
                    className={`environment-delta-bar ${goodDirection ? 'good' : 'bad'}`}
                    style={{ width: `${magnitudePct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <p className="bridge-note">
          Note: values here are structured placeholders for the interactive layer. They should be replaced
          with exact 4Q25 report datapoints during chart-by-chart conversion.
        </p>
      </div>
    </section>
  );
};

const EnvironmentConversionSection = () => {
  const items = [
    { id: 1, chart: 'Liquidity Pace Dashboard', pages: '29-33', status: 'built', theme: 'Liquidity', effort: 'M' },
    { id: 2, chart: 'Quarter Delta Lab', pages: 'Cross-report', status: 'built', theme: 'Cross-theme', effort: 'M' },
    { id: 3, chart: 'Exit Recovery Curve', pages: '27-31', status: 'next', theme: 'Liquidity', effort: 'M' },
    { id: 4, chart: 'Secondary Pricing Dispersion', pages: '34-37', status: 'next', theme: 'Secondaries', effort: 'L' },
    { id: 5, chart: 'Fundraising Vintage Heatmap', pages: '6-8', status: 'planned', theme: 'Fundraising', effort: 'L' },
    { id: 6, chart: 'Valuation Reset Monitor', pages: '11-19', status: 'planned', theme: 'Valuations', effort: 'M' }
  ];
  const [statusFilter, setStatusFilter] = useState('all');
  const visible = statusFilter === 'all' ? items : items.filter((item) => item.status === statusFilter);
  const builtCount = items.filter((item) => item.status === 'built').length;
  const progressPct = (builtCount / items.length) * 100;

  return (
    <section id="environment-conversion" className="content-section">
      <h2>Chart Conversion Tracker</h2>
      <p>
        This tracker moves the environment report from static pages to native web charts over time,
        with explicit status and expected effort.
      </p>
      <div className="interactive-block">
        <div className="environment-conversion-top">
          <div className="environment-conversion-progress">
            <div className="environment-conversion-label">Conversion Progress</div>
            <div className="environment-conversion-track">
              <div className="environment-conversion-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="environment-conversion-meta">{builtCount} of {items.length} items converted</div>
          </div>
          <div className="environment-theme-pills compact">
            {[
              { value: 'all', label: 'All' },
              { value: 'built', label: 'Built' },
              { value: 'next', label: 'Next' },
              { value: 'planned', label: 'Planned' }
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                className={`environment-theme-pill ${statusFilter === option.value ? 'active' : ''}`}
                onClick={() => setStatusFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="environment-table-wrap">
          <table className="environment-table">
            <thead>
              <tr>
                <th>Chart</th>
                <th>Pages</th>
                <th>Theme</th>
                <th>Status</th>
                <th>Effort</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id}>
                  <td>{item.chart}</td>
                  <td>{item.pages}</td>
                  <td>{item.theme}</td>
                  <td>
                    <span className={`environment-status ${item.status}`}>
                      {item.status}
                    </span>
                  </td>
                  <td>{item.effort}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};

const EnvironmentBuildPlanSection = () => (
  <section id="environment-build-plan" className="content-section">
    <h2>To Be Built</h2>
    <p>
      Current state now includes the report explorer, theme lens, and first-pass conversion tooling.
      Remaining work below focuses on data sourcing discipline and publication workflows.
    </p>

    <div className="liquidity-callout-grid">
      <div className="liquidity-callout">
        <h3>Data Binding</h3>
        <p>Replace placeholder delta metrics with exact values from the 4Q25 source workbook and footnotes.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Narrative Layer</h3>
        <p>Add analyst-written chart annotations that can be toggled on/off for concise vs full commentary view.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Publishing Mode</h3>
        <p>Generate client-ready snapshot exports and deep links by section for sharing outside the full report.</p>
      </div>
    </div>
  </section>
);

const BenchmarkHeroSection = ({ benchmarkData, isLoading, loadError }) => {
  const rowCount = benchmarkData?.rows?.length || 0;
  const asOfOptions = benchmarkData?.dimensions?.asOfOptions || [];
  const firstAsOf = asOfOptions[0];
  const lastAsOf = asOfOptions[asOfOptions.length - 1];
  const metricCount = benchmarkData?.dimensions?.metrics?.length || 0;
  const vintageMin = benchmarkData?.dimensions?.vintageRange?.min || 0;
  const vintageMax = benchmarkData?.dimensions?.vintageRange?.max || 0;

  return (
    <section id="benchmark-hero" className="hero-section benchmark-hero">
      <div className="pathway-badge">Benchmark Lab</div>
      <h1>VC World Benchmarks Explorer</h1>
      <p className="hero-subtitle">Interactive analysis of the MSCI World VC benchmark panel (1993-2025)</p>
      <p className="hero-purpose-note">
        Use this tab to pivot by metric, vintage, quarter, and age-in-quarters with flexible aggregation.
        The UI stays schema-driven so it can adapt if new providers/benchmarks are added later.
      </p>
      {isLoading ? (
        <p className="portfolio-inline-note">Loading benchmark dataset...</p>
      ) : loadError ? (
        <p className="portfolio-inline-note">{loadError}</p>
      ) : (
        <div className="metrics-row benchmark-hero-metrics">
          <MetricCard label="Rows" value={rowCount.toLocaleString()} subtext="Observations" accent="#1B2A4A" />
          <MetricCard label="Metric Fields" value={String(metricCount)} subtext="Long-format series" accent="#2D6B4F" />
          <MetricCard
            label="As-Of Range"
            value={firstAsOf && lastAsOf ? `${firstAsOf.dateLabel} to ${lastAsOf.dateLabel}` : 'n/a'}
            subtext="Calendar coverage"
            accent="#4A7BA7"
          />
          <MetricCard label="Vintage Range" value={`${vintageMin}-${vintageMax}`} subtext="Funds included" accent="#A8892E" />
        </div>
      )}
    </section>
  );
};

const BenchmarkExplorerSection = ({ benchmarkData, isLoading, loadError }) => {
  const [provider, setProvider] = useState('all');
  const [benchmark, setBenchmark] = useState('all');
  const [currency, setCurrency] = useState('all');
  const [selectedMetric, setSelectedMetric] = useState('');
  const [alignmentMode, setAlignmentMode] = useState('calendar');
  const [aggregation, setAggregation] = useState('median');
  const [minVintage, setMinVintage] = useState(null);
  const [maxVintage, setMaxVintage] = useState(null);
  const [minAge, setMinAge] = useState(null);
  const [maxAge, setMaxAge] = useState(null);
  const [asOfStartTs, setAsOfStartTs] = useState(null);
  const [asOfEndTs, setAsOfEndTs] = useState(null);
  const [selectedVintages, setSelectedVintages] = useState([]);
  const [defaultLineCount, setDefaultLineCount] = useState(12);

  const dims = benchmarkData?.dimensions;
  const defaultMetric = dims
    ? dims.metrics.includes('irr_median')
      ? 'irr_median'
      : dims.metrics.includes('tvpi_median')
        ? 'tvpi_median'
        : dims.metrics[0] || ''
    : '';
  const resolvedMetric = dims && selectedMetric && dims.metrics.includes(selectedMetric)
    ? selectedMetric
    : defaultMetric;
  const resolvedMinVintage = dims ? (Number.isFinite(minVintage) ? minVintage : dims.vintageRange.min) : 0;
  const resolvedMaxVintage = dims ? (Number.isFinite(maxVintage) ? maxVintage : dims.vintageRange.max) : 0;
  const resolvedMinAge = dims ? (Number.isFinite(minAge) ? minAge : dims.ageRange.min) : 0;
  const resolvedMaxAge = dims ? (Number.isFinite(maxAge) ? maxAge : dims.ageRange.max) : 0;
  const defaultAsOfStartTs = dims?.asOfOptions?.[0]?.ts ?? null;
  const defaultAsOfEndTs = dims?.asOfOptions?.[dims.asOfOptions.length - 1]?.ts ?? null;
  const resolvedAsOfStartTs = asOfStartTs ?? defaultAsOfStartTs;
  const resolvedAsOfEndTs = asOfEndTs ?? defaultAsOfEndTs;

  const filteredMetricRows = useMemo(() => {
    if (!benchmarkData || !resolvedMetric) return [];
    const asOfFloor = Number.isFinite(resolvedAsOfStartTs) && Number.isFinite(resolvedAsOfEndTs)
      ? Math.min(resolvedAsOfStartTs, resolvedAsOfEndTs)
      : resolvedAsOfStartTs;
    const asOfCeiling = Number.isFinite(resolvedAsOfStartTs) && Number.isFinite(resolvedAsOfEndTs)
      ? Math.max(resolvedAsOfStartTs, resolvedAsOfEndTs)
      : resolvedAsOfEndTs;
    return benchmarkData.rows.filter((row) => {
      if (row.value === null || !Number.isFinite(row.value)) return false;
      if (row.metric !== resolvedMetric) return false;
      if (provider !== 'all' && row.provider !== provider) return false;
      if (benchmark !== 'all' && row.benchmark !== benchmark) return false;
      if (currency !== 'all' && row.currency !== currency) return false;
      if (Number.isFinite(row.vintageYear) && (row.vintageYear < resolvedMinVintage || row.vintageYear > resolvedMaxVintage)) return false;
      if (Number.isFinite(row.ageInQuarters) && (row.ageInQuarters < resolvedMinAge || row.ageInQuarters > resolvedMaxAge)) return false;
      if (Number.isFinite(row.asOfTs) && asOfFloor !== null && row.asOfTs < asOfFloor) return false;
      if (Number.isFinite(row.asOfTs) && asOfCeiling !== null && row.asOfTs > asOfCeiling) return false;
      return true;
    });
  }, [
    benchmarkData,
    resolvedMetric,
    provider,
    benchmark,
    currency,
    resolvedMinVintage,
    resolvedMaxVintage,
    resolvedMinAge,
    resolvedMaxAge,
    resolvedAsOfStartTs,
    resolvedAsOfEndTs
  ]);

  const availableVintages = useMemo(() => {
    const set = new Set();
    filteredMetricRows.forEach((row) => {
      if (Number.isFinite(row.vintageYear)) set.add(row.vintageYear);
    });
    return Array.from(set).sort((a, b) => a - b);
  }, [filteredMetricRows]);

  const resolvedVintages = useMemo(() => {
    const availableSet = new Set(availableVintages);
    const manuallySelected = selectedVintages.filter((v) => availableSet.has(v));
    if (manuallySelected.length) return manuallySelected.sort((a, b) => a - b);
    const n = Math.max(1, Math.min(defaultLineCount, availableVintages.length));
    return availableVintages.slice(Math.max(0, availableVintages.length - n));
  }, [selectedVintages, availableVintages, defaultLineCount]);

  const chartSeries = useMemo(() => {
    const useAgeAxis = alignmentMode === 'age' || alignmentMode === 'time-zero';
    const colorForVintage = (vintage) => {
      const hue = (vintage * 31) % 360;
      return `hsl(${hue}, 60%, 42%)`;
    };
    const series = [];
    resolvedVintages.forEach((vintage) => {
      const rows = filteredMetricRows.filter((row) => row.vintageYear === vintage);
      const buckets = new Map();
      rows.forEach((row) => {
        const xKey = useAgeAxis ? row.ageInQuarters : row.asOfTs;
        const xLabel = useAgeAxis
          ? (Number.isFinite(row.ageInQuarters) ? `Q${row.ageInQuarters}` : '')
          : (row.asOfQuarterLabel || row.asOfRaw);
        if (!Number.isFinite(xKey) || !xLabel) return;
        if (!buckets.has(xKey)) buckets.set(xKey, { values: [], xLabel });
        buckets.get(xKey).values.push(row.value);
      });
      let points = Array.from(buckets.entries())
        .map(([xKey, entry]) => ({
          xKey,
          xLabel: entry.xLabel,
          value: aggregateValues(entry.values, aggregation)
        }))
        .filter((point) => Number.isFinite(point.value))
        .sort((a, b) => a.xKey - b.xKey);
      if (alignmentMode === 'time-zero' && points.length) {
        const firstAge = points[0].xKey;
        points = points.map((point) => {
          const shiftedQuarter = point.xKey - firstAge + 1;
          return {
            ...point,
            xKey: shiftedQuarter,
            xLabel: `Q${shiftedQuarter}`
          };
        });
      }
      if (!points.length) return;
      series.push({
        key: `vintage-${vintage}`,
        label: `Vintage ${vintage}`,
        vintage,
        color: colorForVintage(vintage),
        points,
        pointByXKey: new Map(points.map((point) => [point.xKey, point]))
      });
    });
    return series;
  }, [resolvedVintages, filteredMetricRows, alignmentMode, aggregation]);

  const summary = useMemo(() => {
    const values = filteredMetricRows.map((row) => row.value);
    if (!values.length) return null;
    return {
      obs: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      mean: aggregateValues(values, 'mean'),
      median: aggregateValues(values, 'median')
    };
  }, [filteredMetricRows]);

  const selectedMetricMeta = getBenchmarkMetricMeta(resolvedMetric);
  const xAxisLabel = alignmentMode === 'time-zero'
    ? 'Age in Quarters Since First Observation (Q1 = each vintage start)'
    : alignmentMode === 'age'
      ? 'Age in Quarters (Absolute)'
      : 'As-Of Quarter (Calendar Time)';

  const handleVintageSelect = (event) => {
    const values = Array.from(event.target.selectedOptions).map((opt) => Number(opt.value)).filter((value) => Number.isFinite(value));
    setSelectedVintages(values);
  };

  return (
    <section id="benchmark-explorer" className="content-section">
      <h2>Flexible Explorer</h2>
      <p>
        Plot one metric at a time with one line per vintage. Toggle between calendar-time and
        time-zero alignment by fund age to inspect when outcomes become mostly baked in.
      </p>
      <div className="interactive-block">
        {isLoading ? (
          <p className="portfolio-inline-note">Loading benchmark dataset...</p>
        ) : loadError ? (
          <p className="portfolio-inline-note">{loadError}</p>
        ) : !benchmarkData ? (
          <p className="portfolio-inline-note">No benchmark data loaded.</p>
        ) : (
          <>
            <div className="benchmark-control-grid">
              <div className="environment-toolbar-group">
                <span className="environment-toolbar-label">Metric</span>
                <select className="environment-select" value={resolvedMetric} onChange={(e) => setSelectedMetric(e.target.value)}>
                  {dims.metrics.map((metric) => (
                    <option key={metric} value={metric}>{getBenchmarkMetricMeta(metric).label}</option>
                  ))}
                </select>
              </div>
              <div className="environment-toolbar-group">
                <span className="environment-toolbar-label">Time Basis</span>
                <select className="environment-select" value={alignmentMode} onChange={(e) => setAlignmentMode(e.target.value)}>
                  <option value="calendar">Calendar Time (As-Of Quarter)</option>
                  <option value="age">Age in Quarters (Absolute)</option>
                  <option value="time-zero">Time Zero (Each Vintage Starts at Q1)</option>
                </select>
              </div>
              <div className="environment-toolbar-group">
                <span className="environment-toolbar-label">Duplicate Aggregation</span>
                <select className="environment-select" value={aggregation} onChange={(e) => setAggregation(e.target.value)}>
                  <option value="median">Median</option>
                  <option value="mean">Mean</option>
                  <option value="min">Min</option>
                  <option value="max">Max</option>
                  <option value="sum">Sum</option>
                </select>
              </div>
              <div className="environment-toolbar-group">
                <span className="environment-toolbar-label">Default Line Count</span>
                <select className="environment-select" value={defaultLineCount} onChange={(e) => setDefaultLineCount(Number(e.target.value))}>
                  {[8, 12, 16, 24, 32].map((count) => (
                    <option key={count} value={count}>Latest {count}</option>
                  ))}
                </select>
              </div>
              <div className="environment-toolbar-group">
                <span className="environment-toolbar-label">Provider</span>
                <select className="environment-select" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="all">All</option>
                  {dims.providers.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </div>
              <div className="environment-toolbar-group">
                <span className="environment-toolbar-label">Benchmark</span>
                <select className="environment-select" value={benchmark} onChange={(e) => setBenchmark(e.target.value)}>
                  <option value="all">All</option>
                  {dims.benchmarks.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </div>
              <div className="environment-toolbar-group">
                <span className="environment-toolbar-label">Currency</span>
                <select className="environment-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  <option value="all">All</option>
                  {dims.currencies.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </div>
              <div className="environment-toolbar-group benchmark-vintage-picker">
                <span className="environment-toolbar-label">Vintage Lines</span>
                <select className="environment-select benchmark-vintage-select" multiple value={resolvedVintages.map(String)} onChange={handleVintageSelect}>
                  {availableVintages.map((vintage) => (
                    <option key={vintage} value={vintage}>Vintage {vintage}</option>
                  ))}
                </select>
                <div className="benchmark-vintage-picker-actions">
                  <button type="button" className="environment-page-btn" onClick={() => setSelectedVintages(availableVintages.slice(-12))}>Latest 12</button>
                  <button type="button" className="environment-page-btn" onClick={() => setSelectedVintages(availableVintages.slice(-20))}>Latest 20</button>
                  <button type="button" className="environment-page-btn" onClick={() => setSelectedVintages(availableVintages)}>All</button>
                  <button type="button" className="environment-page-btn" onClick={() => setSelectedVintages([])}>Auto</button>
                </div>
              </div>
            </div>

            <div className="sliders-grid benchmark-range-grid">
              <Slider
                label="Min Vintage"
                min={dims.vintageRange.min}
                max={dims.vintageRange.max}
                step={1}
                value={resolvedMinVintage}
                onChange={(value) => setMinVintage(Math.min(value, resolvedMaxVintage))}
                format={(value) => String(Math.round(value))}
                accent="#1B2A4A"
              />
              <Slider
                label="Max Vintage"
                min={dims.vintageRange.min}
                max={dims.vintageRange.max}
                step={1}
                value={resolvedMaxVintage}
                onChange={(value) => setMaxVintage(Math.max(value, resolvedMinVintage))}
                format={(value) => String(Math.round(value))}
                accent="#2D6B4F"
              />
              <Slider
                label="Min Age (Quarters)"
                min={dims.ageRange.min}
                max={dims.ageRange.max}
                step={1}
                value={resolvedMinAge}
                onChange={(value) => setMinAge(Math.min(value, resolvedMaxAge))}
                format={(value) => `Q${Math.round(value)}`}
                accent="#4A7BA7"
              />
              <Slider
                label="Max Age (Quarters)"
                min={dims.ageRange.min}
                max={dims.ageRange.max}
                step={1}
                value={resolvedMaxAge}
                onChange={(value) => setMaxAge(Math.max(value, resolvedMinAge))}
                format={(value) => `Q${Math.round(value)}`}
                accent="#A8892E"
              />
            </div>

            {dims.asOfOptions.length > 0 && (
              <div className="benchmark-date-range">
                <div className="environment-toolbar-label">As-Of Date Window</div>
                <div className="benchmark-date-controls">
                  <select
                    className="environment-select"
                    value={resolvedAsOfStartTs ?? ''}
                    onChange={(e) => setAsOfStartTs(Number(e.target.value))}
                  >
                    {dims.asOfOptions.map((opt) => (
                      <option key={`start-${opt.ts}`} value={opt.ts}>{opt.dateLabel}</option>
                    ))}
                  </select>
                  <span>to</span>
                  <select
                    className="environment-select"
                    value={resolvedAsOfEndTs ?? ''}
                    onChange={(e) => setAsOfEndTs(Number(e.target.value))}
                  >
                    {dims.asOfOptions.map((opt) => (
                      <option key={`end-${opt.ts}`} value={opt.ts}>{opt.dateLabel}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {chartSeries.length ? (
              <>
                <BenchmarkVintageLineChart
                  series={chartSeries}
                  xAxisLabel={xAxisLabel}
                  valueFormatter={(value) => formatBenchmarkMetricValue(value, resolvedMetric, selectedMetricMeta.family === 'currency_mm' ? 0 : selectedMetricMeta.decimals)}
                />
                <div className="benchmark-vintage-legend">
                  {chartSeries.map((line) => (
                    <span key={`legend-${line.key}`} className="benchmark-vintage-chip" style={{ borderColor: line.color }}>
                      <span className="benchmark-vintage-dot" style={{ backgroundColor: line.color }} />
                      {line.label}
                    </span>
                  ))}
                </div>
                <div className="metrics-row benchmark-summary-metrics">
                  <MetricCard label="Filtered Rows" value={filteredMetricRows.length.toLocaleString()} subtext="After filters" accent="#1B2A4A" />
                  <MetricCard label="Vintages Visible" value={chartSeries.length.toLocaleString()} subtext={`Available ${availableVintages.length}`} accent="#A8892E" />
                  <MetricCard
                    label="Overall Median"
                    value={summary ? formatBenchmarkMetricValue(summary.median, resolvedMetric) : 'n/a'}
                    subtext={`${summary?.obs || 0} points`}
                    accent="#2D6B4F"
                  />
                  <MetricCard
                    label="Mean"
                    value={summary ? formatBenchmarkMetricValue(summary.mean, resolvedMetric) : 'n/a'}
                    subtext={summary ? `Min ${formatBenchmarkMetricValue(summary.min, resolvedMetric)}` : 'n/a'}
                    accent="#4A7BA7"
                  />
                  <MetricCard
                    label="Max"
                    value={summary ? formatBenchmarkMetricValue(summary.max, resolvedMetric) : 'n/a'}
                    subtext={summary ? `Agg: ${aggregation}` : 'n/a'}
                    accent="#A8892E"
                  />
                </div>
              </>
            ) : (
              <p className="portfolio-inline-note">No rows match the current filter combination for the selected metric and vintages.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
};

const BenchmarkTableSection = ({ benchmarkData, isLoading, loadError }) => {
  const [metricFilter, setMetricFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState('asOfTs');
  const [sortDir, setSortDir] = useState('desc');
  const [rowLimit, setRowLimit] = useState(120);

  const dims = benchmarkData?.dimensions;
  const resolvedMetricFilter = dims?.metrics?.includes(metricFilter) ? metricFilter : 'all';

  const sortedRows = useMemo(() => {
    if (!benchmarkData) return [];
    const q = query.trim().toLowerCase();
    const base = benchmarkData.rows.filter((row) => {
      if (resolvedMetricFilter !== 'all' && row.metric !== resolvedMetricFilter) return false;
      if (!q) return true;
      return [
        row.provider,
        row.benchmark,
        row.currency,
        row.metric,
        row.sourceFile,
        String(row.vintageYear ?? ''),
        row.asOfRaw
      ].join(' ').toLowerCase().includes(q);
    });
    base.sort((a, b) => {
      const aVal = a[sortBy];
      const bVal = b[sortBy];
      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }
      const textCmp = String(aVal).localeCompare(String(bVal));
      return sortDir === 'asc' ? textCmp : -textCmp;
    });
    return base;
  }, [benchmarkData, resolvedMetricFilter, query, sortBy, sortDir, rowLimit]);
  const tableRows = useMemo(() => sortedRows.slice(0, rowLimit), [sortedRows, rowLimit]);

  const exportFilteredRows = () => {
    if (!sortedRows.length) return;
    const headers = ['as_of', 'provider', 'benchmark', 'currency', 'source_file', 'Age in Quarters', 'vintage_year', 'metric', 'value'];
    const csvCell = (value) => {
      const text = value === null || value === undefined ? '' : String(value);
      if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
      return text;
    };
    const lines = sortedRows.map((row) => ([
      row.asOfRaw,
      row.provider,
      row.benchmark,
      row.currency,
      row.sourceFile,
      row.ageInQuarters,
      row.vintageYear,
      row.metric,
      row.value
    ].map(csvCell).join(',')));
    const csvText = [headers.join(','), ...lines].join('\n');
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `vc-benchmark-filtered-${stamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <section id="benchmark-table" className="content-section">
      <h2>Raw Data Analyzer</h2>
      <p>
        This view is for row-level inspection and ad hoc filtering. Use it to audit source-file coverage,
        spot outliers, and verify exact metric datapoints behind the charted aggregates.
      </p>
      <div className="interactive-block">
        {isLoading ? (
          <p className="portfolio-inline-note">Loading benchmark dataset...</p>
        ) : loadError ? (
          <p className="portfolio-inline-note">{loadError}</p>
        ) : !benchmarkData ? (
          <p className="portfolio-inline-note">No benchmark data loaded.</p>
        ) : (
          <>
            <div className="benchmark-table-toolbar">
              <div className="environment-toolbar-group">
                <span className="environment-toolbar-label">Metric Filter</span>
                <select className="environment-select" value={resolvedMetricFilter} onChange={(e) => setMetricFilter(e.target.value)}>
                  <option value="all">All Metrics</option>
                  {dims.metrics.map((metric) => (
                    <option key={metric} value={metric}>{getBenchmarkMetricMeta(metric).label}</option>
                  ))}
                </select>
              </div>
              <div className="environment-toolbar-group">
                <span className="environment-toolbar-label">Search</span>
                <input
                  className="environment-select benchmark-search-input"
                  type="text"
                  placeholder="provider, benchmark, metric, source file..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="environment-toolbar-group">
                <span className="environment-toolbar-label">Sort By</span>
                <select className="environment-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                  <option value="asOfTs">As-Of Date</option>
                  <option value="vintageYear">Vintage Year</option>
                  <option value="ageInQuarters">Age in Quarters</option>
                  <option value="metric">Metric</option>
                  <option value="value">Value</option>
                </select>
              </div>
              <div className="environment-toolbar-group">
                <span className="environment-toolbar-label">Direction</span>
                <select className="environment-select" value={sortDir} onChange={(e) => setSortDir(e.target.value)}>
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </select>
              </div>
              <div className="environment-toolbar-group">
                <span className="environment-toolbar-label">Rows</span>
                <select className="environment-select" value={rowLimit} onChange={(e) => setRowLimit(Number(e.target.value))}>
                  {[50, 120, 250, 500].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              <div className="environment-toolbar-group benchmark-export-group">
                <span className="environment-toolbar-label">Export</span>
                <button type="button" className="environment-page-btn benchmark-export-btn" onClick={exportFilteredRows}>
                  Export Filtered CSV
                </button>
              </div>
            </div>

            <div className="environment-table-wrap benchmark-table-wrap">
              <table className="environment-table benchmark-data-table">
                <thead>
                  <tr>
                    <th>As Of</th>
                    <th>Provider</th>
                    <th>Benchmark</th>
                    <th>Metric</th>
                    <th>Value</th>
                    <th>Vintage</th>
                    <th>Age (Q)</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((row) => (
                    <tr key={`benchmark-row-${row.id}`}>
                      <td>{row.asOfDate ? row.asOfDate.toISOString().slice(0, 10) : row.asOfRaw}</td>
                      <td>{row.provider}</td>
                      <td>{row.benchmark}</td>
                      <td>{getBenchmarkMetricMeta(row.metric).label}</td>
                      <td>{formatBenchmarkMetricValue(row.value, row.metric)}</td>
                      <td>{Number.isFinite(row.vintageYear) ? row.vintageYear : 'n/a'}</td>
                      <td>{Number.isFinite(row.ageInQuarters) ? row.ageInQuarters : 'n/a'}</td>
                      <td>{row.sourceFile || 'n/a'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="portfolio-inline-note">
              Showing {tableRows.length.toLocaleString()} rows (cap {rowLimit}) from {sortedRows.length.toLocaleString()} filtered rows.
            </p>
          </>
        )}
      </div>
    </section>
  );
};

const BenchmarkHubPage = () => {
  const { benchmarkData, loadError, isLoading } = useVcBenchmarkDataset();

  return (
    <>
      <BenchmarkHeroSection benchmarkData={benchmarkData} isLoading={isLoading} loadError={loadError} />
      <BenchmarkExplorerSection benchmarkData={benchmarkData} isLoading={isLoading} loadError={loadError} />
      <BenchmarkTableSection benchmarkData={benchmarkData} isLoading={isLoading} loadError={loadError} />
    </>
  );
};

const PortfolioHeroStackTeaser = () => {
  const fundLife = 12;
  const horizonYears = 16;
  const annualCurve = useMemo(() => buildAnnualGrossCurve(fundLife, 5, 2.5), []);
  const layered = useMemo(() => simulateLayeredPortfolio({
    annualCommitmentM: 120,
    commitmentYears: horizonYears + 1,
    commitmentGrowth: 0,
    curve: annualCurve,
    horizonYears
  }), [annualCurve]);
  const single = useMemo(() => simulateLayeredPortfolio({
    annualCommitmentM: 120,
    commitmentYears: 1,
    commitmentGrowth: 0,
    curve: annualCurve,
    horizonYears
  }), [annualCurve]);

  const seriesLayeredNav = layered.years.map((row) => row.navM);
  const seriesSingleNav = single.years.map((row) => row.navM);
  const yearLabels = layered.years.map((row) => `Yr ${row.year}`);
  const vintageNavSeries = useMemo(() => {
    return Array.from({ length: horizonYears + 1 }, (_, vintage) => {
      const series = layered.years.map((row) => {
        if (row.year < vintage) return 0;
        const age = row.year - vintage;
        const point = getCurvePointAtAge(annualCurve, age);
        return 120 * point.nav;
      });
      return { label: `Vintage ${vintage + 1}`, series };
    });
  }, [annualCurve, layered.years]);

  return (
    <div className="portfolio-hero-teaser">
      <div className="portfolio-hero-teaser-title">Preview: How Vintages Stack Into Portfolio NAV</div>
      <LayeredNavBuildChart
        singleSeries={seriesSingleNav}
        vintageSeries={vintageNavSeries}
        totalSeries={seriesLayeredNav}
        xLabels={yearLabels}
        xTickStep={2}
        yFormatter={(v) => formatCurrency(v * 1e6, 0)}
        height={220}
        animateOnVisible={false}
        loopAnimation={true}
        showLegend={false}
        showVintageCallout={true}
        exposureTarget={900}
        exposureTargetLabel="Exposure Target"
        exposureTargetLabelBelow={true}
      />
    </div>
  );
};

const PortfolioHeroSection = () => (
  <section id="portfolio-hero" className="hero-section portfolio-hero">
    <div className="pathway-badge">Pathway Education</div>
    <h1>Portfolio Construction in Private Markets</h1>
    <p className="hero-subtitle">How commitments stack over time to produce durable NAV exposure</p>
    <p className="hero-purpose-note">
      This guide starts with one fund lifecycle, then layers multiple vintages and strategy curves
      to show what commitment pacing is required to stay inside a target exposure range.
    </p>
    <PortfolioHeroStackTeaser />
    <div className="hero-scroll-note">Start with one commitment, then build the full program</div>
  </section>
);

const PortfolioLevelSetSection = () => {
  const horizonYears = 12;
  const years = useMemo(() => Array.from({ length: horizonYears + 1 }, (_, i) => i), [horizonYears]);

  const smoothstep = (t) => {
    const clamped = Math.max(0, Math.min(1, t));
    return clamped * clamped * (3 - 2 * clamped);
  };

  const publicSeries = useMemo(
    () => years.map((year) => 100 * Math.pow(1.10, year)),
    [years]
  );

  // Same 10% growth engine, but this line tracks REMAINING NAV in one PE fund
  // after exits begin. NAV can fall even when value has been created, because
  // value is being distributed out of the fund to LPs.
  const peRemainingNavSeries = useMemo(() => {
    return years.map((year) => {
      const grossValue = 100 * Math.pow(1.10, year);
      const realizationProgress = year <= 5 ? 0 : smoothstep((year - 5) / (horizonYears - 5));
      return grossValue * (1 - realizationProgress);
    });
  }, [years, horizonYears]);

  const publicEndValue = publicSeries[publicSeries.length - 1];
  const peNavEndValue = peRemainingNavSeries[peRemainingNavSeries.length - 1];

  return (
    <section id="portfolio-level-set" className="content-section">
      <h2>1. How This Works (Simplified)</h2>
      <p>
        Private equity is not one upfront payment. You first commit capital, then the GP calls it in
        pieces over several years. During that period, your value is reported as NAV. Only later, when
        companies are sold, cash comes back as distributions. Early years are usually cash out; later
        years are cash back.
      </p>

      <div className="interactive-block">
        <div className="portfolio-level-set-grid">
          <div className="portfolio-level-set-card">
            <div className="portfolio-level-set-step">1) Commit</div>
            <p>You promise capital, but do not wire it on day one.</p>
          </div>
          <div className="portfolio-level-set-card">
            <div className="portfolio-level-set-step">2) Capital Calls</div>
            <p>The GP sends notices; you wire capital over time.</p>
          </div>
          <div className="portfolio-level-set-card">
            <div className="portfolio-level-set-step">3) Build Value (NAV)</div>
            <p>Portfolio companies are grown; your reported value changes.</p>
          </div>
          <div className="portfolio-level-set-card">
            <div className="portfolio-level-set-step">4) Exits & Distributions</div>
            <p>Companies are sold and cash is returned to you.</p>
          </div>
        </div>

        <div className="portfolio-level-set-decoder">
          <span><strong>Called Capital</strong> = cash you sent</span>
          <span><strong>NAV</strong> = estimated value still invested</span>
          <span><strong>Distributions</strong> = cash returned to you</span>
          <span><strong>LP Net Position</strong> = distributions minus called capital</span>
        </div>

        <h3 className="chart-title">Why Commitment Pacing Matters</h3>
        <ComparisonChart
          seriesA={publicSeries}
          seriesB={peRemainingNavSeries}
          labelA="Publics: buy-and-hold value (10% annual growth)"
          labelB="Single PE Fund: remaining NAV (value is harvested and returned)"
          xLabels={years.map((year) => `Yr ${year}`)}
          xTickStep={1}
          yFormatter={(v) => `$${v.toFixed(0)}`}
          colorA="#1B2A4A"
          colorB="#2D6B4F"
          height={260}
          inlineLabels={[
            {
              series: 'A',
              index: years.length - 2,
              text: 'Publics: keeps compounding',
              dx: -160,
              dy: -14,
              color: '#1B2A4A'
            },
            {
              series: 'B',
              index: Math.min(years.length - 1, 10),
              text: 'PE fund: NAV declines as exits return cash',
              dx: -240,
              dy: 18,
              color: '#2D6B4F'
            }
          ]}
          continuationArrowA={{
            color: '#1B2A4A',
            text: 'continues'
          }}
        />

        <div className="metrics-row">
          <MetricCard
            label="Publics Buy-and-Hold Value"
            value={`$${publicEndValue.toFixed(0)}`}
            subtext="From $100 growing at 10% for 12 years"
            accent="#1B2A4A"
          />
          <MetricCard
            label="Single PE Fund Remaining NAV"
            value={`$${peNavEndValue.toFixed(0)}`}
            subtext="Remaining NAV trends to ~0 because assets are sold and cash is returned to LPs"
            accent="#2D6B4F"
          />
        </div>

        <div className="portfolio-important-callout" role="note" aria-label="Important portfolio construction clarification">
          <strong>Important:</strong> the fund is not "going to zero" economically. Remaining NAV declines
          because value is being converted into distributions and paid back to investors.
        </div>
        <p className="portfolio-inline-note">
          Public markets can look more "set it and forget it." In PE, one fund naturally runs off, so maintaining
          exposure requires ongoing commitments.
        </p>

      </div>
    </section>
  );
};

const PortfolioSingleFundSection = () => {
  const DEFAULTS = {
    commitmentM: 100,
    grossMultiple: 2.5,
    selectedYear: 0
  };
  const [commitmentM, setCommitmentM] = useState(DEFAULTS.commitmentM);
  const [grossMultiple, setGrossMultiple] = useState(DEFAULTS.grossMultiple);
  const fundLife = 12;
  const investmentPeriod = 5;
  const [selectedYearRaw, setSelectedYearRaw] = useState(DEFAULTS.selectedYear);
  const [playing, setPlaying] = useState(true);
  const yearSliderProgress = (selectedYearRaw / fundLife) * 100;

  const annualCurve = useMemo(
    () => buildAnnualGrossCurve(fundLife, Math.min(investmentPeriod, Math.max(1, fundLife - 1)), grossMultiple),
    [fundLife, investmentPeriod, grossMultiple]
  );

  const annualRows = useMemo(() => {
    return annualCurve.map((row, idx) => {
      const prev = idx > 0 ? annualCurve[idx - 1] : annualCurve[0];
      const calledToDateM = row.drawdown * commitmentM;
      const distributedToDateM = row.dpi * commitmentM;
      const navM = row.nav * commitmentM;
      const capitalCallThisYearM = idx === 0 ? 0 : (row.drawdown - prev.drawdown) * commitmentM;
      const distributionThisYearM = idx === 0 ? 0 : (row.dpi - prev.dpi) * commitmentM;
      const netCashThisYearM = distributionThisYearM - capitalCallThisYearM;
      return {
        year: row.year,
        calledToDateM,
        distributedToDateM,
        navM,
        tvpi: row.tvpi,
        capitalCallThisYearM,
        distributionThisYearM,
        netCashThisYearM
      };
    });
  }, [annualCurve, commitmentM]);

  useEffect(() => {
    if (selectedYearRaw > fundLife) {
      setSelectedYearRaw(fundLife);
    }
  }, [selectedYearRaw, fundLife]);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => {
      setSelectedYearRaw((prev) => (prev >= fundLife ? 0 : Math.min(fundLife, prev + 0.05)));
    }, 45);
    return () => window.clearInterval(timer);
  }, [playing, fundLife]);

  const growthStartYear = Math.max(1, investmentPeriod + 1);
  const harvestStartYear = Math.max(growthStartYear + 1, fundLife - 3);
  const stages = [
    {
      key: 'commit',
      title: '1) Commit Capital',
      range: 'Fund close (Yr 0)',
      lpImpact: 'LP signs commitment; capital is reserved for future calls.',
      cashDirection: 'neutral',
      active: selectedYearRaw < 1
    },
    {
      key: 'deploy',
      title: '2) Deploy Into Companies',
      range: `Yr 1-${investmentPeriod}`,
      lpImpact: 'GP calls capital as investments are executed. LP sends cash to the fund.',
      cashDirection: 'to-fund',
      active: selectedYearRaw >= 1 && selectedYearRaw < growthStartYear
    },
    {
      key: 'grow',
      title: '3) Grow & Mature',
      range: `Yr ${growthStartYear}-${Math.max(growthStartYear, harvestStartYear - 1)}`,
      lpImpact: 'NAV builds from value creation. Distributions start but are usually not dominant yet.',
      cashDirection: 'mixed',
      active: selectedYearRaw >= growthStartYear && selectedYearRaw < harvestStartYear
    },
    {
      key: 'harvest',
      title: '4) Harvest & Exit',
      range: `Yr ${harvestStartYear}-${fundLife}`,
      lpImpact: 'Assets are sold and cash returns accelerate. LP generally receives net cash back.',
      cashDirection: 'to-lp',
      active: selectedYearRaw >= harvestStartYear
    }
  ];
  const activeStage = stages.find((stage) => stage.active) || stages[0];
  const lowerIdx = Math.max(0, Math.min(fundLife, Math.floor(selectedYearRaw)));
  const upperIdx = Math.max(0, Math.min(fundLife, Math.ceil(selectedYearRaw)));
  const blend = selectedYearRaw - lowerIdx;
  const lowerRow = annualRows[lowerIdx] || annualRows[0];
  const upperRow = annualRows[upperIdx] || lowerRow;
  const selectedRow = {
    year: selectedYearRaw,
    calledToDateM: lerp(lowerRow.calledToDateM, upperRow.calledToDateM, blend),
    distributedToDateM: lerp(lowerRow.distributedToDateM, upperRow.distributedToDateM, blend),
    navM: lerp(lowerRow.navM, upperRow.navM, blend),
    tvpi: lerp(lowerRow.tvpi, upperRow.tvpi, blend),
    capitalCallThisYearM: lerp(lowerRow.capitalCallThisYearM, upperRow.capitalCallThisYearM, blend),
    distributionThisYearM: lerp(lowerRow.distributionThisYearM, upperRow.distributionThisYearM, blend),
    netCashThisYearM: lerp(lowerRow.netCashThisYearM, upperRow.netCashThisYearM, blend)
  };
  const finalRow = annualRows[annualRows.length - 1];
  const peakNavM = Math.max(...annualRows.map((row) => row.navM));
  const peakNavYear = annualRows.find((row) => row.navM === peakNavM)?.year ?? 0;
  const crossoverYear = useMemo(() => {
    for (let i = 1; i < annualRows.length; i++) {
      const prev = annualRows[i - 1];
      const curr = annualRows[i];
      if (curr.calledToDateM <= 0) continue;
      const prevNet = prev.distributedToDateM - prev.calledToDateM;
      const currNet = curr.distributedToDateM - curr.calledToDateM;
      if (prevNet < 0 && currNet >= 0) {
        const delta = currNet - prevNet;
        if (Math.abs(delta) < 1e-9) return curr.year;
        const t = (0 - prevNet) / delta;
        return prev.year + t * (curr.year - prev.year);
      }
    }
    const fallback = annualRows.find(
      (row) => row.year > 0 && row.calledToDateM > 0 && row.distributedToDateM >= row.calledToDateM
    );
    return fallback ? fallback.year : null;
  }, [annualRows]);
  const selectedYearLabel = selectedYearRaw.toFixed(1);
  const lpNetPositionM = selectedRow.distributedToDateM - selectedRow.calledToDateM;
  const lpNetPositionLabel = `${lpNetPositionM >= 0 ? '+' : '-'}${formatCurrency(Math.abs(lpNetPositionM) * 1e6, 0)}`;
  const lpNetPositionAccent = lpNetPositionM >= 0 ? '#2D6B4F' : '#B5473A';
  const crossoverYearLabel = crossoverYear === null
    ? null
    : (Math.abs(crossoverYear - Math.round(crossoverYear)) < 0.05
        ? `${Math.round(crossoverYear)}`
        : crossoverYear.toFixed(1));
  const lpNetPositionSubtext = lpNetPositionM >= 0
    ? (crossoverYear === null
        ? 'LP has moved into net positive cash position.'
        : `Crossed to net positive around year ${crossoverYearLabel}.`)
    : 'LP remains net funded (more called than distributed).';
  const laneDirection = selectedRow.netCashThisYearM > 2
    ? 'to-lp'
    : selectedRow.netCashThisYearM < -2
      ? 'to-fund'
      : activeStage.cashDirection;
  const flowByStage = {
    commit: ['lp-fund'],
    deploy: ['lp-fund', 'fund-companies'],
    grow: ['fund-companies', 'companies-fund'],
    harvest: ['companies-fund', 'fund-lp', 'fund-gp']
  };
  const activeFlows = flowByStage[activeStage.key] || [];
  const singleFundContribNavSeries = annualRows.map((row) => ({
    label: `Yr ${row.year}`,
    contributionM: Math.max(0, row.capitalCallThisYearM),
    navM: Math.max(0, row.navM)
  }));

  const resetSection = () => {
    setCommitmentM(DEFAULTS.commitmentM);
    setGrossMultiple(DEFAULTS.grossMultiple);
    setSelectedYearRaw(DEFAULTS.selectedYear);
    setPlaying(true);
  };

  return (
    <section id="portfolio-single-fund" className="content-section">
      <h2>2. Single Fund Lifecycle</h2>
      <p>
        A single fund follows a defined sequence: LPs commit capital, the GP draws it to invest in
        companies, those companies mature, and then exits convert NAV into distributions back to LPs.
        The cash-flow direction flips over time.
      </p>
      <div className="interactive-block">
        <div className="portfolio-lifecycle-assumption-grid">
          <Slider
            label="Total Committed Capital"
            value={commitmentM}
            min={25}
            max={500}
            step={5}
            format={(v) => formatCurrency(v * 1e6, 0)}
            onChange={setCommitmentM}
            accent="#1B2A4A"
          />
          <Slider
            label="Expected Fund Return (Gross MOIC)"
            value={grossMultiple}
            min={1.5}
            max={3.5}
            step={0.05}
            format={(v) => `${v.toFixed(2)}x`}
            onChange={setGrossMultiple}
            accent="#2D8A57"
          />
        </div>

        <div className="portfolio-lifecycle-automation">
          <div className="portfolio-lifecycle-automation-head">
            <div>
              <div className="portfolio-lifecycle-automation-label">Lifecycle Year</div>
              <div className="portfolio-lifecycle-year-readout">Year {selectedYearLabel}</div>
            </div>
            <div className="portfolio-lifecycle-automation-actions">
              <button
                type="button"
                className={`portfolio-play-button ${playing ? 'playing' : ''}`}
                onClick={() => setPlaying((prev) => !prev)}
              >
                {playing ? 'Pause' : 'Play'} Lifecycle
              </button>
              <ResetButton onClick={resetSection} />
            </div>
          </div>
          <div className="portfolio-lifecycle-year-range">
            <span>Yr 0</span>
            <span>Yr {fundLife}</span>
          </div>
          <input
            type="range"
            min={0}
            max={fundLife}
            step={0.01}
            value={selectedYearRaw}
            onChange={(e) => setSelectedYearRaw(Number(e.target.value))}
            className="portfolio-lifecycle-year-slider"
            style={{
              background: `linear-gradient(to right, #1B2A4A 0%, #1B2A4A ${yearSliderProgress}%, #D9D5CF ${yearSliderProgress}%, #D9D5CF 100%)`
            }}
          />
          <div className="portfolio-lifecycle-stage-tag">
            Active Stage: <strong>{activeStage.title}</strong> ({activeStage.range})
          </div>
        </div>

        <div className="metrics-row">
          <MetricCard
            label={`Year ${selectedYearLabel} Capital Called`}
            value={formatCurrency(selectedRow.capitalCallThisYearM * 1e6, 0)}
            subtext={`Cumulative called ${formatCurrency(selectedRow.calledToDateM * 1e6, 0)}`}
            accent="#1B2A4A"
          />
          <MetricCard
            label={`Year ${selectedYearLabel} Distributions`}
            value={formatCurrency(selectedRow.distributionThisYearM * 1e6, 0)}
            subtext={`Cumulative distributed ${formatCurrency(selectedRow.distributedToDateM * 1e6, 0)}`}
            accent="#2D6B4F"
          />
          <MetricCard
            label={`Year ${selectedYearLabel} NAV`}
            value={formatCurrency(selectedRow.navM * 1e6, 0)}
            subtext={`Peak ${formatCurrency(peakNavM * 1e6, 0)} in year ${peakNavYear}`}
            accent="#B5473A"
          />
          <MetricCard
            label={`Year ${selectedYearLabel} LP Net Position`}
            value={lpNetPositionLabel}
            subtext={lpNetPositionSubtext}
            accent={lpNetPositionAccent}
          />
        </div>

        <div className="portfolio-lifecycle-stage-grid">
          {stages.map((stage) => (
            <div key={stage.key} className={`portfolio-lifecycle-stage-card ${stage.active ? 'active' : ''}`}>
              <div className="portfolio-lifecycle-stage-title">{stage.title}</div>
              <div className="portfolio-lifecycle-stage-range">{stage.range}</div>
              <p>{stage.lpImpact}</p>
            </div>
          ))}
        </div>

        <div className="portfolio-flow-sketch">
          <svg
            className="portfolio-flow-svg"
            viewBox="0 0 1000 400"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Single fund lifecycle cash flow from LP to fund to companies and back to LP and GP"
          >
            <defs>
              <marker id="flowArrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
              </marker>
            </defs>

            <g className="portfolio-flow-node" transform="translate(40 44) rotate(-0.35)">
              <rect x="0" y="0" width="200" height="92" rx="10" />
              <text x="100" y="37">LP Capital</text>
              <text x="100" y="64">Pension / Endowment</text>
            </g>

            <g className="portfolio-flow-node" transform="translate(356 44) rotate(0.3)">
              <rect x="0" y="0" width="260" height="92" rx="10" />
              <text x="130" y="37">Fund Vehicle</text>
              <text x="130" y="64">Calls + distributions</text>
            </g>

            <g className="portfolio-flow-node" transform="translate(690 44) rotate(-0.3)">
              <rect x="0" y="0" width="260" height="118" rx="10" />
              <text x="130" y="34">Portfolio Companies</text>
              <text x="130" y="61">Operating growth + exits</text>
              <g className="portfolio-company-doodles" transform="translate(34 76)">
                <rect x="0" y="10" width="34" height="24" rx="2" />
                <line x1="0" y1="34" x2="34" y2="34" />
                <line x1="8" y1="18" x2="8" y2="26" />
                <line x1="16" y1="18" x2="16" y2="26" />
                <line x1="24" y1="18" x2="24" y2="26" />

                <path d="M52 34 L52 16 L68 8 L68 16 L82 10 L82 34 Z" />
                <line x1="58" y1="20" x2="58" y2="27" />
                <line x1="64" y1="20" x2="64" y2="27" />
                <line x1="74" y1="18" x2="74" y2="27" />

                <rect x="100" y="16" width="38" height="18" rx="9" />
                <line x1="110" y1="16" x2="110" y2="8" />
                <circle cx="110" cy="6" r="2" />
                <line x1="128" y1="16" x2="128" y2="9" />
                <circle cx="128" cy="7" r="2" />

                <rect x="152" y="12" width="42" height="22" rx="3" />
                <line x1="164" y1="34" x2="164" y2="42" />
                <line x1="182" y1="34" x2="182" y2="42" />
                <line x1="152" y1="42" x2="194" y2="42" />
              </g>
            </g>

            <g className="portfolio-flow-node" transform="translate(356 252)">
              <rect x="0" y="0" width="260" height="92" rx="10" />
              <text x="130" y="37">Exit Proceeds</text>
              <text x="130" y="64">Cash back in fund</text>
            </g>

            <g className="portfolio-flow-node terminal lp" transform="translate(40 252)">
              <rect x="0" y="0" width="260" height="92" rx="10" />
              <text x="130" y="37">LP Net Distributions</text>
              <text x="130" y="64">Capital + gains</text>
            </g>

            <g className="portfolio-flow-node terminal gp" transform="translate(690 252)">
              <rect x="0" y="0" width="260" height="92" rx="10" />
              <text x="130" y="37">GP Profit Share</text>
              <text x="130" y="64">Carry on profits</text>
            </g>

            <line
              x1="240"
              y1="90"
              x2="356"
              y2="90"
              className={`portfolio-flow-arrow ${activeFlows.includes('lp-fund') ? 'active' : ''}`}
              markerEnd="url(#flowArrow)"
            />
            <text x="298" y="56" className={`portfolio-flow-label ${activeFlows.includes('lp-fund') ? 'active' : ''}`}>Capital calls</text>
            <text x="298" y="85" className={`portfolio-flow-money ${activeFlows.includes('lp-fund') ? 'active' : ''}`}>$</text>

            <line
              x1="616"
              y1="90"
              x2="690"
              y2="94"
              className={`portfolio-flow-arrow ${activeFlows.includes('fund-companies') ? 'active' : ''}`}
              markerEnd="url(#flowArrow)"
            />
            <text x="652" y="56" className={`portfolio-flow-label ${activeFlows.includes('fund-companies') ? 'active' : ''}`}>Deploy capital</text>
            <text x="652" y="88" className={`portfolio-flow-money ${activeFlows.includes('fund-companies') ? 'active' : ''}`}>$</text>

            <path
              d="M 820 162 C 770 214, 664 236, 486 252"
              className={`portfolio-flow-arrow ${activeFlows.includes('companies-fund') ? 'active' : ''}`}
              markerEnd="url(#flowArrow)"
              fill="none"
            />
            <text x="742" y="208" className={`portfolio-flow-label ${activeFlows.includes('companies-fund') ? 'active' : ''}`}>Exit returns</text>
            <text x="672" y="216" className={`portfolio-flow-money ${activeFlows.includes('companies-fund') ? 'active' : ''}`}>$</text>

            <line
              x1="356"
              y1="336"
              x2="286"
              y2="336"
              className={`portfolio-flow-arrow ${activeFlows.includes('fund-lp') ? 'active' : ''}`}
              markerEnd="url(#flowArrow)"
            />
            <text x="321" y="366" className={`portfolio-flow-label ${activeFlows.includes('fund-lp') ? 'active' : ''}`}>Net to LPs</text>
            <text x="321" y="330" className={`portfolio-flow-money ${activeFlows.includes('fund-lp') ? 'active' : ''}`}>$</text>

            <line
              x1="616"
              y1="336"
              x2="704"
              y2="336"
              className={`portfolio-flow-arrow ${activeFlows.includes('fund-gp') ? 'active' : ''}`}
              markerEnd="url(#flowArrow)"
            />
            <text x="660" y="366" className={`portfolio-flow-label ${activeFlows.includes('fund-gp') ? 'active' : ''}`}>Carry to GP</text>
            <text x="660" y="330" className={`portfolio-flow-money ${activeFlows.includes('fund-gp') ? 'active' : ''}`}>$</text>
          </svg>
          <div className="portfolio-flow-caption">
            {laneDirection === 'to-fund'
              ? `Year ${selectedYearLabel}: LP cash is still predominantly flowing into the fund.`
              : laneDirection === 'to-lp'
                ? `Year ${selectedYearLabel}: exits dominate and the fund is returning net cash to LPs.`
                : `Year ${selectedYearLabel}: the fund is in transition, with calls and distributions closer to balance.`}
          </div>
        </div>

        <p className="portfolio-inline-note">
          By year {fundLife}, this run lands near {finalRow.tvpi.toFixed(2)}x gross value on the original
          commitment, with cumulative distributions of {formatCurrency(finalRow.distributedToDateM * 1e6, 0)}.
        </p>

        <h3 className="chart-title">Single Fund: Annual LP Contributions vs Expected NAV</h3>
        <p className="portfolio-inline-note">
          In the chart below, we illustrate how a single {formatCurrency(commitmentM * 1e6, 0)} commitment is
          drawn and how its value progresses. Note that this commitment is invested over {investmentPeriod} years
          (not all at once), expected NAV peaks at about {formatCurrency(peakNavM * 1e6, 0)}, and that peak does
          not occur until year {peakNavYear}. It takes time to build a traditional PE portfolio, and it is
          constantly in a state of flux.
        </p>
        <SingleFundContribNavChart
          data={singleFundContribNavSeries}
          height={245}
          xTickStep={1}
        />
        <p className="portfolio-inline-note">
          This chart is intentionally one fund and presents just one hypothetical (but well-informed)
          possible path for drawdown pace and NAV profile. In Section 3, we layer many single-fund
          exposures together to show how portfolio construction can change the profile. Then later
          we discuss how to improve estimates of your portfolio's future NAV and how to make rapid
          adjustments to that exposure.
        </p>
      </div>
    </section>
  );
};

const PortfolioLayeringSection = ({ globalGrossMultiple, onGrossMultipleChange }) => {
  const DEFAULTS = {
    annualCommitmentM: 125,
    displayYears: 22,
    commitmentGrowth: 0.0,
    localGrossMultiple: 2.5
  };
  const [annualCommitmentM, setAnnualCommitmentM] = useState(DEFAULTS.annualCommitmentM);
  const [displayYears, setDisplayYears] = useState(DEFAULTS.displayYears);
  const [commitmentGrowth, setCommitmentGrowth] = useState(DEFAULTS.commitmentGrowth);
  const [localGrossMultiple, setLocalGrossMultiple] = useState(DEFAULTS.localGrossMultiple);
  const [layerReplayKey, setLayerReplayKey] = useState(0);
  const grossMultiple = globalGrossMultiple ?? localGrossMultiple;
  const setGrossMultiple = onGrossMultipleChange ?? setLocalGrossMultiple;
  const fundLife = 12;

  const annualCurve = useMemo(() => buildAnnualGrossCurve(fundLife, 5, grossMultiple), [fundLife, grossMultiple]);
  const horizonYears = displayYears;
  const commitmentYears = displayYears + 1;
  const layered = useMemo(() => simulateLayeredPortfolio({
    annualCommitmentM,
    commitmentYears,
    commitmentGrowth,
    curve: annualCurve,
    horizonYears
  }), [annualCommitmentM, commitmentYears, commitmentGrowth, annualCurve, horizonYears]);

  const single = useMemo(() => simulateLayeredPortfolio({
    annualCommitmentM,
    commitmentYears: 1,
    commitmentGrowth: 0,
    curve: annualCurve,
    horizonYears
  }), [annualCommitmentM, annualCurve, horizonYears]);

  const seriesLayeredNav = layered.years.map((row) => row.navM);
  const seriesSingleNav = single.years.map((row) => row.navM);
  const yearLabels = layered.years.map((row) => `Yr ${row.year}`);
  const vintageNavSeries = useMemo(() => {
    return Array.from({ length: commitmentYears }, (_, vintage) => {
      const commitM = annualCommitmentM * Math.pow(1 + commitmentGrowth, vintage);
      const series = layered.years.map((row) => {
        if (row.year < vintage) return 0;
        const age = row.year - vintage;
        const point = getCurvePointAtAge(annualCurve, age);
        return commitM * point.nav;
      });
      return { label: `Vintage ${vintage + 1}`, series };
    });
  }, [annualCommitmentM, commitmentGrowth, commitmentYears, layered.years, annualCurve]);

  const peakNavM = Math.max(...seriesLayeredNav);
  const peakYear = layered.years.findIndex((row) => row.navM === peakNavM);
  const trailingWindow = layered.years.slice(Math.max(0, layered.years.length - 6));
  const trailingAverageNavM = trailingWindow.length > 0
    ? trailingWindow.reduce((sum, row) => sum + row.navM, 0) / trailingWindow.length
    : 0;
  const trailingMinNavM = trailingWindow.length > 0 ? Math.min(...trailingWindow.map((row) => row.navM)) : 0;
  const trailingMaxNavM = trailingWindow.length > 0 ? Math.max(...trailingWindow.map((row) => row.navM)) : 0;
  const steadyBandPct = trailingAverageNavM > 1e-6
    ? ((trailingMaxNavM - trailingMinNavM) / trailingAverageNavM) * 100
    : 0;

  const resetSection = () => {
    setAnnualCommitmentM(DEFAULTS.annualCommitmentM);
    setDisplayYears(DEFAULTS.displayYears);
    setCommitmentGrowth(DEFAULTS.commitmentGrowth);
    setGrossMultiple(DEFAULTS.localGrossMultiple);
    setLayerReplayKey((prev) => prev + 1);
  };

  return (
    <section id="portfolio-layering" className="content-section">
      <h2>3. Vintage Layering: From One Commitment to a Program</h2>
      <p>
        A pension plan does not own one fund. It owns many vintages simultaneously. Layering commitments
        year-over-year smooths exposure and can create a more stable NAV base than a single vintage ever could.
      </p>
      <div className="interactive-block">
        <div className="block-actions">
          <button type="button" className="reset-button" onClick={() => setLayerReplayKey((prev) => prev + 1)}>
            Replay Animation
          </button>
          <ResetButton onClick={resetSection} />
        </div>
        <div className="sliders-grid">
          <Slider
            label="Annual Commitment"
            value={annualCommitmentM}
            min={50}
            max={350}
            step={5}
            format={(v) => formatCurrency(v * 1e6, 0)}
            onChange={setAnnualCommitmentM}
            accent="#1B2A4A"
          />
          <Slider
            label="Years Shown"
            value={displayYears}
            min={14}
            max={28}
            step={1}
            format={(v) => `${Math.round(v)} years`}
            onChange={(v) => setDisplayYears(Math.round(v))}
            accent="#2D6B4F"
          />
          <Slider
            label="Commitment Growth Rate"
            value={commitmentGrowth}
            min={-0.05}
            max={0.12}
            step={0.005}
            format={(v) => formatPercent(v, 1)}
            onChange={setCommitmentGrowth}
            accent="#C9A84C"
          />
          <Slider
            label="Gross MOIC Assumption"
            value={grossMultiple}
            min={1.75}
            max={3.25}
            step={0.05}
            format={(v) => `${v.toFixed(2)}x`}
            onChange={setGrossMultiple}
            accent="#B5473A"
          />
        </div>

        <div className="metrics-row">
          <MetricCard label="Total Committed" value={formatCurrency(layered.totalCommittedM * 1e6, 0)} subtext={`Across ${commitmentYears} annual vintages`} accent="#1B2A4A" />
          <MetricCard label="Peak Program NAV" value={formatCurrency(peakNavM * 1e6, 0)} subtext={`Peaks around year ${peakYear}`} accent="#2D6B4F" />
          <MetricCard label="Steady-State Band (Last 5Y)" value={`±${(steadyBandPct / 2).toFixed(1)}%`} subtext={`Around ${formatCurrency(trailingAverageNavM * 1e6, 0)} NAV`} accent="#1B2A4A" />
        </div>

        <h3 className="chart-title">How Single-Vintage NAV Curves Stack Into Portfolio NAV</h3>
        <LayeredNavBuildChart
          singleSeries={seriesSingleNav}
          vintageSeries={vintageNavSeries}
          totalSeries={seriesLayeredNav}
          xLabels={yearLabels}
          xTickStep={2}
          yFormatter={(v) => formatCurrency(v * 1e6, 0)}
          height={300}
          animateOnVisible={true}
          replayKey={layerReplayKey}
          showVintageCallout={true}
          exposureTarget={1950}
          exposureTargetLabel="Exposure Target"
        />
        <p className="portfolio-inline-note">
          Each light-blue curve is one vintage's NAV path. The dark-green line is the point-by-point sum of all those curves.
        </p>

        <p className="portfolio-inline-note">
          Keeping commitments active each year is what allows total NAV to flatten toward a steady state, but it takes time.
          Later in this tool, we can look at ways to achieve a target exposure faster, or adjust an existing portfolio
          downward rapidly through the use of other investment types like secondaries and direct equity.
        </p>
      </div>
    </section>
  );
};

const PortfolioStrategyCurvesSection = () => {
  const [strategyA, setStrategyA] = useState('buyout');
  const [strategyB, setStrategyB] = useState('venture');
  const [metricView, setMetricView] = useState('nav');
  const { scheduleData, loadError } = useStrategyTypeSchedule();

  const keys = scheduleData?.keys || Object.keys(STRATEGY_TYPE_SERIES_META);
  const seriesAData = scheduleData?.byKey?.[strategyA];
  const seriesBData = scheduleData?.byKey?.[strategyB];
  const quarters = scheduleData?.quarters || [];
  const length = quarters.length;
  const seriesA = useMemo(() => {
    if (!seriesAData || !length) return [];
    return metricView === 'nav' ? seriesAData.navPct.slice(0, length) : seriesAData.cumulativeDraw.slice(0, length);
  }, [seriesAData, length, metricView]);
  const seriesB = useMemo(() => {
    if (!seriesBData || !length) return [];
    return metricView === 'nav' ? seriesBData.navPct.slice(0, length) : seriesBData.cumulativeDraw.slice(0, length);
  }, [seriesBData, length, metricView]);
  const xLabels = useMemo(() => (
    quarters.map((_, idx) => `Yr ${Math.floor(idx / 4)}`)
  ), [quarters]);
  const yFormatter = (value) => `${(value * 100).toFixed(0)}%`;

  const findQuarterAtDraw80 = (curve) => {
    if (!curve || !curve.cumulativeDraw?.length) return null;
    const idx = curve.cumulativeDraw.findIndex((value) => value >= 0.8);
    return idx >= 0 ? idx + 1 : null;
  };

  const findPeakNav = (curve) => {
    if (!curve || !curve.navPct?.length) return { quarter: null, value: 0 };
    let bestIdx = 0;
    for (let i = 1; i < curve.navPct.length; i++) {
      if (curve.navPct[i] > curve.navPct[bestIdx]) bestIdx = i;
    }
    return { quarter: bestIdx + 1, value: curve.navPct[bestIdx] || 0 };
  };

  const navHalfLife = (curve) => {
    if (!curve || !curve.navPct?.length) return null;
    const peak = findPeakNav(curve);
    if (!peak.quarter || peak.value <= 0) return null;
    const threshold = peak.value * 0.5;
    for (let i = peak.quarter; i < curve.navPct.length; i++) {
      if (curve.navPct[i] <= threshold) return i + 1;
    }
    return null;
  };

  const formatQuarterAsYear = (quarter) => {
    if (!Number.isFinite(quarter) || quarter <= 0) return 'N/A';
    const years = quarter / 4;
    return Math.abs(years - Math.round(years)) < 0.05 ? `Yr ${Math.round(years)}` : `Yr ${years.toFixed(1)}`;
  };

  const draw80A = seriesAData ? findQuarterAtDraw80(seriesAData) : null;
  const draw80B = seriesBData ? findQuarterAtDraw80(seriesBData) : null;
  const peakA = seriesAData ? findPeakNav(seriesAData) : { quarter: null, value: 0 };
  const peakB = seriesBData ? findPeakNav(seriesBData) : { quarter: null, value: 0 };
  const halfLifeA = seriesAData ? navHalfLife(seriesAData) : null;
  const halfLifeB = seriesBData ? navHalfLife(seriesBData) : null;

  return (
    <section id="portfolio-strategies" className="content-section">
      <h2>5. Strategy/Investment-Type Curve Considerations</h2>
      <p>
        Not all strategies behave the same. Some draw quickly and recycle value faster; others
        build NAV more slowly and keep it outstanding for longer.
      </p>
      <p>
        Toggle two different strategies/types below to compare how they might affect your portfolio.
      </p>
      <div className="interactive-block">
        {!scheduleData ? (
          <p className="portfolio-inline-note">{loadError || 'Loading strategy and investment-type curves...'}</p>
        ) : (
          <>
        <div className="portfolio-select-grid">
          <div className="environment-toolbar-group">
            <span className="environment-toolbar-label">Strategy A</span>
            <select className="environment-select" value={strategyA} onChange={(e) => setStrategyA(e.target.value)}>
              {keys.map((key) => (
                <option key={key} value={key}>{STRATEGY_TYPE_SERIES_META[key]?.label || key}</option>
              ))}
            </select>
          </div>
          <div className="environment-toolbar-group">
            <span className="environment-toolbar-label">Strategy B</span>
            <select className="environment-select" value={strategyB} onChange={(e) => setStrategyB(e.target.value)}>
              {keys.map((key) => (
                <option key={key} value={key}>{STRATEGY_TYPE_SERIES_META[key]?.label || key}</option>
              ))}
            </select>
          </div>
          <div className="environment-toolbar-group">
            <span className="environment-toolbar-label">Metric</span>
            <ToggleSwitch
              options={[
                { label: 'NAV % of Commitment', value: 'nav' },
                { label: 'Drawdown % of Commitment', value: 'drawdown' }
              ]}
              value={metricView}
              onChange={setMetricView}
              accent="#1B2A4A"
            />
          </div>
        </div>

        <div className="metrics-row">
          <MetricCard
            label={`${seriesAData?.label || strategyA}: 80% Draw`}
            value={formatQuarterAsYear(draw80A)}
            subtext="Capital deployment pace"
            accent={seriesAData?.color || '#1B2A4A'}
          />
          <MetricCard
            label={`${seriesBData?.label || strategyB}: 80% Draw`}
            value={formatQuarterAsYear(draw80B)}
            subtext="Capital deployment pace"
            accent={seriesBData?.color || '#2D6B4F'}
          />
          <MetricCard
            label="Peak NAV (% of Commitment)"
            value={`${(peakA.value * 100).toFixed(0)}% / ${(peakB.value * 100).toFixed(0)}%`}
            subtext={`${seriesAData?.label || 'A'} peaks ${formatQuarterAsYear(peakA.quarter)}, ${seriesBData?.label || 'B'} peaks ${formatQuarterAsYear(peakB.quarter)}`}
            accent="#1B2A4A"
          />
          <MetricCard
            label="NAV Half-Life"
            value={`${formatQuarterAsYear(halfLifeA)} / ${formatQuarterAsYear(halfLifeB)}`}
            subtext="When NAV falls below 50% of peak value"
            accent="#B5473A"
          />
        </div>

        <ComparisonChart
          seriesA={seriesA}
          seriesB={seriesB}
          labelA={seriesAData?.label || strategyA}
          labelB={seriesBData?.label || strategyB}
          xLabels={xLabels}
          xTickStep={4}
          yFormatter={yFormatter}
          colorA={seriesAData?.color || '#1B2A4A'}
          colorB={seriesBData?.color || '#2D6B4F'}
          height={260}
        />
        <p className="portfolio-inline-note">
          Percentage metrics in this section are shown as a share of committed capital.
        </p>
        <div className="portfolio-commentary-block">
          <h3 className="portfolio-commentary-title">Commentary</h3>
          <table className="portfolio-commentary-table">
            <tbody>
              {keys.map((key) => {
                const meta = STRATEGY_TYPE_SERIES_META[key];
                return (
                  <tr key={key}>
                    <th scope="row">{meta.label}</th>
                    <td>{meta.commentary}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <NuanceDisclosure
          title="Final Thought"
          summary="These paths are directional guides for modeling behavior by strategy and type."
        >
          <p>
            These are illustrative projections for one example investment in each strategy/type.
            In practice, secondaries are often purchased much later in a fund life, which can make
            RVPI run off faster than shown here.
          </p>
          <p>
            We also model a hypothetical single direct-equity investment, while a diversified direct-equity
            portfolio will usually look different. The key point is that each investment type can behave
            differently and should be modeled independently.
          </p>
        </NuanceDisclosure>
        <PathwayInlineCta line="Want help mapping these curve behaviors to your actual commitment plan?" />
        </>
        )}
      </div>
    </section>
  );
};

const PORTFOLIO_TARGETING_BASE = {
  planAssetsB: 12,
  targetPct: 0.12,
  bandWidth: 0.015,
  denominatorGrowth: 0.045,
  existingNavB: 1.0,
  existingAge: 6,
  annualCommitmentM: 260,
  commitGrowth: 0.03,
  planningYears: 12
};

const buildTargetExposureProjection = ({
  annualCurve,
  planAssetsB,
  denominatorGrowth,
  existingNavB,
  existingAge,
  annualCommitmentM,
  commitGrowth,
  planningYears,
  targetPct
}) => {
  const rows = [];
  const existingStartPoint = getCurvePointAtAge(annualCurve, existingAge);
  const existingStartNav = Math.max(1e-9, existingStartPoint.nav);

  for (let year = 0; year <= planningYears; year++) {
    const assetsB = planAssetsB * Math.pow(1 + denominatorGrowth, year);
    const existingPoint = getCurvePointAtAge(annualCurve, existingAge + year);
    const existingRunoffNavB = existingNavB * (existingPoint.nav / existingStartNav);

    let newBuildNavB = 0;
    for (let vintage = 0; vintage <= year; vintage++) {
      const commitB = (annualCommitmentM / 1000) * Math.pow(1 + commitGrowth, vintage);
      const age = year - vintage;
      const point = getCurvePointAtAge(annualCurve, age);
      newBuildNavB += commitB * point.nav;
    }

    const totalNavB = existingRunoffNavB + newBuildNavB;
    const exposure = assetsB > 0 ? totalNavB / assetsB : 0;
    rows.push({
      year,
      assetsB,
      existingRunoffNavB,
      newBuildNavB,
      totalNavB,
      exposure
    });
  }

  const year5Exposure = rows[Math.min(5, rows.length - 1)]?.exposure || 0;
  const suggestedCommitmentM = year5Exposure > 1e-6
    ? annualCommitmentM * (targetPct / year5Exposure)
    : annualCommitmentM;

  return { rows, year5Exposure, suggestedCommitmentM };
};

const findFirstYearInBand = (rows, targetPct, bandWidth) => {
  const low = targetPct - bandWidth;
  const high = targetPct + bandWidth;
  const row = rows.find((entry) => entry.year > 0 && entry.exposure >= low && entry.exposure <= high);
  return row ? row.year : null;
};

const findPeakExposureRow = (rows = []) => {
  if (!rows.length) return { year: 0, exposure: 0 };
  return rows.reduce((best, row) => (row.exposure > best.exposure ? row : best), rows[0]);
};

const PortfolioTargetingSection = () => {
  const [planAssetsB, setPlanAssetsB] = useState(PORTFOLIO_TARGETING_BASE.planAssetsB);
  const [targetPct, setTargetPct] = useState(PORTFOLIO_TARGETING_BASE.targetPct);
  const [bandWidth, setBandWidth] = useState(PORTFOLIO_TARGETING_BASE.bandWidth);
  const [denominatorGrowth, setDenominatorGrowth] = useState(PORTFOLIO_TARGETING_BASE.denominatorGrowth);
  const [existingNavB, setExistingNavB] = useState(PORTFOLIO_TARGETING_BASE.existingNavB);
  const [existingAge, setExistingAge] = useState(PORTFOLIO_TARGETING_BASE.existingAge);
  const [annualCommitmentM, setAnnualCommitmentM] = useState(PORTFOLIO_TARGETING_BASE.annualCommitmentM);
  const [commitGrowth, setCommitGrowth] = useState(PORTFOLIO_TARGETING_BASE.commitGrowth);
  const [planningYears, setPlanningYears] = useState(PORTFOLIO_TARGETING_BASE.planningYears);
  const [activeScenario, setActiveScenario] = useState('base');

  const annualCurve = useMemo(() => buildAnnualGrossCurve(12, 5, 2.5), []);
  const scenarioPresets = useMemo(() => ([
    { id: 'base', label: 'Base', values: PORTFOLIO_TARGETING_BASE },
    {
      id: 'fast-ramp',
      label: 'Fast Ramp',
      values: {
        ...PORTFOLIO_TARGETING_BASE,
        annualCommitmentM: 420,
        commitGrowth: 0.05,
        existingNavB: 0.85,
        existingAge: 7
      }
    },
    {
      id: 'growth-shock',
      label: 'Denominator Growth Shock',
      values: {
        ...PORTFOLIO_TARGETING_BASE,
        denominatorGrowth: 0.07,
        annualCommitmentM: 295
      }
    },
    {
      id: 'over-commit',
      label: 'Over-Commit',
      values: {
        ...PORTFOLIO_TARGETING_BASE,
        annualCommitmentM: 480,
        commitGrowth: 0.06,
        bandWidth: 0.02
      }
    },
    {
      id: 'secondary-sale',
      label: 'Secondary Sale',
      values: {
        ...PORTFOLIO_TARGETING_BASE,
        existingNavB: 0.65,
        existingAge: 8,
        annualCommitmentM: 210,
        commitGrowth: 0.01
      }
    }
  ]), []);

  const applyScenario = (scenarioId) => {
    const selected = scenarioPresets.find((scenario) => scenario.id === scenarioId);
    if (!selected) return;
    const values = selected.values;
    setPlanAssetsB(values.planAssetsB);
    setTargetPct(values.targetPct);
    setBandWidth(values.bandWidth);
    setDenominatorGrowth(values.denominatorGrowth);
    setExistingNavB(values.existingNavB);
    setExistingAge(values.existingAge);
    setAnnualCommitmentM(values.annualCommitmentM);
    setCommitGrowth(values.commitGrowth);
    setPlanningYears(values.planningYears);
    setActiveScenario(scenarioId);
  };

  const markCustom = () => {
    if (activeScenario !== 'custom') setActiveScenario('custom');
  };

  const projection = useMemo(() => {
    return buildTargetExposureProjection({
      annualCurve,
      planAssetsB,
      denominatorGrowth,
      existingNavB,
      existingAge,
      annualCommitmentM,
      commitGrowth,
      planningYears,
      targetPct
    });
  }, [
    annualCurve,
    planAssetsB,
    denominatorGrowth,
    existingNavB,
    existingAge,
    annualCommitmentM,
    commitGrowth,
    planningYears,
    targetPct
  ]);

  const baseProjection = useMemo(() => {
    return buildTargetExposureProjection({
      annualCurve,
      ...PORTFOLIO_TARGETING_BASE
    });
  }, [annualCurve]);

  const yearLabels = projection.rows.map((row) => `Yr ${row.year}`);
  const exposurePctSeries = projection.rows.map((row) => row.exposure * 100);
  const targetSeries = projection.rows.map(() => targetPct * 100);
  const runoffSeries = projection.rows.map((row) => row.existingRunoffNavB);
  const buildSeries = projection.rows.map((row) => row.newBuildNavB);
  const currentExposure = projection.rows[0]?.exposure || 0;
  const inBandYears = projection.rows.filter((row) => row.exposure >= targetPct - bandWidth && row.exposure <= targetPct + bandWidth).length;
  const firstYearInBand = findFirstYearInBand(projection.rows, targetPct, bandWidth);
  const peakExposureRow = findPeakExposureRow(projection.rows);
  const miniTickStep = Math.max(1, Math.round(planningYears / 6));

  const baseFirstYearInBand = findFirstYearInBand(
    baseProjection.rows,
    PORTFOLIO_TARGETING_BASE.targetPct,
    PORTFOLIO_TARGETING_BASE.bandWidth
  );
  const basePeakExposureRow = findPeakExposureRow(baseProjection.rows);
  const deltaYear5Bps = (projection.year5Exposure - baseProjection.year5Exposure) * 10000;
  const deltaPeakBps = (peakExposureRow.exposure - basePeakExposureRow.exposure) * 10000;
  const yearsToTargetDelta = firstYearInBand === null || baseFirstYearInBand === null
    ? null
    : firstYearInBand - baseFirstYearInBand;

  const signedBps = (value) => `${value >= 0 ? '+' : ''}${Math.round(value).toLocaleString()} bps`;
  const signedYears = (value) => `${value > 0 ? '+' : ''}${value}y`;

  return (
    <section id="portfolio-targeting" className="content-section">
      <h2>7. Chasing Exposure Targets</h2>
      <p>
        Assuming we have a general baseline for how to project our future exposure to a reasonable degree
        of accuracy, planning how you get there leads to the next set of questions.
      </p>
      <div className="interactive-block">
        <div className="portfolio-targeting-kicker">Questions to pressure-test before setting a pacing plan</div>
        <ul className="portfolio-targeting-questions">
          <li>How fast do you want (need?) to achieve your target?</li>
          <li>How wide is your target range?</li>
          <li>What investment strategies and types are you capable of pursuing?</li>
          <li>Will your strategy/type mix change over time?</li>
          <li>How sensitive are you to exceeding your target? Falling short?</li>
          <li>What tools are you comfortable with executing (e.g., secondary sales) to actively manage your exposure?</li>
          <li>Are you committed to consistently investing or do you want to try to time the market?</li>
          <li>What is the growth rate of your underlying portfolio?</li>
        </ul>
        <div className="portfolio-targeting-manager-callout">
          <strong>Manager Check:</strong> Make sure your manager has good answers to these questions.
        </div>
        <p className="portfolio-inline-note">
          These are all important considerations you should work with your team or investment manager
          to understand, because they each have a massive impact on how you approach PE.
        </p>
        <p className="portfolio-inline-note">
          One thing I'd like to note is that we (at Pathway) often see folks think about exposure
          targets as a discrete number. Clients work with a consultant to figure out a target, but one
          that applies to their current total portfolio NAV. A diversified PE portfolio takes time to
          develop, and so by the time you reach your expected dollar exposure, the denominator that was
          relevant at the outset has changed, sometimes materially.
        </p>
        <p className="portfolio-inline-note">
          A key part of the trip here is to understand your target exposure relative to the rest of your
          portfolio, how all the other variables might change, and how sensitive you are to those changes.
        </p>
      </div>

      <div className="interactive-block">
        <div className="portfolio-scenario-row">
          <div className="portfolio-targeting-kicker">Quick scenarios</div>
          <div className="portfolio-scenario-chips">
            {scenarioPresets.map((scenario) => (
              <button
                key={scenario.id}
                type="button"
                className={`portfolio-scenario-chip ${activeScenario === scenario.id ? 'active' : ''}`}
                onClick={() => applyScenario(scenario.id)}
              >
                {scenario.label}
              </button>
            ))}
          </div>
        </div>

        <div className="portfolio-flight-strip">
          <div className="portfolio-flight-strip-head">
            <div>
              <div className="portfolio-flight-kicker">Portfolio Flight Path</div>
              <div className="portfolio-flight-summary">
                {formatPercent(currentExposure, 1)} now | target band {formatPercent(targetPct - bandWidth, 1)} to {formatPercent(targetPct + bandWidth, 1)} | {firstYearInBand === null ? 'target band not reached in horizon' : `first in-band year: Yr ${firstYearInBand}`}
              </div>
            </div>
            <div className="portfolio-flight-pill">
              {firstYearInBand === null ? 'No in-band year' : `Yr ${firstYearInBand} in-band`}
            </div>
          </div>
          <ComparisonChart
            seriesA={exposurePctSeries}
            seriesB={targetSeries}
            labelA="Projected PE Exposure"
            labelB="Target Exposure"
            xLabels={yearLabels}
            xTickStep={miniTickStep}
            yFormatter={(value) => `${value.toFixed(1)}%`}
            colorA="#1B2A4A"
            colorB="#2D6B4F"
            height={160}
            marker={firstYearInBand === null ? null : {
              index: firstYearInBand,
              label: `First in-band Yr ${firstYearInBand}`,
              color: '#C9A84C'
            }}
          />
        </div>

        <div className="sliders-grid">
          <Slider label="Plan Assets Today" value={planAssetsB} min={5} max={60} step={0.5} format={(v) => `${formatCurrency(v * 1e9, 0)}`} onChange={(v) => { markCustom(); setPlanAssetsB(v); }} accent="#1B2A4A" />
          <Slider label="Target PE Exposure" value={targetPct} min={0.05} max={0.2} step={0.005} format={(v) => formatPercent(v, 1)} onChange={(v) => { markCustom(); setTargetPct(v); }} accent="#2D6B4F" />
          <Slider label="Target Band Width (+/-)" value={bandWidth} min={0.005} max={0.03} step={0.0025} format={(v) => formatPercent(v, 2)} onChange={(v) => { markCustom(); setBandWidth(v); }} accent="#9A9690" />
          <Slider label="Denominator Growth" value={denominatorGrowth} min={0} max={0.08} step={0.0025} format={(v) => formatPercent(v, 1)} onChange={(v) => { markCustom(); setDenominatorGrowth(v); }} accent="#C9A84C" />
          <Slider label="Existing Portfolio NAV" value={existingNavB} min={0.25} max={3.5} step={0.05} format={(v) => formatCurrency(v * 1e9, 0)} onChange={(v) => { markCustom(); setExistingNavB(v); }} accent="#1B2A4A" />
          <Slider label="Existing Portfolio Avg Age" value={existingAge} min={1} max={11} step={1} format={(v) => `Year ${Math.round(v)}`} onChange={(v) => { markCustom(); setExistingAge(Math.round(v)); }} accent="#B5473A" />
          <Slider label="Annual New Commitments" value={annualCommitmentM} min={75} max={900} step={5} format={(v) => formatCurrency(v * 1e6, 0)} onChange={(v) => { markCustom(); setAnnualCommitmentM(v); }} accent="#1B2A4A" />
          <Slider label="Commitment Growth" value={commitGrowth} min={-0.03} max={0.08} step={0.0025} format={(v) => formatPercent(v, 1)} onChange={(v) => { markCustom(); setCommitGrowth(v); }} accent="#2D6B4F" />
          <Slider label="Planning Horizon" value={planningYears} min={6} max={18} step={1} format={(v) => `${Math.round(v)} years`} onChange={(v) => { markCustom(); setPlanningYears(Math.round(v)); }} accent="#9A9690" />
        </div>

        <div className="metrics-row">
          <MetricCard label="Current Exposure" value={formatPercent(currentExposure, 1)} subtext="Year 0 NAV / assets" accent="#1B2A4A" />
          <MetricCard label="Year 5 Projected Exposure" value={formatPercent(projection.year5Exposure, 1)} subtext={`Target ${formatPercent(targetPct, 1)}`} accent="#2D6B4F" />
          <MetricCard label="Implied Annual Commitments" value={formatCurrency(projection.suggestedCommitmentM * 1e6, 0)} subtext="Approx commitment to align by year 5" accent="#B5473A" />
        </div>

        <div className="portfolio-delta-panel">
          <div className="portfolio-delta-title">What Changed vs Base</div>
          <div className="portfolio-delta-grid">
            <div className="portfolio-delta-item">
              <span>Year 5 exposure</span>
              <strong className={deltaYear5Bps >= 0 ? 'positive' : 'negative'}>{signedBps(deltaYear5Bps)}</strong>
            </div>
            <div className="portfolio-delta-item">
              <span>Years to reach band</span>
              <strong className={yearsToTargetDelta === null ? '' : yearsToTargetDelta <= 0 ? 'positive' : 'negative'}>
                {yearsToTargetDelta === null ? 'N/A' : signedYears(yearsToTargetDelta)}
              </strong>
            </div>
            <div className="portfolio-delta-item">
              <span>Peak exposure</span>
              <strong className={deltaPeakBps <= 0 ? 'positive' : 'negative'}>
                {signedBps(deltaPeakBps)}
              </strong>
            </div>
          </div>
        </div>

        <p className="portfolio-inline-note">
          Exposure-in-band years in current run: <strong>{inBandYears}</strong> of <strong>{projection.rows.length}</strong>
        </p>

        <h3 className="chart-title">Projected PE Exposure vs Target</h3>
        <ComparisonChart
          seriesA={exposurePctSeries}
          seriesB={targetSeries}
          labelA="Projected PE Exposure"
          labelB="Target Exposure"
          xLabels={yearLabels}
          xTickStep={2}
          yFormatter={(value) => `${value.toFixed(1)}%`}
          colorA="#1B2A4A"
          colorB="#2D6B4F"
          height={260}
        />

        <h3 className="chart-title">Existing Portfolio Runoff vs New-Build NAV</h3>
        <ComparisonChart
          seriesA={runoffSeries}
          seriesB={buildSeries}
          labelA="Existing Portfolio NAV"
          labelB="New Commitments NAV"
          xLabels={yearLabels}
          xTickStep={2}
          yFormatter={(value) => formatCurrency(value * 1e9, 0)}
          colorA="#9A9690"
          colorB="#1B2A4A"
          height={250}
        />
      </div>

      <PathwayInlineCta line="Need a second set of eyes on exposure pacing and denominator risk?" />
    </section>
  );
};

const PortfolioTypesSection = () => {
  const [secondaryPct, setSecondaryPct] = useState(0.2);
  const [directPct, setDirectPct] = useState(0.1);
  const [annualCommitmentM, setAnnualCommitmentM] = useState(200);
  const { scheduleData, loadError } = useStrategyTypeSchedule();

  const setSecondarySafe = (value) => {
    const bounded = Math.min(0.75, Math.max(0, value));
    const maxSecondary = Math.max(0, 0.9 - directPct);
    setSecondaryPct(Math.min(bounded, maxSecondary));
  };
  const setDirectSafe = (value) => {
    const bounded = Math.min(0.75, Math.max(0, value));
    const maxDirect = Math.max(0, 0.9 - secondaryPct);
    setDirectPct(Math.min(bounded, maxDirect));
  };

  const primaryPct = Math.max(0, 1 - secondaryPct - directPct);

  const annualCurves = useMemo(() => {
    if (!scheduleData?.byKey || !scheduleData?.quarters?.length) return null;
    const quarterCount = scheduleData.quarters.length;
    const horizonYears = Math.max(1, Math.floor(quarterCount / 4));

    const annualize = (key) => {
      const curve = scheduleData.byKey[key];
      if (!curve) return { draw: [0], nav: [0] };
      const draw = [0];
      const nav = [0];
      for (let year = 1; year <= horizonYears; year++) {
        const idx = Math.min(curve.cumulativeDraw.length - 1, year * 4 - 1);
        draw.push(curve.cumulativeDraw[idx] || 0);
        nav.push(curve.navPct[idx] || 0);
      }
      return { draw, nav };
    };

    return {
      horizonYears,
      primary: annualize('buyout'),
      secondary: annualize('secondary'),
      direct: annualize('direct')
    };
  }, [scheduleData]);

  const horizonYears = annualCurves?.horizonYears || 15;
  const years = useMemo(() => Array.from({ length: horizonYears + 1 }, (_, i) => i), [horizonYears]);

  const mixSeries = useMemo(() => {
    if (!annualCurves) return { called: [], nav: [], allPrimaryNav: [] };
    const called = [];
    const nav = [];
    const allPrimaryNav = [];
    const getAt = (arr, year) => {
      if (!arr?.length) return 0;
      const idx = Math.max(0, Math.min(arr.length - 1, year));
      return arr[idx] || 0;
    };

    years.forEach((year) => {
      const pDraw = getAt(annualCurves.primary.draw, year);
      const sDraw = getAt(annualCurves.secondary.draw, year);
      const dDraw = getAt(annualCurves.direct.draw, year);
      const pNav = getAt(annualCurves.primary.nav, year);
      const sNav = getAt(annualCurves.secondary.nav, year);
      const dNav = getAt(annualCurves.direct.nav, year);

      called.push(primaryPct * pDraw + secondaryPct * sDraw + directPct * dDraw);
      nav.push(primaryPct * pNav + secondaryPct * sNav + directPct * dNav);
      allPrimaryNav.push(pNav);
    });
    return { called, nav, allPrimaryNav };
  }, [years, annualCurves, primaryPct, secondaryPct, directPct]);

  const year1CallM = (mixSeries.called[1] || 0) * annualCommitmentM;
  const year1NavM = (mixSeries.nav[1] || 0) * annualCommitmentM;
  const residualYearIndex = Math.min(10, Math.max(0, mixSeries.nav.length - 1));
  const residualYear10M = (mixSeries.nav[residualYearIndex] || 0) * annualCommitmentM;

  return (
    <section id="portfolio-types" className="content-section">
      <h2>6. Blending Investment Types and Strategies: a Dynamic Effect</h2>
      <p>
        Different investment types change both deployment speed and NAV duration. Secondaries and
        direct equity can put capital to work faster, but they typically season faster too.
      </p>
      <div className="interactive-block">
        {!scheduleData ? (
          <p className="portfolio-inline-note">{loadError || 'Loading strategy and investment-type curves...'}</p>
        ) : (
          <>
        <div className="sliders-grid">
          <Slider label="Secondary Allocation" value={secondaryPct} min={0} max={0.75} step={0.01} format={(v) => formatPercent(v, 0)} onChange={setSecondarySafe} accent="#A8892E" />
          <Slider label="Direct Equity Allocation" value={directPct} min={0} max={0.75} step={0.01} format={(v) => formatPercent(v, 0)} onChange={setDirectSafe} accent="#B5473A" />
          <Slider label="Illustrative Annual Commitment" value={annualCommitmentM} min={50} max={500} step={5} format={(v) => formatCurrency(v * 1e6, 0)} onChange={setAnnualCommitmentM} accent="#1B2A4A" />
        </div>

        <div className="portfolio-mix-chips">
          <span className="portfolio-mix-chip primary">Primary {formatPercent(primaryPct, 0)}</span>
          <span className="portfolio-mix-chip secondary">Secondary {formatPercent(secondaryPct, 0)}</span>
          <span className="portfolio-mix-chip direct">Direct {formatPercent(directPct, 0)}</span>
        </div>

        <div className="metrics-row">
          <MetricCard label="Year 1 Called Capital" value={formatCurrency(year1CallM * 1e6, 0)} subtext="Faster with secondary/direct mix" accent="#1B2A4A" />
          <MetricCard label="Year 1 NAV" value={formatCurrency(year1NavM * 1e6, 0)} subtext="More immediate exposure" accent="#2D6B4F" />
          <MetricCard label="Year 10 Residual NAV" value={formatCurrency(residualYear10M * 1e6, 0)} subtext="Typically shorter duration with faster-turn assets" accent="#B5473A" />
        </div>

        <h3 className="chart-title">Blended Mix: Drawdown Speed vs NAV</h3>
        <ComparisonChart
          seriesA={mixSeries.called}
          seriesB={mixSeries.nav}
          labelA="Cumulative Drawdown %"
          labelB="NAV % of Annual Commitment"
          xLabels={years.map((year) => `Yr ${year}`)}
          xTickStep={2}
          yFormatter={(value) => `${(value * 100).toFixed(0)}%`}
          colorA="#1B2A4A"
          colorB="#2D6B4F"
          height={250}
        />

        <h3 className="chart-title">Blended NAV vs All-Primary NAV</h3>
        <ComparisonChart
          seriesA={mixSeries.nav}
          seriesB={mixSeries.allPrimaryNav}
          labelA="Blended Mix NAV"
          labelB="All-Primary NAV"
          xLabels={years.map((year) => `Yr ${year}`)}
          xTickStep={2}
          yFormatter={(value) => `${(value * 100).toFixed(0)}%`}
          colorA="#1B2A4A"
          colorB="#9A9690"
          height={250}
        />
        <p className="portfolio-inline-note">
          Makes sense? Unfortunately the above blends really only show you the hypothetical mix of these
          selections, and they only represent how a single year of commitments develop. There is more to go!
        </p>
          </>
        )}
      </div>
    </section>
  );
};

const PortfolioForecastBandChart = ({
  title,
  subtitle,
  bands,
  lineSeries = [],
  focusYear = 8,
  horizonYears = 12,
  maxY = 4
}) => {
  const width = 760;
  const height = 360;
  const padding = { top: 20, right: 24, bottom: 36, left: 52 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const focus = Math.max(0, Math.min(horizonYears, Math.round(focusYear)));
  const activeBand = bands.find((band) => band.active) || bands[bands.length - 1];

  const xFor = (year) => padding.left + (year / horizonYears) * plotWidth;
  const yFor = (value) => padding.top + (1 - value / maxY) * plotHeight;
  const xTicks = useMemo(() => {
    const ticks = [0];
    const stride = horizonYears > 12 ? 3 : 2;
    for (let year = stride; year < horizonYears; year += stride) ticks.push(year);
    if (ticks[ticks.length - 1] !== horizonYears) ticks.push(horizonYears);
    return ticks;
  }, [horizonYears]);

  const buildBandPath = (series) => {
    if (!series || series.length === 0) return '';
    const top = series.map((point) => `${xFor(point.year)},${yFor(point.high)}`).join(' L ');
    const bottom = [...series]
      .reverse()
      .map((point) => `${xFor(point.year)},${yFor(point.low)}`)
      .join(' L ');
    return `M ${top} L ${bottom} Z`;
  };

  const buildLinePath = (series) => {
    if (!series || series.length === 0) return '';
    return series
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(point.year)} ${yFor(point.value)}`)
      .join(' ');
  };

  const focusLow = activeBand?.series?.[focus]?.low ?? 0;
  const focusHigh = activeBand?.series?.[focus]?.high ?? 0;
  const focusX = xFor(focus);
  const yLow = yFor(focusLow);
  const yHigh = yFor(focusHigh);
  const focusLabel = `Focus: Yr ${focus}`;
  const focusLabelWidth = Math.max(86, focusLabel.length * 10 + 10);
  const focusLabelX = Math.min(width - padding.right - focusLabelWidth, focusX + 8);
  const focusLabelY = padding.top + 4;
  const rangeLabel = `${focusLow.toFixed(2)}x to ${focusHigh.toFixed(2)}x`;
  const rangeLabelWidth = Math.max(120, rangeLabel.length * 10 + 10);
  const rangeLabelX = Math.min(width - padding.right - rangeLabelWidth, focusX + 10);
  const rangeLabelY = Math.max(padding.top + 16, yHigh - 22);

  return (
    <div className="portfolio-funnel-chart-shell">
      <div className="portfolio-funnel-chart-head">
        <span className="portfolio-funnel-chart-title">{title}</span>
        <span className="portfolio-funnel-chart-subtitle">{subtitle}</span>
      </div>

      <svg className="portfolio-funnel-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        {[0, 1, 2, 3, 4].map((tick) => (
          <g key={`y-${tick}`}>
            <line
              x1={padding.left}
              y1={yFor(tick)}
              x2={padding.left + plotWidth}
              y2={yFor(tick)}
              stroke="#E4EAF3"
              strokeWidth="1"
            />
            <text x={padding.left - 8} y={yFor(tick) + 6} textAnchor="end" fontSize="19" fill="#6B7488">
              {tick.toFixed(1)}x
            </text>
          </g>
        ))}

        {xTicks.map((year) => (
          <g key={`x-${year}`}>
            <line
              x1={xFor(year)}
              y1={padding.top}
              x2={xFor(year)}
              y2={padding.top + plotHeight}
              stroke="#F1F4FA"
              strokeWidth="1"
            />
            <text x={xFor(year)} y={height - 12} textAnchor="middle" fontSize="18" fill="#6B7488">
              Yr {year}
            </text>
          </g>
        ))}

        {bands.map((band) => (
          <g key={band.key} opacity={band.visible ? 1 : 0}>
            <path d={buildBandPath(band.series)} fill={band.fill} />
            <path d={buildLinePath(band.series.map((point) => ({ year: point.year, value: point.high })))} fill="none" stroke={band.stroke} strokeWidth={band.active ? 2.6 : 1.4} />
            <path d={buildLinePath(band.series.map((point) => ({ year: point.year, value: point.low })))} fill="none" stroke={band.stroke} strokeWidth={band.active ? 2.6 : 1.4} />
          </g>
        ))}

        {lineSeries.map((line) => (
          <path
            key={line.key}
            d={buildLinePath(line.series)}
            fill="none"
            stroke={line.color}
            strokeWidth={line.active ? 2.5 : 1.5}
            strokeDasharray={line.dashed ? '6 4' : 'none'}
            opacity={line.visible ? 1 : 0}
          />
        ))}

        <line x1={focusX} y1={padding.top} x2={focusX} y2={padding.top + plotHeight} stroke="#1B2A4A" strokeWidth="1.2" strokeDasharray="5 4" />
        <rect
          x={focusLabelX}
          y={focusLabelY}
          width={focusLabelWidth}
          height={20}
          rx={4}
          fill="rgba(255,255,255,0.94)"
          stroke="rgba(27, 42, 74, 0.22)"
        />
        <text x={focusLabelX + 6} y={focusLabelY + 14} fontSize="18" fill="#1B2A4A">{focusLabel}</text>

        <line x1={focusX} y1={yHigh} x2={focusX} y2={yLow} stroke={activeBand?.stroke || '#1B2A4A'} strokeWidth="2.4" />
        <circle cx={focusX} cy={yHigh} r="3.2" fill={activeBand?.stroke || '#1B2A4A'} />
        <circle cx={focusX} cy={yLow} r="3.2" fill={activeBand?.stroke || '#1B2A4A'} />
        <rect
          x={rangeLabelX}
          y={rangeLabelY}
          width={rangeLabelWidth}
          height={20}
          rx={4}
          fill="rgba(255,255,255,0.94)"
          stroke="rgba(27, 42, 74, 0.22)"
        />
        <text x={rangeLabelX + 6} y={rangeLabelY + 14} fontSize="18" fill={activeBand?.stroke || '#1B2A4A'}>
          {rangeLabel}
        </text>
      </svg>

      <div className="portfolio-funnel-legend">
        {bands.filter((band) => band.visible).map((band) => (
          <div key={band.key} className={`portfolio-funnel-legend-item ${band.active ? 'active' : ''}`}>
            <span className="swatch" style={{ background: band.fill, borderColor: band.stroke }} />
            <span>{band.label}</span>
          </div>
        ))}
        {lineSeries.filter((line) => line.visible).map((line) => (
          <div key={line.key} className={`portfolio-funnel-legend-item ${line.active ? 'active' : ''}`}>
            <span className="line-swatch" style={{ borderColor: line.color, borderStyle: line.dashed ? 'dashed' : 'solid' }} />
            <span>{line.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const PortfolioFutureForecastSection = () => {
  const HORIZON = 15;
  const MAX_Y = 4.0;
  const FOCUS_YEAR = 8;
  const DEFAULTS = {
    step: 1,
    benchmarkP10: 0.70,
    benchmarkP90: 2.90,
    pathwayLow: 0.35,
    pathwayHigh: 3.20,
    pathwayP10: 0.95,
    pathwayP90: 2.60,
    diversifiedP25: 1.45,
    diversifiedP75: 2.25
  };

  const [step, setStep] = useState(DEFAULTS.step);
  const [benchmarkP10, setBenchmarkP10] = useState(DEFAULTS.benchmarkP10);
  const [benchmarkP90, setBenchmarkP90] = useState(DEFAULTS.benchmarkP90);
  const [pathwayLow, setPathwayLow] = useState(DEFAULTS.pathwayLow);
  const [pathwayHigh, setPathwayHigh] = useState(DEFAULTS.pathwayHigh);
  const [pathwayP10, setPathwayP10] = useState(DEFAULTS.pathwayP10);
  const [pathwayP90, setPathwayP90] = useState(DEFAULTS.pathwayP90);
  const [diversifiedP25, setDiversifiedP25] = useState(DEFAULTS.diversifiedP25);
  const [diversifiedP75, setDiversifiedP75] = useState(DEFAULTS.diversifiedP75);
  const stepRefs = useRef([]);

  const years = useMemo(() => Array.from({ length: HORIZON + 1 }, (_, i) => i), []);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const growthCurve = useMemo(() => {
    const normalizer = 1 - Math.exp(-HORIZON / 4.2);
    return years.map((year) => (1 - Math.exp(-year / 4.2)) / normalizer);
  }, [years]);

  const normalized = useMemo(() => {
    const bLow = clamp(Math.min(benchmarkP10, benchmarkP90 - 0.1), 0.05, MAX_Y - 0.2);
    const bHigh = clamp(Math.max(benchmarkP90, bLow + 0.1), bLow + 0.1, MAX_Y);
    const pLow = clamp(Math.min(pathwayLow, pathwayHigh - 0.1), 0.02, MAX_Y - 0.2);
    const pHigh = clamp(Math.max(pathwayHigh, pLow + 0.1), pLow + 0.1, MAX_Y);
    const p10 = clamp(Math.min(pathwayP10, pathwayP90 - 0.1), pLow, pHigh - 0.1);
    const p90 = clamp(Math.max(pathwayP90, p10 + 0.1), p10 + 0.1, pHigh);
    const d25 = clamp(Math.min(diversifiedP25, diversifiedP75 - 0.1), p10, p90 - 0.1);
    const d75 = clamp(Math.max(diversifiedP75, d25 + 0.1), d25 + 0.1, p90);
    return { bLow, bHigh, pLow, pHigh, p10, p90, d25, d75 };
  }, [benchmarkP10, benchmarkP90, pathwayLow, pathwayHigh, pathwayP10, pathwayP90, diversifiedP25, diversifiedP75]);

  const makeRangeSeries = (lowTerminal, highTerminal, lowPow = 1.15, highPow = 0.95) => {
    return years.map((year, idx) => {
      const g = growthCurve[idx];
      const low = lowTerminal <= 0 ? 0 : lowTerminal * Math.pow(g, lowPow);
      const high = highTerminal * Math.pow(g, highPow);
      return { year, low, high };
    });
  };

  const makeLineSeries = (targetTerminal, pow = 1.0) => (
    years.map((year, idx) => ({
      year,
      value: targetTerminal * Math.pow(growthCurve[idx], pow)
    }))
  );

  const theoretical = useMemo(() => makeRangeSeries(0, MAX_Y, 1.0, 0.86), [years, growthCurve]);
  const benchmarkBand = useMemo(() => makeRangeSeries(normalized.bLow, normalized.bHigh, 1.15, 0.95), [normalized, years, growthCurve]);
  const benchmarkMedian = useMemo(() => makeLineSeries((normalized.bLow + normalized.bHigh) / 2, 1.02), [normalized, years, growthCurve]);
  const pathwayHighLowBand = useMemo(() => makeRangeSeries(normalized.pLow, normalized.pHigh, 1.2, 0.92), [normalized, years, growthCurve]);
  const pathwayPercentileBand = useMemo(() => makeRangeSeries(normalized.p10, normalized.p90, 1.1, 0.98), [normalized, years, growthCurve]);
  const pathwayMedian = useMemo(() => makeLineSeries((normalized.p10 + normalized.p90) / 2, 1.0), [normalized, years, growthCurve]);
  const diversifiedBand = useMemo(() => makeRangeSeries(normalized.d25, normalized.d75, 1.06, 1.0), [normalized, years, growthCurve]);

  const benchmarkBands = [
    {
      key: 'theoretical',
      label: 'Unbounded prior (0 to max)',
      series: theoretical,
      fill: 'rgba(154, 150, 144, 0.20)',
      stroke: '#8E8A84',
      visible: true,
      active: step === 1
    },
    {
      key: 'benchmark',
      label: 'Benchmark p10-p90 band',
      series: benchmarkBand,
      fill: 'rgba(74, 123, 167, 0.35)',
      stroke: '#3F6C97',
      visible: step >= 2,
      active: step === 2
    }
  ];

  const pathwayBands = [
    {
      key: 'pathway-hilo',
      label: 'Pathway high/low observed band (placeholder)',
      series: pathwayHighLowBand,
      fill: 'rgba(181, 71, 58, 0.20)',
      stroke: '#B5473A',
      visible: step >= 3,
      active: step === 3
    },
    {
      key: 'pathway-percentile',
      label: 'Pathway p10-p90 band (placeholder)',
      series: pathwayPercentileBand,
      fill: 'rgba(45, 107, 79, 0.34)',
      stroke: '#2D6B4F',
      visible: step >= 4,
      active: step === 4
    },
    {
      key: 'diversified',
      label: 'Diversified portfolio p25-p75 band',
      series: diversifiedBand,
      fill: 'rgba(201, 168, 76, 0.44)',
      stroke: '#A8892E',
      visible: step >= 5,
      active: step === 5
    }
  ];

  const benchmarkLines = [
    {
      key: 'benchmark-median',
      label: 'Benchmark median',
      series: benchmarkMedian,
      color: '#1B2A4A',
      dashed: true,
      visible: step >= 2,
      active: step === 2
    }
  ];

  const pathwayLines = [
    {
      key: 'pathway-median',
      label: 'Pathway median',
      series: pathwayMedian,
      color: '#1B2A4A',
      dashed: true,
      visible: step >= 4,
      active: step >= 4
    }
  ];

  const activeSeries = step === 1
    ? theoretical
    : step === 2
      ? benchmarkBand
      : step === 3
        ? pathwayHighLowBand
        : step === 4
          ? pathwayPercentileBand
          : diversifiedBand;

  const focusIndex = Math.max(0, Math.min(HORIZON, Math.round(FOCUS_YEAR)));
  const activeLow = activeSeries[focusIndex]?.low ?? 0;
  const activeHigh = activeSeries[focusIndex]?.high ?? 0;
  const activeWidth = activeHigh - activeLow;

  const stepTitles = [
    'Start wide: 0 to max outcomes',
    'Tighten with benchmark percentiles',
    'Switch to Pathway high/low history',
    'Refine with Pathway percentile ranges',
    'Apply diversification smoothing'
  ];

  const stepPrompt = [
    'Everything is possible at first. This is a deliberately unhelpful starting point.',
    'Third-party benchmark medians and percentiles quickly trim the impossible tails.',
    'Manager-level Pathway history provides a stronger bound than broad public benchmarks.',
    'Pathway percentile ranges tighten uncertainty into a usable planning distribution.',
    'Portfolio diversification compresses single-fund volatility into a steadier expected band.'
  ];

  useEffect(() => {
    const nodes = stepRefs.current.filter(Boolean);
    if (!nodes.length) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const nextStep = Number(entry.target.getAttribute('data-step'));
          if (nextStep >= 1 && nextStep <= 5) {
            setStep((prev) => (prev === nextStep ? prev : nextStep));
          }
        });
      },
      {
        root: null,
        rootMargin: '-35% 0px -45% 0px',
        threshold: 0.05
      }
    );

    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  const resetForecast = () => {
    setStep(DEFAULTS.step);
    setBenchmarkP10(DEFAULTS.benchmarkP10);
    setBenchmarkP90(DEFAULTS.benchmarkP90);
    setPathwayLow(DEFAULTS.pathwayLow);
    setPathwayHigh(DEFAULTS.pathwayHigh);
    setPathwayP10(DEFAULTS.pathwayP10);
    setPathwayP90(DEFAULTS.pathwayP90);
    setDiversifiedP25(DEFAULTS.diversifiedP25);
    setDiversifiedP75(DEFAULTS.diversifiedP75);
  };

  return (
    <section id="portfolio-future-forecast" className="content-section">
      <h2>4. Future Forecast Funnel</h2>
      <p>
        Fine, annual commitments build the portfolio. But how do you forecast future NAV amounts
        with enough confidence to plan pacing? This section walks from a deliberately wide uncertainty
        range to a practical planning band.
      </p>
      <p>
        To get a practical starting point, let&apos;s look at data internal to Pathway. The figure below
        plots aggregate RVPI by quarter for every vintage from 1993-2022. The underlying data
        represents a diversified PE portfolio of primary fund investments. You will see that each
        vintage tends to follow a pattern: starting around cost, building in value, then declining
        as portfolio companies are realized. Any given vintage year is affected by factors including
        the macro environment and Pathway&apos;s own diversification choices, but this still provides a
        reasonable baseline for how a diversified vintage of PE investments can progress.
      </p>
      <div className="interactive-block portfolio-rvpi-context-block">
        <div className="block-header">
          <span className="block-title">Observed RVPI Paths Across Pathway Primary Vintages</span>
          <span className="block-subtitle">Each line is one vintage path; dashed navy line shows aggregate median trend</span>
        </div>
        <RvpiVintageTrendChart height={320} />
      </div>
      <p>
        Now let's think about how we can use this rich data to project future portfolio NAV outcomes.
        Scroll through the five steps below.
      </p>

      <div className="interactive-block">
        <div className="block-header">
          <span className="block-title">NAV Forecasting: Narrowing the Cone of Outcomes</span>
          <span className="block-subtitle">X-axis is time (15 years), Y-axis is possible NAV outcome range</span>
        </div>

        <div className="portfolio-funnel-story-grid">
          <div className="portfolio-funnel-left-rail">
            <PortfolioForecastBandChart
              title={`Forecast Funnel: RVPI Ranges Over Time (Step ${step} of 5)`}
              subtitle={stepTitles[step - 1]}
              bands={[...benchmarkBands, ...pathwayBands]}
              lineSeries={[...benchmarkLines, ...pathwayLines]}
              focusYear={FOCUS_YEAR}
              horizonYears={HORIZON}
              maxY={MAX_Y}
            />
            <div className="metrics-row portfolio-funnel-metrics-inline">
              <MetricCard
                label={`Year ${FOCUS_YEAR} Active Range`}
                value={`${activeLow.toFixed(2)}x to ${activeHigh.toFixed(2)}x`}
                subtext={`Step ${step} lens`}
                accent="#1B2A4A"
              />
              <MetricCard
                label={`Year ${FOCUS_YEAR} Width`}
                value={`${activeWidth.toFixed(2)}x`}
                subtext="Top minus bottom"
                accent="#2D6B4F"
              />
            </div>
          </div>

          <div className="portfolio-funnel-step-stack">
            {stepTitles.map((title, idx) => (
              <button
                type="button"
                key={title}
                ref={(node) => { stepRefs.current[idx] = node; }}
                data-step={idx + 1}
                className={`portfolio-funnel-step-card ${step === idx + 1 ? 'active' : step > idx + 1 ? 'done' : ''}`}
                onClick={() => setStep(idx + 1)}
              >
                <span className="portfolio-funnel-step-card-index">Step {idx + 1}</span>
                <span className="portfolio-funnel-step-card-title">{title}</span>
                <span className="portfolio-funnel-step-card-copy">{stepPrompt[idx]}</span>
              </button>
            ))}
            <div className="portfolio-funnel-reset-row">
              <ResetButton onClick={resetForecast} />
            </div>
          </div>
        </div>

        <div className="portfolio-funnel-proprietary">
          <div className="portfolio-funnel-proprietary-title">Pathway&apos;s Expertise</div>
          <p>
            Benchmark data is useful, but it can only narrow the funnel so far. Pathway can
            tighten these ranges further by grounding assumptions in proprietary manager-level
            historical NAV and cash-flow behavior.
          </p>
        </div>

        <details className="portfolio-funnel-advanced">
          <summary>Model inputs (advanced / placeholders)</summary>
          <div className="sliders-grid three-up">
            <Slider
              label="Benchmark P10 Terminal NAV (Placeholder)"
              value={benchmarkP10}
              min={0.2}
              max={2.2}
              step={0.05}
              format={(v) => `${v.toFixed(2)}x`}
              onChange={setBenchmarkP10}
              accent="#4A7BA7"
            />
            <Slider
              label="Benchmark P90 Terminal NAV (Placeholder)"
              value={benchmarkP90}
              min={1.0}
              max={4.0}
              step={0.05}
              format={(v) => `${v.toFixed(2)}x`}
              onChange={setBenchmarkP90}
              accent="#4A7BA7"
            />
            <Slider
              label="Pathway High Terminal (Placeholder)"
              value={pathwayHigh}
              min={1.0}
              max={4.0}
              step={0.05}
              format={(v) => `${v.toFixed(2)}x`}
              onChange={setPathwayHigh}
              accent="#B5473A"
            />
            <Slider
              label="Pathway Low Terminal (Placeholder)"
              value={pathwayLow}
              min={0.0}
              max={1.8}
              step={0.05}
              format={(v) => `${v.toFixed(2)}x`}
              onChange={setPathwayLow}
              accent="#B5473A"
            />
            <Slider
              label="Pathway P10 Terminal (Placeholder)"
              value={pathwayP10}
              min={0.4}
              max={2.4}
              step={0.05}
              format={(v) => `${v.toFixed(2)}x`}
              onChange={setPathwayP10}
              accent="#2D6B4F"
            />
            <Slider
              label="Pathway P90 Terminal (Placeholder)"
              value={pathwayP90}
              min={1.2}
              max={3.4}
              step={0.05}
              format={(v) => `${v.toFixed(2)}x`}
              onChange={setPathwayP90}
              accent="#2D6B4F"
            />
            <Slider
              label="Diversified P25 Terminal"
              value={diversifiedP25}
              min={0.8}
              max={2.6}
              step={0.05}
              format={(v) => `${v.toFixed(2)}x`}
              onChange={setDiversifiedP25}
              accent="#C9A84C"
            />
            <Slider
              label="Diversified P75 Terminal"
              value={diversifiedP75}
              min={1.2}
              max={3.0}
              step={0.05}
              format={(v) => `${v.toFixed(2)}x`}
              onChange={setDiversifiedP75}
              accent="#C9A84C"
            />
          </div>
        </details>
      </div>
    </section>
  );
};

const PortfolioAdjustingExposureSection = () => (
  <section id="portfolio-adjusting" className="content-section">
    <h2>8. Adjusting Exposure</h2>
    <p>
      Moving your exposure to PE up and down is easy, but there are serious consequences to consider.
      We&apos;ll keep this simple for now.
    </p>

    <div className="liquidity-callout-grid">
      <div className="liquidity-callout">
        <h3>Increasing Exposure Quickly</h3>
        <p>
          Invest in secondaries and co-investments to deploy capital faster. That can accelerate exposure,
          but it is still a market call at a discrete point in time and subject to current pricing.
        </p>
      </div>
      <div className="liquidity-callout">
        <h3>Reducing Exposure Quickly</h3>
        <p>
          Sell assets in a secondary transaction to create immediate liquidity. In most cases, this process
          is inefficient and may realize less cash than your current marks.
        </p>
      </div>
      <div className="liquidity-callout">
        <h3>Pathway&apos;s Practical View</h3>
        <p>
          Manage exposure actively at least annually so you are not forced into timing calls that are
          disconnected from portfolio quality or underlying performance.
        </p>
      </div>
    </div>
    <PathwayInlineCta line="Thinking about accelerating or reducing exposure now?" />
  </section>
);

const PortfolioRiffsSection = () => (
  <section id="portfolio-riffs" className="content-section">
    <h2>9. Put This Into Action With Pathway</h2>
    <p>
      The mechanics above are the base layer. The hard part is executing a repeatable program with
      governance, pacing, and liquidity discipline through real market cycles.
    </p>

    <div className="liquidity-callout-grid">
      <div className="liquidity-callout">
        <h3>Commitment Policy Bands</h3>
        <p>Design rules-based commitment bands tied to funded status, pacing ranges, and denominator volatility.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Liquidity Shock Protocol</h3>
        <p>Predefine actions for denominator shocks: pacing cuts, strategy rotation, secondary sales, or holdbacks.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Portfolio Construction Discipline</h3>
        <p>Balance vintages, strategies, and liquidity tools to keep exposure resilient without chasing markets.</p>
      </div>
    </div>

    <div className="portfolio-riffs-cta">
      <div className="portfolio-riffs-cta-title">Want help applying this to your portfolio?</div>
      <p>
        You can learn more in our{' '}
        <a href="#liquidity-hero">Liquidity Management section</a>{' '}
        or reach out directly at{' '}
        <a href="mailto:newinvestors@pathwaycapital.com">newinvestors@pathwaycapital.com</a>.
      </p>
    </div>

    <WhatWeDidntCover
      items={[
        'Program-level leverage or NAV credit facilities and their effect on pacing flexibility.',
        'Currency effects for global portfolios and how FX can distort denominator-based exposure targets.',
        'How manager concentration limits should differ by strategy maturity and secondary liquidity depth.',
        'Operational implementation: staffing model, pacing committee cadence, and live commitment approval workflows.',
        'How to calibrate forecasting priors by strategy, region, and market regime before turning ranges into pacing decisions.'
      ]}
    />
  </section>
);

const PortfolioSourcesFooter = () => (
  <section className="content-section">
    <div className="sources-footer">
      <div className="sources-title">Sources</div>
      <ol className="sources-list">
        <li>
          "Set it and forget it" pop-culture reference:{' '}
          <a href="https://commons.wikimedia.org/wiki/Special:FilePath/Ron_Popeil.jpeg" target="_blank" rel="noreferrer">
            Ron Popeil image
          </a>
        </li>
      </ol>
    </div>
  </section>
);

const AsiaHeroSection = () => (
  <section id="asia-hero" className="hero-section asia-hero">
    <div className="draft-hero-banner">DRAFT - NOT FINAL</div>
    <div className="pathway-badge">Pathway Education</div>
    <h1>Investing in Private Equity in Asia</h1>
    <p className="hero-subtitle">A practical LP framework for strategy, manager selection, and implementation risk</p>
    <p className="hero-purpose-note">
      Asia can offer strong growth, deep company-formation pipelines, and differentiated access opportunities.
      It also requires tighter underwriting discipline on governance, legal structure, currency, and exit realism.
    </p>
    <div className="hero-scroll-note">Use this page as a working checklist for portfolio design and manager conversations</div>
  </section>
);

const AsiaWhyNowSection = () => (
  <section id="asia-why-now" className="content-section">
    <h2>1. Why Include Asia in a PE Program?</h2>
    <p>
      For many LPs, Asia is not just a geography call. It is a return-source diversification decision.
      Company growth profiles, financing ecosystems, and exit channels can differ from the US and Europe,
      creating differentiated opportunity sets when selected carefully.
    </p>
    <div className="liquidity-callout-grid">
      <div className="liquidity-callout">
        <h3>Growth + Innovation Exposure</h3>
        <p>Sector expansion in technology, healthcare, manufacturing modernization, and consumer ecosystems can create distinct value-creation paths.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Diversification Value</h3>
        <p>Regional cycles can be imperfectly correlated with Western buyout cycles, which can support better program-level risk balance.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Implementation Matters</h3>
        <p>The dispersion between top and median outcomes is often wide, so manager selection and pacing policy drive realized results.</p>
      </div>
    </div>
    <PathwayInlineCta line="Need help deciding how much Asia exposure belongs in your overall private markets program?" />
  </section>
);

const AsiaMarketStructureSection = () => (
  <section id="asia-market-structure" className="content-section">
    <h2>2. Market Structure: What Is Different in Asia?</h2>
    <p>
      Asia is not one market. Country-level legal frameworks, listing channels, currency regimes,
      and sponsor ecosystems vary meaningfully. Underwriting should start with local market structure,
      not a single regional average.
    </p>
    <div className="interactive-block">
      <div className="portfolio-commentary-block">
        <h3 className="portfolio-commentary-title">Key Structural Variables To Underwrite</h3>
        <table className="portfolio-commentary-table">
          <tbody>
            <tr>
              <th scope="row">Governance</th>
              <td>Minority protections, board control, and enforcement norms can materially impact downside protection.</td>
            </tr>
            <tr>
              <th scope="row">Legal structure</th>
              <td>Fund domicile, tax treaties, and local corporate-law realities can change net outcomes to LPs.</td>
            </tr>
            <tr>
              <th scope="row">Exit channels</th>
              <td>Trade sale, sponsor-to-sponsor, and IPO depth differ by market and by cycle, affecting hold periods and realizations.</td>
            </tr>
            <tr>
              <th scope="row">Currency</th>
              <td>FX can dominate near-term reported performance if not framed clearly at underwriting and portfolio levels.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
);

const AsiaDueDiligenceSection = () => (
  <section id="asia-dd" className="content-section">
    <h2>3. Manager Due Diligence Priorities</h2>
    <p>
      The central question is not whether a manager has one strong fund, but whether their sourcing,
      governance, and exit process is repeatable across cycles.
    </p>
    <div className="liquidity-callout-grid">
      <div className="liquidity-callout">
        <h3>Deal Access Quality</h3>
        <p>Look for repeatable proprietary or advantaged sourcing, not only intermediated auction participation.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Underwriting Discipline</h3>
        <p>Pressure-test assumptions on revenue quality, leverage tolerance, working-capital behavior, and downside cases.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Post-Investment Execution</h3>
        <p>Assess operating value creation, local board effectiveness, and cadence of intervention when plans miss.</p>
      </div>
    </div>
    <div className="interactive-block">
      <p className="portfolio-inline-note">
        Practical DD prompt: ask managers to walk one top-quartile and one weak deal end-to-end, including
        original underwriting, what broke, what changed, and how exit value was ultimately realized.
      </p>
    </div>
  </section>
);

const AsiaPortfolioDesignSection = () => {
  const [strategyLens, setStrategyLens] = useState('buyout');
  const lensText = {
    buyout: 'Buyout sleeves can improve governance control and operating intervention, but entry pricing and leverage assumptions need conservative stress tests.',
    growth: 'Growth equity can capture structural expansion and founder-led value creation, but underwriting quality of growth and path to liquidity is critical.',
    venture: 'Venture can provide upside convexity and innovation access, but outcome dispersion and duration risk are typically highest.',
    secondaries: 'Secondaries can improve pacing and shorten J-curve effects, but discounts/premiums and asset-quality dispersion require deep portfolio-level analysis.'
  };

  return (
    <section id="asia-portfolio-design" className="content-section">
      <h2>4. Portfolio Design Across Strategies and Types</h2>
      <p>
        A durable Asia allocation usually combines multiple sleeves rather than relying on one strategy.
        The goal is to balance return potential, pacing, and liquidity realism.
      </p>
      <div className="interactive-block">
        <div className="environment-toolbar-group">
          <span className="environment-toolbar-label">Strategy Lens</span>
          <ToggleSwitch
            options={[
              { label: 'Buyout', value: 'buyout' },
              { label: 'Growth', value: 'growth' },
              { label: 'Venture', value: 'venture' },
              { label: 'Secondaries', value: 'secondaries' }
            ]}
            value={strategyLens}
            onChange={setStrategyLens}
            accent="#1B2A4A"
          />
        </div>
        <p className="portfolio-inline-note">{lensText[strategyLens]}</p>
        <div className="metrics-row">
          <MetricCard label="Pacing Goal" value="Smooth NAV Build" subtext="Avoid concentration in one vintage or one strategy" accent="#1B2A4A" />
          <MetricCard label="Liquidity Goal" value="Realistic Exit Map" subtext="Align strategy weights with likely hold periods" accent="#2D6B4F" />
          <MetricCard label="Risk Goal" value="Controlled Dispersion" subtext="Diversify by country, strategy, and GP process quality" accent="#B5473A" />
        </div>
      </div>
      <PathwayInlineCta line="Want support turning this into an executable Asia pacing plan?" />
    </section>
  );
};

const AsiaExecutionGovernanceSection = () => (
  <section id="asia-execution-governance" className="content-section">
    <h2>5. Execution and Governance: Where Programs Win or Lose</h2>
    <p>
      Strong strategy design can still underperform if governance and implementation are weak.
      Define operating rules before the market is stressed.
    </p>
    <div className="liquidity-callout-grid">
      <div className="liquidity-callout">
        <h3>Decision Cadence</h3>
        <p>Set an annual and quarterly pacing cadence so commitment decisions are process-driven, not sentiment-driven.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Risk Limits</h3>
        <p>Use explicit ranges for country concentration, manager concentration, and strategy drift.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Escalation Rules</h3>
        <p>Predefine what triggers pacing cuts, secondary sales, or strategy reweighting when conditions move quickly.</p>
      </div>
    </div>
  </section>
);

const AsiaRedFlagsSection = () => (
  <section id="asia-red-flags" className="content-section">
    <h2>6. Red Flags to Watch Closely</h2>
    <div className="interactive-block">
      <ul className="portfolio-targeting-questions">
        <li>Fund narrative relies on macro tailwinds but provides weak deal-level evidence.</li>
        <li>Attribution is dominated by mark-up optimism with limited realized exits.</li>
        <li>Underwriting memos do not show a robust downside plan or governance path.</li>
        <li>Team turnover is high, with key local operators recently departed.</li>
        <li>FX and legal-structure risk are treated as minor instead of modeled explicitly.</li>
        <li>Portfolio concentration is justified as conviction without clear risk controls.</li>
      </ul>
    </div>
  </section>
);

const AsiaPlaybookSection = () => (
  <section id="asia-playbook" className="content-section">
    <h2>7. LP Playbook: How to Implement Thoughtfully</h2>
    <p>
      Start with clear objectives, build a pacing plan that acknowledges uncertainty, and maintain
      governance discipline when market narratives swing.
    </p>
    <div className="liquidity-callout-grid">
      <div className="liquidity-callout">
        <h3>Define the role of Asia</h3>
        <p>Clarify whether Asia is expected to add growth, diversification, liquidity optionality, or all three.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Build by vintages, not headlines</h3>
        <p>Use multi-year commitment pacing to avoid accidental market timing and concentration risk.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Review outcomes annually</h3>
        <p>Re-underwrite manager assumptions and rebalance strategy/country weights based on realized evidence.</p>
      </div>
    </div>
    <PathwayInlineCta line="If you want to discuss Asia PE allocation design in detail, Pathway can help." />
  </section>
);

const CustomTermsHeroSection = () => (
  <section id="custom-terms-hero" className="hero-section liquidity-hero">
    <div className="hero-kicker">Custom Infrastructure Terms</div>
    <h1>EDIF IV Economic Terms Comparison</h1>
    <p className="hero-summary">
      This page compares a custom structure against a traditional PE structure using the same pacing and return path.
      Pacing is fixed to a typical infrastructure curve so the model isolates what the terms themselves do to LP cash timing
      and net outcomes.
    </p>
    <div className="liquidity-callout-grid">
      <div className="liquidity-callout">
        <h3>Custom structure modeled</h3>
        <p>6% hurdle, no catch-up, 20% carry only above hurdle, 3% minimum LP net yield gate, fee on invested capital, and annual carry payment cap at 1.5% of NAV.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Traditional comparison</h3>
        <p>8% hurdle, full catch-up approximation, and standard fee basis (committed during investment period, then NAV).</p>
      </div>
      <div className="liquidity-callout">
        <h3>Timing stress test</h3>
        <p>Run shared gross-return scenarios and see how the term structures alone shift LP outcomes.</p>
      </div>
    </div>
  </section>
);

const CustomTermsModelSection = () => {
  const years = 12;
  const [feeDiscountTier, setFeeDiscountTier] = useState('firstClose');
  const [lateHurdleStress, setLateHurdleStress] = useState(false);
  const customDefaults = useMemo(() => ({
    commitmentM: 150,
    baseReturn: 0.13,
    feeRate: 0.0085,
    feeMode: 'invested',
    hurdleRate: 0.06,
    carryRate: 0.20,
    catchupMode: 'none',
    hasCarryCap: true,
    annualCarryCapRate: 0.015,
    minNetYieldRate: 0.03,
    escrowFraction: 2 / 3
  }), []);

  const traditionalDefaults = useMemo(() => ({
    commitmentM: 150,
    baseReturn: 0.13,
    feeRate: 0.0100,
    feeMode: 'committed',
    stepDownEnabled: true,
    stepDownFeeRate: 0.0080,
    stepDownBasis: 'nav',
    hurdleRate: 0.08,
    carryRate: 0.20,
    catchupMode: 'full',
    hasCarryCap: false,
    annualCarryCapRate: 0.015
  }), []);

  const [customFund, setCustomFund] = useState(customDefaults);
  const [traditionalFund, setTraditionalFund] = useState(traditionalDefaults);
  const customHeadlineFee = useMemo(() => getEdifFeeRate(customFund.commitmentM, 'headline'), [customFund.commitmentM]);
  const customEffectiveFee = useMemo(() => getEdifFeeRate(customFund.commitmentM, feeDiscountTier), [customFund.commitmentM, feeDiscountTier]);
  const traditionalHeadlineFee = useMemo(() => getEdifFeeRate(traditionalFund.commitmentM, 'headline'), [traditionalFund.commitmentM]);
  const customSelectedFee = Number.isFinite(customFund.feeRate) ? customFund.feeRate : customEffectiveFee;
  const traditionalSelectedFee = Number.isFinite(traditionalFund.feeRate) ? traditionalFund.feeRate : traditionalHeadlineFee;
  const activeDistributionCurve = lateHurdleStress ? LATE_HURDLE_DISTRIBUTION_PCT : TYPICAL_INFRA_DISTRIBUTION_PCT;
  const customReturnPath = useMemo(() => buildAnnualReturnPath(customFund.baseReturn, lateHurdleStress), [customFund.baseReturn, lateHurdleStress]);
  const traditionalReturnPath = useMemo(() => buildAnnualReturnPath(traditionalFund.baseReturn, lateHurdleStress), [traditionalFund.baseReturn, lateHurdleStress]);

  const updateFund = (setter, key, value) => {
    setter((prev) => ({ ...prev, [key]: value }));
  };

  const buildTerms = (fund) => ({
    feeMode: fund.feeMode,
    feeRate: fund.feeRate,
    stepDownEnabled: Boolean(fund.stepDownEnabled),
    stepDownFeeRate: fund.stepDownFeeRate ?? fund.feeRate,
    stepDownBasis: fund.stepDownBasis || 'nav',
    expenseRate: 0.002,
    hurdleRate: fund.hurdleRate,
    carryRate: fund.carryRate,
    catchupMode: fund.catchupMode || 'full',
    annualCarryCapRate: fund.hasCarryCap ? fund.annualCarryCapRate : Number.POSITIVE_INFINITY,
    minNetYieldRate: fund.minNetYieldRate || 0,
    escrowFraction: fund.escrowFraction || 0,
    investmentPeriodYears: 5,
    forceLiquidationAtEnd: false
  });

  const renderFundControls = ({ fund, setter, title, accent }) => (
    <div className="custom-terms-fund-card">
      <div className="custom-terms-fund-head">
        <div className="custom-terms-fund-title" style={{ color: accent }}>{title}</div>
      </div>

      <div className="sliders-grid three-up">
        <Slider value={fund.commitmentM} onChange={(v) => updateFund(setter, 'commitmentM', v)} min={25} max={500} step={5} label="Commitment Size ($M)" format={(v) => `$${v.toFixed(0)}M`} accent={accent} />
        <Slider value={fund.baseReturn} onChange={(v) => updateFund(setter, 'baseReturn', v)} min={0.08} max={0.20} step={0.005} label="Annual Gross Return" format={(v) => formatPercent(v, 1)} accent={accent} />
        <Slider value={Number.isFinite(fund.feeRate) ? fund.feeRate : (title === 'Custom Fund' ? customEffectiveFee : traditionalHeadlineFee)} onChange={(v) => updateFund(setter, 'feeRate', v)} min={0} max={0.03} step={0.0005} label="Fee Rate" format={(v) => formatPercent(v, 2)} />
        <Slider value={fund.hurdleRate} onChange={(v) => updateFund(setter, 'hurdleRate', v)} min={0} max={0.12} step={0.0025} label="Hurdle Rate" format={(v) => formatPercent(v, 1)} />
        <Slider value={fund.carryRate} onChange={(v) => updateFund(setter, 'carryRate', v)} min={0} max={0.30} step={0.005} label="Carry Rate" format={(v) => formatPercent(v, 1)} />
        <Slider
          value={fund.minNetYieldRate || 0}
          onChange={(v) => updateFund(setter, 'minNetYieldRate', v)}
          min={0}
          max={0.08}
          step={0.001}
          label="Min LP Net Yield Gate"
          format={(v) => formatPercent(v, 1)}
          disabled={title !== 'Custom Fund'}
        />
        <Slider
          value={fund.escrowFraction || 0}
          onChange={(v) => updateFund(setter, 'escrowFraction', v)}
          min={0}
          max={1}
          step={0.01}
          label="Carry Escrow Fraction"
          format={(v) => formatPercent(v, 0)}
          disabled={title !== 'Custom Fund'}
        />
        {fund.hasCarryCap ? (
          <Slider value={fund.annualCarryCapRate} onChange={(v) => updateFund(setter, 'annualCarryCapRate', v)} min={0} max={0.2} step={0.001} label="Annual Carry Cap Threshold (% NAV)" format={(v) => formatPercent(v, 1)} />
        ) : null}
      </div>

      <div className="toggle-row">
        <span className="toggle-label">Fee Basis Mode</span>
        <ToggleSwitch
          options={[
            { label: 'Invested', value: 'invested' },
            { label: 'Committed', value: 'committed' },
            { label: 'NAV', value: 'nav' }
          ]}
          value={fund.feeMode}
          onChange={(v) => updateFund(setter, 'feeMode', v)}
          accent={accent}
        />
      </div>
      <div className="metric-subtext">
        Headline fee: {title === 'Custom Fund'
          ? formatPercent(customHeadlineFee, 2)
          : formatPercent(traditionalHeadlineFee, 2)}
        {title === 'Custom Fund' ? ` | ${feeDiscountTier} tier ref: ${formatPercent(customEffectiveFee, 2)}` : ''} | Fee selected: {formatPercent(Number.isFinite(fund.feeRate) ? fund.feeRate : (title === 'Custom Fund' ? customEffectiveFee : traditionalHeadlineFee), 2)}
      </div>
      <div className="toggle-row">
        <span className="toggle-label">Catch-up Mode</span>
        <ToggleSwitch
          options={[
            { label: 'No Catch-up', value: 'none' },
            { label: 'Full Catch-up', value: 'full' }
          ]}
          value={fund.catchupMode}
          onChange={(v) => updateFund(setter, 'catchupMode', v)}
          accent={accent}
        />
      </div>
      <div className="toggle-row">
        <span className="toggle-label">Annual Carry Cap</span>
        <ToggleSwitch
          options={[
            { label: 'Yes', value: true },
            { label: 'No', value: false }
          ]}
          value={fund.hasCarryCap}
          onChange={(v) => updateFund(setter, 'hasCarryCap', v)}
          accent={accent}
        />
      </div>
      {title === 'Traditional Fund' ? (
        <>
          <div className="toggle-row">
            <span className="toggle-label">Fee Step-Down (Post Investment Period)</span>
            <ToggleSwitch
              options={[
                { label: 'Yes', value: true },
                { label: 'No', value: false }
              ]}
              value={Boolean(fund.stepDownEnabled)}
              onChange={(v) => updateFund(setter, 'stepDownEnabled', v)}
              accent={accent}
            />
          </div>
          {fund.stepDownEnabled ? (
            <div className="sliders-grid two-up">
              <Slider value={fund.stepDownFeeRate || 0} onChange={(v) => updateFund(setter, 'stepDownFeeRate', v)} min={0} max={0.03} step={0.0005} label="Post-Period Fee Rate" format={(v) => formatPercent(v, 2)} />
              <div className="toggle-row" style={{ marginBottom: 0 }}>
                <span className="toggle-label">Step-Down Fee Basis</span>
                <ToggleSwitch
                  options={[
                    { label: 'NAV', value: 'nav' },
                    { label: 'Invested', value: 'invested' },
                    { label: 'Committed', value: 'committed' }
                  ]}
                  value={fund.stepDownBasis || 'nav'}
                  onChange={(v) => updateFund(setter, 'stepDownBasis', v)}
                  accent={accent}
                />
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );

  const customModel = useMemo(() => runTermStructureModel({
    commitmentM: customFund.commitmentM,
    contributionPctByYear: TYPICAL_INFRA_CONTRIBUTION_PCT,
    distributionPctByYear: activeDistributionCurve,
    baseReturn: customFund.baseReturn,
    timingSkew: 0,
    annualReturnPath: customReturnPath,
    escrowYield: 0,
    lpAltReinvestRate: 0.06,
    terms: buildTerms({ ...customFund, feeRate: customSelectedFee })
  }), [customFund, activeDistributionCurve, customReturnPath, customSelectedFee]);

  const traditionalModel = useMemo(() => runTermStructureModel({
    commitmentM: traditionalFund.commitmentM,
    contributionPctByYear: TYPICAL_INFRA_CONTRIBUTION_PCT,
    distributionPctByYear: activeDistributionCurve,
    baseReturn: traditionalFund.baseReturn,
    timingSkew: 0,
    annualReturnPath: traditionalReturnPath,
    escrowYield: 0,
    lpAltReinvestRate: 0.06,
    terms: buildTerms({ ...traditionalFund, feeRate: traditionalSelectedFee })
  }), [traditionalFund, activeDistributionCurve, traditionalReturnPath, traditionalSelectedFee]);

  const scenarioCurve = useMemo(() => {
    const returns = [];
    const customNetMultiple = [];
    const traditionalNetMultiple = [];
    for (let r = 0.08; r <= 0.1801; r += 0.01) {
      const annualReturn = Number(r.toFixed(3));
      const custom = runTermStructureModel({
        commitmentM: customFund.commitmentM,
        contributionPctByYear: TYPICAL_INFRA_CONTRIBUTION_PCT,
        distributionPctByYear: activeDistributionCurve,
        baseReturn: annualReturn,
        timingSkew: 0,
        annualReturnPath: buildAnnualReturnPath(annualReturn, lateHurdleStress),
        escrowYield: 0,
        lpAltReinvestRate: 0.06,
        terms: buildTerms({ ...customFund, feeRate: customSelectedFee })
      });
      const traditional = runTermStructureModel({
        commitmentM: traditionalFund.commitmentM,
        contributionPctByYear: TYPICAL_INFRA_CONTRIBUTION_PCT,
        distributionPctByYear: activeDistributionCurve,
        baseReturn: annualReturn,
        timingSkew: 0,
        annualReturnPath: buildAnnualReturnPath(annualReturn, lateHurdleStress),
        escrowYield: 0,
        lpAltReinvestRate: 0.06,
        terms: buildTerms({ ...traditionalFund, feeRate: traditionalSelectedFee })
      });
      returns.push(`${(annualReturn * 100).toFixed(0)}%`);
      customNetMultiple.push(custom.totals.netMultiple);
      traditionalNetMultiple.push(traditional.totals.netMultiple);
    }
    return { returns, customNetMultiple, traditionalNetMultiple };
  }, [customFund, traditionalFund, activeDistributionCurve, lateHurdleStress, customSelectedFee, traditionalSelectedFee]);

  const commitmentSensitivity = useMemo(() => {
    const commits = [25, 50, 100, 150, 250, 350, 500];
    const labels = commits.map((c) => `$${c}M`);
    const customTiered = commits.map((c) => {
      const feeRate = getEdifFeeRate(c, feeDiscountTier);
      const model = runTermStructureModel({
        commitmentM: c,
        contributionPctByYear: TYPICAL_INFRA_CONTRIBUTION_PCT,
        distributionPctByYear: activeDistributionCurve,
        baseReturn: customFund.baseReturn,
        timingSkew: 0,
        annualReturnPath: buildAnnualReturnPath(customFund.baseReturn, lateHurdleStress),
        escrowYield: 0,
        lpAltReinvestRate: 0.06,
        terms: buildTerms({ ...customFund, feeRate })
      });
      return model.totals.netMultiple;
    });
    const traditionalFlat = commits.map((c) => {
      const model = runTermStructureModel({
        commitmentM: c,
        contributionPctByYear: TYPICAL_INFRA_CONTRIBUTION_PCT,
        distributionPctByYear: activeDistributionCurve,
        baseReturn: traditionalFund.baseReturn,
        timingSkew: 0,
        annualReturnPath: buildAnnualReturnPath(traditionalFund.baseReturn, lateHurdleStress),
        escrowYield: 0,
        lpAltReinvestRate: 0.06,
        terms: buildTerms({ ...traditionalFund, feeRate: getEdifFeeRate(c, 'headline') })
      });
      return model.totals.netMultiple;
    });
    return { labels, customTiered, traditionalFlat };
  }, [customFund, traditionalFund, activeDistributionCurve, feeDiscountTier, lateHurdleStress]);

  const yearlyLpNetCustomM = customModel.rows.map((row) => (row.lpDistribution - row.called - row.fee - row.expense) / 1e6);
  const yearlyLpNetTraditionalM = traditionalModel.rows.map((row) => (row.lpDistribution - row.called - row.fee - row.expense) / 1e6);
  const yearLabels = Array.from({ length: years }, (_, i) => `Y${i + 1}`);

  return (
    <section id="custom-terms-model" className="content-section">
      <h2>Interactive Term Sheet Comparison</h2>
      <p>
        Both structures use the exact same infrastructure pacing, return path, and expense assumption. The only differences
        are terms, so you can isolate what those terms do to LP return and cash timing.
      </p>

      <div className="interactive-block custom-terms-block">
        <div className="block-header">
          <span className="block-title">Fund-by-Fund Controls</span>
          <span className="block-subtitle">Pacing and timing are fixed; drag a small set of high-impact terms</span>
        </div>
        <div className="block-actions">
          <ResetButton
            label="Reset Inputs"
            onClick={() => {
              setFeeDiscountTier('firstClose');
              setCustomFund(customDefaults);
              setTraditionalFund(traditionalDefaults);
            }}
          />
        </div>
        <div className="custom-terms-fund-grid">
          {renderFundControls({ fund: customFund, setter: setCustomFund, title: 'Custom Fund', accent: '#B5473A' })}
          {renderFundControls({ fund: traditionalFund, setter: setTraditionalFund, title: 'Traditional Fund', accent: '#1B2A4A' })}
        </div>
        <div className="toggle-row">
          <span className="toggle-label">Late Hurdle Stress</span>
          <ToggleSwitch
            options={[
              { label: 'Off', value: false },
              { label: 'On', value: true }
            ]}
            value={lateHurdleStress}
            onChange={setLateHurdleStress}
            accent="#C9A84C"
          />
        </div>
        <p className="portfolio-inline-note">
          <strong>What this toggle does:</strong> it back-ends realization by shifting annual distributions later
          in fund life and uses a back-loaded annual return path. That delays hurdle attainment and is where
          `no catch-up` can materially reduce or delay GP carry versus a traditional catch-up structure.
        </p>

        <div className="metrics-row">
          <MetricCard label="Custom LP Net TVPI" value={`${customModel.totals.netMultiple.toFixed(2)}x`} subtext={customModel.totals.lpIrr !== null ? `${formatPercent(customModel.totals.lpIrr, 1)} IRR (incl. terminal NAV)` : 'IRR n/a'} accent="#B5473A" />
          <MetricCard label="Traditional LP Net TVPI" value={`${traditionalModel.totals.netMultiple.toFixed(2)}x`} subtext={traditionalModel.totals.lpIrr !== null ? `${formatPercent(traditionalModel.totals.lpIrr, 1)} IRR (incl. terminal NAV)` : 'IRR n/a'} accent="#1B2A4A" />
          <MetricCard label="Custom Escrow Deposits" value={formatCurrency(customModel.totals.totalCarryEscrowed, 0)} subtext="Carry routed into escrow account" accent="#9A9690" />
          <MetricCard label="Escrow Final Allocation" value={`${formatCurrency(customModel.totals.escrowPayoutToGPFinal, 0)} GP / ${formatCurrency(customModel.totals.escrowReturnedToLPFinal, 0)} LP`} subtext="At final true-up" accent="#2D6B4F" />
        </div>

        <div className="underinvesting-charts">
          <div className="tradeoff-curve underinvesting-curve">
            <div className="tradeoff-curve-title">Net TVPI Across Return Scenarios</div>
            <ComparisonChart
              seriesA={scenarioCurve.customNetMultiple}
              seriesB={scenarioCurve.traditionalNetMultiple}
              labelA="Custom"
              labelB="Traditional"
              xLabels={scenarioCurve.returns}
              xTickStep={2}
              yFormatter={(v) => `${v.toFixed(2)}x`}
              colorA="#B5473A"
              colorB="#1B2A4A"
              height={220}
              showLegend={false}
            />
          </div>

          <div className="tradeoff-curve underinvesting-curve">
            <div className="tradeoff-curve-title">Annual LP Net Cash Flow (After Fees/Carry)</div>
            <ComparisonChart
              seriesA={yearlyLpNetCustomM}
              seriesB={yearlyLpNetTraditionalM}
              labelA="Custom LP Net CF"
              labelB="Traditional LP Net CF"
              xLabels={yearLabels}
              xTickStep={1}
              yFormatter={(v) => formatCurrency(v * 1e6, 0)}
              colorA="#B5473A"
              colorB="#1B2A4A"
              height={220}
              showLegend={false}
            />
          </div>
        </div>

        <div className="tradeoff-curve underinvesting-curve">
          <div className="tradeoff-curve-title">Commitment Size Fee-Discount Sensitivity (Custom vs Traditional)</div>
          <div className="toggle-row">
            <span className="toggle-label">Custom Discount Tier</span>
            <ToggleSwitch
              options={[
                { label: 'First Close', value: 'firstClose' },
                { label: 'Headline', value: 'headline' },
                { label: 'Existing', value: 'existing' }
              ]}
              value={feeDiscountTier}
              onChange={setFeeDiscountTier}
              accent="#B5473A"
            />
          </div>
          <ComparisonChart
            seriesA={commitmentSensitivity.customTiered}
            seriesB={commitmentSensitivity.traditionalFlat}
            labelA="Custom (Tiered Fee)"
            labelB="Traditional (Current Fee)"
            xLabels={commitmentSensitivity.labels}
            xTickStep={1}
            yFormatter={(v) => `${v.toFixed(2)}x`}
            colorA="#B5473A"
            colorB="#1B2A4A"
            height={220}
            showLegend={false}
          />
        </div>

        <div className="assumptions-table-container schedule-table-container">
          <table className="assumptions-table schedule-table custom-terms-table">
            <thead>
              <tr>
                <th>Year</th>
                <th>Custom NAV Start</th>
                <th>Custom Carry Cap</th>
                <th>Custom Escrow In</th>
                <th>Custom Escrow Out (GP)</th>
                <th>Custom Escrow Out (LP)</th>
                <th>Custom Escrow End</th>
                <th>Custom LP Net CF</th>
                <th>Traditional NAV Start</th>
                <th>Traditional Carry Cap</th>
                <th>Traditional LP Net CF</th>
              </tr>
            </thead>
            <tbody>
              {customModel.rows.map((customRow, idx) => {
                const tradRow = traditionalModel.rows[idx];
                const customLpNet = customRow.lpDistribution - customRow.called - customRow.fee - customRow.expense;
                const tradLpNet = tradRow.lpDistribution - tradRow.called - tradRow.fee - tradRow.expense;
                return (
                  <tr key={`custom-terms-row-${idx}`}>
                    <td>{customRow.year}</td>
                    <td>{formatCurrency(customRow.navStart, 0)}</td>
                    <td>{customRow.annualCarryCapAmount === null ? 'Uncapped' : formatCurrency(customRow.annualCarryCapAmount, 0)}</td>
                    <td>{formatCurrency(customRow.escrowDeposit, 0)}</td>
                    <td>{formatCurrency(customRow.escrowReleaseToGP, 0)}</td>
                    <td>{formatCurrency(customRow.escrowReturnToLP, 0)}</td>
                    <td>{formatCurrency(customRow.escrowBalanceEnd, 0)}</td>
                    <td>{formatCurrency(customLpNet, 0)}</td>
                    <td>{formatCurrency(tradRow.navStart, 0)}</td>
                    <td>{tradRow.annualCarryCapAmount === null ? 'Uncapped' : formatCurrency(tradRow.annualCarryCapAmount, 0)}</td>
                    <td>{formatCurrency(tradLpNet, 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="portfolio-inline-note">
          <strong>Escrow relevance for LPs:</strong> escrow mostly changes GP payment timing and clawback protection.
          LP economics change primarily if escrow is released back to LP at final true-up or if foregone LP reinvestment is material.
        </p>
        <p className="portfolio-inline-note">
          <strong>Modeling simplification:</strong> both funds use the same fixed infra pacing and a common expense assumption of 20 bps,
          so differences shown are driven by fee basis, hurdle/carry terms, annual carry cap mechanics, and escrow treatment.
        </p>
        <div className="assumptions-table-container">
          <div className="roadmap-title">EDIF Fee Discount Reference (Management Fee on Invested Capital)</div>
          <table className="assumptions-table custom-terms-table">
            <thead>
              <tr>
                <th>Commitment Tier</th>
                <th>Headline Fee</th>
                <th>With First Close</th>
                <th>FC + Existing Investor</th>
              </tr>
            </thead>
            <tbody>
              {EDIF_FEE_DISCOUNT_SCHEDULE.map((row, idx) => {
                const tierLabel = row.max === Number.POSITIVE_INFINITY
                  ? `>= $${row.min}M`
                  : `$${row.min}M - $${row.max}M`;
                const customInTier = customFund.commitmentM >= row.min && customFund.commitmentM < row.max;
                const traditionalInTier = traditionalFund.commitmentM >= row.min && traditionalFund.commitmentM < row.max;
                return (
                  <tr key={`fee-tier-${idx}`} className={customInTier || traditionalInTier ? 'post-investment' : ''}>
                    <td className="basis-cell">
                      <span className="basis-value">{tierLabel}{customInTier ? ' (Custom)' : ''}{traditionalInTier ? ' (Traditional)' : ''}</span>
                    </td>
                    <td>{formatPercent(row.headline, 2)}</td>
                    <td>{formatPercent(row.firstClose, 2)}</td>
                    <td>{formatPercent(row.existing, 2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="table-note">
            Custom headline: {formatPercent(customHeadlineFee, 2)} at ${customFund.commitmentM.toFixed(0)}M.
            Traditional headline: {formatPercent(traditionalHeadlineFee, 2)} at ${traditionalFund.commitmentM.toFixed(0)}M.
            Traditional always uses headline; custom uses selected discount tier.
          </div>
        </div>
      </div>
    </section>
  );
};

// ============================================================================
// MAIN APP
// ============================================================================

export default function App() {
  const [globalGrossMultiple, setGlobalGrossMultiple] = useState(BASELINE_GROSS_TVPI);
  const [globalDeploymentRate, setGlobalDeploymentRate] = useState(1.0);
  const compactControls = true;
  const [hasAcceptedDisclaimer, setHasAcceptedDisclaimer] = useState(false);
  const [disclaimerReady, setDisclaimerReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const validHashes = new Set(SECTION_LINKS.map((section) => section.id));
    const hash = window.location.hash.replace('#', '').toLowerCase();
    if (hash && !validHashes.has(hash)) {
      window.location.hash = SECTION_LINKS[0].id;
    }
  }, []);

  useEffect(() => {
    let acknowledged = false;
    try {
      acknowledged = window.localStorage.getItem(DISCLAIMER_STORAGE_KEY) === 'true';
    } catch (_) {
      acknowledged = false;
    }
    setHasAcceptedDisclaimer(acknowledged);
    setDisclaimerReady(true);
  }, []);

  useEffect(() => {
    if (!disclaimerReady) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = hasAcceptedDisclaimer ? previousOverflow : 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [disclaimerReady, hasAcceptedDisclaimer]);

  const acknowledgeDisclaimer = () => {
    setHasAcceptedDisclaimer(true);
    try {
      window.localStorage.setItem(DISCLAIMER_STORAGE_KEY, 'true');
    } catch (_) {
      // Ignore storage failures and keep the session-local state.
    }
  };

  return (
    <div className={`pe-fees-app ${compactControls ? 'compact-controls' : ''}`}>
      <style>{`
        /* Reset and base */
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }

        :root {
          --pathway-navy: #1B2A4A;
          --pathway-navy-dark: #0F1B33;
          --pathway-navy-light: #2C3E5E;
          --pathway-gold: #C9A84C;
          --pathway-gold-dark: #A8892E;
          --pathway-off-white: #F5F3EF;
          --pathway-gray-light: #E8E6E1;
          --pathway-gray: #9A9690;
          --pathway-gray-dark: #4A4641;
        }

        .pe-fees-app {
          font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
          background: #FFFFFF;
          color: var(--pathway-gray-dark);
          min-height: 100vh;
          width: 100%;
          line-height: 1.7;
        }

        .app-shell {
          display: grid;
          grid-template-columns: 230px minmax(0, 1fr);
          gap: 0;
        }

        .app-main {
          min-width: 0;
          background: #ffffff;
        }

        .app-main > section {
          position: relative;
        }

        .app-main > section::before {
          content: '';
          position: absolute;
          top: 0;
          left: 28px;
          right: 28px;
          height: 1px;
          background: linear-gradient(
            90deg,
            rgba(27, 42, 74, 0) 0%,
            rgba(27, 42, 74, 0.2) 18%,
            rgba(201, 168, 76, 0.28) 50%,
            rgba(27, 42, 74, 0.2) 82%,
            rgba(27, 42, 74, 0) 100%
          );
        }

        .app-main > section:first-child::before {
          display: none;
        }

        section[id] {
          scroll-margin-top: 90px;
        }

        .side-nav {
          position: sticky;
          top: 72px;
          align-self: start;
          height: calc(100vh - 82px);
          overflow-y: auto;
          border-right: 1px solid #DDE4EF;
          background: #ffffff;
          padding: 18px 12px;
        }

        .side-nav-title {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 1.2px;
          text-transform: uppercase;
          color: #667088;
          margin: 0 10px 12px;
        }

        .side-nav-links {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .side-nav-link {
          display: grid;
          grid-template-columns: 30px minmax(0, 1fr);
          align-items: center;
          text-decoration: none;
          color: #647086;
          font-size: 12px;
          border-radius: 8px;
          padding: 7px 9px;
          border-right: 2px solid transparent;
          transition: all 0.15s ease;
        }

        .side-nav-link:hover {
          background: #F5F7FB;
          color: var(--pathway-navy);
        }

        .side-nav-link.active {
          background: #F1F4FA;
          color: var(--pathway-navy-dark);
          border-right-color: var(--pathway-gold);
          font-weight: 600;
        }

        .side-nav-index {
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 10px;
          letter-spacing: 0.4px;
          color: #8A93A7;
        }

        .side-nav-link.active .side-nav-index {
          color: var(--pathway-gold-dark);
        }

        .side-nav-text {
          line-height: 1.35;
        }

        /* Header */
        .site-header {
          position: sticky;
          top: 0;
          z-index: 100;
          background: linear-gradient(90deg, #012646 0%, #012138 100%);
          border-bottom: 1px solid rgba(255, 255, 255, 0.14);
          box-shadow: 0 6px 18px rgba(6, 18, 36, 0.34);
          padding: 0 26px;
        }

        .header-content {
          max-width: 1400px;
          margin: 0 auto;
          display: flex;
          min-height: 78px;
          justify-content: space-between;
          align-items: center;
          gap: 24px;
        }

        .header-brand-lockup {
          display: flex;
          align-items: center;
        }

        .header-actions {
          display: flex;
          align-items: center;
          gap: 14px;
          flex-shrink: 0;
          position: relative;
        }

        .header-pathway-mark {
          height: 46px;
          width: auto;
          display: block;
          opacity: 1;
        }

        .header-note {
          font-size: 12px;
          color: rgba(255, 255, 255, 0.78);
        }

        .header-cta {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 40px;
          padding: 0 16px;
          border-radius: 999px;
          background: #C9A84C;
          color: #0F1B33;
          text-decoration: none;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          box-shadow: 0 10px 20px rgba(201, 168, 76, 0.28);
          transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
        }

        .header-cta:hover {
          transform: translateY(-1px);
          background: #D7B968;
          box-shadow: 0 14px 24px rgba(201, 168, 76, 0.34);
        }

        @media (max-width: 980px) {
          .site-header {
            padding: 0 16px;
          }

          .header-content {
            min-height: 64px;
            gap: 14px;
          }

          .header-brand-lockup {
            min-width: 0;
          }

          .header-pathway-mark {
            height: 38px;
          }

          .header-note {
            display: none;
          }

          .header-cta {
            min-height: 36px;
            padding: 0 12px;
            font-size: 11px;
          }

          .sticky-contact-cta {
            display: none;
          }

          .sticky-contact-mini {
            display: none;
          }
        }

        .sticky-contact-cta {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 120;
          display: block;
          min-width: 230px;
          background: linear-gradient(180deg, #1B2A4A 0%, #0F1B33 100%);
          border: 1px solid rgba(255, 255, 255, 0.26);
          border-radius: 12px;
          padding: 8px 10px 10px;
          box-shadow: 0 14px 30px rgba(8, 18, 35, 0.35);
          transition: transform 0.18s ease, box-shadow 0.18s ease;
        }

        .sticky-contact-cta:hover {
          transform: translateY(-1px);
          box-shadow: 0 18px 36px rgba(8, 18, 35, 0.4);
        }

        .sticky-contact-link {
          display: grid;
          gap: 1px;
          text-decoration: none;
          color: #ffffff;
          padding: 2px 2px 0;
        }

        .sticky-contact-close {
          width: 22px;
          height: 22px;
          border: 1px solid rgba(255, 255, 255, 0.4);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.08);
          color: rgba(255, 255, 255, 0.9);
          font-size: 14px;
          line-height: 1;
          cursor: pointer;
          margin-left: auto;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .sticky-contact-close:hover {
          background: rgba(255, 255, 255, 0.16);
        }

        .sticky-contact-mini {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 120;
          border: 1px solid rgba(27, 42, 74, 0.25);
          border-radius: 999px;
          background: #ffffff;
          color: #1B2A4A;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.2px;
          padding: 8px 12px;
          cursor: pointer;
          box-shadow: 0 10px 24px rgba(8, 18, 35, 0.18);
        }

        .sticky-contact-mini:hover {
          background: #F3F7FD;
          border-color: #1B2A4A;
        }

        .sticky-contact-kicker {
          font-size: 10px;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.72);
          font-weight: 600;
        }

        .sticky-contact-title {
          font-size: 14px;
          font-weight: 600;
          color: #ffffff;
          letter-spacing: 0.1px;
        }

        .sticky-contact-email {
          font-size: 12px;
          color: #C9A84C;
          font-weight: 500;
        }

        /* Master Dashboard */
        .master-dashboard {
          background: #ffffff;
          padding: 52px 28px 34px;
          border-bottom: none;
        }

        .dashboard-header {
          text-align: center;
          margin-bottom: 26px;
        }

        .dashboard-header h1 {
          font-size: clamp(32px, 5vw, 48px);
          font-weight: 300;
          color: #1B2A4A;
          margin-bottom: 12px;
          letter-spacing: -0.5px;
        }

        .dashboard-subtitle {
          font-size: 16px;
          color: #667088;
        }

        .dashboard-actions {
          margin-top: 10px;
          display: flex;
          justify-content: center;
        }

        .dashboard-grid {
          display: grid;
          grid-template-columns: 280px 1fr 280px;
          gap: 22px;
          max-width: 1300px;
          margin: 0 auto;
        }

        .synthesis-grid {
          grid-template-columns: minmax(255px, 320px) minmax(0, 1fr);
          grid-template-areas:
            "controls main"
            "metrics main";
          column-gap: 24px;
          row-gap: 24px;
          align-items: start;
        }

        .synthesis-grid .dashboard-controls {
          grid-area: controls;
        }

        .synthesis-grid .dashboard-main {
          grid-area: main;
          min-width: 0;
          align-self: start;
        }

        .synthesis-grid .dashboard-metrics {
          grid-area: metrics;
        }

        .synthesis-grid .viz-container {
          min-height: 280px;
          flex: 0 0 auto;
        }

        .synthesis-grid .lifecycle-canvas {
          height: 250px;
        }

        .synthesis-grid .waterfall-master-canvas {
          height: 225px;
        }

        .dashboard-controls {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .control-group {
          background: #F7F9FD;
          border: 1px solid #DEE5F0;
          border-radius: 10px;
          padding: 16px;
        }

        .control-group-header {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: #1B2A4A;
          margin-bottom: 16px;
          padding-bottom: 8px;
          border-bottom: 1px solid #D9D5CF;
        }

        .dashboard-main {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .viz-container {
          background: #F7F9FD;
          border: 1px solid #DEE5F0;
          border-radius: 10px;
          padding: 14px;
          flex: 1;
        }

        .viz-header {
          margin-bottom: 16px;
        }

        .viz-title {
          display: block;
          font-size: 14px;
          font-weight: 500;
          color: #1B2A4A;
          margin-bottom: 4px;
        }

        .viz-subtitle {
          font-size: 12px;
          color: #9A9690;
        }

        .lifecycle-canvas {
          width: 100%;
          height: 220px;
          display: block;
        }

        .waterfall-master-canvas {
          width: 100%;
          height: 200px;
          display: block;
        }

        .dashboard-metrics {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .metric-group {
          background: #F7F9FD;
          border: 1px solid #DEE5F0;
          border-radius: 10px;
          padding: 12px;
        }

        .metric-group-header {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: #9A9690;
          margin-bottom: 12px;
        }

        .metric-large {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          margin-bottom: 8px;
        }

        .metric-large .metric-label {
          font-size: 13px;
          color: #9A9690;
        }

        .metric-large .metric-value {
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 24px;
          font-weight: 500;
        }

        .metric-small {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 12px;
          color: #9A9690;
          padding: 6px 0;
        }

        .metric-small.highlight {
          background: rgba(19, 35, 58, 0.06);
          margin: 0 -16px;
          padding: 8px 16px;
          border-radius: 4px;
        }

        .metric-divider {
          height: 1px;
          background: #D9D5CF;
          margin: 8px 0;
        }

        .hurdle-badge {
          text-align: center;
          padding: 12px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 500;
        }

        .hurdle-badge.cleared {
          background: rgba(45, 107, 79, 0.12);
          border: 1px solid rgba(45, 107, 79, 0.28);
          color: #1B2A4A;
        }

        .hurdle-badge.not-cleared {
          background: rgba(181, 71, 58, 0.12);
          border: 1px solid rgba(181, 71, 58, 0.28);
          color: #B5473A;
        }

        .breakdown-transition {
          max-width: 700px;
          margin: 40px auto 0;
          text-align: center;
        }

        .transition-line {
          width: 60px;
          height: 2px;
          background: linear-gradient(90deg, #1B2A4A, #C9A84C);
          margin: 0 auto 30px;
        }

        .breakdown-transition h2 {
          font-size: 32px;
          font-weight: 300;
          color: #1B2A4A;
          margin-bottom: 12px;
        }

        .breakdown-transition p {
          font-size: 16px;
          color: #9A9690;
          line-height: 1.7;
        }

        @media (max-width: 1100px) {
          .app-shell {
            grid-template-columns: 1fr;
          }

          .side-nav {
            display: none;
          }

          .dashboard-grid {
            grid-template-columns: 1fr;
            max-width: 700px;
          }

          .dashboard-controls {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 16px;
          }

          .dashboard-metrics {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 16px;
          }
        }

        @media (max-width: 1350px) {
          .synthesis-grid {
            grid-template-columns: minmax(250px, 1fr) minmax(250px, 1fr);
            grid-template-areas:
              "controls metrics"
              "main main";
            max-width: 960px;
            gap: 16px;
          }
        }

        @media (max-width: 920px) {
          .synthesis-grid {
            grid-template-columns: 1fr;
            grid-template-areas:
              "controls"
              "metrics"
              "main";
            max-width: 700px;
          }
        }

        @media (max-width: 700px) {
          .dashboard-controls {
            grid-template-columns: 1fr;
          }

          .dashboard-metrics {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 980px) {
          .management-fee-block .sliders-grid {
            grid-template-columns: repeat(2, minmax(150px, 1fr));
          }
        }

        /* Hero Section */
        .hero-section {
          padding: 62px 28px;
          text-align: center;
          background:
            radial-gradient(circle at 14% 12%, rgba(27, 42, 74, 0.12), transparent 40%),
            radial-gradient(circle at 86% 18%, rgba(201, 168, 76, 0.22), transparent 34%),
            linear-gradient(180deg, #ffffff 0%, #F7F8FB 62%, #F5F3EF 100%);
          border-bottom: none;
        }

        .pathway-badge {
          display: inline-block;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          letter-spacing: 2px;
          text-transform: uppercase;
          color: #1B2A4A;
          border: 1px solid #1B2A4A;
          padding: 6px 16px;
          margin-bottom: 30px;
        }

        .hero-section h1 {
          font-size: clamp(28px, 5vw, 48px);
          font-weight: 400;
          color: #1B2A4A;
          max-width: 1100px;
          margin-left: auto;
          margin-right: auto;
          margin-bottom: 16px;
          letter-spacing: -0.5px;
          text-wrap: balance;
        }

        .hero-subtitle {
          font-size: clamp(18px, 2.1vw, 24px);
          font-weight: 400;
          color: #9A9690;
          max-width: 760px;
          margin: 0 auto 22px;
          line-height: 1.35;
          text-wrap: balance;
        }

        .hero-purpose-note {
          max-width: 720px;
          margin: -4px auto 16px;
          font-size: 15px;
          color: #4F5B72;
          line-height: 1.55;
          text-wrap: balance;
        }

        .hero-action-bar {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
          margin: 0 auto 14px;
        }

        .hero-primary-cta,
        .hero-secondary-cta {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 44px;
          padding: 0 18px;
          border-radius: 999px;
          text-decoration: none;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease;
        }

        .hero-primary-cta {
          background: #1B2A4A;
          color: #ffffff;
          box-shadow: 0 10px 24px rgba(27, 42, 74, 0.16);
        }

        .hero-primary-cta:hover {
          transform: translateY(-1px);
          background: #10213F;
        }

        .hero-secondary-cta {
          border: 1px solid #C9D4E4;
          background: rgba(255, 255, 255, 0.82);
          color: #1B2A4A;
        }

        .hero-secondary-cta:hover {
          transform: translateY(-1px);
          border-color: #1B2A4A;
          background: #ffffff;
        }

        .hero-trust-strip {
          margin: 0 auto 18px;
          padding: 9px 14px;
          max-width: 620px;
          border: 1px solid #D9E1EC;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.78);
          color: #5A667D;
          font-size: 12px;
          letter-spacing: 0.2px;
        }

        .hero-graphboard {
          max-width: 980px;
          margin: 0 auto 18px;
          background: rgba(255, 255, 255, 0.82);
          border: 1px solid #DBE2ED;
          border-radius: 12px;
          padding: 16px 14px 10px;
          box-shadow: 0 12px 24px rgba(19, 35, 58, 0.08);
        }

        .hero-graph-canvas {
          width: 100%;
          height: 320px;
          display: block;
        }

        .hero-graph-legend {
          margin-top: 8px;
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 10px;
        }

        .hero-legend-item {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          color: #5F687A;
          border: 1px solid #D6DEEA;
          border-radius: 999px;
          padding: 5px 10px;
        }

        .hero-legend-item.gross {
          border-color: rgba(45, 107, 79, 0.35);
          color: #2D6B4F;
        }

        .hero-legend-item.net {
          border-color: rgba(27, 42, 74, 0.35);
          color: #1B2A4A;
        }

        .hero-legend-item.spread {
          border-color: rgba(201, 168, 76, 0.45);
          color: #A8892E;
        }

        .hero-metrics {
          max-width: 980px;
          margin: 0 auto 10px;
        }

        .hero-scroll-note {
          font-size: 13px;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          color: #9A9690;
          margin-bottom: 0;
        }

        .draft-hero-banner {
          display: block;
          width: min(680px, 100%);
          margin: 0 auto 14px;
          padding: 9px 12px;
          border-radius: 10px;
          background: #B5473A;
          color: #ffffff;
          text-align: center;
          font-size: 13px;
          letter-spacing: 1.1px;
          text-transform: uppercase;
          font-weight: 700;
          border: 1px solid rgba(255, 255, 255, 0.38);
          box-shadow: 0 8px 18px rgba(181, 71, 58, 0.32);
        }

        .liquidity-hero {
          background:
            radial-gradient(circle at 12% 8%, rgba(27, 42, 74, 0.16), transparent 40%),
            radial-gradient(circle at 84% 24%, rgba(45, 107, 79, 0.18), transparent 36%),
            linear-gradient(180deg, #ffffff 0%, #F8FAFD 62%, #F3F7FB 100%);
        }

        .environment-hero {
          background:
            radial-gradient(circle at 12% 10%, rgba(1, 38, 70, 0.28), transparent 42%),
            radial-gradient(circle at 88% 22%, rgba(0, 136, 204, 0.16), transparent 34%),
            linear-gradient(180deg, #F3F8FF 0%, #EAF2FB 62%, #E8EEF7 100%);
        }

        /* Content Sections */
        .content-section {
          max-width: 900px;
          margin: 0 auto;
          padding: 54px 30px 44px;
          border-bottom: none;
          background: #ffffff;
        }

        .content-section h2 {
          font-size: 28px;
          font-weight: 400;
          color: #1B2A4A;
          margin-bottom: 18px;
          padding-bottom: 8px;
          border-bottom: 1px solid #E3E8F1;
        }

        .content-section h3 {
          font-size: 20px;
          font-weight: 400;
          color: #1B2A4A;
          margin: 30px 0 12px;
        }

        .content-section p {
          margin-bottom: 14px;
          font-size: 16px;
        }

        .chart-title {
          margin-top: 18px;
          margin-bottom: 8px;
        }

        .source-sup {
          font-size: 0.72em;
          margin-left: 2px;
        }

        .source-sup a {
          color: #1B2A4A;
          text-decoration: none;
          border-bottom: 1px solid rgba(27, 42, 74, 0.4);
        }

        .source-sup a:hover {
          color: #A8892E;
          border-bottom-color: rgba(168, 137, 46, 0.6);
        }

        .content-section strong {
          color: #1B2A4A;
        }

        .content-section em {
          color: #1B2A4A;
          font-style: normal;
        }

        .nuance-disclosure {
          margin: 10px 0 18px;
        }

        @media (min-width: 1280px) {
          .nuance-disclosure {
            max-width: 620px;
          }
        }

        .nuance-disclosure-trigger {
          width: 100%;
          border: 1px solid #D6DFEC;
          background: linear-gradient(180deg, #FBFDFF 0%, #F4F8FD 100%);
          border-radius: 12px;
          padding: 10px 12px;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
          text-align: left;
          cursor: pointer;
        }

        .nuance-disclosure-trigger:hover {
          border-color: #B9C8DE;
        }

        .nuance-disclosure-left {
          display: grid;
          gap: 3px;
          min-width: 0;
        }

        .nuance-disclosure-kicker {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: #607189;
          font-weight: 600;
        }

        .nuance-disclosure-title {
          font-size: 14px;
          line-height: 1.25;
          color: #1B2A4A;
          font-weight: 600;
        }

        .nuance-disclosure-summary {
          font-size: 12px;
          color: #5D6880;
          line-height: 1.4;
        }

        .nuance-disclosure-action {
          font-size: 11px;
          color: #1B2A4A;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.7px;
          border: 1px solid #CFD7E5;
          border-radius: 999px;
          padding: 5px 10px;
          white-space: nowrap;
          background: #ffffff;
        }

        .nuance-disclosure-panel {
          border: 1px solid #D6DFEC;
          border-top: none;
          border-radius: 0 0 12px 12px;
          background: #FBFDFF;
          padding: 11px 12px 12px;
          font-size: 13px;
          line-height: 1.5;
          color: #4F5B72;
        }

        .nuance-disclosure.open .nuance-disclosure-trigger {
          border-radius: 12px 12px 0 0;
          border-bottom-color: #E5EBF4;
        }

        /* Interactive Blocks */
        .interactive-block {
          background: #ffffff;
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          padding: 18px;
          margin: 22px 0;
          box-shadow: 0 10px 28px rgba(15, 27, 51, 0.05);
        }

        .block-header {
          margin-bottom: 14px;
        }

        .block-actions {
          display: flex;
          justify-content: flex-end;
          margin: -8px 0 10px;
        }

        .reset-button {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          color: #1B2A4A;
          border: 1px solid #CFD7E5;
          background: #ffffff;
          border-radius: 999px;
          padding: 8px 14px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .reset-button:hover {
          border-color: #1B2A4A;
          background: #F5F7FB;
        }

        .block-title {
          display: block;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 14px;
          font-weight: 500;
          color: #1B2A4A;
          margin-bottom: 4px;
        }

        .block-subtitle {
          font-size: 13px;
          color: #9A9690;
        }

        .interactive-margin-shell {
          position: relative;
        }

        .interactive-margin-callout {
          position: absolute;
          top: 86px;
          right: -210px;
          width: 180px;
          padding: 10px 12px;
          border: 1px solid #DCE3EE;
          border-left: 3px solid #C9A84C;
          border-radius: 12px;
          background: linear-gradient(180deg, #FFFDF8 0%, #F8FAFD 100%);
          box-shadow: 0 10px 22px rgba(15, 27, 51, 0.07);
        }

        .interactive-margin-arrow {
          position: absolute;
          left: -18px;
          top: 14px;
          color: #A8892E;
          font-size: 18px;
          font-weight: 700;
          line-height: 1;
          animation: marginArrowNudge 1.8s ease-in-out infinite;
        }

        .interactive-margin-kicker {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: #8A6D1F;
          margin-bottom: 4px;
        }

        .interactive-margin-text {
          font-size: 11px;
          line-height: 1.45;
          color: #556279;
        }

        .actual-spread-block {
          background:
            radial-gradient(circle at 10% 10%, rgba(27, 42, 74, 0.08), transparent 34%),
            radial-gradient(circle at 88% 16%, rgba(201, 168, 76, 0.12), transparent 28%),
            linear-gradient(180deg, #FFFFFF 0%, #F9FBFE 100%);
        }

        .actual-spread-intro {
          max-width: 760px;
          color: #44526B;
        }

        .actual-spread-intro.compact {
          margin-top: -4px;
          font-size: 15px;
        }

        .actual-spread-metrics {
          margin: 10px 0 14px;
        }

        .actual-spread-metrics .metric-card {
          background: rgba(255, 255, 255, 0.86);
          border: 1px solid #DBE3EE;
          box-shadow: 0 8px 18px rgba(19, 35, 58, 0.05);
        }

        .actual-spread-chart-shell {
          margin: 4px 0 6px;
        }

        .actual-spread-chart-shell::before {
          content: 'Scatter = anonymized Pathway-observed funds | dotted line = median observed net by gross band';
          display: block;
          margin-bottom: 8px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.7px;
          text-transform: uppercase;
          color: #5B6983;
        }

        .actual-spread-chart-wrap {
          border: 1px solid #D7E0EE;
          border-radius: 14px;
          overflow: hidden;
          background:
            radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 0.95), rgba(247, 250, 254, 0.96)),
            linear-gradient(180deg, #FBFCFF 0%, #F5F8FC 100%);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
        }

        .actual-spread-chart-svg {
          width: 100%;
          height: auto;
          display: block;
        }

        .actual-spread-axis-label {
          fill: #6A7588;
          font-size: 11px;
          font-family: 'Helvetica Neue', sans-serif;
        }

        .actual-spread-axis-title {
          fill: #415574;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.7px;
          text-transform: uppercase;
          font-family: 'Helvetica Neue', sans-serif;
        }

        .actual-spread-callout-kicker {
          fill: #7B6222;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          font-family: 'Helvetica Neue', sans-serif;
        }

        .actual-spread-callout-title {
          fill: #1B2A4A;
          font-size: 13px;
          font-weight: 700;
          font-family: 'Helvetica Neue', sans-serif;
        }

        .actual-spread-callout-copy {
          fill: #55627B;
          font-size: 11px;
          font-family: 'Helvetica Neue', sans-serif;
        }

        .actual-spread-hover-readout {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 38px;
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #FBFCFF;
          padding: 8px 11px;
          margin-top: 8px;
          font-size: 12px;
          color: #45526A;
          flex-wrap: wrap;
        }

        .actual-spread-hover-label {
          font-weight: 700;
          color: #1B2A4A;
        }

        .actual-spread-hover-sep {
          color: #9AA4B8;
          font-size: 11px;
        }

        .actual-spread-trend-shell {
          margin-top: 14px;
          border: 1px solid #D7E0EE;
          border-radius: 14px;
          background: #FCFDFF;
          padding: 12px 12px 10px;
        }

        .actual-spread-trend-head {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: 10px;
          flex-wrap: wrap;
          margin-bottom: 6px;
        }

        .actual-spread-trend-title {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: #1B2A4A;
        }

        .actual-spread-trend-copy {
          font-size: 12px;
          color: #5F6C83;
        }

        .actual-spread-trend-wrap {
          width: 100%;
        }

        .actual-spread-trend-svg {
          width: 100%;
          height: auto;
          display: block;
        }

        .actual-spread-trend-value {
          fill: #8E3F34;
          font-size: 10px;
          font-weight: 700;
          font-family: 'Helvetica Neue', sans-serif;
        }

        .actual-spread-outlier-note,
        .actual-spread-footnote {
          margin: 10px 0 0;
          font-size: 12px;
          line-height: 1.55;
          color: #5C6679;
        }

        .liquidity-callout-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          margin-top: 18px;
        }

        .liquidity-callout {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          padding: 14px;
          background: #FBFCFF;
        }

        .liquidity-callout h3 {
          margin: 0 0 8px;
          font-size: 16px;
          color: #1B2A4A;
          font-weight: 500;
        }

        .liquidity-callout p {
          margin: 0;
          font-size: 14px;
          color: #5B657A;
          line-height: 1.55;
        }

        .custom-terms-block .metrics-row {
          margin-top: 12px;
        }

        .custom-terms-fund-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 14px;
          margin-bottom: 14px;
        }

        .custom-terms-fund-card {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          padding: 12px;
          background: #FCFDFF;
        }

        .custom-terms-fund-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 10px;
          margin-bottom: 8px;
          flex-wrap: wrap;
        }

        .custom-terms-fund-title {
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.7px;
          text-transform: uppercase;
        }

        .custom-terms-fund-note {
          font-size: 12px;
          color: #5B657A;
          margin-bottom: 8px;
        }

        .custom-terms-fund-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }

        .custom-terms-pacing-head {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 10px;
          margin: 16px 0 10px;
          flex-wrap: wrap;
        }

        .custom-terms-pacing-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .mini-action {
          border: 1px solid #CFD7E5;
          border-radius: 999px;
          padding: 7px 10px;
          background: #FFFFFF;
          color: #1B2A4A;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.3px;
          text-transform: uppercase;
          cursor: pointer;
        }

        .mini-action:hover {
          border-color: #1B2A4A;
          background: #F5F7FB;
        }

        .custom-terms-pacing-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 10px;
          margin: 10px 0 16px;
        }

        .custom-terms-year-card {
          border: 1px solid #E1E8F3;
          border-radius: 8px;
          padding: 10px;
          background: #FBFCFF;
        }

        .custom-terms-year-title {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.7px;
          text-transform: uppercase;
          color: #1B2A4A;
          margin-bottom: 8px;
        }

        .custom-terms-year-label {
          display: block;
          font-size: 10px;
          letter-spacing: 0.5px;
          text-transform: uppercase;
          color: #6B7488;
          margin: 0 0 4px;
        }

        .custom-terms-year-slider {
          width: 100%;
          accent-color: #1B2A4A;
        }

        .custom-terms-year-slider-gold {
          accent-color: #C9A84C;
        }

        .custom-terms-year-value {
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 11px;
          color: #4A4641;
          margin: 4px 0 8px;
        }

        .custom-terms-table th,
        .custom-terms-table td {
          font-size: 10px;
          white-space: nowrap;
        }

        .environment-explorer-block {
          padding-top: 14px;
        }

        .environment-toolbar {
          display: grid;
          grid-template-columns: minmax(160px, 220px) minmax(320px, 1fr) minmax(120px, 160px);
          gap: 10px;
          margin-bottom: 10px;
          align-items: end;
        }

        .environment-toolbar-group {
          display: flex;
          flex-direction: column;
          gap: 6px;
          min-width: 0;
        }

        .environment-toolbar-label {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.9px;
          text-transform: uppercase;
          color: #6B7488;
        }

        .environment-select {
          border: 1px solid #CFD7E5;
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 13px;
          color: #1B2A4A;
          background: #FFFFFF;
        }

        .environment-page-controls {
          display: grid;
          grid-template-columns: auto minmax(160px, 1fr) auto;
          gap: 10px;
          align-items: center;
        }

        .environment-page-btn {
          border: 1px solid #CFD7E5;
          border-radius: 8px;
          background: #ffffff;
          color: #1B2A4A;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.2px;
          padding: 7px 10px;
          cursor: pointer;
        }

        .environment-page-btn:hover {
          background: #F4F8FE;
          border-color: #AEBBD2;
        }

        .environment-page-slider {
          width: 100%;
          accent-color: #1B2A4A;
        }

        .environment-page-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
          font-size: 13px;
          color: #4F5B72;
          flex-wrap: wrap;
        }

        .environment-open-link {
          color: #1B2A4A;
          text-decoration: none;
          border-bottom: 1px solid rgba(27, 42, 74, 0.4);
          font-weight: 500;
        }

        .environment-open-link:hover {
          color: #A8892E;
          border-bottom-color: rgba(168, 137, 46, 0.6);
        }

        .environment-frame-wrap {
          border: 1px solid #D7E0EE;
          border-radius: 10px;
          overflow: hidden;
          background: #F6F8FC;
          min-height: 560px;
        }

        .environment-pdf-frame {
          width: 100%;
          height: 70vh;
          min-height: 560px;
          border: 0;
          background: #ffffff;
        }

        .environment-theme-pills {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 14px;
        }

        .environment-theme-pill {
          border: 1px solid #CCD8EA;
          background: #FFFFFF;
          color: #2E3F5E;
          border-radius: 999px;
          padding: 8px 12px;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.3px;
          cursor: pointer;
        }

        .environment-theme-pill.active,
        .environment-theme-pill:hover {
          border-color: #1B2A4A;
          color: #1B2A4A;
          background: #F1F5FC;
        }

        .environment-theme-detail {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #FBFCFF;
          padding: 14px;
        }

        .environment-theme-pages {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.9px;
          text-transform: uppercase;
          color: #6B7488;
          margin-bottom: 4px;
        }

        .environment-theme-detail p {
          margin: 0;
          font-size: 14px;
          line-height: 1.6;
          color: #4F5B72;
        }

        .benchmark-hero {
          background:
            radial-gradient(circle at 10% 8%, rgba(27, 42, 74, 0.2), transparent 42%),
            radial-gradient(circle at 82% 14%, rgba(74, 123, 167, 0.17), transparent 36%),
            linear-gradient(180deg, #F7FAFE 0%, #EDF4FC 66%, #E8F0FA 100%);
        }

        .benchmark-hero-metrics .metric-card {
          min-height: 98px;
        }

        .benchmark-control-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 10px;
          margin-bottom: 14px;
          align-items: end;
        }

        .benchmark-vintage-picker {
          border: 1px solid #DCE3EE;
          border-radius: 9px;
          background: #FBFCFF;
          padding: 8px;
        }

        .benchmark-vintage-select {
          min-height: 150px;
          font-size: 12px;
          padding: 6px;
        }

        .benchmark-vintage-picker-actions {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 6px;
          margin-top: 8px;
        }

        .benchmark-range-grid {
          margin-top: 8px;
        }

        .benchmark-date-range {
          margin: 2px 0 12px;
          border: 1px solid #DCE3EE;
          border-radius: 9px;
          background: #FBFCFF;
          padding: 10px;
        }

        .benchmark-date-controls {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          margin-top: 6px;
        }

        .benchmark-date-controls span {
          font-size: 12px;
          color: #6B7488;
        }

        .benchmark-chart-shell {
          margin: 6px 0 8px;
        }

        .benchmark-chart-wrap {
          position: relative;
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #FFFFFF;
          overflow: hidden;
        }

        .benchmark-series-svg {
          width: 100%;
          height: 100%;
          display: block;
        }

        .benchmark-hover-readout {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 34px;
          border: 1px solid #DCE3EE;
          border-radius: 9px;
          background: #FBFCFF;
          padding: 7px 10px;
          margin-top: 6px;
          color: #44526B;
          flex-wrap: wrap;
        }

        .benchmark-hover-readout-title {
          font-size: 12px;
          font-weight: 700;
        }

        .benchmark-hover-readout-axis {
          font-size: 12px;
          color: #5A667D;
        }

        .benchmark-hover-readout-value {
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 15px;
          color: #1B2A4A;
        }

        .benchmark-hover-readout-sep {
          font-size: 11px;
          color: #9AA4B8;
        }

        .benchmark-hover-readout-empty {
          font-size: 12px;
          color: #6B7488;
        }

        .benchmark-vintage-legend {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin: 4px 0 2px;
        }

        .benchmark-vintage-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border: 1px solid #D1DAE8;
          border-radius: 999px;
          padding: 4px 8px;
          font-size: 11px;
          color: #34445E;
          background: #FFFFFF;
        }

        .benchmark-vintage-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          display: inline-block;
        }

        .benchmark-summary-metrics {
          margin-top: 10px;
        }

        .portfolio-hero {
          background:
            radial-gradient(circle at 10% 10%, rgba(27, 42, 74, 0.22), transparent 40%),
            radial-gradient(circle at 88% 18%, rgba(201, 168, 76, 0.2), transparent 36%),
            linear-gradient(180deg, #F8FBFF 0%, #F0F5FC 62%, #EDF2F8 100%);
        }

        .asia-hero {
          background:
            radial-gradient(circle at 12% 12%, rgba(10, 78, 121, 0.24), transparent 42%),
            radial-gradient(circle at 86% 18%, rgba(45, 107, 79, 0.18), transparent 34%),
            linear-gradient(180deg, #F5FAFF 0%, #ECF4FD 62%, #EAF2FB 100%);
        }

        .portfolio-hero-teaser {
          margin: 14px auto 10px;
          max-width: 980px;
          border: 1px solid #D7E0EE;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.92);
          padding: 10px 12px 8px;
          box-shadow: 0 8px 20px rgba(19, 35, 58, 0.08);
        }

        .portfolio-hero-teaser-title {
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          color: #4F5B72;
          margin-bottom: 2px;
        }

        .portfolio-select-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
          margin-bottom: 10px;
          align-items: end;
        }

        .portfolio-inline-note {
          margin: 6px 0 14px;
          font-size: 13px;
          color: #4F5B72;
        }

        .portfolio-targeting-questions {
          margin: 4px 0 14px;
          padding-left: 0;
          list-style: none;
          display: grid;
          gap: 6px;
          color: #2E3F5E;
          font-size: 15px;
          line-height: 1.5;
        }

        .portfolio-targeting-kicker {
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          font-weight: 600;
          color: #5B6983;
          margin-bottom: 8px;
        }

        .portfolio-targeting-questions li {
          border: 1px solid #DCE3EE;
          border-radius: 9px;
          background: #FBFCFF;
          padding: 9px 10px;
        }

        .portfolio-targeting-manager-callout {
          margin: 8px 0 12px;
          border: 1px solid rgba(27, 42, 74, 0.22);
          border-left: 4px solid #1B2A4A;
          border-radius: 10px;
          background: rgba(27, 42, 74, 0.06);
          padding: 10px 12px;
          font-size: 14px;
          color: #2E3F5E;
          line-height: 1.45;
        }

        .portfolio-scenario-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 10px 12px;
          margin-bottom: 8px;
        }

        .portfolio-scenario-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .portfolio-scenario-chip {
          border: 1px solid #CAD5E6;
          border-radius: 999px;
          background: #FFFFFF;
          color: #44526B;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          padding: 7px 11px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .portfolio-scenario-chip:hover {
          border-color: #1B2A4A;
          color: #1B2A4A;
          background: #F3F7FE;
        }

        .portfolio-scenario-chip.active {
          background: #1B2A4A;
          color: #FFFFFF;
          border-color: #1B2A4A;
        }

        .portfolio-flight-strip {
          position: sticky;
          top: 86px;
          z-index: 5;
          border: 1px solid #CCD8EA;
          border-radius: 12px;
          background: linear-gradient(180deg, rgba(248, 251, 255, 0.98) 0%, rgba(241, 246, 253, 0.98) 100%);
          box-shadow: 0 10px 20px rgba(16, 33, 63, 0.08);
          padding: 12px 12px 10px;
          margin-bottom: 14px;
          backdrop-filter: blur(2px);
        }

        .portfolio-flight-strip-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 10px 14px;
          flex-wrap: wrap;
          margin-bottom: 6px;
        }

        .portfolio-flight-kicker {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.9px;
          text-transform: uppercase;
          color: #5D6C86;
          margin-bottom: 3px;
        }

        .portfolio-flight-summary {
          font-size: 13px;
          line-height: 1.45;
          color: #33445F;
        }

        .portfolio-flight-pill {
          border: 1px solid rgba(27, 42, 74, 0.24);
          border-radius: 999px;
          background: rgba(27, 42, 74, 0.08);
          color: #1B2A4A;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.5px;
          text-transform: uppercase;
          white-space: nowrap;
          padding: 6px 10px;
        }

        .portfolio-delta-panel {
          margin-top: 10px;
          border: 1px solid #D6DFEC;
          border-radius: 10px;
          background: #FAFCFF;
          padding: 10px 12px;
        }

        .portfolio-delta-title {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.9px;
          text-transform: uppercase;
          color: #5D6C86;
          margin-bottom: 8px;
        }

        .portfolio-delta-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
        }

        .portfolio-delta-item {
          border: 1px solid #E2E8F2;
          border-radius: 8px;
          background: #FFFFFF;
          padding: 8px 10px;
          display: grid;
          gap: 3px;
        }

        .portfolio-delta-item span {
          font-size: 11px;
          color: #5F6E86;
          letter-spacing: 0.3px;
        }

        .portfolio-delta-item strong {
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 16px;
          color: #1B2A4A;
        }

        .portfolio-delta-item strong.positive {
          color: #2D6B4F;
        }

        .portfolio-delta-item strong.negative {
          color: #B5473A;
        }

        .pathway-inline-cta {
          margin: 16px 0 4px;
          border: 1px solid #D6DFEC;
          border-radius: 10px;
          background: linear-gradient(180deg, #FBFDFF 0%, #F4F8FD 100%);
          padding: 12px 14px;
          font-size: 13px;
          color: #44526B;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }

        .pathway-inline-cta a {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 36px;
          padding: 0 14px;
          border-radius: 999px;
          background: #1B2A4A;
          color: #ffffff;
          text-decoration: none;
          font-weight: 600;
          border: 1px solid #1B2A4A;
          white-space: nowrap;
        }

        .pathway-inline-cta a:hover {
          background: #10213F;
        }

        .portfolio-commentary-block {
          margin-top: 12px;
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #FBFCFF;
          padding: 12px;
        }

        .portfolio-commentary-title {
          margin: 0 0 8px;
          font-size: 14px;
          font-weight: 600;
          letter-spacing: 0.7px;
          text-transform: uppercase;
          color: #415574;
        }

        .portfolio-commentary-table {
          width: 100%;
          border-collapse: collapse;
        }

        .portfolio-commentary-table th,
        .portfolio-commentary-table td {
          border-top: 1px solid #E6ECF5;
          padding: 7px 8px;
          text-align: left;
          vertical-align: top;
          font-size: 13px;
          line-height: 1.45;
        }

        .portfolio-commentary-table tr:first-child th,
        .portfolio-commentary-table tr:first-child td {
          border-top: none;
        }

        .portfolio-commentary-table th {
          width: 180px;
          color: #1B2A4A;
          font-weight: 600;
        }

        .portfolio-commentary-table td {
          color: #4F5B72;
          font-weight: 400;
        }

        @media (max-width: 1080px) {
          .portfolio-flight-strip {
            position: static;
            top: auto;
          }

          .portfolio-delta-grid {
            grid-template-columns: 1fr;
          }
        }

        .portfolio-riffs-cta {
          margin: 16px 0 8px;
          border: 1px solid rgba(27, 42, 74, 0.2);
          border-radius: 10px;
          background: linear-gradient(180deg, #FAFCFF 0%, #F3F8FE 100%);
          padding: 12px 14px;
          color: #2E3F5E;
        }

        .portfolio-riffs-cta-title {
          font-size: 15px;
          font-weight: 600;
          color: #1B2A4A;
          margin-bottom: 4px;
        }

        .portfolio-riffs-cta p {
          margin: 0;
          font-size: 14px;
          line-height: 1.55;
        }

        .portfolio-riffs-cta a {
          color: #1B2A4A;
          text-decoration: none;
          border-bottom: 1px solid rgba(27, 42, 74, 0.35);
          font-weight: 600;
        }

        .portfolio-riffs-cta a:hover {
          color: #A8892E;
          border-bottom-color: rgba(168, 137, 46, 0.5);
        }

        .portfolio-important-callout {
          margin: 8px 0 10px;
          padding: 11px 12px;
          border: 1px solid rgba(181, 71, 58, 0.35);
          border-left: 4px solid #B5473A;
          border-radius: 10px;
          background: rgba(181, 71, 58, 0.06);
          color: #2E3F5E;
          font-size: 14px;
          line-height: 1.45;
        }

        .portfolio-important-callout strong {
          color: #9E3C31;
        }

        .portfolio-level-set-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
          margin: 4px 0 12px;
        }

        .portfolio-level-set-card {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #FBFCFF;
          padding: 12px;
        }

        .portfolio-level-set-step {
          font-size: 14px;
          font-weight: 600;
          color: #1B2A4A;
          margin-bottom: 4px;
        }

        .portfolio-level-set-card p {
          margin: 0;
          font-size: 14px;
          line-height: 1.45;
          color: #4F5B72;
        }

        .portfolio-level-set-decoder {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px 14px;
          margin: 0 0 10px;
          padding: 10px 12px;
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #F8FAFD;
          font-size: 13px;
          color: #4F5B72;
        }

        .portfolio-lifecycle-assumption-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
          margin: 0 0 10px;
        }

        .portfolio-lifecycle-automation {
          border: 1px solid #DCE3EE;
          border-radius: 12px;
          background: #F9FBFF;
          padding: 14px 16px;
          margin: 2px 0 12px;
        }

        .portfolio-lifecycle-automation-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }

        .portfolio-lifecycle-automation-label {
          font-size: 11px;
          letter-spacing: 0.9px;
          text-transform: uppercase;
          color: #6B7488;
          margin-bottom: 4px;
        }

        .portfolio-lifecycle-year-readout {
          font-size: 34px;
          line-height: 1;
          font-weight: 600;
          color: #1B2A4A;
          letter-spacing: -0.4px;
        }

        .portfolio-lifecycle-automation-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .portfolio-lifecycle-year-range {
          margin: 10px 0 5px;
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          color: #6B7488;
          letter-spacing: 0.6px;
          text-transform: uppercase;
        }

        .portfolio-lifecycle-year-slider {
          -webkit-appearance: none;
          width: 100%;
          height: 8px;
          border-radius: 999px;
          outline: none;
          margin: 2px 0 10px;
        }

        .portfolio-lifecycle-year-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: #ffffff;
          border: 2px solid #1B2A4A;
          box-shadow: 0 2px 8px rgba(27, 42, 74, 0.2);
          cursor: pointer;
        }

        .portfolio-lifecycle-year-slider::-moz-range-thumb {
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: #ffffff;
          border: 2px solid #1B2A4A;
          box-shadow: 0 2px 8px rgba(27, 42, 74, 0.2);
          cursor: pointer;
        }

        .portfolio-play-button {
          border: 1px solid #CFD7E5;
          border-radius: 999px;
          background: #ffffff;
          color: #1B2A4A;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.5px;
          text-transform: uppercase;
          padding: 8px 14px;
          cursor: pointer;
        }

        .portfolio-play-button.playing {
          background: #1B2A4A;
          color: #ffffff;
          border-color: #1B2A4A;
        }

        .portfolio-lifecycle-stage-tag {
          margin-top: 2px;
          font-size: 13px;
          color: #4F5B72;
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          padding: 8px 10px;
          background: #F8FAFD;
        }

        .portfolio-lifecycle-stage-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 10px;
          margin: 10px 0 14px;
        }

        .portfolio-lifecycle-stage-card {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #FBFCFF;
          padding: 11px 12px;
          transition: border-color 0.2s ease, background 0.2s ease, transform 0.2s ease;
        }

        .portfolio-lifecycle-stage-card.active {
          border-color: rgba(27, 42, 74, 0.38);
          background: #F1F5FC;
          transform: translateY(-1px);
        }

        .portfolio-lifecycle-stage-title {
          font-size: 14px;
          font-weight: 600;
          color: #1B2A4A;
          margin-bottom: 2px;
        }

        .portfolio-lifecycle-stage-range {
          font-size: 12px;
          letter-spacing: 0.7px;
          text-transform: uppercase;
          color: #6B7488;
          margin-bottom: 6px;
        }

        .portfolio-lifecycle-stage-card p {
          margin: 0;
          font-size: 14px;
          line-height: 1.5;
          color: #4F5B72;
        }

        .portfolio-flow-sketch {
          border: 1px solid #DCE3EE;
          border-radius: 12px;
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(247, 251, 255, 0.96)),
            repeating-linear-gradient(
              0deg,
              rgba(27, 42, 74, 0.03) 0px,
              rgba(27, 42, 74, 0.03) 1px,
              transparent 1px,
              transparent 22px
            );
          padding: 14px;
          margin-top: 8px;
        }

        .portfolio-flow-svg {
          width: 100%;
          height: 420px;
        }

        .portfolio-flow-node rect {
          fill: #FFFFFF;
          stroke: #1B2A4A;
          stroke-width: 1.9;
          stroke-dasharray: 8 6;
          rx: 10;
        }

        .portfolio-flow-node text {
          fill: #24344F;
          text-anchor: middle;
          font-family: "Courier New", "SFMono-Regular", ui-monospace, monospace;
        }

        .portfolio-flow-node text:first-of-type {
          font-size: 17px;
          font-weight: 700;
        }

        .portfolio-flow-node text:last-of-type {
          font-size: 14px;
          opacity: 1;
        }

        .portfolio-company-doodles {
          stroke: #3F587D;
          fill: none;
          stroke-width: 1.8;
          stroke-linecap: round;
          stroke-linejoin: round;
        }

        .portfolio-flow-node.terminal.lp rect {
          stroke: #2D6B4F;
        }

        .portfolio-flow-node.terminal.gp rect {
          stroke: #B5473A;
        }

        .portfolio-flow-arrow {
          stroke: #7DB294;
          stroke-width: 2.2;
          stroke-dasharray: 7 9;
          color: #7DB294;
          opacity: 0.58;
        }

        .portfolio-flow-arrow.active {
          stroke: #2D8A57;
          color: #2D8A57;
          stroke-width: 3.8;
          stroke-dasharray: 6 6;
          opacity: 1;
          animation: flowDash 0.75s linear infinite;
          filter: drop-shadow(0 0 2px rgba(45, 138, 87, 0.35));
        }

        .portfolio-flow-label {
          fill: #3D4D69;
          font-size: 15px;
          font-weight: 600;
          font-family: "Helvetica Neue", Arial, sans-serif;
          text-anchor: middle;
          letter-spacing: 0.2px;
          paint-order: stroke fill;
          stroke: rgba(255, 255, 255, 0.96);
          stroke-width: 5px;
          pointer-events: none;
        }

        .portfolio-flow-label.active {
          fill: #2D8A57;
          font-weight: 700;
          stroke: rgba(255, 255, 255, 0.98);
        }

        .portfolio-flow-money {
          fill: #2F6E4B;
          font-size: 18px;
          font-weight: 700;
          font-family: "Helvetica Neue", Arial, sans-serif;
          text-anchor: middle;
          paint-order: stroke fill;
          stroke: rgba(255, 255, 255, 0.96);
          stroke-width: 5px;
          pointer-events: none;
        }

        .portfolio-flow-money.active {
          fill: #2D8A57;
        }

        .portfolio-flow-caption {
          margin-top: 8px;
          font-size: 14px;
          color: #2E3F5E;
          line-height: 1.5;
        }

        .portfolio-forecast-step-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
          gap: 12px;
          margin-bottom: 10px;
          align-items: end;
        }

        .portfolio-forecast-stage-note {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #F8FAFD;
          padding: 10px 12px;
          min-height: 66px;
          display: grid;
          gap: 4px;
          color: #4F5B72;
          font-size: 13px;
          line-height: 1.45;
        }

        .portfolio-forecast-stage-note strong {
          color: #1B2A4A;
          font-size: 13px;
        }

        .portfolio-forecast-chart {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #FBFCFF;
          padding: 14px 12px 12px;
          margin: 10px 0 12px;
        }

        .portfolio-forecast-axis {
          position: relative;
          height: 20px;
          margin: 0 0 8px;
          border-bottom: 1px dashed #CCD6E5;
        }

        .portfolio-forecast-axis span {
          position: absolute;
          top: -1px;
          transform: translateX(-50%);
          font-size: 11px;
          color: #6B7488;
          white-space: nowrap;
        }

        .portfolio-forecast-row {
          padding: 8px 0 10px;
          transition: opacity 0.25s ease, transform 0.25s ease;
        }

        .portfolio-forecast-row + .portfolio-forecast-row {
          border-top: 1px solid #E8EDF5;
        }

        .portfolio-forecast-row.pending {
          opacity: 0.35;
        }

        .portfolio-forecast-row.active {
          opacity: 1;
          transform: translateY(-1px);
        }

        .portfolio-forecast-row-head {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 6px;
          align-items: baseline;
        }

        .portfolio-forecast-row-title {
          font-size: 13px;
          font-weight: 600;
          color: #1B2A4A;
        }

        .portfolio-forecast-row-range {
          font-size: 12px;
          color: #4F5B72;
          font-weight: 600;
          white-space: nowrap;
        }

        .portfolio-forecast-track {
          position: relative;
          height: 26px;
          border-radius: 999px;
          background: #EEF3FA;
          overflow: visible;
        }

        .portfolio-forecast-band {
          position: absolute;
          top: 4px;
          height: 18px;
          border-radius: 999px;
          transition: left 0.3s ease, width 0.3s ease, opacity 0.25s ease;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .portfolio-forecast-band.infinite {
          background: repeating-linear-gradient(
            135deg,
            rgba(154, 150, 144, 0.45),
            rgba(154, 150, 144, 0.45) 8px,
            rgba(154, 150, 144, 0.2) 8px,
            rgba(154, 150, 144, 0.2) 16px
          );
        }

        .portfolio-forecast-band.pathway {
          background: rgba(74, 123, 167, 0.45);
        }

        .portfolio-forecast-band.modeled {
          background: rgba(45, 107, 79, 0.48);
        }

        .portfolio-forecast-band.diversified {
          background: rgba(201, 168, 76, 0.55);
        }

        .portfolio-forecast-infinity {
          font-size: 11px;
          font-weight: 600;
          color: #4A4641;
          letter-spacing: 0.2px;
        }

        .portfolio-forecast-bound {
          position: absolute;
          top: -17px;
          transform: translateX(-50%);
          font-size: 11px;
          font-weight: 600;
          color: #2E3F5E;
          white-space: nowrap;
        }

        .portfolio-forecast-baseline {
          position: absolute;
          top: 0;
          bottom: 0;
          border-left: 1px dashed rgba(27, 42, 74, 0.55);
        }

        .portfolio-forecast-baseline span {
          position: absolute;
          top: 27px;
          left: 4px;
          font-size: 10px;
          color: #5C6780;
          background: rgba(255, 255, 255, 0.9);
          padding: 1px 3px;
          border-radius: 4px;
          border: 1px solid rgba(220, 227, 238, 0.9);
        }

        .portfolio-funnel-controls {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          gap: 12px;
          margin-bottom: 10px;
          align-items: end;
        }

        .portfolio-funnel-step-status {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #F8FAFD;
          padding: 10px 12px;
          min-height: 92px;
        }

        .portfolio-funnel-step-title {
          font-size: 20px;
          font-weight: 500;
          line-height: 1.3;
          color: #3D434D;
          margin-bottom: 4px;
        }

        .portfolio-funnel-step-prompt {
          font-size: 16px;
          line-height: 1.45;
          color: #3D434D;
          margin-bottom: 10px;
        }

        .portfolio-funnel-step-pills {
          display: inline-flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .portfolio-funnel-pill {
          width: 26px;
          height: 26px;
          border-radius: 6px;
          border: 1px solid #C7D3E4;
          background: #FFFFFF;
          color: #52607A;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .portfolio-funnel-pill.done {
          border-color: rgba(45, 107, 79, 0.35);
          color: #2D6B4F;
          background: rgba(45, 107, 79, 0.1);
        }

        .portfolio-funnel-pill.active {
          border-color: #1B2A4A;
          color: #ffffff;
          background: #1B2A4A;
        }

        .portfolio-funnel-pill:hover {
          border-color: #91A5C3;
        }

        .portfolio-funnel-step-btn {
          border: 1px solid #C7D3E4;
          border-radius: 8px;
          background: #1B2A4A;
          color: #ffffff;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.2px;
          padding: 9px 12px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .portfolio-funnel-step-btn:hover:not(:disabled) {
          background: #25385F;
          border-color: #25385F;
        }

        .portfolio-funnel-step-btn.ghost {
          background: #ffffff;
          color: #1B2A4A;
        }

        .portfolio-funnel-step-btn.ghost:hover:not(:disabled) {
          background: #F4F8FE;
          border-color: #AEBBD2;
        }

        .portfolio-funnel-step-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }

        .portfolio-funnel-story-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.68fr) minmax(240px, 0.45fr);
          gap: 12px;
          margin-bottom: 12px;
          align-items: start;
        }

        .portfolio-funnel-left-rail {
          display: grid;
          gap: 8px;
          align-content: start;
        }

        .portfolio-funnel-step-stack {
          display: grid;
          gap: 8px;
          max-height: 620px;
          overflow-y: auto;
          padding-top: 2px;
          padding-right: 4px;
        }

        .portfolio-funnel-step-card {
          width: 100%;
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #F8FAFD;
          padding: 8px 10px;
          display: grid;
          gap: 2px;
          text-align: left;
          cursor: pointer;
          transition: border-color 0.2s ease, background 0.2s ease, transform 0.2s ease;
          color: #4F5B72;
        }

        .portfolio-funnel-step-card:hover {
          border-color: #AEBBD2;
          background: #FFFFFF;
        }

        .portfolio-funnel-step-card.done {
          border-color: rgba(45, 107, 79, 0.35);
          background: rgba(45, 107, 79, 0.08);
        }

        .portfolio-funnel-step-card.active {
          border-color: #1B2A4A;
          background: rgba(27, 42, 74, 0.06);
          transform: none;
          box-shadow: 0 0 0 1px rgba(27, 42, 74, 0.06) inset;
        }

        .portfolio-funnel-step-card:focus-visible {
          outline: 2px solid rgba(27, 42, 74, 0.5);
          outline-offset: 1px;
        }

        .portfolio-funnel-step-card-index {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.7px;
          text-transform: uppercase;
          color: #415574;
        }

        .portfolio-funnel-step-card-title {
          font-size: 16px;
          line-height: 1.25;
          color: #3D434D;
          font-weight: 500;
        }

        .portfolio-funnel-step-card-copy {
          font-size: 13px;
          line-height: 1.45;
          color: #4F5B72;
        }

        .portfolio-funnel-step-card:not(.active) .portfolio-funnel-step-card-copy {
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        .portfolio-funnel-reset-row {
          display: flex;
          justify-content: flex-end;
          margin-top: 4px;
        }

        .portfolio-funnel-metrics-inline {
          margin-top: 0;
          gap: 8px;
          grid-template-columns: repeat(2, minmax(140px, 1fr));
        }

        .portfolio-funnel-metrics-inline .metric-card {
          padding: 10px 12px;
          border-radius: 8px;
        }

        .portfolio-funnel-metrics-inline .metric-label {
          font-size: 10px;
          margin-bottom: 4px;
        }

        .portfolio-funnel-metrics-inline .metric-value {
          font-size: 17px;
        }

        .portfolio-funnel-metrics-inline .metric-subtext {
          font-size: 11px;
          margin-top: 2px;
        }

        .portfolio-funnel-advanced {
          margin-top: 2px;
        }

        .portfolio-funnel-advanced > summary {
          cursor: pointer;
          color: #4F5B72;
          font-size: 13px;
          font-weight: 500;
          margin-bottom: 8px;
        }

        .portfolio-funnel-advanced[open] > summary {
          color: #1B2A4A;
        }

        .portfolio-funnel-chart-shell {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #FBFCFF;
          padding: 10px 10px 8px;
        }

        .portfolio-funnel-chart-head {
          display: flex;
          flex-direction: column;
          gap: 3px;
          margin-bottom: 6px;
        }

        .portfolio-funnel-chart-title {
          display: block;
          font-size: 14px;
          font-weight: 600;
          color: #34496B;
          line-height: 1.3;
        }

        .portfolio-funnel-chart-subtitle {
          display: block;
          font-size: 12px;
          color: #5E6B82;
          line-height: 1.35;
        }

        .portfolio-funnel-svg {
          width: 100%;
          height: auto;
          min-height: 360px;
          display: block;
        }

        .portfolio-funnel-legend {
          margin-top: 6px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px 12px;
        }

        .portfolio-funnel-legend-item {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: #5A677E;
        }

        .portfolio-funnel-legend-item.active {
          color: #1B2A4A;
          font-weight: 600;
        }

        .portfolio-funnel-legend .swatch {
          width: 14px;
          height: 9px;
          border: 1px solid #BCC9DD;
          border-radius: 2px;
          display: inline-block;
        }

        .portfolio-funnel-legend .line-swatch {
          width: 18px;
          height: 0;
          border-top: 2px solid #1B2A4A;
          display: inline-block;
        }

        .portfolio-funnel-placeholder,
        .portfolio-funnel-proprietary {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #F8FAFD;
          padding: 11px 12px;
        }

        .portfolio-rvpi-context-block {
          margin: 10px 0 12px;
        }

        .portfolio-funnel-placeholder-title,
        .portfolio-funnel-proprietary-title {
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.7px;
          text-transform: uppercase;
          color: #415574;
          margin-bottom: 5px;
        }

        .portfolio-funnel-placeholder p,
        .portfolio-funnel-proprietary p {
          margin: 0;
          font-size: 13px;
          line-height: 1.5;
          color: #4F5B72;
        }

        @keyframes flowDash {
          from { stroke-dashoffset: 24; }
          to { stroke-dashoffset: 0; }
        }

        .portfolio-mix-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin: -2px 0 12px;
        }

        .portfolio-mix-chip {
          display: inline-flex;
          align-items: center;
          border-radius: 999px;
          padding: 4px 10px;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          border: 1px solid #D3DCE9;
          background: #F8FAFD;
          color: #2E3F5E;
        }

        .portfolio-mix-chip.primary {
          border-color: rgba(27, 42, 74, 0.3);
          color: #1B2A4A;
        }

        .portfolio-mix-chip.secondary {
          border-color: rgba(168, 137, 46, 0.35);
          color: #A37D23;
        }

        .portfolio-mix-chip.direct {
          border-color: rgba(181, 71, 58, 0.35);
          color: #B5473A;
        }

        .environment-theme-pills.compact {
          margin-bottom: 0;
        }

        .environment-kpi-inline {
          border: 1px solid #D3DDEB;
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 13px;
          color: #1B2A4A;
          background: #F8FBFF;
          font-weight: 500;
        }

        .environment-delta-grid {
          display: grid;
          gap: 10px;
          margin-top: 6px;
        }

        .environment-delta-card {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #FBFCFF;
          padding: 10px 12px;
        }

        .environment-delta-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
          font-size: 13px;
          color: #1B2A4A;
          font-weight: 500;
        }

        .environment-delta-pages {
          font-size: 10px;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: #6B7488;
          font-weight: 600;
          white-space: nowrap;
        }

        .environment-delta-values {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          align-items: center;
          gap: 8px;
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 13px;
          color: #44516B;
          margin-bottom: 8px;
        }

        .environment-delta-values span:first-child {
          text-align: left;
        }

        .environment-delta-values span:last-child {
          text-align: right;
        }

        .environment-delta-change {
          border-radius: 999px;
          padding: 2px 8px;
          font-weight: 600;
          font-size: 12px;
          white-space: nowrap;
        }

        .environment-delta-change.good {
          color: #1F6A4D;
          background: rgba(45, 107, 79, 0.13);
        }

        .environment-delta-change.bad {
          color: #B5473A;
          background: rgba(181, 71, 58, 0.13);
        }

        .environment-delta-bar-track {
          width: 100%;
          height: 8px;
          border-radius: 999px;
          background: #E6EDF8;
          overflow: hidden;
        }

        .environment-delta-bar {
          height: 100%;
          border-radius: 999px;
        }

        .environment-delta-bar.good {
          background: linear-gradient(90deg, #2D6B4F, #4C9B74);
        }

        .environment-delta-bar.bad {
          background: linear-gradient(90deg, #B5473A, #DA675A);
        }

        .environment-conversion-top {
          display: grid;
          grid-template-columns: minmax(220px, 1fr) auto;
          gap: 12px;
          align-items: end;
          margin-bottom: 12px;
        }

        .environment-conversion-progress {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .environment-conversion-label {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.9px;
          text-transform: uppercase;
          color: #6B7488;
        }

        .environment-conversion-track {
          width: 100%;
          height: 8px;
          background: #E6EDF8;
          border-radius: 999px;
          overflow: hidden;
        }

        .environment-conversion-fill {
          height: 100%;
          background: linear-gradient(90deg, #1B2A4A, #2D6B4F);
        }

        .environment-conversion-meta {
          font-size: 12px;
          color: #4F5B72;
        }

        .environment-table-wrap {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          overflow-x: auto;
          background: #FBFCFF;
        }

        .environment-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
          min-width: 640px;
        }

        .benchmark-table-wrap {
          max-height: 560px;
          overflow: auto;
        }

        .benchmark-data-table {
          min-width: 980px;
        }

        .benchmark-table-toolbar {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
          gap: 10px;
          margin-bottom: 12px;
          align-items: end;
        }

        .benchmark-search-input {
          width: 100%;
        }

        .benchmark-export-group {
          justify-content: flex-end;
        }

        .benchmark-export-btn {
          width: 100%;
          white-space: nowrap;
        }

        .environment-table th,
        .environment-table td {
          text-align: left;
          padding: 10px 12px;
          border-bottom: 1px solid #E6ECF5;
          color: #465168;
        }

        .environment-table th {
          font-size: 10px;
          letter-spacing: 0.7px;
          text-transform: uppercase;
          color: #6B7488;
          font-weight: 600;
          background: #F3F6FB;
          white-space: nowrap;
        }

        .environment-status {
          display: inline-block;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.7px;
          text-transform: uppercase;
          border-radius: 999px;
          padding: 2px 8px;
          border: 1px solid transparent;
        }

        .environment-status.built {
          color: #1F6A4D;
          background: rgba(45, 107, 79, 0.12);
          border-color: rgba(45, 107, 79, 0.24);
        }

        .environment-status.next {
          color: #1B2A4A;
          background: rgba(27, 42, 74, 0.1);
          border-color: rgba(27, 42, 74, 0.22);
        }

        .environment-status.planned {
          color: #A37D23;
          background: rgba(201, 168, 76, 0.16);
          border-color: rgba(201, 168, 76, 0.3);
        }

        .bridge-note {
          margin: 12px 0 18px;
          font-size: 13px;
          color: #6E7688;
        }

        .roadmap-table-wrap {
          margin-top: 22px;
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          overflow: hidden;
          background: #FAFBFD;
        }

        .roadmap-title {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.9px;
          text-transform: uppercase;
          color: #5B657A;
          padding: 10px 14px;
          border-bottom: 1px solid #E0E7F2;
          background: #F3F6FB;
        }

        .roadmap-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
          color: #4A4641;
        }

        .roadmap-table th,
        .roadmap-table td {
          text-align: left;
          padding: 10px 12px;
          border-bottom: 1px solid #E6ECF5;
          vertical-align: top;
        }

        .roadmap-table th {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          color: #6E7688;
        }

        .roadmap-table tbody tr:last-child td {
          border-bottom: none;
        }

        .roadmap-table a {
          color: #1B2A4A;
          text-decoration: none;
          border-bottom: 1px solid rgba(27, 42, 74, 0.25);
        }

        .roadmap-table a:hover {
          color: #A8892E;
          border-bottom-color: rgba(168, 137, 46, 0.55);
        }

        .metric-tradeoff-note {
          margin-top: 14px;
          border: 1px solid #DCE3EE;
          border-left: 3px solid #4A7BA7;
          border-radius: 10px;
          background: #F7FAFE;
          padding: 12px 14px;
        }

        .metric-tradeoff-title {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: #415574;
          margin-bottom: 6px;
        }

        .metric-tradeoff-note p {
          margin: 0;
          font-size: 13px;
          line-height: 1.55;
          color: #546173;
        }

        /* Sliders */
        .slider-container {
          margin-bottom: 20px;
        }

        .slider-header {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: start;
          column-gap: 8px;
          min-height: 34px;
          margin-bottom: 8px;
        }

        .slider-label {
          display: block;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 12px;
          color: #9A9690;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          line-height: 1.25;
        }

        .slider-value {
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 14px;
          font-weight: 500;
          line-height: 1.2;
          padding-top: 1px;
        }

        .slider-track-container {
          position: relative;
        }

        .slider-container.disabled {
          opacity: 0.55;
        }

        .slider-container.disabled .slider-input {
          cursor: not-allowed;
        }

        .slider-input {
          width: 100%;
          height: 6px;
          border-radius: 3px;
          appearance: none;
          cursor: pointer;
          outline: none;
        }

        .slider-input::-webkit-slider-thumb {
          appearance: none;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #ffffff;
          border: 2px solid #9A9690;
          cursor: pointer;
          box-shadow: 0 2px 6px rgba(19, 35, 58, 0.2);
        }

        .slider-input::-moz-range-thumb {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #ffffff;
          cursor: pointer;
          border: 2px solid #9A9690;
        }

        .sliders-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 16px;
          margin-bottom: 16px;
        }

        .sliders-grid.two-up {
          grid-template-columns: repeat(2, minmax(180px, 1fr));
        }

        .sliders-grid.three-up {
          grid-template-columns: repeat(3, minmax(160px, 1fr));
        }

        /* Global compact mode so users can see controls and outputs together */
        .compact-controls .interactive-block {
          padding: 18px;
          margin: 24px 0;
        }

        .compact-controls .block-header {
          margin-bottom: 14px;
        }

        .compact-controls .block-actions {
          margin: -8px 0 10px;
        }

        .compact-controls .sliders-grid {
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 10px;
          margin-bottom: 14px;
        }

        .compact-controls .slider-container {
          margin-bottom: 10px;
        }

        .compact-controls .slider-label {
          font-size: 10px;
          letter-spacing: 0.4px;
          line-height: 1.2;
        }

        .compact-controls .slider-value {
          font-size: 12px;
        }

        .compact-controls .slider-header {
          min-height: 28px;
          margin-bottom: 6px;
        }

        .compact-controls .slider-input {
          height: 4px;
        }

        .compact-controls .slider-input::-webkit-slider-thumb {
          width: 14px;
          height: 14px;
        }

        .compact-controls .slider-input::-moz-range-thumb {
          width: 14px;
          height: 14px;
        }

        .compact-controls .toggle-row {
          gap: 10px;
          margin-bottom: 10px;
        }

        .compact-controls .toggle-label {
          min-width: 120px;
          font-size: 11px;
        }

        .compact-controls .toggle-button {
          font-size: 11px;
          padding: 6px 10px;
        }

        .compact-controls .terms-section {
          padding: 12px 14px;
          margin-bottom: 14px;
        }

        .compact-controls .metrics-row {
          margin-top: 12px;
          gap: 10px;
        }

        .compact-controls .metric-card {
          padding: 12px;
        }

        .compact-controls .net-impact-panel {
          margin-top: 12px;
          padding: 10px 10px 6px;
        }

        .compact-controls .timeline-canvas,
        .compact-controls .waterfall-canvas,
        .compact-controls .comparison-canvas {
          margin: 10px 0 6px;
        }

        /* Section-specific compact layout for the management fee calculator */
        .management-fee-block {
          padding: 18px;
        }

        .management-fee-block .block-header {
          margin-bottom: 14px;
        }

        .management-fee-block .block-actions {
          margin: -8px 0 10px;
        }

        .management-fee-block .sliders-grid {
          grid-template-columns: repeat(5, minmax(130px, 1fr));
          gap: 10px;
          margin-bottom: 14px;
        }

        .management-fee-block .slider-container {
          margin-bottom: 10px;
        }

        .management-fee-block .slider-label {
          font-size: 10px;
          letter-spacing: 0.4px;
        }

        .management-fee-block .slider-value {
          font-size: 13px;
        }

        .management-fee-block .terms-section {
          padding: 12px 14px;
          margin-bottom: 14px;
        }

        .management-fee-block .toggle-row {
          gap: 10px;
          margin-bottom: 10px;
        }

        .management-fee-block .toggle-label {
          min-width: 120px;
          font-size: 11px;
        }

        .management-fee-block .toggle-button {
          padding: 6px 10px;
          font-size: 11px;
        }

        .management-fee-block .terms-explainer {
          margin: -4px 0 10px;
          font-size: 12px;
          color: #5B657A;
          line-height: 1.45;
        }

        .management-fee-block .terms-explainer:last-child {
          margin-bottom: 0;
        }

        .management-fee-block .timeline-canvas {
          margin: 8px 0 4px;
        }

        .management-fee-block .metrics-row {
          margin-top: 12px;
          gap: 10px;
        }

        .management-fee-block .metric-card {
          padding: 12px;
        }

        .management-fee-block .net-impact-panel {
          margin-top: 12px;
          padding: 10px 10px 6px;
        }

        .management-inline-note {
          margin: 8px 0 0;
          font-size: 13px;
          color: #5B657A;
          line-height: 1.5;
        }

        /* Toggle Switch */
        .toggle-row {
          display: flex;
          align-items: center;
          gap: 16px;
          margin-bottom: 16px;
          flex-wrap: wrap;
        }

        .toggle-label {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 12px;
          color: #9A9690;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          min-width: 140px;
        }

        .toggle-container {
          display: flex;
          gap: 4px;
        }

        .toggle-button {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 12px;
          padding: 8px 16px;
          border: 1px solid #D9D5CF;
          background: transparent;
          color: #9A9690;
          cursor: pointer;
          transition: all 0.2s;
        }

        .toggle-button:first-child {
          border-radius: 4px 0 0 4px;
        }

        .toggle-button:last-child {
          border-radius: 0 4px 4px 0;
        }

        .toggle-button.active {
          color: #F5F3EF;
        }

        /* Terms Section */
        .terms-section {
          background: #E8E6E1;
          border-radius: 6px;
          padding: 16px 20px;
          margin-bottom: 24px;
        }

        .terms-header {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: #1B2A4A;
          margin-bottom: 16px;
          padding-bottom: 8px;
          border-bottom: 1px solid #D9D5CF;
        }

        .terms-section .toggle-row:last-child {
          margin-bottom: 0;
        }

        .terms-explainer {
          margin: -6px 0 14px;
          font-size: 12px;
          color: #5B657A;
          line-height: 1.45;
        }

        /* Assumptions Table */
        .assumptions-toggle {
          display: block;
          width: 100%;
          padding: 12px;
          margin-top: 20px;
          background: transparent;
          border: 1px dashed #D9D5CF;
          border-radius: 6px;
          color: #9A9690;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 13px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .assumptions-toggle:hover {
          border-color: #1B2A4A;
          color: #1B2A4A;
        }

        .assumptions-table-container {
          margin-top: 20px;
          overflow-x: auto;
        }

        .assumptions-table {
          width: 100%;
          border-collapse: collapse;
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 11px;
        }

        .assumptions-table th {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 10px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: #9A9690;
          text-align: right;
          padding: 8px 10px;
          border-bottom: 1px solid #D9D5CF;
          white-space: nowrap;
        }

        .assumptions-table th:first-child {
          text-align: center;
        }

        .assumptions-table td {
          text-align: right;
          padding: 8px 10px;
          border-bottom: 1px solid #E8E6E1;
          color: #4A4641;
        }

        .assumptions-table td:first-child {
          text-align: center;
          color: #9A9690;
        }

        .assumptions-table tr.post-investment {
          background: rgba(27, 42, 74, 0.04);
        }

        .assumptions-table .basis-cell {
          text-align: left;
        }

        .assumptions-table .basis-label {
          display: block;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 9px;
          color: #9A9690;
          text-transform: uppercase;
        }

        .assumptions-table .basis-value {
          color: #1B2A4A;
        }

        .assumptions-table .fee-cell {
          color: #B5473A;
        }

        .table-note {
          margin-top: 12px;
          font-size: 11px;
          color: #9A9690;
          font-style: italic;
        }

        /* Metrics */
        .metrics-row {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 16px;
          margin-top: 14px;
        }

        .net-impact-panel {
          margin-top: 18px;
          border: 1px solid #E8E6E1;
          border-radius: 8px;
          background: rgba(19, 35, 58, 0.03);
          padding: 14px 14px 8px;
        }

        .net-impact-title {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          color: #9A9690;
          margin-bottom: 8px;
        }

        .metric-card {
          background: #E8E6E1;
          padding: 16px;
          border-radius: 6px;
          text-align: center;
        }

        .metric-label {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          color: #9A9690;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 8px;
        }

        .metric-value {
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 20px;
          font-weight: 500;
        }

        .metric-subtext {
          font-size: 12px;
          color: #9A9690;
          margin-top: 4px;
        }

        /* Charts */
        .flow-canvas,
        .waterfall-canvas,
        .timeline-canvas,
        .comparison-canvas {
          display: block;
          margin: 14px 0;
        }

        .bar-chart {
          display: flex;
          flex-direction: column;
        }

        .bar-chart-bars {
          display: flex;
          align-items: flex-end;
          justify-content: space-around;
          height: 100%;
          min-height: 140px;
          padding: 20px 0;
        }

        .bar-column {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: flex-end;
          flex: 1;
          max-width: 60px;
          height: 100%;
        }

        .bar {
          width: 40px;
          border-radius: 4px 4px 0 0;
          transition: height 0.3s ease;
        }

        .bar-value-label {
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 11px;
          color: #1B2A4A;
          margin-bottom: 8px;
        }

        .bar-label {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 10px;
          color: #9A9690;
          margin-top: 8px;
          text-align: center;
        }

        /* Waterfall Legend */
        .waterfall-legend {
          display: flex;
          justify-content: center;
          gap: 24px;
          margin-top: 16px;
        }

        .legend-item {
          display: flex;
          align-items: center;
          gap: 8px;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 12px;
          color: #9A9690;
        }

        .legend-color {
          width: 12px;
          height: 12px;
          border-radius: 2px;
        }

        /* Hurdle Status */
        .hurdle-status {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          border-radius: 6px;
          margin-bottom: 20px;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 13px;
          transition: all 0.3s ease;
        }

        .hurdle-status.cleared {
          background: rgba(45, 107, 79, 0.12);
          border: 1px solid rgba(45, 107, 79, 0.28);
          color: #1B2A4A;
        }

        .hurdle-status.not-cleared {
          background: rgba(181, 71, 58, 0.12);
          border: 1px solid rgba(181, 71, 58, 0.28);
          color: #B5473A;
        }

        .hurdle-indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: currentColor;
          animation: pulse 2s infinite;
        }

        .assumption-note {
          font-size: 13px;
          color: #5B657A;
          background: #F7FAFE;
          border: 1px solid #DCE3EE;
          border-radius: 8px;
          padding: 10px 12px;
          margin-bottom: 18px;
        }

        .carry-link-note {
          margin: -6px 0 14px;
          font-size: 12px;
          color: #5B657A;
          line-height: 1.45;
        }

        .carry-hinge-note {
          margin: 8px 0 10px;
          font-size: 12px;
          color: #5E687C;
          line-height: 1.45;
        }

        .profit-split-panel {
          margin-top: 14px;
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #FAFCFF;
          padding: 12px 14px;
        }

        .profit-split-title {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: #415574;
          margin-bottom: 8px;
        }

        .profit-split-bar {
          width: 100%;
          height: 28px;
          border-radius: 999px;
          overflow: hidden;
          display: flex;
          background: #E3E8F1;
        }

        .profit-split-segment {
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.4px;
          white-space: nowrap;
          min-width: 48px;
        }

        .profit-split-segment.lp {
          background: #1B2A4A;
          color: #F5F3EF;
        }

        .profit-split-segment.gp {
          background: #B5473A;
          color: #FBECE8;
        }

        .profit-split-meta {
          margin-top: 8px;
          display: flex;
          flex-wrap: wrap;
          gap: 10px 18px;
          font-size: 12px;
          color: #596275;
        }

        .profit-split-catchup {
          margin-top: 8px;
          font-size: 12px;
          color: #6B7283;
          line-height: 1.45;
        }

        .future-net-deal-note {
          margin: 12px 0 4px;
          font-size: 13px;
          color: #5B657A;
          line-height: 1.5;
        }

        .not-covered-block {
          margin-top: 18px;
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #FAFCFF;
          padding: 12px 14px;
        }

        .not-covered-title {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: #415574;
          margin-bottom: 6px;
        }

        .not-covered-list {
          margin: 0;
          padding-left: 18px;
          color: #5B657A;
          font-size: 13px;
          line-height: 1.5;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        @keyframes marginArrowNudge {
          0%, 100% {
            transform: translateX(0);
          }
          50% {
            transform: translateX(-4px);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .interactive-margin-arrow {
            animation: none;
          }
        }

        /* Comparison Grid */
        .comparison-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 20px;
          margin: 32px 0;
        }

        .comparison-card {
          background: #ffffff;
          border: 1px solid #E8E6E1;
          border-radius: 8px;
          padding: 24px;
        }

        .comparison-card h4 {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 14px;
          font-weight: 500;
          color: #1B2A4A;
          margin-bottom: 12px;
        }

        .comparison-card p {
          font-size: 14px;
          margin-bottom: 16px;
        }

        .comparison-list {
          list-style: none;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 13px;
        }

        .comparison-list li {
          margin-bottom: 6px;
          color: #9A9690;
        }

        .comparison-metrics {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin: 24px 0;
        }

        .comparison-column h5 {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 12px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 12px;
          text-align: center;
        }

        .comparison-column.european h5 { color: #1B2A4A; }
        .comparison-column.american h5 { color: #B5473A; }

        .metric-stack {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .difference-callout {
          background: #E8E6E1;
          padding: 16px;
          border-radius: 6px;
          text-align: center;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 14px;
        }

        .difference-callout .positive { color: #1B2A4A; }
        .difference-callout .negative { color: #B5473A; }

        /* Fee Structure Comparison */
        .structure-comparison {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
          margin: 16px 0 14px;
        }

        .structure-card {
          background: linear-gradient(180deg, #FBFCFF 0%, #F4F7FC 100%);
          border: 2px solid;
          border-radius: 10px;
          padding: 12px 14px;
          text-align: center;
        }

        .structure-label {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 12px;
          font-weight: 600;
          margin-bottom: 6px;
        }

        .structure-net {
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 20px;
          color: #1B2A4A;
          margin-bottom: 4px;
          line-height: 1.15;
        }

        .structure-secondary {
          font-size: 12px;
          color: #4A4641;
          margin-bottom: 6px;
        }

        .structure-breakdown {
          display: flex;
          justify-content: center;
          flex-wrap: wrap;
          gap: 4px 12px;
          font-size: 11px;
          color: #9A9690;
        }

        .tradeoff-curve {
          margin-top: 10px;
          border: 1px solid #DCE3EE;
          border-radius: 12px;
          background: linear-gradient(180deg, #FCFDFF 0%, #F5F8FC 100%);
          padding: 14px 16px 10px;
        }

        .tradeoff-curve-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 14px;
          margin-bottom: 6px;
        }

        .tradeoff-curve-kicker {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: #6E7688;
          margin-bottom: 4px;
        }

        .tradeoff-curve-title {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 20px;
          line-height: 1.15;
          color: #1B2A4A;
          margin: 0;
        }

        .tradeoff-curve-subtitle {
          margin-top: 4px;
          font-size: 12px;
          color: #5B657A;
          line-height: 1.45;
        }

        .tradeoff-curve-note {
          margin: 2px 0 0;
          font-size: 12px;
          color: #5B657A;
          line-height: 1.5;
        }

        .tvpi-crossover-pill {
          min-width: 190px;
          padding: 10px 12px;
          border-radius: 10px;
          border: 1px solid rgba(201, 168, 76, 0.45);
          background: linear-gradient(180deg, #FFFDF6 0%, #FAF5E7 100%);
        }

        .tvpi-crossover-pill-label {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.7px;
          text-transform: uppercase;
          color: #8A6D1F;
          margin-bottom: 4px;
        }

        .tvpi-crossover-pill-value {
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 14px;
          color: #1B2A4A;
          line-height: 1.25;
        }

        .underinvesting-charts {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 18px;
          align-items: start;
        }

        .underinvesting-curve {
          margin: 0;
        }

        .underinvesting-legend {
          display: flex;
          flex-wrap: wrap;
          gap: 8px 22px;
          margin: 2px 0 6px;
          align-items: center;
        }

        .underinvesting-legend-item {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: #4A4641;
        }

        .underinvesting-legend-line {
          width: 30px;
          height: 3px;
          border-radius: 999px;
          display: inline-block;
        }

        .crossover-indicator {
          background: #E8E6E1;
          border-radius: 8px;
          padding: 20px;
          text-align: center;
          margin-top: 24px;
        }

        .crossover-line {
          height: 2px;
          background: linear-gradient(90deg, #1B2A4A, #B5473A);
          margin-bottom: 16px;
        }

        .crossover-text strong {
          display: block;
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 16px;
          color: #1B2A4A;
          margin-bottom: 8px;
        }

        .crossover-text p {
          font-size: 13px;
          color: #9A9690;
          margin: 0;
        }

        /* Returns Grid */
        .returns-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 12px;
          margin-bottom: 24px;
        }

        .return-input label {
          display: block;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          color: #9A9690;
          text-transform: uppercase;
          margin-bottom: 8px;
        }

        /* Callouts */
        .callout {
          display: flex;
          gap: 16px;
          background: #E8E6E1;
          border-left: 3px solid #1B2A4A;
          padding: 20px;
          margin: 32px 0;
          border-radius: 0 8px 8px 0;
        }

        .callout-insight {
          border-left-color: #C9A84C;
        }

        .callout-icon {
          font-size: 24px;
          flex-shrink: 0;
        }

        .callout-content {
          font-size: 15px;
        }

        .callout-content strong {
          color: #1B2A4A;
        }

        /* Expense Categories */
        .expense-categories {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .expense-category {
          display: grid;
          grid-template-columns: minmax(140px, 180px) minmax(120px, 1fr) 48px minmax(220px, 1.2fr);
          align-items: center;
          gap: 10px;
        }

        .expense-bar-container {
          width: 100%;
          height: 12px;
          background: #E8E6E1;
          border-radius: 999px;
          position: relative;
          overflow: hidden;
        }

        .expense-bar {
          height: 100%;
          border-radius: 999px;
          transition: width 0.3s ease;
        }

        .expense-percent {
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 12px;
          color: #1B2A4A;
          font-weight: 500;
          text-align: right;
        }

        .expense-name {
          font-size: 13px;
          font-weight: 500;
          color: #1B2A4A;
          line-height: 1.2;
        }

        .expense-desc {
          font-size: 12px;
          color: #9A9690;
          line-height: 1.3;
        }

        .line-credit-block .sliders-grid {
          grid-template-columns: repeat(4, minmax(140px, 1fr));
          gap: 10px;
          margin-bottom: 14px;
        }

        .line-credit-block .comparison-canvas {
          margin: 10px 0 8px;
        }

        .loc-call-timing {
          margin-top: 4px;
        }

        .loc-call-timing-title {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: #5B657A;
          margin-bottom: 8px;
        }

        .loc-call-timing-note {
          margin: 6px 0 0;
          font-size: 12px;
          color: #6B7283;
          line-height: 1.45;
        }

        .loc-mechanics-explainer {
          margin-top: 14px;
          border: 1px solid #DCE3EE;
          border-radius: 12px;
          background: linear-gradient(180deg, #FBFCFF 0%, #F6F9FD 100%);
          padding: 14px;
        }

        .loc-mechanics-title {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.9px;
          text-transform: uppercase;
          color: #415574;
          margin-bottom: 10px;
        }

        .loc-mechanics-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }

        .loc-mechanics-card {
          border: 1px solid #D7E0EE;
          border-radius: 10px;
          background: #FFFFFF;
          padding: 12px;
        }

        .loc-mechanics-card.positive {
          border-left: 4px solid #2D6B4F;
        }

        .loc-mechanics-card.negative {
          border-left: 4px solid #B5473A;
        }

        .loc-mechanics-card-title {
          font-size: 13px;
          font-weight: 700;
          color: #1B2A4A;
          margin-bottom: 6px;
        }

        .loc-mechanics-card p {
          margin: 0;
          font-size: 13px;
          line-height: 1.55;
          color: #4F5B72;
        }

        .loc-mechanics-summary {
          margin: 10px 0 0;
          font-size: 13px;
          line-height: 1.55;
          color: #45526A;
        }

        .loc-outcome-charts {
          margin-top: 12px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }

        .loc-outcome-chart {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #FBFCFF;
          padding: 10px 12px 12px;
        }

        .loc-outcome-title {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: #415574;
          margin-bottom: 4px;
        }

        .loc-outcome-chart .bar-chart {
          height: 200px;
        }

        .loc-outcome-chart .bar-chart-bars {
          justify-content: center;
          gap: 48px;
          padding: 14px 0 8px;
        }

        .loc-outcome-chart .bar-column {
          flex: 0 0 auto;
          max-width: none;
          min-width: 112px;
        }

        .loc-outcome-chart .bar {
          width: 96px;
          border-radius: 8px 8px 0 0;
          box-shadow: 0 8px 16px rgba(27, 42, 74, 0.15);
        }

        .loc-outcome-chart .bar-value-label {
          font-size: 12px;
          font-weight: 600;
        }

        .loc-outcome-chart .bar-label {
          font-size: 11px;
          color: #6E7688;
        }

        .loc-outcome-delta {
          margin-top: 6px;
          font-size: 16px;
          color: #1B2A4A;
          font-weight: 500;
        }

        .loc-outcome-delta.negative {
          color: #B5473A;
        }

        .loc-zoom-note {
          margin-top: 4px;
          font-size: 11px;
          color: #7B8395;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .loc-assumption-note {
          margin: 8px 0 0;
          font-size: 12px;
          color: #6B7283;
          line-height: 1.45;
        }

        .loc-lp-impact-note {
          margin: 12px 0 0;
          padding-top: 10px;
          border-top: 1px solid #E2E8F2;
          font-size: 14px;
          line-height: 1.5;
          color: #4E586D;
        }

        .line-credit-block .metrics-row {
          margin-top: 12px;
          gap: 10px;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        }

        .line-credit-block .metric-card {
          padding: 12px;
        }

        .line-credit-tradeoffs {
          margin-top: 14px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }

        .line-credit-tradeoff {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          padding: 12px 14px;
          background: #FAFCFF;
        }

        .line-credit-tradeoff.positive {
          border-left: 3px solid #2D6B4F;
        }

        .line-credit-tradeoff.negative {
          border-left: 3px solid #B5473A;
        }

        .line-credit-tradeoff-title {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: #415574;
          margin-bottom: 6px;
        }

        .line-credit-tradeoff p {
          margin: 0;
          font-size: 13px;
          color: #5B657A;
          line-height: 1.5;
        }

        .waterfall-timing-block .comparison-canvas {
          margin: 8px 0 6px;
        }

        .waterfall-timing-block .metrics-row {
          margin-top: 8px;
          gap: 12px;
        }

        .waterfall-timing-block .metric-card {
          padding: 14px;
        }

        .waterfall-timing-block .difference-callout {
          margin-top: 10px;
          padding: 14px 16px;
        }

        .timing-layout {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
          margin-top: 4px;
        }

        .timing-card {
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          background: #FBFCFF;
          padding: 12px 14px;
        }

        .timing-card-title {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: #415574;
          margin-bottom: 8px;
        }

        .timing-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 13px;
          color: #5B657A;
          padding: 7px 0;
          border-top: 1px solid #E8EDF5;
        }

        .timing-row:first-of-type {
          border-top: none;
          padding-top: 0;
        }

        .timing-row strong {
          font-family: 'SF Mono', 'Monaco', monospace;
          color: #1B2A4A;
          font-weight: 500;
        }

        /* Conclusion */
        .conclusion {
          border-top: 1px solid #E8E6E1;
          margin-top: 40px;
        }

        .pathway-footer {
          text-align: center;
          padding: 40px 0;
          border-top: 1px solid #E8E6E1;
          margin-top: 40px;
        }

        .pathway-logo {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 14px;
          letter-spacing: 3px;
          text-transform: uppercase;
          color: #1B2A4A;
          margin-bottom: 8px;
        }

        .pathway-footer p {
          font-size: 13px;
          color: #9A9690;
          margin: 0;
        }

        .compliance-footer {
          border-top: 1px solid #DCE3EE;
          background: #F7F9FC;
          padding: 18px 24px 26px;
        }

        .compliance-footer-inner {
          max-width: 1080px;
          margin: 0 auto;
          display: grid;
          gap: 8px;
        }

        .compliance-footer-title {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 1.2px;
          text-transform: uppercase;
          color: #1B2A4A;
        }

        .compliance-footer p {
          margin: 0;
          font-size: 12px;
          line-height: 1.55;
          color: #5C6679;
        }

        .compliance-modal-backdrop {
          position: fixed;
          inset: 0;
          z-index: 220;
          background: rgba(9, 18, 34, 0.62);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }

        .compliance-modal {
          width: min(640px, 100%);
          border-radius: 16px;
          background: #ffffff;
          box-shadow: 0 24px 60px rgba(8, 18, 35, 0.32);
          border: 1px solid #D9E2EE;
          padding: 22px;
        }

        .compliance-modal-kicker {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 1.2px;
          text-transform: uppercase;
          color: #A8892E;
          margin-bottom: 10px;
        }

        .compliance-modal h2 {
          font-size: clamp(24px, 4vw, 32px);
          line-height: 1.15;
          color: #1B2A4A;
          margin-bottom: 14px;
        }

        .compliance-modal-copy {
          display: grid;
          gap: 10px;
          color: #4F5B72;
          font-size: 15px;
          line-height: 1.6;
        }

        .compliance-modal-meta {
          margin-top: 14px;
          font-size: 12px;
          color: #6A7588;
          letter-spacing: 0.3px;
        }

        .compliance-modal-actions {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
          margin-top: 20px;
        }

        .compliance-modal-link {
          color: #1B2A4A;
          font-weight: 600;
          text-decoration: none;
          border-bottom: 1px solid rgba(27, 42, 74, 0.35);
        }

        .compliance-modal-link:hover {
          color: #A8892E;
          border-bottom-color: rgba(168, 137, 46, 0.6);
        }

        .compliance-modal-button {
          min-height: 42px;
          padding: 0 16px;
          border: 0;
          border-radius: 999px;
          background: #1B2A4A;
          color: #ffffff;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          cursor: pointer;
        }

        .compliance-modal-button:hover {
          background: #10213F;
        }

        .sources-footer {
          margin-top: 26px;
          padding-top: 18px;
          border-top: 1px solid #E3E8F1;
        }

        .sources-title {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 1px;
          text-transform: uppercase;
          color: #6E7688;
          margin-bottom: 10px;
        }

        .sources-list {
          margin: 0;
          padding-left: 18px;
          color: #6A707A;
          font-size: 13px;
          line-height: 1.55;
        }

        .sources-list a {
          color: #1B2A4A;
          text-decoration: none;
          border-bottom: 1px solid rgba(27, 42, 74, 0.35);
        }

        .sources-list a:hover {
          color: #A8892E;
          border-bottom-color: rgba(168, 137, 46, 0.6);
        }

        /* Responsive */
        @media (max-width: 980px) {
          .interactive-margin-callout {
            position: static;
            width: auto;
            margin: 0 0 12px;
          }

          .interactive-margin-arrow {
            display: none;
          }

          .expense-category {
            grid-template-columns: minmax(120px, 160px) minmax(100px, 1fr) 44px;
            row-gap: 4px;
          }

          .expense-desc {
            grid-column: 1 / -1;
          }

          .line-credit-block .sliders-grid {
            grid-template-columns: repeat(2, minmax(140px, 1fr));
          }

          .loc-outcome-charts {
            grid-template-columns: 1fr;
          }

          .loc-mechanics-grid {
            grid-template-columns: 1fr;
          }

          .line-credit-tradeoffs {
            grid-template-columns: 1fr;
          }

          .underinvesting-charts {
            grid-template-columns: 1fr;
          }

          .timing-layout {
            grid-template-columns: 1fr;
          }

          .environment-toolbar {
            grid-template-columns: 1fr;
          }

          .environment-page-controls {
            grid-template-columns: auto 1fr auto;
          }

          .environment-pdf-frame {
            min-height: 460px;
            height: 64vh;
          }

          .environment-conversion-top {
            grid-template-columns: 1fr;
          }

          .portfolio-select-grid {
            grid-template-columns: 1fr;
          }

          .portfolio-hero-teaser {
            padding: 10px;
          }

          .portfolio-forecast-step-grid {
            grid-template-columns: 1fr;
          }

          .portfolio-funnel-controls {
            grid-template-columns: 1fr;
          }

          .portfolio-funnel-story-grid {
            grid-template-columns: 1fr;
          }

          .portfolio-funnel-metrics-inline {
            grid-template-columns: 1fr;
          }

          .portfolio-funnel-svg {
            min-height: 0;
          }

          .portfolio-funnel-legend {
            display: flex;
            flex-wrap: wrap;
          }

          .portfolio-funnel-step-stack {
            max-height: none;
            overflow: visible;
            padding-right: 0;
          }

          .portfolio-lifecycle-assumption-grid {
            grid-template-columns: 1fr;
          }

          .portfolio-level-set-grid,
          .portfolio-level-set-decoder {
            grid-template-columns: 1fr;
          }

          .portfolio-commentary-table th {
            width: 140px;
          }

          .portfolio-lifecycle-stage-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .portfolio-flow-svg {
            height: 390px;
          }

          .sliders-grid.three-up {
            grid-template-columns: repeat(2, minmax(140px, 1fr));
          }

          .custom-terms-fund-grid {
            grid-template-columns: 1fr;
          }

          .custom-terms-pacing-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .liquidity-callout-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 600px) {
          .header-content {
            align-items: flex-start;
            flex-direction: column;
            justify-content: center;
            padding: 10px 0;
          }

          .header-actions {
            width: 100%;
            justify-content: space-between;
          }

          .hero-action-bar {
            flex-direction: column;
          }

          .hero-primary-cta,
          .hero-secondary-cta {
            width: 100%;
          }

          .hero-trust-strip {
            border-radius: 14px;
          }

          .pathway-inline-cta {
            align-items: flex-start;
          }

          .pathway-inline-cta a {
            width: 100%;
          }

          .compliance-modal {
            padding: 18px;
          }

          .compliance-modal-actions {
            align-items: stretch;
          }

          .compliance-modal-button {
            width: 100%;
          }

          .structure-comparison {
            grid-template-columns: 1fr;
          }

          .tradeoff-curve-head {
            flex-direction: column;
          }

          .tvpi-crossover-pill {
            min-width: 0;
            width: 100%;
          }

          .comparison-metrics {
            grid-template-columns: 1fr;
          }

          .management-fee-block .sliders-grid {
            grid-template-columns: 1fr;
          }

          .sliders-grid.two-up,
          .sliders-grid.three-up {
            grid-template-columns: 1fr;
          }

          .custom-terms-pacing-grid {
            grid-template-columns: 1fr;
          }

          .environment-frame-wrap {
            min-height: 420px;
          }

          .environment-pdf-frame {
            min-height: 420px;
            height: 60vh;
          }

          .environment-delta-values {
            grid-template-columns: 1fr;
            gap: 4px;
          }

          .environment-delta-values span,
          .environment-delta-values span:last-child {
            text-align: left;
          }

          .portfolio-mix-chips {
            gap: 6px;
          }

          .portfolio-commentary-table th,
          .portfolio-commentary-table td {
            display: block;
            width: 100%;
            padding: 6px 0;
            border-top: none;
          }

          .portfolio-commentary-table tr {
            display: block;
            border-top: 1px solid #E6ECF5;
            padding: 6px 0;
          }

          .portfolio-commentary-table tr:first-child {
            border-top: none;
          }

          .portfolio-lifecycle-stage-grid {
            grid-template-columns: 1fr;
          }

          .portfolio-lifecycle-automation {
            padding: 12px 12px;
          }

          .portfolio-lifecycle-year-readout {
            font-size: 30px;
          }

          .portfolio-lifecycle-automation-actions {
            width: 100%;
            justify-content: flex-start;
          }

          .portfolio-flow-svg {
            height: 480px;
          }

          .portfolio-funnel-step-title {
            font-size: 18px;
          }

          .portfolio-funnel-step-prompt {
            font-size: 14px;
          }

          .portfolio-funnel-step-card-title {
            font-size: 17px;
          }

          .portfolio-funnel-step-card-copy {
            font-size: 14px;
          }

          .portfolio-funnel-step-stack {
            max-height: none;
            overflow: visible;
            padding-right: 0;
          }

          .portfolio-forecast-row-head {
            flex-direction: column;
            align-items: flex-start;
            gap: 2px;
          }

          .hero-graphboard {
            padding: 16px;
          }

          .hero-graph-canvas {
            height: 260px;
          }

          .expense-category {
            grid-template-columns: 1fr;
            gap: 6px;
          }

          .expense-bar-container {
            height: 10px;
          }

          .expense-percent {
            text-align: left;
            font-size: 11px;
          }

          .line-credit-block .sliders-grid {
            grid-template-columns: 1fr;
          }

          .loc-outcome-chart .bar-chart-bars {
            gap: 28px;
          }

          .loc-outcome-chart .bar {
            width: 74px;
          }

          .profit-split-meta {
            flex-direction: column;
            gap: 6px;
          }
        }
      `}</style>

      <Header />
      <div className="app-shell">
        <SideNav sections={SECTION_LINKS} />
        <main className="app-main">
          <>
            <HeroSection />
            <IntroSection
              globalGrossMultiple={globalGrossMultiple}
              onGrossMultipleChange={setGlobalGrossMultiple}
            />
            <ManagementFeeSection />
            <ExpensesSection
              globalGrossMultiple={globalGrossMultiple}
              onGrossMultipleChange={setGlobalGrossMultiple}
              globalDeploymentRate={globalDeploymentRate}
              onDeploymentRateChange={setGlobalDeploymentRate}
            />
            <CarrySection
              globalGrossMultiple={globalGrossMultiple}
              onGrossMultipleChange={setGlobalGrossMultiple}
            />
            <WaterfallComparisonSection
              globalGrossMultiple={globalGrossMultiple}
              onGrossMultipleChange={setGlobalGrossMultiple}
            />
            <UnderinvestingSection
              globalGrossMultiple={globalGrossMultiple}
              onGrossMultipleChange={setGlobalGrossMultiple}
              globalDeploymentRate={globalDeploymentRate}
              onDeploymentRateChange={setGlobalDeploymentRate}
            />
            <FeeTradeoffSection
              globalGrossMultiple={globalGrossMultiple}
              onGrossMultipleChange={setGlobalGrossMultiple}
            />
            <QuarterlyScheduleSection
              globalGrossMultiple={globalGrossMultiple}
              onGrossMultipleChange={setGlobalGrossMultiple}
              globalDeploymentRate={globalDeploymentRate}
              onDeploymentRateChange={setGlobalDeploymentRate}
            />
            <ConclusionSection />
          </>
        </main>
      </div>
      <ComplianceFooter />
      <StickyContactPrompt />
      {disclaimerReady && !hasAcceptedDisclaimer ? (
        <ComplianceModal onAcknowledge={acknowledgeDisclaimer} />
      ) : null}
    </div>
  );
}
