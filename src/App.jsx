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

const SECTION_LINKS = [
  { id: 'hero-baseline', label: 'Gross Baseline' },
  { id: 'why-matters', label: 'Why This Matters' },
  { id: 'management-fees', label: 'Management Fees' },
  { id: 'fund-expenses', label: 'Fund Expenses' },
  { id: 'carried-interest', label: 'Carry Mechanics' },
  { id: 'waterfall-structures', label: 'Waterfalls' },
  { id: 'underinvesting-impact', label: 'Underinvesting' },
  { id: 'fee-carry-tradeoff', label: 'Fee/Carry Tradeoff' },
  { id: 'accrued-carry', label: 'Accrued Carry' },
  { id: 'quarterly-schedule', label: 'Quarterly Schedule' },
  { id: 'synthesis', label: 'Put It Together' },
  { id: 'conclusion', label: 'Conclusion' }
];

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

const BarChart = ({ data, height = 200, accent = '#1B2A4A', showLabels = true }) => {
  const maxValue = Math.max(...data.map(d => d.value));

  return (
    <div className="bar-chart" style={{ height }}>
      <div className="bar-chart-bars">
        {data.map((d, i) => (
          <div key={i} className="bar-column">
            <div className="bar-value-label">{d.valueLabel || formatCurrency(d.value, 0)}</div>
            <div
              className="bar"
              style={{
                height: `${(d.value / maxValue) * 100}%`,
                backgroundColor: d.color || accent,
                opacity: d.opacity || 1
              }}
            />
            {showLabels && <div className="bar-label">{d.label}</div>}
          </div>
        ))}
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

    const padding = { top: 40, bottom: 60, left: 20, right: 20 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = h - padding.top - padding.bottom;

    const maxValue = Math.max(...data.map(d => d.cumulative));
    const barWidth = chartWidth / data.length * 0.6;
    const gap = chartWidth / data.length * 0.4;

    let runningTotal = 0;

    data.forEach((d, i) => {
      const x = padding.left + i * (barWidth + gap) + gap / 2;
      const barTop = padding.top + (1 - d.cumulative / maxValue) * chartHeight;
      const prevTop = i === 0 ? padding.top + chartHeight : padding.top + (1 - runningTotal / maxValue) * chartHeight;
      const barHeight = Math.abs(prevTop - barTop);

      // Connector line from previous bar
      if (i > 0) {
        ctx.strokeStyle = '#7f8ea5';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x - gap / 2, prevTop);
        ctx.lineTo(x, prevTop);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw bar
      ctx.fillStyle = d.color;
      if (d.isIncrease) {
        ctx.fillRect(x, barTop, barWidth, barHeight);
      } else {
        ctx.fillRect(x, prevTop, barWidth, barHeight);
      }

      // Draw value label
      ctx.fillStyle = '#1B2A4A';
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'center';
      const valueY = d.isIncrease ? barTop - 8 : prevTop - 8;
      ctx.fillText(d.valueLabel, x + barWidth / 2, barTop - 8);

      // Draw category label
      ctx.fillStyle = '#9A9690';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'center';

      // Word wrap for labels
      const words = d.label.split(' ');
      let line = '';
      let lineY = h - padding.bottom + 15;
      words.forEach((word, wi) => {
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

const ComparisonChart = ({ seriesA, seriesB, labelA, labelB, height = 250, colorA = '#1B2A4A', colorB = '#B5473A' }) => {
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

    const padding = { top: 40, bottom: 50, left: 60, right: 20 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = h - padding.top - padding.bottom;

    const allValues = [...seriesA, ...seriesB];
    const maxValue = Math.max(...allValues) * 1.1;
    const minValue = Math.min(...allValues, 0) * 1.1;
    const range = maxValue - minValue;

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
      ctx.fillText(formatCurrency(val, 0), padding.left - 8, y + 4);
    }

    // Draw series A
    ctx.strokeStyle = colorA;
    ctx.lineWidth = 2;
    ctx.beginPath();
    seriesA.forEach((val, i) => {
      const x = padding.left + (i / (seriesA.length - 1)) * chartWidth;
      const y = padding.top + ((maxValue - val) / range) * chartHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw series B
    ctx.strokeStyle = colorB;
    ctx.lineWidth = 2;
    ctx.beginPath();
    seriesB.forEach((val, i) => {
      const x = padding.left + (i / (seriesB.length - 1)) * chartWidth;
      const y = padding.top + ((maxValue - val) / range) * chartHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Legend
    ctx.fillStyle = colorA;
    ctx.fillRect(padding.left, 10, 20, 3);
    ctx.fillStyle = '#4A4641';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(labelA, padding.left + 28, 14);

    ctx.fillStyle = colorB;
    ctx.fillRect(padding.left + 120, 10, 20, 3);
    ctx.fillStyle = '#4A4641';
    ctx.fillText(labelB, padding.left + 148, 14);

    // X-axis labels
    for (let i = 0; i < seriesA.length; i++) {
      const x = padding.left + (i / (seriesA.length - 1)) * chartWidth;
      ctx.fillStyle = '#9A9690';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(`Yr ${i}`, x, h - padding.bottom + 20);
    }
  }, [seriesA, seriesB, labelA, labelB, colorA, colorB]);

  return <canvas ref={canvasRef} className="comparison-canvas" style={{ width: '100%', height }} />;
};

// ============================================================================
// SECTION COMPONENTS
// ============================================================================

const Header = () => (
  <header className="site-header">
    <div className="header-content">
      <div className="header-logo">
        <span className="logo-text">Pathway Capital</span>
      </div>
      <nav className="header-nav">
        <span className="nav-tagline">Private Equity Research</span>
      </nav>
    </div>
  </header>
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
      ctx.fillText('Gross Multiple (TVPI)', padding.left + chartWidth / 2, height - 8);
      ctx.save();
      ctx.translate(14, padding.top + chartHeight / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText('Net Multiple (TVPI)', 0, 0);
      ctx.restore();

      ctx.beginPath();
      netCurve.forEach((p, idx) => {
        const x = axisX(p.gross, padding, width);
        const y = axisY(p.gross, padding, height);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.lineTo(axisX(maxX, padding, width), axisY(minY, padding, height));
      ctx.lineTo(axisX(minX, padding, width), axisY(minY, padding, height));
      ctx.closePath();
      ctx.fillStyle = 'rgba(201, 168, 76, 0.16)';
      ctx.fill();

      ctx.strokeStyle = '#2D6B4F';
      ctx.lineWidth = 1.8;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(axisX(minX, padding, width), axisY(minX, padding, height));
      ctx.lineTo(axisX(maxX, padding, width), axisY(maxX, padding, height));
      ctx.stroke();
      ctx.setLineDash([]);

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

      ctx.fillStyle = '#0F1B33';
      ctx.font = '600 11px Helvetica Neue';
      ctx.textAlign = 'left';
      ctx.fillText('Baseline 2.5x → 2.0x', bx + 10, by - 10);

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
      <div className="hero-graph-legend">
        <span className="hero-legend-item gross">Gross (No Fees)</span>
        <span className="hero-legend-item net">Net (To LP)</span>
        <span className="hero-legend-item spread">Gross-to-Net Spread</span>
      </div>
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
    const rvpi = GROSS_BASE_CURVE.getNAV(yearProgress, distProgress, grossMultiple) * drawdown;

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
  deploymentRate = 1
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
    if (grossDistribution > 0) {
      const lpReturn = Math.min(grossDistribution, lpBalance);
      lpBalance = Math.max(0, lpBalance - lpReturn);
      const residual = grossDistribution - lpReturn;
      carry = residual * carryRate;
      netDistribution = lpReturn + residual - carry;
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

  // Quarter-level simulation can understate catch-up; top up at fund end.
  const carryTopUp = Math.max(0, targetCarry - cumulativeCarry);
  if (carryTopUp > 0 && schedule.length > 0) {
    cumulativeCarry += carryTopUp;
    cumulativeNetDist -= carryTopUp;
    const last = schedule[schedule.length - 1];
    last.carry += carryTopUp;
    last.netDistribution = Math.max(0, last.netDistribution - carryTopUp);
    last.cumulativeCarry = cumulativeCarry;
    last.cumulativeNetDist = cumulativeNetDist;
    last.netCF -= carryTopUp;
    last.cumulativeNetCF -= carryTopUp;
    netCashFlows.push({ period: last.quarter, amount: -carryTopUp });
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
        q.nav + q.cumulativeNetDPI,
        q.cumulativeNetDPI
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

    // Draw NAV + Distributions line (total value)
    ctx.strokeStyle = '#2D6B4F';
    ctx.lineWidth = 3;
    ctx.beginPath();
    quarterlyData.forEach((q, i) => {
      const x = padding.left + (q.quarter / totalQuarters) * chartWidth;
      const totalValue = q.nav + q.cumulativeNetDPI;
      const y = padding.top + (1 - totalValue / maxValue) * chartHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw distributions area (DPI)
    ctx.fillStyle = 'rgba(74, 123, 167, 0.18)';
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top + chartHeight);
    quarterlyData.forEach((q) => {
      const x = padding.left + (q.quarter / totalQuarters) * chartWidth;
      const y = padding.top + (1 - q.cumulativeNetDPI / maxValue) * chartHeight;
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
    for (let year = 0; year <= totalYears; year += 2) {
      const x = padding.left + (year * 4 / totalQuarters) * chartWidth;
      ctx.fillStyle = '#9A9690';
      ctx.font = '11px Helvetica Neue';
      ctx.textAlign = 'center';
      ctx.fillText(`Yr ${year}`, x, height - padding.bottom + 25);
    }

    // Legend
    const legendY = height - 25;
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
    ctx.fillText('Capital Calls', padding.left + 22, legendY + 5);

    ctx.fillStyle = '#2D6B4F';
    ctx.fillRect(padding.left + 120, legendY, 15, 3);
    ctx.fillStyle = '#9A9690';
    ctx.fillText('NAV + DPI', padding.left + 142, legendY + 5);

    ctx.fillStyle = 'rgba(74, 123, 167, 0.35)';
    ctx.fillRect(padding.left + 230, legendY - 3, 15, 10);
    ctx.fillStyle = '#9A9690';
    ctx.fillText('Distributions', padding.left + 252, legendY + 5);

  }, [calculations, fundLife, investmentPeriod, fundSize]);

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

  }, [calculations]);

  return (
    <section id={sectionId} className="master-dashboard">
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

      <div className="dashboard-grid">
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
        <div className="dashboard-main">
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

const HeroSection = () => {
  const baseline = useMemo(() => {
    const fundSize = 1e6;
    const data = generateQuarterlyData(
      GROSS_BASE_CURVE.baseFundLife,
      GROSS_BASE_CURVE.baseInvestmentPeriod,
      GROSS_BASE_CURVE.baseGrossMultiple
    );
    const flows = [];
    data.forEach((q) => {
      if (q.capitalCall > 0) {
        flows.push({ period: q.quarter, amount: -q.capitalCall * fundSize });
      }
      if (q.distribution > 0) {
        flows.push({ period: q.quarter, amount: q.distribution * fundSize });
      }
    });
    const grossIRR = flows.length > 2 ? calculateIRR(flows, 4) : 0;
    return {
      grossTVPI: GROSS_BASE_CURVE.baseGrossMultiple,
      grossIRR,
      netTVPI: 2.0,
      netIRR: 0.15
    };
  }, []);

  return (
    <section id="hero-baseline" className="hero-section">
      <div className="pathway-badge">Interactive Learning Model</div>
      <h1>The Economics of Private Equity</h1>
      <p className="hero-subtitle">A guide to getting from gross to net.</p>

      <HeroGrossNetGraph />

      <div className="metrics-row hero-metrics">
        <MetricCard
          label="Gross Baseline"
          value={`${baseline.grossTVPI.toFixed(2)}x TVPI`}
          subtext={`${formatPercent(baseline.grossIRR)} gross IRR`}
          accent="#2D6B4F"
        />
        <MetricCard
          label="Net Baseline"
          value={`${baseline.netTVPI.toFixed(2)}x TVPI`}
          subtext={`${formatPercent(baseline.netIRR)} net IRR target`}
          accent="#1B2A4A"
        />
        <MetricCard
          label="Interactive"
          value="Use The Sliders"
          subtext="Each section shows net investor impact"
          accent="#C9A84C"
        />
      </div>

      <p className="hero-scroll-note">Scroll down to build the gross-to-net bridge, one concept at a time.</p>
    </section>
  );
};

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

  const netReturn = useMemo(() => {
    const model = buildQuarterlySchedule({
      fundSizeM: BASELINE_MODEL_INPUTS.fundSize * 1e6,
      fundLife: BASELINE_MODEL_INPUTS.fundLife,
      investmentPeriod: BASELINE_MODEL_INPUTS.investmentPeriod,
      grossMultiple: grossReturn,
      mgmtFeeRate: BASELINE_MODEL_INPUTS.mgmtFeeRate,
      expenseRate: BASELINE_MODEL_INPUTS.expenseRate,
      carryRate: BASELINE_MODEL_INPUTS.carryRate,
      hurdleRate: BASELINE_MODEL_INPUTS.hurdleRate,
      deploymentRate: 1
    });
    return model.totals.netMultiple;
  }, [grossReturn]);

  const resetIntro = () => handleGrossChange(BASELINE_GROSS_TVPI);

  return (
    <section id="why-matters" className="content-section">
      <h2>Why This Matters</h2>

      <p>
        Private equity has consistently outperformed public markets over the long term.
        Top-quartile funds have delivered returns that justify the illiquidity, complexity,
        and yes—the fees. But between the <em>gross</em> returns a fund generates and the
        <em>net</em> returns an investor actually receives lies a series of economic arrangements
        that every LP should understand deeply.
      </p>

      <p>
        This isn't a critique of PE economics. Quite the opposite: <strong>our goal as LPs
        is to pay as much carried interest as possible</strong>—because that means our
        investments have generated substantial gains. A fund that returns 3x and takes
        meaningful carry has still made us wealthy. A fund that returns 1x and takes no
        carry has wasted a decade of our capital.
      </p>

      <div className="interactive-block">
        <div className="block-header">
          <span className="block-title">From Gross to Net</span>
          <span className="block-subtitle">Drag to explore the relationship</span>
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
          label="Gross Multiple (TVPI)"
          format={(v) => `${v.toFixed(2)}x`}
        />

        <div className="metrics-row">
          <MetricCard
            label="Gross Return"
            value={`${grossReturn.toFixed(2)}x`}
            subtext="Before fees & carry"
          />
          <MetricCard
            label="Net Return"
            value={`${netReturn.toFixed(2)}x`}
            subtext="What you actually receive"
            accent="#B5473A"
          />
          <MetricCard
            label="Fee Drag"
            value={`${((grossReturn - netReturn) / (grossReturn - 1) * 100).toFixed(0)}%`}
            subtext="Of gross profits"
            accent="#9A9690"
          />
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
    feeRate: 0.02,
    investmentPeriod: 5,
    fundLife: 12,
    hasRateStepDown: true,
    postInvestmentBasis: 'remaining'
  };
  const [fundSize, setFundSize] = useState(DEFAULTS.fundSize); // millions
  const [feeRate, setFeeRate] = useState(DEFAULTS.feeRate);
  const [investmentPeriod, setInvestmentPeriod] = useState(DEFAULTS.investmentPeriod);
  const [fundLife, setFundLife] = useState(DEFAULTS.fundLife);
  const [hasRateStepDown, setHasRateStepDown] = useState(DEFAULTS.hasRateStepDown);
  const [postInvestmentBasis, setPostInvestmentBasis] = useState(DEFAULTS.postInvestmentBasis); // 'committed' or 'remaining'
  const [showAssumptions, setShowAssumptions] = useState(false);
  const resetManagementFee = () => {
    setFundSize(DEFAULTS.fundSize);
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
  const feeAsPercentOfCommitment = totalFees / fundSize;
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
        </div>

        <TimelineChart
          data={feeData.map(d => ({
            label: d.label,
            value: d.fee,
            cumulative: d.cumulativeFees
          }))}
          height={200}
          showCumulative={true}
        />

        <div className="metrics-row">
          <MetricCard
            label="Total Management Fees"
            value={formatCurrency(totalFees * 1e6, 0)}
          />
          <MetricCard
            label="As % of Commitment"
            value={formatPercent(feeAsPercentOfCommitment)}
            accent="#B5473A"
          />
          <MetricCard
            label="Average Annual Fee"
            value={formatCurrency((totalFees / fundLife) * 1e6, 0)}
            accent="#9A9690"
          />
        </div>

        <div className="net-impact-panel">
          <div className="net-impact-title">Net Investor Impact</div>
          <div className="metrics-row">
            <MetricCard
              label="Net Multiple Drag"
              value={`${feeMultipleDrag.toFixed(2)}x`}
              subtext="From management fees alone"
              accent="#B5473A"
            />
            <MetricCard
              label="Implied Net TVPI"
              value={`${netAfterFeesOnly.toFixed(2)}x`}
              subtext="Starting from 2.00x baseline"
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

const ExpensesSection = () => {
  const DEFAULTS = {
    fundSize: 500,
    investmentPeriod: 5,
    fundLife: 10,
    expenseRate: 0.005
  };
  const [fundSize, setFundSize] = useState(DEFAULTS.fundSize);
  const [investmentPeriod, setInvestmentPeriod] = useState(DEFAULTS.investmentPeriod);
  const [fundLife, setFundLife] = useState(DEFAULTS.fundLife);
  const [expenseRate, setExpenseRate] = useState(DEFAULTS.expenseRate);
  const resetExpenses = () => {
    setFundSize(DEFAULTS.fundSize);
    setInvestmentPeriod(DEFAULTS.investmentPeriod);
    setFundLife(DEFAULTS.fundLife);
    setExpenseRate(DEFAULTS.expenseRate);
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

  return (
    <section id="fund-expenses" className="content-section">
      <h2>Fund Expenses: The Hidden Layer</h2>

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
              <div className="expense-bar-container">
                <div
                  className="expense-bar"
                  style={{
                    width: `${cat.percent}%`,
                    backgroundColor: cat.color
                  }}
                />
                <span className="expense-percent">{cat.percent}%</span>
              </div>
              <div className="expense-info">
                <span className="expense-name">{cat.name}</span>
                <span className="expense-desc">{cat.description}</span>
              </div>
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
              label="Net Multiple Drag"
              value={`${expenseMultipleDrag.toFixed(2)}x`}
              subtext="From fund expenses alone"
              accent="#D4A017"
            />
            <MetricCard
              label="Implied Net TVPI"
              value={`${netAfterExpensesOnly.toFixed(2)}x`}
              subtext="Starting from 2.00x baseline"
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
  );
};

const CarrySection = () => {
  const DEFAULTS = {
    fundIRR: 0.15,
    carryRate: 0.20,
    hurdleRate: 0.08,
    holdPeriod: 5
  };
  const [fundSize] = useState(500);
  const [fundIRR, setFundIRR] = useState(DEFAULTS.fundIRR); // LP's actual IRR
  const [carryRate, setCarryRate] = useState(DEFAULTS.carryRate);
  const [hurdleRate, setHurdleRate] = useState(DEFAULTS.hurdleRate);
  const [holdPeriod, setHoldPeriod] = useState(DEFAULTS.holdPeriod);
  const resetCarry = () => {
    setFundIRR(DEFAULTS.fundIRR);
    setCarryRate(DEFAULTS.carryRate);
    setHurdleRate(DEFAULTS.hurdleRate);
    setHoldPeriod(DEFAULTS.holdPeriod);
  };

  const waterfallData = useMemo(() => {
    // Work backwards from IRR to get gross multiple
    // IRR = (ending value / beginning value)^(1/years) - 1
    // So ending value = beginning value * (1 + IRR)^years
    const lpEndingValue = fundSize * Math.pow(1 + fundIRR, holdPeriod);

    // Calculate hurdle amount
    const hurdleAmount = fundSize * (Math.pow(1 + hurdleRate, holdPeriod) - 1);
    const hurdleCleared = fundIRR >= hurdleRate;

    // Calculate profits and carry
    // If hurdle cleared: GP gets carryRate of ALL profits (not just above hurdle)
    // If hurdle not cleared: GP gets nothing
    const totalProfit = lpEndingValue - fundSize;

    let gpCarry = 0;
    let lpProfit = totalProfit;

    if (hurdleCleared && totalProfit > 0) {
      // GP gets 20% of total profits
      gpCarry = totalProfit * carryRate;
      lpProfit = totalProfit * (1 - carryRate);
    }

    const lpTotal = fundSize + lpProfit;
    const totalDistributions = lpTotal + gpCarry;
    const grossMultiple = totalDistributions / fundSize;

    // Build waterfall stages for visualization
    const stages = [];

    // Stage 1: Return of capital
    stages.push({
      label: 'Return of Capital',
      value: fundSize,
      cumulative: fundSize,
      color: '#1B2A4A',
      isIncrease: true,
      valueLabel: formatCurrency(fundSize * 1e6, 0)
    });

    if (totalProfit > 0) {
      if (hurdleCleared) {
        // Stage 2: Preferred return (part of LP profit)
        const prefReturn = Math.min(hurdleAmount, lpProfit);
        stages.push({
          label: 'Preferred Return',
          value: prefReturn,
          cumulative: fundSize + prefReturn,
          color: '#1B2A4A',
          isIncrease: true,
          valueLabel: formatCurrency(prefReturn * 1e6, 0)
        });

        // Stage 3: GP Catch-up + Carry (shown together for simplicity)
        if (gpCarry > 0) {
          stages.push({
            label: 'GP Carry (20%)',
            value: gpCarry,
            cumulative: fundSize + prefReturn + gpCarry,
            color: '#B5473A',
            isIncrease: true,
            valueLabel: formatCurrency(gpCarry * 1e6, 0)
          });
        }

        // Stage 4: Remaining LP profit
        const remainingLPProfit = lpProfit - prefReturn;
        if (remainingLPProfit > 0) {
          stages.push({
            label: 'LP Profit Share',
            value: remainingLPProfit,
            cumulative: fundSize + lpProfit + gpCarry,
            color: '#1B2A4A',
            isIncrease: true,
            valueLabel: formatCurrency(remainingLPProfit * 1e6, 0)
          });
        }
      } else {
        // Hurdle not cleared - all profit to LP, no carry
        stages.push({
          label: 'LP Profit (No Carry)',
          value: totalProfit,
          cumulative: fundSize + totalProfit,
          color: '#1B2A4A',
          isIncrease: true,
          valueLabel: formatCurrency(totalProfit * 1e6, 0)
        });
      }
    }

    return {
      stages,
      lpTotal,
      gpCarry,
      totalDistributions,
      grossMultiple,
      hurdleCleared,
      hurdleAmount,
      totalProfit
    };
  }, [fundSize, fundIRR, carryRate, hurdleRate, holdPeriod]);

  const netMultiple = waterfallData.lpTotal / fundSize;
  const lpNetIRR = Math.pow(waterfallData.lpTotal / fundSize, 1 / holdPeriod) - 1;

  return (
    <section id="carried-interest" className="content-section">
      <h2>Carried Interest: The Performance Incentive</h2>

      <p>
        Carried interest—"carry"—is the GP's share of profits above a threshold. The
        standard structure is <strong>"20% of profits after an 8% preferred return"</strong>.
        The key word is "after": the hurdle isn't a deduction from carry—it's a
        <em> gate</em>. If the fund clears the hurdle, the GP earns 20% of <em>all</em> profits.
        If it doesn't, the GP earns nothing.
      </p>

      <p>
        This binary nature makes the hurdle a powerful LP protection. A fund returning 7%
        annually pays zero carry. A fund returning 9% pays carry on the full profit—not
        just the 1% above the hurdle.
      </p>

      <div className="interactive-block">
        <div className="block-header">
          <span className="block-title">The Distribution Waterfall</span>
          <span className="block-subtitle">Drag IRR below the hurdle to see carry disappear</span>
        </div>
        <div className="block-actions">
          <ResetButton onClick={resetCarry} />
        </div>

        <div className="sliders-grid">
          <Slider
            value={fundIRR}
            onChange={setFundIRR}
            min={-0.05}
            max={0.30}
            step={0.005}
            label="Fund IRR (Gross)"
            format={(v) => formatPercent(v)}
            accent={fundIRR >= hurdleRate ? '#1B2A4A' : '#B5473A'}
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

        <div className={`hurdle-status ${waterfallData.hurdleCleared ? 'cleared' : 'not-cleared'}`}>
          <div className="hurdle-indicator"></div>
          <span>
            {waterfallData.hurdleCleared
              ? `Hurdle cleared — GP earns ${formatPercent(carryRate)} of all profits`
              : `Hurdle not cleared — GP earns zero carry`
            }
          </span>
        </div>

        <WaterfallChart data={waterfallData.stages} height={280} />

        <div className="waterfall-legend">
          <div className="legend-item">
            <span className="legend-color" style={{ backgroundColor: '#1B2A4A' }}></span>
            <span>To LPs</span>
          </div>
          <div className="legend-item">
            <span className="legend-color" style={{ backgroundColor: '#B5473A' }}></span>
            <span>To GP (Carry)</span>
          </div>
        </div>

        <div className="metrics-row">
          <MetricCard
            label="LP Net Multiple"
            value={`${netMultiple.toFixed(2)}x`}
            subtext={`${formatPercent(lpNetIRR)} net IRR`}
            accent="#1B2A4A"
          />
          <MetricCard
            label="GP Carry"
            value={formatCurrency(waterfallData.gpCarry * 1e6, 0)}
            subtext={waterfallData.hurdleCleared ? `${formatPercent(carryRate)} of profits` : 'Hurdle not met'}
            accent={waterfallData.gpCarry > 0 ? '#B5473A' : '#9A9690'}
          />
          <MetricCard
            label="Gross Multiple"
            value={`${waterfallData.grossMultiple.toFixed(2)}x`}
            subtext={`${formatPercent(fundIRR)} gross IRR`}
            accent="#9A9690"
          />
        </div>
      </div>

      <h3>The Waterfall Mechanics</h3>

      <p>
        <strong>1. Return of Capital:</strong> LPs receive their contributed capital back first.
        No carry is paid until the full commitment is returned.
      </p>

      <p>
        <strong>2. Preferred Return (Hurdle):</strong> LPs receive a "preferred return"—typically
        8% annually, compounded—on their contributed capital. This is the gate the fund must
        clear before any carry is earned.
      </p>

      <p>
        <strong>3. GP Catch-Up:</strong> Once the preferred return is paid, the GP receives
        100% of subsequent distributions until they've "caught up" to their 20% share of all
        profits to date. This is standard in virtually all institutional funds—it ensures the
        GP receives their full 20% once the hurdle is cleared.
      </p>

      <p>
        <strong>4. 80/20 Split:</strong> Remaining distributions are split 80% to LPs and
        20% to the GP.
      </p>

      <div className="callout callout-insight">
        <div className="callout-icon">💡</div>
        <div className="callout-content">
          The catch-up affects <em>timing</em> of GP cash flows, not total economics. Whether
          catch-up is 100% or 50%, the GP ultimately receives 20% of total profits if the
          hurdle is cleared. Try dragging the IRR slider across the hurdle threshold to see
          the binary nature of this protection.
        </div>
      </div>
    </section>
  );
};

const WaterfallComparisonSection = ({ globalGrossMultiple, onGrossMultipleChange } = {}) => {
  const DEFAULT_EXIT_YEAR = 5;
  const [fundSize] = useState(500);
  const [localGrossMultiple, setLocalGrossMultiple] = useState(BASELINE_GROSS_TVPI);
  const grossMultiple = globalGrossMultiple ?? localGrossMultiple;
  const setGrossMultiple = onGrossMultipleChange ?? setLocalGrossMultiple;
  const [exitYear, setExitYear] = useState(DEFAULT_EXIT_YEAR);
  const resetWaterfallComparison = () => {
    setGrossMultiple(BASELINE_GROSS_TVPI);
    setExitYear(DEFAULT_EXIT_YEAR);
  };

  // Simulate European (whole-fund) vs American (deal-by-deal) waterfall
  const comparisonData = useMemo(() => {
    const totalValue = fundSize * grossMultiple;
    const profits = totalValue - fundSize;
    const hurdleRate = 0.08;
    const carryRate = 0.20;

    // European: Must return all capital + hurdle on entire fund first
    const europeanHurdle = fundSize * (Math.pow(1 + hurdleRate, exitYear) - 1);
    const europeanCarriableProfit = Math.max(0, profits - europeanHurdle);
    const europeanCarry = europeanCarriableProfit * carryRate;
    const europeanLpNet = totalValue - europeanCarry;

    // American: Deal-by-deal, carry on each profitable exit
    // Simplified: assume 5 deals, each with different returns
    const deals = [
      { invested: 100, returned: 100 * 2.5, years: 3 }, // Winner
      { invested: 100, returned: 100 * 2.0, years: 4 }, // Good
      { invested: 100, returned: 100 * 1.5, years: 5 }, // Modest
      { invested: 100, returned: 100 * 0.8, years: 5 }, // Loss
      { invested: 100, returned: 100 * (grossMultiple * 5 - 5.8) / 1, years: exitYear }, // Varies
    ];

    let americanCarry = 0;
    deals.forEach(deal => {
      const dealHurdle = deal.invested * (Math.pow(1 + hurdleRate, deal.years) - 1);
      const dealProfit = deal.returned - deal.invested;
      if (dealProfit > dealHurdle) {
        americanCarry += (dealProfit - dealHurdle) * carryRate;
      }
    });
    const americanLpNet = totalValue - americanCarry;

    // IRR calculation (simplified)
    const europeanIRR = Math.pow(europeanLpNet / fundSize, 1 / exitYear) - 1;
    const americanIRR = Math.pow(americanLpNet / fundSize, 1 / exitYear) - 1;

    return {
      european: {
        carry: europeanCarry,
        lpNet: europeanLpNet,
        multiple: europeanLpNet / fundSize,
        irr: europeanIRR
      },
      american: {
        carry: americanCarry,
        lpNet: americanLpNet,
        multiple: americanLpNet / fundSize,
        irr: americanIRR
      }
    };
  }, [fundSize, grossMultiple, exitYear]);

  return (
    <section id="waterfall-structures" className="content-section">
      <h2>European vs. American Waterfalls</h2>

      <p>
        Not all waterfalls are created equal. The two dominant structures—<strong>European
        (whole-fund)</strong> and <strong>American (deal-by-deal)</strong>—can produce
        meaningfully different outcomes for LPs and GPs from identical underlying returns.
      </p>

      <div className="comparison-grid">
        <div className="comparison-card">
          <h4>European (Whole-Fund)</h4>
          <p>
            The GP receives carry only after <em>all</em> contributed capital plus the
            preferred return on the <em>entire fund</em> has been returned to LPs. Early
            winners don't generate carry until later losers are accounted for.
          </p>
          <ul className="comparison-list">
            <li>✓ More LP-friendly</li>
            <li>✓ Natural loss offset</li>
            <li>✓ Carry paid later in fund life</li>
          </ul>
        </div>

        <div className="comparison-card">
          <h4>American (Deal-by-Deal)</h4>
          <p>
            The GP receives carry on each profitable investment as it's realized, subject
            to a deal-level hurdle. Early winners generate immediate carry, regardless of
            how later investments perform.
          </p>
          <ul className="comparison-list">
            <li>✗ More GP-friendly</li>
            <li>✗ No automatic loss offset</li>
            <li>✗ Carry paid earlier</li>
          </ul>
        </div>
      </div>

      <div className="interactive-block">
        <div className="block-header">
          <span className="block-title">Waterfall Comparison</span>
          <span className="block-subtitle">Same gross returns, different LP outcomes</span>
        </div>
        <div className="block-actions">
          <ResetButton onClick={resetWaterfallComparison} />
        </div>

        <div className="sliders-grid">
          <Slider
            value={grossMultiple}
            onChange={setGrossMultiple}
            min={1.0}
            max={3.0}
            step={0.05}
            label="Gross Multiple"
            format={(v) => `${v.toFixed(2)}x`}
          />

          <Slider
            value={exitYear}
            onChange={setExitYear}
            min={3}
            max={8}
            step={1}
            label="Average Hold Period"
            format={(v) => `${v} years`}
          />
        </div>

        <div className="comparison-metrics">
          <div className="comparison-column european">
            <h5>European Waterfall</h5>
            <div className="metric-stack">
              <MetricCard
                label="LP Net Multiple"
                value={`${comparisonData.european.multiple.toFixed(2)}x`}
                accent="#1B2A4A"
              />
              <MetricCard
                label="GP Carry"
                value={formatCurrency(comparisonData.european.carry * 1e6, 0)}
                accent="#9A9690"
              />
            </div>
          </div>

          <div className="comparison-column american">
            <h5>American Waterfall</h5>
            <div className="metric-stack">
              <MetricCard
                label="LP Net Multiple"
                value={`${comparisonData.american.multiple.toFixed(2)}x`}
                accent="#B5473A"
              />
              <MetricCard
                label="GP Carry"
                value={formatCurrency(comparisonData.american.carry * 1e6, 0)}
                accent="#9A9690"
              />
            </div>
          </div>
        </div>

        <div className="difference-callout">
          <strong>LP Difference: </strong>
          {comparisonData.european.multiple > comparisonData.american.multiple ? (
            <span className="positive">
              European waterfall returns {formatCurrency((comparisonData.european.lpNet - comparisonData.american.lpNet) * 1e6, 0)} more to LPs
            </span>
          ) : comparisonData.european.multiple < comparisonData.american.multiple ? (
            <span className="negative">
              American waterfall returns {formatCurrency((comparisonData.american.lpNet - comparisonData.european.lpNet) * 1e6, 0)} more to LPs
            </span>
          ) : (
            <span>Waterfalls produce equivalent results at this return level</span>
          )}
          <p style={{ marginTop: '10px', marginBottom: 0, color: '#9A9690' }}>
            Net IRR impact: {(Math.abs(comparisonData.european.irr - comparisonData.american.irr) * 10000).toFixed(0)} bps difference
          </p>
        </div>
      </div>

      <h3>Why the Difference Matters</h3>

      <p>
        The American waterfall creates a <strong>timing asymmetry</strong>. When an early
        investment exits at a high multiple, the GP receives carry immediately—even if
        later investments ultimately lose money. In a European structure, those gains would
        be held against future losses before carry is calculated.
      </p>

      <p>
        This asymmetry is partially addressed by <strong>clawback provisions</strong>, which
        require GPs to return excess carry if the final fund economics don't support it.
        However, clawbacks are notoriously difficult to enforce and often come years after
        the carry was distributed (and spent).
      </p>

      <div className="callout">
        <div className="callout-icon">⚖️</div>
        <div className="callout-content">
          Most institutional-quality buyout funds use European waterfalls. American structures
          are more common in venture capital, where the return dispersion between winners and
          losers is more extreme and the timeline to liquidity is longer.
        </div>
      </div>
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
  const DEFAULT_FUND_LIFE = 5;
  const [localGrossMultiple, setLocalGrossMultiple] = useState(BASELINE_GROSS_TVPI);
  const grossMultiple = globalGrossMultiple ?? localGrossMultiple;
  const setGrossMultiple = onGrossMultipleChange ?? setLocalGrossMultiple;
  const [fundLife, setFundLife] = useState(DEFAULT_FUND_LIFE);
  const resetFeeTradeoff = () => {
    setGrossMultiple(BASELINE_GROSS_TVPI);
    setFundLife(DEFAULT_FUND_LIFE);
  };

  // Compare 2/20 vs 1.5/25 vs 1/30
  const structures = useMemo(() => {
    const fundSize = 100; // Normalize to $100 for easy math

    const calcNet = (mgmtFee, carryRate) => {
      // Total management fees (simplified)
      const totalMgmtFees = fundSize * mgmtFee * fundLife * 0.8; // Rough average accounting for step-down

      // Invested capital after fees
      const invested = fundSize - totalMgmtFees;

      // Gross value
      const grossValue = invested * grossMultiple;
      const profit = Math.max(0, grossValue - fundSize);

      // Carry (simplified, no hurdle for comparison)
      const carry = profit * carryRate;

      const netValue = grossValue - carry;
      const netMultiple = netValue / fundSize;

      return {
        mgmtFees: totalMgmtFees,
        carry,
        netValue,
        netMultiple
      };
    };

    return {
      twoTwenty: { ...calcNet(0.02, 0.20), label: '2% / 20%', color: '#1B2A4A' },
      onePointFiveTwentyFive: { ...calcNet(0.015, 0.25), label: '1.5% / 25%', color: '#C9A84C' },
      oneThirty: { ...calcNet(0.01, 0.30), label: '1% / 30%', color: '#B5473A' }
    };
  }, [grossMultiple, fundLife]);

  // Find crossover point
  const crossoverMultiple = useMemo(() => {
    // Solve for where 2/20 = 1/30
    // At low returns, 2/20 is worse (higher mgmt fees, lower carry doesn't matter)
    // At high returns, 2/20 is better (lower carry dominates)
    for (let m = 1.0; m <= 4.0; m += 0.01) {
      const fundSize = 100;
      const mgmtFees220 = fundSize * 0.02 * fundLife * 0.8;
      const mgmtFees130 = fundSize * 0.01 * fundLife * 0.8;

      const invested220 = fundSize - mgmtFees220;
      const invested130 = fundSize - mgmtFees130;

      const profit220 = Math.max(0, invested220 * m - fundSize);
      const profit130 = Math.max(0, invested130 * m - fundSize);

      const net220 = invested220 * m - profit220 * 0.20;
      const net130 = invested130 * m - profit130 * 0.30;

      if (net220 >= net130) {
        return m;
      }
    }
    return 4.0;
  }, [fundLife]);

  const netOutcomes = Object.values(structures).map((s) => s.netMultiple);
  const bestNet = Math.max(...netOutcomes);
  const worstNet = Math.min(...netOutcomes);
  const netSpread = bestNet - worstNet;

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
            min={4}
            max={8}
            step={1}
            label="Fund Life"
            format={(v) => `${v} years`}
          />
        </div>

        <div className="structure-comparison">
          {Object.entries(structures).map(([key, data]) => (
            <div key={key} className="structure-card" style={{ borderColor: data.color }}>
              <div className="structure-label" style={{ color: data.color }}>{data.label}</div>
              <div className="structure-net">{data.netMultiple.toFixed(2)}x net</div>
              <div className="structure-breakdown">
                <span>Mgmt: {formatCurrency(data.mgmtFees * 1e6, 0)}</span>
                <span>Carry: {formatCurrency(data.carry * 1e6, 0)}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="crossover-indicator">
          <div className="crossover-line"></div>
          <div className="crossover-text">
            <strong>Crossover Point: {crossoverMultiple.toFixed(2)}x gross</strong>
            <p>
              Below this return, lower management fees win.<br/>
              Above this return, lower carry wins.
            </p>
          </div>
        </div>

        <div className="net-impact-panel">
          <div className="net-impact-title">Net Investor Impact</div>
          <div className="metrics-row">
            <MetricCard
              label="Best Net TVPI"
              value={`${bestNet.toFixed(2)}x`}
              subtext="Most LP-favorable structure here"
              accent="#1B2A4A"
            />
            <MetricCard
              label="Worst Net TVPI"
              value={`${worstNet.toFixed(2)}x`}
              subtext="Least LP-favorable structure here"
              accent="#B5473A"
            />
            <MetricCard
              label="Net Spread"
              value={`${netSpread.toFixed(2)}x`}
              subtext="Pure fee-structure impact"
              accent="#9A9690"
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
          The crossover typically falls around <strong>2.0-2.5x gross</strong> depending on
          fund life and exact terms. If you believe a GP will deliver upper-quartile returns,
          the traditional 2/20 structure may actually be more LP-friendly than a "discount"
          1/30 structure.
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

    <div className="final-thought">
      <p>
        <em>
          Remember: our goal is to pay as much carry as possible. That means our
          investments have delivered exceptional returns. The best fund economics
          are the ones attached to the best funds.
        </em>
      </p>
    </div>

    <div className="pathway-footer">
      <div className="pathway-logo">Pathway Capital</div>
      <p>Institutional Private Equity Investment</p>
    </div>
  </section>
);

// ============================================================================
// MAIN APP
// ============================================================================

export default function App() {
  const [globalGrossMultiple, setGlobalGrossMultiple] = useState(BASELINE_GROSS_TVPI);
  const [globalDeploymentRate, setGlobalDeploymentRate] = useState(1.0);

  return (
    <div className="pe-fees-app">
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
          grid-template-columns: 250px minmax(0, 1fr);
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
          left: 40px;
          right: 40px;
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
          padding: 22px 14px;
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
          padding: 8px 10px;
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
          background: linear-gradient(90deg, var(--pathway-navy) 0%, var(--pathway-navy-dark) 100%);
          border-bottom: 1px solid rgba(255, 255, 255, 0.16);
          padding: 14px 40px;
        }

        .header-content {
          max-width: 1200px;
          margin: 0 auto;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .header-logo {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .logo-text {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 18px;
          font-weight: 500;
          letter-spacing: 2px;
          text-transform: uppercase;
          color: #FFFFFF;
        }

        .header-nav {
          display: flex;
          align-items: center;
          gap: 24px;
        }

        .nav-tagline {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 12px;
          color: rgba(255, 255, 255, 0.72);
          letter-spacing: 1px;
          text-transform: uppercase;
        }

        /* Master Dashboard */
        .master-dashboard {
          background: #ffffff;
          padding: 64px 40px 46px;
          border-bottom: none;
        }

        .dashboard-header {
          text-align: center;
          margin-bottom: 40px;
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
          margin-top: 14px;
          display: flex;
          justify-content: center;
        }

        .dashboard-grid {
          display: grid;
          grid-template-columns: 280px 1fr 280px;
          gap: 30px;
          max-width: 1400px;
          margin: 0 auto;
        }

        .dashboard-controls {
          display: flex;
          flex-direction: column;
          gap: 24px;
        }

        .control-group {
          background: #F7F9FD;
          border: 1px solid #DEE5F0;
          border-radius: 10px;
          padding: 20px;
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
          gap: 20px;
        }

        .viz-container {
          background: #F7F9FD;
          border: 1px solid #DEE5F0;
          border-radius: 10px;
          padding: 20px;
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
          gap: 16px;
        }

        .metric-group {
          background: #F7F9FD;
          border: 1px solid #DEE5F0;
          border-radius: 10px;
          padding: 16px;
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
          margin: 60px auto 0;
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
          margin-bottom: 16px;
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

        @media (max-width: 700px) {
          .dashboard-controls {
            grid-template-columns: 1fr;
          }

          .dashboard-metrics {
            grid-template-columns: 1fr;
          }
        }

        /* Hero Section */
        .hero-section {
          padding: 80px 40px;
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
          font-size: 18px;
          color: #9A9690;
          max-width: 760px;
          margin: 0 auto 28px;
        }

        .hero-graphboard {
          max-width: 980px;
          margin: 0 auto 28px;
          background: rgba(255, 255, 255, 0.82);
          border: 1px solid #DBE2ED;
          border-radius: 12px;
          padding: 20px 20px 14px;
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

        /* Content Sections */
        .content-section {
          max-width: 900px;
          margin: 0 auto;
          padding: 70px 40px 62px;
          border-bottom: none;
          background: #ffffff;
        }

        .content-section h2 {
          font-size: 28px;
          font-weight: 400;
          color: #1B2A4A;
          margin-bottom: 24px;
          padding-bottom: 10px;
          border-bottom: 1px solid #E3E8F1;
        }

        .content-section h3 {
          font-size: 20px;
          font-weight: 400;
          color: #1B2A4A;
          margin: 40px 0 16px;
        }

        .content-section p {
          margin-bottom: 20px;
          font-size: 17px;
        }

        .content-section strong {
          color: #1B2A4A;
        }

        .content-section em {
          color: #1B2A4A;
          font-style: normal;
        }

        /* Interactive Blocks */
        .interactive-block {
          background: #ffffff;
          border: 1px solid #DCE3EE;
          border-radius: 10px;
          padding: 24px;
          margin: 32px 0;
          box-shadow: 0 10px 28px rgba(15, 27, 51, 0.05);
        }

        .block-header {
          margin-bottom: 24px;
        }

        .block-actions {
          display: flex;
          justify-content: flex-end;
          margin: -12px 0 16px;
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

        /* Sliders */
        .slider-container {
          margin-bottom: 20px;
        }

        .slider-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }

        .slider-label {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 12px;
          color: #9A9690;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .slider-value {
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 14px;
          font-weight: 500;
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
          margin-bottom: 24px;
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
          margin-top: 24px;
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
          margin: 20px 0;
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
          padding: 20px 0;
        }

        .bar-column {
          display: flex;
          flex-direction: column;
          align-items: center;
          flex: 1;
          max-width: 60px;
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
          grid-template-columns: repeat(3, 1fr);
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
          gap: 12px;
        }

        .expense-category {
          display: flex;
          align-items: center;
          gap: 16px;
        }

        .expense-bar-container {
          width: 120px;
          height: 24px;
          background: #E8E6E1;
          border-radius: 4px;
          position: relative;
          overflow: hidden;
          flex-shrink: 0;
        }

        .expense-bar {
          height: 100%;
          border-radius: 4px;
          transition: width 0.3s ease;
        }

        .expense-percent {
          position: absolute;
          right: 8px;
          top: 50%;
          transform: translateY(-50%);
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 11px;
          color: #1B2A4A;
          font-weight: 500;
        }

        .expense-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .expense-name {
          font-size: 13px;
          font-weight: 500;
          color: #1B2A4A;
        }

        .expense-desc {
          font-size: 11px;
          color: #9A9690;
        }

        /* Conclusion */
        .conclusion {
          border-top: 1px solid #E8E6E1;
          margin-top: 40px;
        }

        .final-thought {
          background: linear-gradient(135deg, #ffffff 0%, #E8E6E1 100%);
          border: 1px solid #D9D5CF;
          border-radius: 8px;
          padding: 32px;
          margin: 40px 0;
          text-align: center;
        }

        .final-thought p {
          font-size: 18px;
          color: #1B2A4A;
          margin: 0;
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

        /* Responsive */
        @media (max-width: 600px) {
          .structure-comparison {
            grid-template-columns: 1fr;
          }

          .comparison-metrics {
            grid-template-columns: 1fr;
          }

          .hero-graphboard {
            padding: 16px;
          }

          .hero-graph-canvas {
            height: 260px;
          }
        }
      `}</style>

      <Header />
      <div className="app-shell">
        <SideNav sections={SECTION_LINKS} />
        <main className="app-main">
          <HeroSection />
          <IntroSection
            globalGrossMultiple={globalGrossMultiple}
            onGrossMultipleChange={setGlobalGrossMultiple}
          />
          <ManagementFeeSection />
          <ExpensesSection />
          <CarrySection />
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
          <AccruedCarrySection />
          <QuarterlyScheduleSection
            globalGrossMultiple={globalGrossMultiple}
            onGrossMultipleChange={setGlobalGrossMultiple}
            globalDeploymentRate={globalDeploymentRate}
            onDeploymentRateChange={setGlobalDeploymentRate}
          />
          <MasterDashboard
            asSynthesis={true}
            sectionId="synthesis"
            globalGrossMultiple={globalGrossMultiple}
            onGrossMultipleChange={setGlobalGrossMultiple}
          />
          <ConclusionSection />
        </main>
      </div>
    </div>
  );
}
