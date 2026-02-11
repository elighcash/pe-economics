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

const SECTION_LINKS = [
  { id: 'hero-baseline', label: 'Gross Baseline' },
  { id: 'why-matters', label: 'Why This Matters' },
  { id: 'management-fees', label: 'Management Fees' },
  { id: 'fee-nuances', label: 'Fee Nuances' },
  { id: 'fund-expenses', label: 'Fund Expenses' },
  { id: 'carried-interest', label: 'Carry Mechanics' },
  { id: 'waterfall-structures', label: 'Waterfalls' },
  { id: 'underinvesting-impact', label: 'Underinvesting' },
  { id: 'fee-carry-tradeoff', label: 'Fee/Carry Tradeoff' },
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
  marker = null
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
    marker
  ]);

  return <canvas ref={canvasRef} className="comparison-canvas" style={{ width: '100%', height }} />;
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

// ============================================================================
// SECTION COMPONENTS
// ============================================================================

const Header = ({ compactControls, onToggleCompactControls }) => {
  const [menuOpen, setMenuOpen] = useState(false);

  const handleToggleCompact = () => {
    onToggleCompactControls();
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
      <p className="hero-subtitle">A guide to getting from gross to net.</p>
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
    const grossProfitPerUnit = Math.max(0.0001, grossMOIC - 1);
    const dragPctOfGrossProfit = (totalDrag / grossProfitPerUnit) * 100;

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
        Top-quartile funds have delivered returns that justify the illiquidity, complexity,
        and yes—the fees. But between the <em>gross</em> returns a fund generates and the
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
            subtext={`${grossToNetBridge.dragPctOfGrossProfit.toFixed(0)}% of gross profits`}
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
          <MetricCard
            label="Total Gross-to-Net Drag"
            value={`-${grossToNetBridge.totalDrag.toFixed(2)}x`}
            subtext={`${grossToNetBridge.dragPctOfGrossProfit.toFixed(0)}% of gross profits`}
            accent="#1B2A4A"
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
      </div>

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
  const PRE_CARRY_IRR_MIN = 0.0;
  const PRE_CARRY_IRR_MAX = 0.5;
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
  const clampedPreCarryNetIRR = Math.max(PRE_CARRY_IRR_MIN, Math.min(PRE_CARRY_IRR_MAX, preCarryNetIRRFromGross));

  const handlePreCarryNetIRRChange = (nextIrr) => {
    const clamped = Math.max(PRE_CARRY_IRR_MIN, Math.min(PRE_CARRY_IRR_MAX, nextIrr));
    const impliedPreCarryMultiple = Math.pow(1 + clamped, holdPeriod);
    const impliedGross = impliedPreCarryMultiple + NON_CARRY_DRAG_MULTIPLE;
    setGrossMOIC(Math.max(1.0, Math.min(3.5, impliedGross)));
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
            min={PRE_CARRY_IRR_MIN}
            max={PRE_CARRY_IRR_MAX}
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

  const irrCurve = useMemo(() => {
    const labels = [];
    const twoTwenty = [];
    const oneThirty = [];
    for (let m = 1.0; m <= 3.5001; m += CURVE_STEP) {
      const gross = Number(m.toFixed(2));
      labels.push(`${gross.toFixed(2)}x`);
      twoTwenty.push(calcNetOutcome(gross, 0.02, 0.20).netIRR * 100);
      oneThirty.push(calcNetOutcome(gross, 0.01, 0.30).netIRR * 100);
    }
    return { labels, twoTwenty, oneThirty };
  }, [fundLife]);

  const crossoverResult = useMemo(() => {
    const EPS = 0.01; // 0.01% IRR ~= 1 bp in chart units
    const points = irrCurve.labels
      .map((label, i) => ({
        multiple: parseFloat(label),
        diff: irrCurve.twoTwenty[i] - irrCurve.oneThirty[i]
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

      if (Math.abs(leftDiff) <= EPS) {
        const tailDiffs = points.slice(i - 1).map((p) => p.diff);
        const tailMin = Math.min(...tailDiffs);
        upwardCandidates.push({
          multiple: left.multiple,
          sustained: tailMin >= -EPS
        });
        continue;
      }

      // We only care about the economically intuitive transition:
      // low gross range favors lower fee; high gross range favors lower carry.
      const isUpwardCross = leftDiff < -EPS && rightDiff > EPS;
      if (!isUpwardCross) continue;

      const denom = rightDiff - leftDiff;
      const t = Math.abs(denom) < 1e-9 ? 0 : (0 - leftDiff) / denom;
      const clampedT = Math.max(0, Math.min(1, t));
      const x = left.multiple + (right.multiple - left.multiple) * clampedT;
      const tailDiffs = points.slice(i).map((p) => p.diff);
      const tailMin = Math.min(...tailDiffs);
      upwardCandidates.push({
        multiple: x,
        sustained: tailMin >= -EPS
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
  }, [irrCurve]);

  const crossoverMultiple = crossoverResult.multiple;
  const crossoverIndex = useMemo(() => {
    const rawIndex = Math.round((crossoverMultiple - 1.0) / CURVE_STEP);
    return Math.max(0, Math.min(irrCurve.labels.length - 1, rawIndex));
  }, [crossoverMultiple, irrCurve.labels.length]);

  const irrOutcomes = Object.values(structures).map((s) => s.netIRR);
  const bestNetIRR = Math.max(...irrOutcomes);
  const worstNetIRR = Math.min(...irrOutcomes);
  const irrSpreadBps = (bestNetIRR - worstNetIRR) * 10000;

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
              <div className="structure-net">{formatPercent(data.netIRR, 1)} net IRR</div>
              <div className="structure-breakdown">
                <span>Net TVPI: {data.netMultiple.toFixed(2)}x</span>
                <span>Mgmt: {formatCurrency(data.mgmtFees, 0)}</span>
                <span>Carry: {formatCurrency(data.carry, 0)}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="tradeoff-curve">
          <div className="tradeoff-curve-title">Net IRR Across Gross MOIC Outcomes</div>
          <ComparisonChart
            seriesA={irrCurve.twoTwenty}
            seriesB={irrCurve.oneThirty}
            labelA="2% / 20%"
            labelB="1% / 30%"
            xLabels={irrCurve.labels}
            xTickStep={10}
            yFormatter={(v) => `${v.toFixed(1)}%`}
            colorA="#1B2A4A"
            colorB="#B5473A"
            height={220}
            marker={crossoverResult.hasCrossover ? {
              index: crossoverIndex,
              label: `Crossover ${crossoverMultiple.toFixed(2)}x`,
              color: '#C9A84C'
            } : null}
          />
        </div>

        <p className="assumption-note">
          Model note: carry catch-up is allocated across carry-paying periods once LP capital and
          pref are cleared, rather than as a single terminal-only carry lump.
        </p>

        <div className="net-impact-panel">
          <div className="net-impact-title">Net Investor Impact</div>
          <div className="metrics-row">
            <MetricCard
              label="Best Net IRR"
              value={formatPercent(bestNetIRR, 1)}
              subtext="Most LP-favorable structure here"
              accent="#1B2A4A"
            />
            <MetricCard
              label="Worst Net IRR"
              value={formatPercent(worstNetIRR, 1)}
              subtext="Least LP-favorable structure here"
              accent="#B5473A"
            />
            <MetricCard
              label="IRR Spread"
              value={`${irrSpreadBps.toFixed(0)} bps`}
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
          {crossoverResult.hasCrossover ? (
            <>
              In this IRR setup, the crossover is around <strong>{crossoverMultiple.toFixed(2)}x gross</strong>.
              Below that point, lower fees tend to dominate; above it, lower carry tends to dominate.
            </>
          ) : (
            <>
              In this IRR setup, no crossover appears in the displayed range (1.0x to 3.5x gross).
              In that range, one structure stays marginally ahead on IRR, while TVPI can still tell a different story.
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
        'Term-level interactions like variable carry tiers, offset formulas, and expense sharing that can shift gross-to-net economics over time.'
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

// ============================================================================
// MAIN APP
// ============================================================================

export default function App() {
  const [globalGrossMultiple, setGlobalGrossMultiple] = useState(BASELINE_GROSS_TVPI);
  const [globalDeploymentRate, setGlobalDeploymentRate] = useState(1.0);
  const [compactControls, setCompactControls] = useState(true);

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
        }

        .synthesis-grid .dashboard-controls {
          grid-area: controls;
        }

        .synthesis-grid .dashboard-main {
          grid-area: main;
          min-width: 0;
        }

        .synthesis-grid .dashboard-metrics {
          grid-area: metrics;
        }

        .synthesis-grid .viz-container {
          min-height: 280px;
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
              "controls metrics";
            max-width: 860px;
            gap: 16px;
          }

          .synthesis-grid .synthesis-main {
            display: none;
          }
        }

        @media (max-width: 920px) {
          .synthesis-grid {
            grid-template-columns: 1fr;
            grid-template-areas:
              "controls"
              "metrics";
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
          font-size: 18px;
          color: #9A9690;
          max-width: 760px;
          margin: 0 auto 22px;
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
      />
      <div className="app-shell">
        <SideNav sections={SECTION_LINKS} />
        <main className="app-main">
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
