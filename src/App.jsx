import React, { useState, useMemo, useEffect, useRef } from 'react';

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

// Shared source-of-truth mapping for gross to net TVPI.
// Anchored at 2.5x gross -> 2.0x net, with widening drag at higher outcomes.
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

const Slider = ({ value, onChange, min, max, step = 0.01, label, format = (v) => v, accent = '#1B2A4A' }) => {
  const percentage = ((value - min) / (max - min)) * 100;

  return (
    <div className="slider-container">
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
  { id: 'portfolio-single-fund', label: 'Single Fund Lifecycle' },
  { id: 'portfolio-layering', label: 'Vintage Layering' },
  { id: 'portfolio-strategies', label: 'Strategy Curves' },
  { id: 'portfolio-targeting', label: 'Target Exposure Planning' },
  { id: 'portfolio-types', label: 'Investment Type Mix' },
  { id: 'portfolio-future-forecast', label: 'Future Forecast Funnel' },
  { id: 'portfolio-riffs', label: 'Implementation Riffs' }
];

const ENVIRONMENT_REPORT_FILE = 'pathway-4q25-private-market-environment-report.pdf';
const ENVIRONMENT_REPORT_PAGE_COUNT = 48;

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
      <div className="side-nav-title">Contents</div>
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
  showLegend = true
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

      const padding = { top: 40, bottom: 50, left: 60, right: 20 };
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
    showLegend
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
  height = 290
}) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
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

    const allValues = [
      ...safeTotal,
      ...safeSingle,
      ...safeVintages.flat()
    ].filter((value) => Number.isFinite(value));
    const maxValue = Math.max(1e-9, ...allValues) * 1.1;
    const minValue = 0;
    const range = Math.max(1e-9, maxValue - minValue);

    const xForIndex = (i) => padding.left + (i / denominator) * chartWidth;
    const yForValue = (v) => padding.top + ((maxValue - v) / range) * chartHeight;

    // Grid and y-axis labels.
    ctx.strokeStyle = '#E8E6E1';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (i / 4) * chartHeight;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      const value = maxValue - (i / 4) * range;
      ctx.fillStyle = '#9A9690';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(yFormatter(value), padding.left - 8, y + 4);
    }

    // Light fill for total portfolio NAV.
    ctx.beginPath();
    safeTotal.forEach((value, i) => {
      const x = xForIndex(i);
      const y = yForValue(value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xForIndex(length - 1), yForValue(0));
    ctx.lineTo(xForIndex(0), yForValue(0));
    ctx.closePath();
    ctx.fillStyle = 'rgba(45, 107, 79, 0.08)';
    ctx.fill();

    // Draw each individual vintage curve.
    safeVintages.forEach((series) => {
      ctx.strokeStyle = 'rgba(74, 123, 167, 0.35)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      series.forEach((value, i) => {
        const x = xForIndex(i);
        const y = yForValue(value);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });

    // Single-commitment template curve (dashed).
    if (safeSingle.length === length) {
      ctx.strokeStyle = '#9A9690';
      ctx.lineWidth = 1.8;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      safeSingle.forEach((value, i) => {
        const x = xForIndex(i);
        const y = yForValue(value);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Summed portfolio NAV (bold).
    ctx.strokeStyle = '#2D6B4F';
    ctx.lineWidth = 3;
    ctx.beginPath();
    safeTotal.forEach((value, i) => {
      const x = xForIndex(i);
      const y = yForValue(value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // End marker and label.
    const endX = xForIndex(length - 1);
    const endY = yForValue(safeTotal[length - 1]);
    ctx.fillStyle = '#2D6B4F';
    ctx.beginPath();
    ctx.arc(endX, endY, 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '600 10px Helvetica Neue';
    const totalLabel = 'Summed Portfolio NAV';
    const labelWidth = ctx.measureText(totalLabel).width + 10;
    const labelX = Math.max(padding.left + 4, Math.min(width - padding.right - labelWidth, endX - labelWidth - 8));
    const labelY = Math.max(padding.top + 6, endY - 18);
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.fillRect(labelX, labelY, labelWidth, 14);
    ctx.strokeStyle = 'rgba(45, 107, 79, 0.45)';
    ctx.strokeRect(labelX, labelY, labelWidth, 14);
    ctx.fillStyle = '#2D6B4F';
    ctx.textAlign = 'left';
    ctx.fillText(totalLabel, labelX + 5, labelY + 10);

    // Legend.
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
  }, [singleSeries, vintageSeries, totalSeries, xLabels, xTickStep, yFormatter]);

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

// ============================================================================
// SECTION COMPONENTS
// ============================================================================

const Header = ({ compactControls, onToggleCompactControls, activePage, onNavigatePage }) => {
  const [menuOpen, setMenuOpen] = useState(false);

  const handleToggleCompact = () => {
    onToggleCompactControls();
    setMenuOpen(false);
  };

  const handleNavigate = (pageKey) => {
    onNavigatePage(pageKey);
    setMenuOpen(false);
  };

  return (
    <header className="site-header">
      <div className="header-content">
        <div className="header-logo">
          <img
            className="header-pathway-mark"
            src="https://pathwaycapital.com/wp-content/uploads/2019/01/pathway-logo@1x.svg"
            alt="Pathway Capital logo"
          />
          <span className="header-product-tag">Education</span>
        </div>
        <div className="header-actions">
          <div className="header-menu">
            <button
              type="button"
              className="header-menu-button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-label="Open header menu"
            >
              <span></span>
              <span></span>
              <span></span>
            </button>
            {menuOpen && (
              <div className="header-menu-panel">
                <button
                  type="button"
                  className={`header-menu-item ${activePage === 'economics' ? 'active' : ''}`}
                  onClick={() => handleNavigate('economics')}
                >
                  Private Markets Economics
                </button>
                <button
                  type="button"
                  className={`header-menu-item ${activePage === 'liquidity' ? 'active' : ''}`}
                  onClick={() => handleNavigate('liquidity')}
                >
                  Liquidity Management
                </button>
                <button
                  type="button"
                  className={`header-menu-item ${activePage === 'portfolio' ? 'active' : ''}`}
                  onClick={() => handleNavigate('portfolio')}
                >
                  Portfolio Construction
                </button>
                <button
                  type="button"
                  className={`header-menu-item ${activePage === 'environment' ? 'active' : ''}`}
                  onClick={() => handleNavigate('environment')}
                >
                  Market Environment
                </button>
                <div className="header-menu-divider" />
                <button type="button" className="header-menu-item" onClick={handleToggleCompact}>
                  Compact Controls: {compactControls ? 'On' : 'Off'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};

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

      const phase = reducedMotion ? 0.62 : (Math.sin(timestamp * 0.00045) + 1) / 2;
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
      <div className="pathway-badge">Interactive Learning Model</div>
      <h1>The Economics of Private Equity</h1>
      <p className="hero-subtitle">
        Controlling costs in private markets is critical. Below is an interactive guide to help
        you understand how these costs impact returns, and strategies for how Pathway improves these outcomes.
      </p>
      <p className="hero-purpose-note">
        This guide is for LPs who want to understand what they are paying for. Strong funds can
        justify strong economics, but only if you can trace each term from gross performance to net outcome.
      </p>

      <HeroGrossNetGraph />

      <p className="hero-scroll-note">Scroll down to build the gross-to-net bridge, one concept at a time.</p>
    </section>
);

const IntroSection = ({ globalGrossMultiple, onGrossMultipleChange } = {}) => {
  const [localGrossReturn, setLocalGrossReturn] = useState(2.5);
  const grossReturn = globalGrossMultiple ?? localGrossReturn;
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
        Minimizing fees is generally a solid goal, but the gross-to-net spread is driven by
        multiple economic terms rather than any single line item. One of the most important is
        carried interest: the GP's share of profits, which is both a transfer from LP gross
        returns and an incentive to drive stronger performance. A fund that returns 3x and pays
        meaningful carry can still deliver excellent net outcomes. A fund that returns 1x and pays
        little or no carry has still consumed years of capital with limited value creation.
      </p>

      <div className="interactive-block management-fee-block">
        <div className="block-header">
          <span className="block-title">From Gross to Net</span>
          <span className="block-subtitle">Drag gross MOIC and watch the bridge into net TVPI</span>
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

      <p>
        The difference between gross and net isn't a mystery or a trick. It's the result
        of contractual economics that compensate GPs for their work and align incentives
        around performance. Understanding these mechanics makes you a better investor—able
        to evaluate terms, negotiate where appropriate, and set realistic expectations for
        your portfolio.
      </p>

      <p>
        Let's break down each component, starting with the most straightforward: the
        management fee.
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
            label="Total Management Fees"
            value={formatCurrency(totalFees * 1e6, 0)}
            subtext="Fund-level fees"
          />
          <MetricCard
            label="Illustrative LP Fees"
            value={formatCurrency(lpTotalFees * 1e6, 0)}
            subtext={`On ${formatCurrency(lpCommitment * 1e6, 0)} commitment`}
            accent="#4A7BA7"
          />
          <MetricCard
            label="LP Fee Load"
            value={formatPercent(lpFeeAsPercentOfCommitment)}
            subtext="As % of LP commitment"
            accent="#B5473A"
          />
          <MetricCard
            label="LP Average Annual Fee"
            value={formatCurrency(lpAverageAnnualFee * 1e6, 0)}
            accent="#9A9690"
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

      <section id="lines-of-credit" className="content-subsection">
        <h3>Subscription Lines Of Credit</h3>

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
      </section>

      <WhatWeDidntCover
        items={[
          'How fund expense practices have changed over time, including periods where more costs shifted from GP operating budgets into fund-level expenses.',
          'How expense caps are often negotiated as a percentage limit (for example, against committed capital or an annual expense budget) and what sits inside vs outside those caps.',
          'How expense definitions and reimbursement mechanics are negotiable terms in the LPA and side letters, just like fee rates and carry terms.'
        ]}
      />
    </section>
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
      <h2>Carried Interest: The Performance Incentive</h2>

      <p className="assumption-note">
        Assumptions for this section: full deployment, no recycling, European-style waterfall, and
        an illustrative 0.20x non-carry spread is already baked into the pre-carry net return.
        The bridge below only shows carry mechanics.
      </p>

      <p>
        Carried interest is the GP share of profits once the hurdle has been achieved.
        This section builds LP outcomes from gross profit, then subtracts GP catch-up and
        GP carry share as negative deductions.
      </p>

      <p>
        The hurdle is tested on a <strong>net LP basis</strong>. Hold period matters because
        compounding raises the dollar profit required before carry can turn on.
      </p>

      <div className="interactive-block">
        <div className="block-header">
          <span className="block-title">Carry Bridge: Pre-Carry Net Return To LP Net Outcome</span>
          <span className="block-subtitle">Start from net return before carry, then apply hurdle, catch-up, and final split</span>
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
              ? `Pre-carry net IRR of ${formatPercent(preCarryNetIRR, 1)} clears the ${formatPercent(hurdleRate, 1)} hurdle by +${preCarryVsHurdleBps.toFixed(0)} bps, so carry applies to excess profits.`
              : `Pre-carry net IRR of ${formatPercent(preCarryNetIRR, 1)} is below the ${formatPercent(hurdleRate, 1)} hurdle by ${Math.abs(preCarryVsHurdleBps).toFixed(0)} bps, so carry is not yet active.`
            }
          </span>
        </div>

        <p className="carry-hinge-note">
          Catch-up hinge: once capital + pref are covered, GP catch-up can temporarily absorb
          incremental profit, so LP net IRR may not move much until catch-up is complete.
        </p>

        <WaterfallChart data={waterfallData.stages} height={280} />

        <div className="profit-split-panel">
          <div className="profit-split-title">Profit Split (Of Pre-Carry Profit)</div>
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
        <strong>1. Return of Capital:</strong> LP capital is returned first.
      </p>

      <p>
        <strong>2. Preferred Return (Hurdle):</strong> This is an earnings threshold, not a
        separate payout line. In this view the hurdle is {formatPercent(hurdleRate, 1)} over a {holdPeriod}-year
        hold, so longer hold periods raise required dollars via compounding.
      </p>

      <p>
        <strong>3. GP Catch-Up:</strong> After hurdle clearance, GP catch-up can take most near-term
        incremental profit until the GP is at its carry share, creating a temporary hinge in LP net IRR progression.
      </p>

      <p>
        <strong>4. Final Split:</strong> Remaining profit is split LP {lpSplitPercent}% / GP {gpSplitPercent}%
        based on the carry slider.
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
  const currentDeploymentIndex = useMemo(() => {
    const rawIndex = Math.round((deploymentRate - 0.6) / 0.02);
    return Math.max(0, Math.min(deploymentCurve.labels.length - 1, rawIndex));
  }, [deploymentRate, deploymentCurve.labels.length]);

  return (
    <section id="underinvesting-impact" className="content-section">
      <h2>Underinvesting: Hidden Net Drag</h2>

      <p>
        A GP can underdeploy capital and still produce a strong gross multiple on invested dollars.
        But from the LP perspective, fee load is still tied to commitment. That makes the gross-to-net
        spread wider on a commitment basis and can materially reduce net IRR.
      </p>

      <div className="interactive-block">
        <div className="block-header">
          <span className="block-title">Deployment Efficiency Stress Test</span>
          <span className="block-subtitle">Same gross MOIC on invested capital, different net LP outcomes</span>
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
            label="Deployment Rate"
            format={(v) => `${(v * 100).toFixed(0)}%`}
            accent="#C9A84C"
          />
        </div>

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
            height={220}
            showLegend={false}
            marker={{
              index: currentDeploymentIndex,
              label: `Current ${(deploymentRate * 100).toFixed(0)}%`,
              color: '#C9A84C'
            }}
          />
          <p className="bridge-note">
            Green stays at invested-basis gross MOIC; navy shows the translated commitment-basis
            gross TVPI as deployment changes.
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
    <section id="fee-carry-tradeoff" className="content-section">
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

        <div className="tvpi-crossover-banner">
          <div className="tvpi-crossover-topline">TVPI Crossover (Primary)</div>
          {tvpiCrossoverResult.hasCrossover ? (
            <>
              <div className="tvpi-crossover-value">{tvpiCrossoverMultiple.toFixed(2)}x gross MOIC</div>
              <div className="tvpi-crossover-subtext">
                At this gross outcome, both fee structures land on roughly the same net TVPI.
              </div>
            </>
          ) : (
            <div className="tvpi-crossover-subtext">
              No TVPI crossover appears in the displayed range (1.0x to 3.5x gross).
            </div>
          )}
        </div>

        <div className="tradeoff-curve">
          <div className="tradeoff-curve-title">Net TVPI Across Gross MOIC Outcomes</div>
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
            marker={tvpiCrossoverResult.hasCrossover ? {
              index: tvpiCrossoverIndex,
              label: `TVPI Cross ${tvpiCrossoverMultiple.toFixed(2)}x`,
              color: '#C9A84C'
            } : null}
          />
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

const PortfolioHeroSection = () => (
  <section id="portfolio-hero" className="hero-section portfolio-hero">
    <div className="pathway-badge">Pathway Education</div>
    <h1>Portfolio Construction in Private Markets</h1>
    <p className="hero-subtitle">How commitments stack over time to produce durable NAV exposure</p>
    <p className="hero-purpose-note">
      This guide starts with one fund lifecycle, then layers multiple vintages and strategy curves
      to show what commitment pacing is required to stay inside a target exposure range.
    </p>
    <div className="hero-scroll-note">Start with one commitment, then build the full program</div>
  </section>
);

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
  const selectedYearLabel = selectedYearRaw.toFixed(1);
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
      <h2>1. Single Fund Lifecycle</h2>
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
        <SingleFundContribNavChart
          data={singleFundContribNavSeries}
          height={245}
          xTickStep={1}
        />
        <p className="portfolio-inline-note">
          This chart is intentionally one fund only. In Section 2, we layer many single-fund NAV curves
          to show how portfolio construction changes the profile.
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
  };

  return (
    <section id="portfolio-layering" className="content-section">
      <h2>2. Vintage Layering: From One Commitment to a Program</h2>
      <p>
        A pension plan does not own one fund. It owns many vintages simultaneously. Layering commitments
        year-over-year smooths exposure and can create a more stable NAV base than a single vintage ever could.
      </p>
      <div className="interactive-block">
        <div className="block-actions">
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
  const [metricView, setMetricView] = useState('drawdown');

  const curveA = useMemo(() => {
    const strategy = PORTFOLIO_STRATEGY_CURVES[strategyA];
    return buildAnnualGrossCurve(strategy.fundLife, strategy.investmentPeriod, strategy.grossMultiple);
  }, [strategyA]);
  const curveB = useMemo(() => {
    const strategy = PORTFOLIO_STRATEGY_CURVES[strategyB];
    return buildAnnualGrossCurve(strategy.fundLife, strategy.investmentPeriod, strategy.grossMultiple);
  }, [strategyB]);

  const maxYears = Math.max(
    PORTFOLIO_STRATEGY_CURVES[strategyA].fundLife,
    PORTFOLIO_STRATEGY_CURVES[strategyB].fundLife
  );
  const years = Array.from({ length: maxYears + 1 }, (_, i) => i);

  const seriesA = years.map((year) => getCurvePointAtAge(curveA, year)[metricView]);
  const seriesB = years.map((year) => getCurvePointAtAge(curveB, year)[metricView]);
  const yearLabels = years.map((year) => `Yr ${year}`);

  const yFormatter = metricView === 'drawdown' || metricView === 'nav'
    ? (value) => `${(value * 100).toFixed(0)}%`
    : (value) => `${value.toFixed(2)}x`;

  const findYearAtDraw80 = (curve) => {
    const row = curve.find((point) => point.drawdown >= 0.8);
    return row ? row.year : curve[curve.length - 1].year;
  };
  const navDuration = (curve) => {
    const peak = Math.max(...curve.map((point) => point.nav));
    const threshold = peak * 0.5;
    const hit = curve.find((point, idx) => idx > 0 && point.nav <= threshold);
    return hit ? hit.year : curve[curve.length - 1].year;
  };

  return (
    <section id="portfolio-strategies" className="content-section">
      <h2>3. Strategy-Specific Curves</h2>
      <p>
        Not all strategies behave the same. Some draw quickly and recycle value faster; others
        build NAV more slowly and keep it outstanding for longer.
      </p>
      <div className="interactive-block">
        <div className="portfolio-select-grid">
          <div className="environment-toolbar-group">
            <span className="environment-toolbar-label">Strategy A</span>
            <select className="environment-select" value={strategyA} onChange={(e) => setStrategyA(e.target.value)}>
              {Object.entries(PORTFOLIO_STRATEGY_CURVES).map(([key, value]) => (
                <option key={key} value={key}>{value.label}</option>
              ))}
            </select>
          </div>
          <div className="environment-toolbar-group">
            <span className="environment-toolbar-label">Strategy B</span>
            <select className="environment-select" value={strategyB} onChange={(e) => setStrategyB(e.target.value)}>
              {Object.entries(PORTFOLIO_STRATEGY_CURVES).map(([key, value]) => (
                <option key={key} value={key}>{value.label}</option>
              ))}
            </select>
          </div>
          <div className="environment-toolbar-group">
            <span className="environment-toolbar-label">Metric</span>
            <ToggleSwitch
              options={[
                { label: 'Drawdown %', value: 'drawdown' },
                { label: 'NAV %', value: 'nav' },
                { label: 'TVPI', value: 'tvpi' }
              ]}
              value={metricView}
              onChange={setMetricView}
              accent="#1B2A4A"
            />
          </div>
        </div>

        <div className="metrics-row">
          <MetricCard
            label={`${PORTFOLIO_STRATEGY_CURVES[strategyA].label}: 80% Draw`}
            value={`Yr ${findYearAtDraw80(curveA)}`}
            subtext="Capital deployment pace"
            accent={PORTFOLIO_STRATEGY_CURVES[strategyA].color}
          />
          <MetricCard
            label={`${PORTFOLIO_STRATEGY_CURVES[strategyB].label}: 80% Draw`}
            value={`Yr ${findYearAtDraw80(curveB)}`}
            subtext="Capital deployment pace"
            accent={PORTFOLIO_STRATEGY_CURVES[strategyB].color}
          />
          <MetricCard
            label="Approx NAV Half-Life"
            value={`${navDuration(curveA)}y / ${navDuration(curveB)}y`}
            subtext="Year when NAV falls below half of peak"
            accent="#1B2A4A"
          />
        </div>

        <ComparisonChart
          seriesA={seriesA}
          seriesB={seriesB}
          labelA={PORTFOLIO_STRATEGY_CURVES[strategyA].label}
          labelB={PORTFOLIO_STRATEGY_CURVES[strategyB].label}
          xLabels={yearLabels}
          xTickStep={2}
          yFormatter={yFormatter}
          colorA={PORTFOLIO_STRATEGY_CURVES[strategyA].color}
          colorB={PORTFOLIO_STRATEGY_CURVES[strategyB].color}
          height={260}
        />
      </div>
    </section>
  );
};

const PortfolioTargetingSection = () => {
  const [planAssetsB, setPlanAssetsB] = useState(12);
  const [targetPct, setTargetPct] = useState(0.12);
  const [bandWidth, setBandWidth] = useState(0.015);
  const [denominatorGrowth, setDenominatorGrowth] = useState(0.045);
  const [existingNavB, setExistingNavB] = useState(1.0);
  const [existingAge, setExistingAge] = useState(6);
  const [annualCommitmentM, setAnnualCommitmentM] = useState(260);
  const [commitGrowth, setCommitGrowth] = useState(0.03);
  const [planningYears, setPlanningYears] = useState(12);

  const annualCurve = useMemo(() => buildAnnualGrossCurve(12, 5, 2.5), []);
  const projection = useMemo(() => {
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

    const inBandYears = rows.filter((row) => row.exposure >= targetPct - bandWidth && row.exposure <= targetPct + bandWidth).length;
    const year5Exposure = rows[Math.min(5, rows.length - 1)]?.exposure || 0;
    const suggestedCommitmentM = year5Exposure > 1e-6
      ? annualCommitmentM * (targetPct / year5Exposure)
      : annualCommitmentM;

    return { rows, inBandYears, year5Exposure, suggestedCommitmentM };
  }, [
    annualCurve,
    planAssetsB,
    denominatorGrowth,
    existingNavB,
    existingAge,
    annualCommitmentM,
    commitGrowth,
    planningYears,
    targetPct,
    bandWidth
  ]);

  const yearLabels = projection.rows.map((row) => `Yr ${row.year}`);
  const exposurePctSeries = projection.rows.map((row) => row.exposure * 100);
  const targetSeries = projection.rows.map(() => targetPct * 100);
  const runoffSeries = projection.rows.map((row) => row.existingRunoffNavB);
  const buildSeries = projection.rows.map((row) => row.newBuildNavB);
  const currentExposure = projection.rows[0]?.exposure || 0;

  return (
    <section id="portfolio-targeting" className="content-section">
      <h2>4. Target Exposure Planning for a Pension Plan</h2>
      <p>
        Hitting a target PE allocation is dynamic. Existing NAV runs off, plan assets (the denominator)
        change over time, and commitment pacing must adapt as both move.
      </p>
      <div className="interactive-block">
        <div className="sliders-grid">
          <Slider label="Plan Assets Today" value={planAssetsB} min={5} max={60} step={0.5} format={(v) => `${formatCurrency(v * 1e9, 0)}`} onChange={setPlanAssetsB} accent="#1B2A4A" />
          <Slider label="Target PE Exposure" value={targetPct} min={0.05} max={0.2} step={0.005} format={(v) => formatPercent(v, 1)} onChange={setTargetPct} accent="#2D6B4F" />
          <Slider label="Target Band Width (+/-)" value={bandWidth} min={0.005} max={0.03} step={0.0025} format={(v) => formatPercent(v, 2)} onChange={setBandWidth} accent="#9A9690" />
          <Slider label="Denominator Growth" value={denominatorGrowth} min={0} max={0.08} step={0.0025} format={(v) => formatPercent(v, 1)} onChange={setDenominatorGrowth} accent="#C9A84C" />
          <Slider label="Existing Portfolio NAV" value={existingNavB} min={0.25} max={3.5} step={0.05} format={(v) => formatCurrency(v * 1e9, 0)} onChange={setExistingNavB} accent="#1B2A4A" />
          <Slider label="Existing Portfolio Avg Age" value={existingAge} min={1} max={11} step={1} format={(v) => `Year ${Math.round(v)}`} onChange={(v) => setExistingAge(Math.round(v))} accent="#B5473A" />
          <Slider label="Annual New Commitments" value={annualCommitmentM} min={75} max={900} step={5} format={(v) => formatCurrency(v * 1e6, 0)} onChange={setAnnualCommitmentM} accent="#1B2A4A" />
          <Slider label="Commitment Growth" value={commitGrowth} min={-0.03} max={0.08} step={0.0025} format={(v) => formatPercent(v, 1)} onChange={setCommitGrowth} accent="#2D6B4F" />
          <Slider label="Planning Horizon" value={planningYears} min={6} max={18} step={1} format={(v) => `${Math.round(v)} years`} onChange={(v) => setPlanningYears(Math.round(v))} accent="#9A9690" />
        </div>

        <div className="metrics-row">
          <MetricCard label="Current Exposure" value={formatPercent(currentExposure, 1)} subtext="Year 0 NAV / assets" accent="#1B2A4A" />
          <MetricCard label="Year 5 Projected Exposure" value={formatPercent(projection.year5Exposure, 1)} subtext={`Target ${formatPercent(targetPct, 1)}`} accent="#2D6B4F" />
          <MetricCard label="Implied Annual Commitments" value={formatCurrency(projection.suggestedCommitmentM * 1e6, 0)} subtext="Approx commitment to align by year 5" accent="#B5473A" />
        </div>

        <p className="portfolio-inline-note">
          Exposure-in-band years in current run: <strong>{projection.inBandYears}</strong> of <strong>{projection.rows.length}</strong>
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
    </section>
  );
};

const PortfolioTypesSection = () => {
  const [secondaryPct, setSecondaryPct] = useState(0.2);
  const [directPct, setDirectPct] = useState(0.1);
  const [annualCommitmentM, setAnnualCommitmentM] = useState(200);

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
  const horizonYears = 12;
  const years = Array.from({ length: horizonYears + 1 }, (_, i) => i);

  const primaryCurve = useMemo(() => buildAnnualGrossCurve(
    PORTFOLIO_STRATEGY_CURVES.buyout.fundLife,
    PORTFOLIO_STRATEGY_CURVES.buyout.investmentPeriod,
    PORTFOLIO_STRATEGY_CURVES.buyout.grossMultiple
  ), []);
  const secondaryCurve = useMemo(() => buildAnnualGrossCurve(
    PORTFOLIO_STRATEGY_CURVES.secondary.fundLife,
    PORTFOLIO_STRATEGY_CURVES.secondary.investmentPeriod,
    PORTFOLIO_STRATEGY_CURVES.secondary.grossMultiple
  ), []);
  const directCurve = useMemo(() => buildAnnualGrossCurve(
    PORTFOLIO_STRATEGY_CURVES.direct.fundLife,
    PORTFOLIO_STRATEGY_CURVES.direct.investmentPeriod,
    PORTFOLIO_STRATEGY_CURVES.direct.grossMultiple
  ), []);

  const mixSeries = useMemo(() => {
    const called = [];
    const nav = [];
    const allPrimaryNav = [];
    years.forEach((year) => {
      const p = getCurvePointAtAge(primaryCurve, year);
      const s = getCurvePointAtAge(secondaryCurve, year);
      const d = getCurvePointAtAge(directCurve, year);
      called.push(primaryPct * p.drawdown + secondaryPct * s.drawdown + directPct * d.drawdown);
      nav.push(primaryPct * p.nav + secondaryPct * s.nav + directPct * d.nav);
      allPrimaryNav.push(p.nav);
    });
    return { called, nav, allPrimaryNav };
  }, [years, primaryCurve, secondaryCurve, directCurve, primaryPct, secondaryPct, directPct]);

  const year1CallM = mixSeries.called[1] * annualCommitmentM;
  const year1NavM = mixSeries.nav[1] * annualCommitmentM;
  const residualYear10M = mixSeries.nav[10] * annualCommitmentM;

  return (
    <section id="portfolio-types" className="content-section">
      <h2>5. Investment Type Mix: Primaries, Secondaries, Direct Equity</h2>
      <p>
        Different investment types change both deployment speed and NAV duration. Secondaries and
        direct equity can put capital to work faster, but they typically season faster too.
      </p>
      <div className="interactive-block">
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
  const width = 1000;
  const height = 300;
  const padding = { top: 20, right: 24, bottom: 36, left: 52 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const focus = Math.max(0, Math.min(horizonYears, Math.round(focusYear)));
  const activeBand = bands.find((band) => band.active) || bands[bands.length - 1];

  const xFor = (year) => padding.left + (year / horizonYears) * plotWidth;
  const yFor = (value) => padding.top + (1 - value / maxY) * plotHeight;

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
            <text x={padding.left - 8} y={yFor(tick) + 4} textAnchor="end" fontSize="11" fill="#6B7488">
              {tick.toFixed(1)}x
            </text>
          </g>
        ))}

        {[0, 2, 4, 6, 8, 10, 12].map((year) => (
          <g key={`x-${year}`}>
            <line
              x1={xFor(year)}
              y1={padding.top}
              x2={xFor(year)}
              y2={padding.top + plotHeight}
              stroke="#F1F4FA"
              strokeWidth="1"
            />
            <text x={xFor(year)} y={height - 12} textAnchor="middle" fontSize="11" fill="#6B7488">
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
        <text x={focusX + 5} y={padding.top + 12} fontSize="11" fill="#1B2A4A">Focus: Yr {focus}</text>

        <line x1={focusX} y1={yHigh} x2={focusX} y2={yLow} stroke={activeBand?.stroke || '#1B2A4A'} strokeWidth="2.4" />
        <circle cx={focusX} cy={yHigh} r="3.2" fill={activeBand?.stroke || '#1B2A4A'} />
        <circle cx={focusX} cy={yLow} r="3.2" fill={activeBand?.stroke || '#1B2A4A'} />
        <text x={focusX + 8} y={Math.max(padding.top + 12, yHigh - 6)} fontSize="11" fill={activeBand?.stroke || '#1B2A4A'}>
          {focusLow.toFixed(2)}x to {focusHigh.toFixed(2)}x
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
  const HORIZON = 12;
  const MAX_Y = 4.0;
  const DEFAULTS = {
    step: 1,
    focusYear: 8,
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
  const [focusYear, setFocusYear] = useState(DEFAULTS.focusYear);
  const [benchmarkP10, setBenchmarkP10] = useState(DEFAULTS.benchmarkP10);
  const [benchmarkP90, setBenchmarkP90] = useState(DEFAULTS.benchmarkP90);
  const [pathwayLow, setPathwayLow] = useState(DEFAULTS.pathwayLow);
  const [pathwayHigh, setPathwayHigh] = useState(DEFAULTS.pathwayHigh);
  const [pathwayP10, setPathwayP10] = useState(DEFAULTS.pathwayP10);
  const [pathwayP90, setPathwayP90] = useState(DEFAULTS.pathwayP90);
  const [diversifiedP25, setDiversifiedP25] = useState(DEFAULTS.diversifiedP25);
  const [diversifiedP75, setDiversifiedP75] = useState(DEFAULTS.diversifiedP75);

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

  const focusIndex = Math.max(0, Math.min(HORIZON, Math.round(focusYear)));
  const activeLow = activeSeries[focusIndex]?.low ?? 0;
  const activeHigh = activeSeries[focusIndex]?.high ?? 0;
  const activeWidth = activeHigh - activeLow;
  const baselineWidth = (theoretical[focusIndex]?.high ?? 0) - (theoretical[focusIndex]?.low ?? 0);
  const compression = baselineWidth > 0 ? (1 - activeWidth / baselineWidth) * 100 : 0;

  const stepTitles = [
    'Start wide: 0 to max outcomes',
    'Tighten with benchmark percentiles',
    'Switch to Pathway high/low history',
    'Refine with Pathway percentile ranges',
    'Apply diversification smoothing'
  ];

  const stepPrompt = step === 1
    ? 'Click "Tighten With Benchmark Data" to narrow using third-party medians and percentiles.'
    : step === 2
      ? 'Now click "Use Pathway Data" to switch to a richer historical lens.'
      : step === 3
        ? 'Use Pathway percentiles to tighten from high/low extremes into a practical range.'
        : step === 4
          ? 'Apply diversification to show how a portfolio smooths single-fund volatility.'
          : 'You are now at a planning-grade band. Reset to replay the narrowing process.';

  const nextStepLabel = step === 1
    ? 'Tighten With Benchmark Data'
    : step === 2
      ? 'Use Pathway Data'
      : step === 3
        ? 'Tighten With Pathway Percentiles'
        : step === 4
          ? 'Apply Diversification'
          : 'Restart Funnel';

  const advanceStep = () => {
    setStep((prev) => (prev >= 5 ? 1 : prev + 1));
  };

  const resetForecast = () => {
    setStep(DEFAULTS.step);
    setFocusYear(DEFAULTS.focusYear);
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
      <h2>6. Future Forecast Funnel</h2>
      <p>
        This walks users from a deliberately broad uncertainty band to a practical planning range.
        The first chart uses benchmark-style data, then the second asks: what if we had richer internal
        history? Placeholder endpoints are intentionally editable so you can swap in real Pathway values later.
      </p>

      <div className="interactive-block">
        <div className="block-header">
          <span className="block-title">Single-Fund NAV Forecast: Narrowing The Funnel Over Time</span>
          <span className="block-subtitle">X-axis is time, Y-axis is possible NAV outcome range</span>
        </div>
        <div className="block-actions">
          <button type="button" className="portfolio-funnel-step-btn ghost" onClick={() => setStep((prev) => Math.max(1, prev - 1))} disabled={step === 1}>
            Previous Step
          </button>
          <button type="button" className="portfolio-funnel-step-btn" onClick={advanceStep}>
            {nextStepLabel}
          </button>
          <ResetButton onClick={resetForecast} />
        </div>

        <div className="portfolio-funnel-controls">
          <Slider
            label="Future Year To Inspect"
            value={focusYear}
            min={1}
            max={HORIZON}
            step={1}
            format={(v) => `Year ${Math.round(v)}`}
            onChange={(v) => setFocusYear(Math.round(v))}
            accent="#1B2A4A"
          />
          <div className="portfolio-funnel-step-status">
            <div className="portfolio-funnel-step-title">Step {step} of 5: {stepTitles[step - 1]}</div>
            <div className="portfolio-funnel-step-prompt">{stepPrompt}</div>
            <div className="portfolio-funnel-step-pills">
              {stepTitles.map((_, idx) => (
                <button
                  type="button"
                  key={idx}
                  className={`portfolio-funnel-pill ${step === idx + 1 ? 'active' : step > idx + 1 ? 'done' : ''}`}
                  onClick={() => setStep(idx + 1)}
                >
                  {idx + 1}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="portfolio-funnel-chart-grid">
          <PortfolioForecastBandChart
            title="Chart A: Benchmark Funnel"
            subtitle="From 0-to-max uncertainty to a benchmark percentile band"
            bands={benchmarkBands}
            lineSeries={benchmarkLines}
            focusYear={focusYear}
            horizonYears={HORIZON}
            maxY={MAX_Y}
          />

          {step < 3 ? (
            <div className="portfolio-funnel-placeholder">
              <div className="portfolio-funnel-placeholder-title">Chart B: What if we had better historical data?</div>
              <p>
                Click <strong>Use Pathway Data</strong> to unlock a second funnel that uses
                proprietary manager-level history to refine assumptions beyond benchmark medians.
              </p>
            </div>
          ) : (
            <PortfolioForecastBandChart
              title="Chart B: Pathway Proprietary Funnel"
              subtitle="From Pathway high/low history to percentile bands and diversified outcomes"
              bands={pathwayBands}
              lineSeries={pathwayLines}
              focusYear={focusYear}
              horizonYears={HORIZON}
              maxY={MAX_Y}
            />
          )}
        </div>

        <div className="portfolio-funnel-proprietary">
          <div className="portfolio-funnel-proprietary-title">Why this should highlight Pathway expertise</div>
          <p>
            Benchmark medians are useful, but they can only narrow the funnel so far. The second chart is where
            Pathway can demonstrate edge by grounding assumptions in proprietary manager-level historical NAV and
            cash-flow behavior. Replace the placeholder range endpoints with final internal values before publication.
          </p>
        </div>

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

        <div className="metrics-row">
          <MetricCard
            label={`Year ${focusYear} Active Range`}
            value={`${activeLow.toFixed(2)}x to ${activeHigh.toFixed(2)}x`}
            subtext={`Step ${step} lens`}
            accent="#1B2A4A"
          />
          <MetricCard
            label={`Year ${focusYear} Width`}
            value={`${activeWidth.toFixed(2)}x`}
            subtext="Top minus bottom"
            accent="#2D6B4F"
          />
          <MetricCard
            label="Funnel Compression"
            value={`${Math.max(0, compression).toFixed(0)}%`}
            subtext={`Compared with unbounded prior at Year ${focusYear}`}
            accent="#C9A84C"
          />
        </div>
      </div>
    </section>
  );
};

const PortfolioRiffsSection = () => (
  <section id="portfolio-riffs" className="content-section">
    <h2>Riffs: What Else Matters in Real Programs</h2>
    <p>
      The mechanics above are the base layer. In actual portfolio construction, pacing policy and
      governance determine whether target exposure is resilient through market cycles.
    </p>

    <div className="liquidity-callout-grid">
      <div className="liquidity-callout">
        <h3>Commitment Policy Bands</h3>
        <p>Most programs benefit from a rules-based commitment band tied to funded status and denominator volatility.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Liquidity Shock Protocol</h3>
        <p>Predefine actions for a denominator shock: pacing cut, strategy rotation, secondaries, or temporary holdback.</p>
      </div>
      <div className="liquidity-callout">
        <h3>Vintage Diversification</h3>
        <p>Vintage balance is often as important as manager selection for keeping NAV and distributions stable.</p>
      </div>
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

// ============================================================================
// MAIN APP
// ============================================================================

export default function App() {
  const [globalGrossMultiple, setGlobalGrossMultiple] = useState(BASELINE_GROSS_TVPI);
  const [globalDeploymentRate, setGlobalDeploymentRate] = useState(1.0);
  const [compactControls, setCompactControls] = useState(true);
  const [activePage, setActivePage] = useState(() => {
    if (typeof window === 'undefined') return 'economics';
    const hash = window.location.hash.replace('#', '').toLowerCase();
    if (hash.startsWith('portfolio') || PORTFOLIO_SECTION_LINKS.some((section) => section.id === hash)) {
      return 'portfolio';
    }
    if (hash.startsWith('environment') || ENVIRONMENT_SECTION_LINKS.some((section) => section.id === hash)) {
      return 'environment';
    }
    return hash.startsWith('liquidity') ? 'liquidity' : 'economics';
  });

  useEffect(() => {
    const syncPageFromHash = () => {
      const hash = window.location.hash.replace('#', '').toLowerCase();
      if (PORTFOLIO_SECTION_LINKS.some((section) => section.id === hash) || hash.startsWith('portfolio')) {
        setActivePage('portfolio');
      } else if (ENVIRONMENT_SECTION_LINKS.some((section) => section.id === hash) || hash.startsWith('environment')) {
        setActivePage('environment');
      } else if (LIQUIDITY_SECTION_LINKS.some((section) => section.id === hash) || hash.startsWith('liquidity')) {
        setActivePage('liquidity');
      } else {
        setActivePage('economics');
      }
    };

    syncPageFromHash();
    window.addEventListener('hashchange', syncPageFromHash);
    return () => window.removeEventListener('hashchange', syncPageFromHash);
  }, []);

  const navigateToPage = (pageKey) => {
    const targetPage = pageKey === 'liquidity'
      ? 'liquidity'
      : pageKey === 'portfolio'
        ? 'portfolio'
      : pageKey === 'environment'
        ? 'environment'
        : 'economics';
    setActivePage(targetPage);
    const firstSectionId = targetPage === 'liquidity'
      ? LIQUIDITY_SECTION_LINKS[0].id
      : targetPage === 'portfolio'
        ? PORTFOLIO_SECTION_LINKS[0].id
      : targetPage === 'environment'
        ? ENVIRONMENT_SECTION_LINKS[0].id
        : SECTION_LINKS[0].id;
    window.location.hash = firstSectionId;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const activeSections = activePage === 'liquidity'
    ? LIQUIDITY_SECTION_LINKS
    : activePage === 'portfolio'
      ? PORTFOLIO_SECTION_LINKS
    : activePage === 'environment'
      ? ENVIRONMENT_SECTION_LINKS
      : SECTION_LINKS;

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

        .header-logo {
          display: flex;
          align-items: center;
          gap: 14px;
          flex-shrink: 0;
        }

        .header-product-tag {
          border: 1px solid rgba(255, 255, 255, 0.38);
          color: rgba(255, 255, 255, 0.92);
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 1.2px;
          text-transform: uppercase;
          border-radius: 999px;
          padding: 4px 10px;
          line-height: 1;
        }

        .header-actions {
          display: flex;
          align-items: center;
          gap: 14px;
          flex-shrink: 0;
          position: relative;
        }

        .header-pathway-mark {
          height: 34px;
          width: auto;
          display: block;
          filter: brightness(0) invert(1);
          opacity: 0.98;
        }

        .header-menu {
          position: relative;
        }

        .header-menu-button {
          width: 38px;
          height: 38px;
          border: 1px solid rgba(255, 255, 255, 0.52);
          background: rgba(255, 255, 255, 0.08);
          border-radius: 8px;
          display: inline-flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          gap: 4px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .header-menu-button:hover {
          background: rgba(255, 255, 255, 0.2);
          border-color: rgba(255, 255, 255, 0.82);
        }

        .header-menu-button span {
          width: 16px;
          height: 1.6px;
          border-radius: 999px;
          background: #FFFFFF;
          display: block;
        }

        .header-menu-panel {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          min-width: 210px;
          background: #FFFFFF;
          border: 1px solid #C5D1E3;
          border-radius: 10px;
          box-shadow: 0 12px 22px rgba(15, 27, 51, 0.22);
          padding: 6px;
          z-index: 10;
        }

        .header-menu-item {
          width: 100%;
          text-align: left;
          border: 0;
          background: transparent;
          color: #1B2A4A;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          padding: 10px 12px;
          border-radius: 7px;
          cursor: pointer;
        }

        .header-menu-item:hover {
          background: #EEF3FB;
        }

        .header-menu-item.active {
          background: #EEF3FB;
          color: #10213F;
        }

        .header-menu-divider {
          height: 1px;
          margin: 6px 4px;
          background: #DCE3EE;
        }

        @media (max-width: 980px) {
          .site-header {
            padding: 0 16px;
          }

          .header-content {
            min-height: 64px;
            gap: 14px;
          }

          .header-product-tag {
            font-size: 9px;
            padding: 4px 8px;
          }

          .header-pathway-mark {
            height: 26px;
          }

          .header-menu-button {
            width: 34px;
            height: 34px;
          }
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
          margin-bottom: 16px;
          letter-spacing: -0.5px;
        }

        .hero-subtitle {
          font-size: clamp(20px, 2.4vw, 28px);
          font-weight: 400;
          color: #9A9690;
          max-width: 980px;
          margin: 0 auto 22px;
          line-height: 1.35;
        }

        .hero-purpose-note {
          max-width: 860px;
          margin: -4px auto 16px;
          font-size: 16px;
          color: #4F5B72;
          line-height: 1.55;
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

        .portfolio-hero {
          background:
            radial-gradient(circle at 10% 10%, rgba(27, 42, 74, 0.22), transparent 40%),
            radial-gradient(circle at 88% 18%, rgba(201, 168, 76, 0.2), transparent 36%),
            linear-gradient(180deg, #F8FBFF 0%, #F0F5FC 62%, #EDF2F8 100%);
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
          gap: 12px;
          margin: 24px 0;
        }

        .structure-card {
          background: #E8E6E1;
          border: 2px solid;
          border-radius: 8px;
          padding: 16px;
          text-align: center;
        }

        .structure-label {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 14px;
          font-weight: 500;
          margin-bottom: 8px;
        }

        .structure-net {
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 24px;
          color: #1B2A4A;
          margin-bottom: 8px;
        }

        .structure-breakdown {
          display: flex;
          flex-direction: column;
          gap: 2px;
          font-size: 11px;
          color: #9A9690;
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

          .line-credit-tradeoffs {
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

          .portfolio-forecast-step-grid {
            grid-template-columns: 1fr;
          }

          .portfolio-lifecycle-assumption-grid {
            grid-template-columns: 1fr;
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

          .liquidity-callout-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 600px) {
          .structure-comparison {
            grid-template-columns: 1fr;
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

      <Header
        compactControls={compactControls}
        onToggleCompactControls={() => setCompactControls((prev) => !prev)}
        activePage={activePage}
        onNavigatePage={navigateToPage}
      />
      <div className="app-shell">
        <SideNav sections={activeSections} />
        <main className="app-main">
          {activePage === 'economics' ? (
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
          ) : activePage === 'liquidity' ? (
            <>
              <LiquidityHeroSection />
              <LiquidityNormalCourseSection
                globalGrossMultiple={globalGrossMultiple}
                onGrossMultipleChange={setGlobalGrossMultiple}
              />
              <LiquiditySecondariesSection
                globalGrossMultiple={globalGrossMultiple}
              />
              <LiquidityToolkitSection />
              <LiquidityToBeBuiltSection />
            </>
          ) : activePage === 'portfolio' ? (
            <>
              <PortfolioHeroSection />
              <PortfolioSingleFundSection />
              <PortfolioLayeringSection
                globalGrossMultiple={globalGrossMultiple}
                onGrossMultipleChange={setGlobalGrossMultiple}
              />
              <PortfolioStrategyCurvesSection />
              <PortfolioTargetingSection />
              <PortfolioTypesSection />
              <PortfolioFutureForecastSection />
              <PortfolioRiffsSection />
            </>
          ) : (
            <>
              <EnvironmentHeroSection />
              <EnvironmentExplorerSection />
              <EnvironmentThemesSection />
              <EnvironmentDeltaLabSection />
              <EnvironmentConversionSection />
              <EnvironmentBuildPlanSection />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
