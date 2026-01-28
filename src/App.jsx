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

// ============================================================================
// REUSABLE COMPONENTS
// ============================================================================

const Slider = ({ value, onChange, min, max, step = 0.01, label, format = (v) => v, accent = '#4ECDC4' }) => {
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
            background: `linear-gradient(to right, ${accent} 0%, ${accent} ${percentage}%, #2a2a3a ${percentage}%, #2a2a3a 100%)`
          }}
        />
      </div>
    </div>
  );
};

const MetricCard = ({ label, value, subtext, accent = '#4ECDC4' }) => (
  <div className="metric-card">
    <div className="metric-label">{label}</div>
    <div className="metric-value" style={{ color: accent }}>{value}</div>
    {subtext && <div className="metric-subtext">{subtext}</div>}
  </div>
);

const ToggleSwitch = ({ options, value, onChange, accent = '#4ECDC4' }) => (
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

// ============================================================================
// VISUALIZATION COMPONENTS
// ============================================================================

const BarChart = ({ data, height = 200, accent = '#4ECDC4', showLabels = true }) => {
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
      ctx.fillStyle = stage.color || '#4ECDC4';
      ctx.fillRect(x - 30, y, 60, barHeight);

      // Draw label
      ctx.fillStyle = '#888';
      ctx.font = '12px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(stage.label, x, h - 20);

      // Draw value
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px system-ui';
      ctx.fillText(stage.valueLabel || formatCurrency(stage.value, 1), x, y - 10);

      // Draw flow arrow
      if (i < stages.length - 1) {
        const nextStage = stages[i + 1];
        const nextBarHeight = (nextStage.value / maxValue) * (h - 80);
        const nextY = h - 40 - nextBarHeight;

        ctx.strokeStyle = '#444';
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
        ctx.fillStyle = '#444';
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
        ctx.strokeStyle = '#333';
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
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'center';
      const valueY = d.isIncrease ? barTop - 8 : prevTop - 8;
      ctx.fillText(d.valueLabel, x + barWidth / 2, barTop - 8);

      // Draw category label
      ctx.fillStyle = '#888';
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
      ctx.fillStyle = '#666';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(formatCurrency(val, 0), padding.left - 8, y + 4);
    }

    // Draw line
    ctx.strokeStyle = '#4ECDC4';
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

      ctx.fillStyle = '#4ECDC4';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();

      // Year label
      ctx.fillStyle = '#888';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(d.label, x, h - padding.bottom + 20);
    });
  }, [data, showCumulative]);

  return <canvas ref={canvasRef} className="timeline-canvas" style={{ width: '100%', height }} />;
};

const ComparisonChart = ({ seriesA, seriesB, labelA, labelB, height = 250, colorA = '#4ECDC4', colorB = '#FF6B6B' }) => {
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
      ctx.strokeStyle = '#444';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, zeroY);
      ctx.lineTo(width - padding.right, zeroY);
      ctx.stroke();
    }

    // Draw grid
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (i / 4) * chartHeight;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      const val = maxValue - (i / 4) * range;
      ctx.fillStyle = '#666';
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
    ctx.fillStyle = '#aaa';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(labelA, padding.left + 28, 14);

    ctx.fillStyle = colorB;
    ctx.fillRect(padding.left + 120, 10, 20, 3);
    ctx.fillStyle = '#aaa';
    ctx.fillText(labelB, padding.left + 148, 14);

    // X-axis labels
    for (let i = 0; i < seriesA.length; i++) {
      const x = padding.left + (i / (seriesA.length - 1)) * chartWidth;
      ctx.fillStyle = '#666';
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

// ============================================================================
// BASE CURVE DATA - Quarterly LP net returns for a typical 2.0x net fund
// Source: Industry benchmark data, 2% mgmt fee, 20% carry, 50bps expenses
// ============================================================================

const BASE_CURVE = [
  { q: 1, drawdown: 0.0375, dpi: 0.000, rvpi: 0.940 },
  { q: 2, drawdown: 0.0750, dpi: 0.000, rvpi: 0.940 },
  { q: 3, drawdown: 0.1125, dpi: 0.000, rvpi: 0.940 },
  { q: 4, drawdown: 0.1500, dpi: 0.000, rvpi: 0.940 },
  { q: 5, drawdown: 0.2125, dpi: 0.000, rvpi: 0.941 },
  { q: 6, drawdown: 0.2750, dpi: 0.000, rvpi: 0.943 },
  { q: 7, drawdown: 0.3375, dpi: 0.000, rvpi: 0.944 },
  { q: 8, drawdown: 0.4000, dpi: 0.000, rvpi: 0.945 },
  { q: 9, drawdown: 0.4500, dpi: 0.001, rvpi: 0.947 },
  { q: 10, drawdown: 0.5000, dpi: 0.002, rvpi: 0.948 },
  { q: 11, drawdown: 0.5500, dpi: 0.003, rvpi: 0.949 },
  { q: 12, drawdown: 0.6000, dpi: 0.004, rvpi: 0.951 },
  { q: 13, drawdown: 0.6375, dpi: 0.008, rvpi: 0.952 },
  { q: 14, drawdown: 0.6750, dpi: 0.012, rvpi: 0.953 },
  { q: 15, drawdown: 0.7125, dpi: 0.017, rvpi: 0.952 },
  { q: 16, drawdown: 0.7500, dpi: 0.023, rvpi: 0.954 },
  { q: 17, drawdown: 0.7750, dpi: 0.027, rvpi: 0.957 },
  { q: 18, drawdown: 0.8000, dpi: 0.040, rvpi: 0.960 },
  { q: 19, drawdown: 0.8250, dpi: 0.056, rvpi: 0.956 },
  { q: 20, drawdown: 0.8500, dpi: 0.074, rvpi: 0.954 },
  { q: 21, drawdown: 0.8750, dpi: 0.098, rvpi: 0.953 },
  { q: 22, drawdown: 0.9000, dpi: 0.126, rvpi: 0.950 },
  { q: 23, drawdown: 0.9250, dpi: 0.158, rvpi: 0.941 },
  { q: 24, drawdown: 0.9500, dpi: 0.192, rvpi: 0.930 },
  { q: 25, drawdown: 0.9625, dpi: 0.237, rvpi: 0.921 },
  { q: 26, drawdown: 0.9750, dpi: 0.282, rvpi: 0.910 },
  { q: 27, drawdown: 0.9875, dpi: 0.329, rvpi: 0.894 },
  { q: 28, drawdown: 1.0000, dpi: 0.380, rvpi: 0.873 },
  { q: 29, drawdown: 1.0000, dpi: 0.446, rvpi: 0.851 },
  { q: 30, drawdown: 1.0000, dpi: 0.515, rvpi: 0.827 },
  { q: 31, drawdown: 1.0000, dpi: 0.589, rvpi: 0.796 },
  { q: 32, drawdown: 1.0000, dpi: 0.666, rvpi: 0.765 },
  { q: 33, drawdown: 1.0000, dpi: 0.747, rvpi: 0.731 },
  { q: 34, drawdown: 1.0000, dpi: 0.831, rvpi: 0.695 },
  { q: 35, drawdown: 1.0000, dpi: 0.920, rvpi: 0.653 },
  { q: 36, drawdown: 1.0000, dpi: 1.013, rvpi: 0.612 },
  { q: 37, drawdown: 1.0000, dpi: 1.092, rvpi: 0.572 },
  { q: 38, drawdown: 1.0000, dpi: 1.173, rvpi: 0.528 },
  { q: 39, drawdown: 1.0000, dpi: 1.259, rvpi: 0.485 },
  { q: 40, drawdown: 1.0000, dpi: 1.350, rvpi: 0.444 },
  { q: 41, drawdown: 1.0000, dpi: 1.406, rvpi: 0.405 },
  { q: 42, drawdown: 1.0000, dpi: 1.460, rvpi: 0.362 },
  { q: 43, drawdown: 1.0000, dpi: 1.517, rvpi: 0.325 },
  { q: 44, drawdown: 1.0000, dpi: 1.573, rvpi: 0.291 },
  { q: 45, drawdown: 1.0000, dpi: 1.629, rvpi: 0.263 },
  { q: 46, drawdown: 1.0000, dpi: 1.684, rvpi: 0.234 },
  { q: 47, drawdown: 1.0000, dpi: 1.741, rvpi: 0.208 },
  { q: 48, drawdown: 1.0000, dpi: 1.797, rvpi: 0.182 },
  { q: 49, drawdown: 1.0000, dpi: 1.835, rvpi: 0.156 },
  { q: 50, drawdown: 1.0000, dpi: 1.872, rvpi: 0.130 },
  { q: 51, drawdown: 1.0000, dpi: 1.910, rvpi: 0.104 },
  { q: 52, drawdown: 1.0000, dpi: 1.948, rvpi: 0.078 },
  { q: 53, drawdown: 1.0000, dpi: 1.968, rvpi: 0.052 },
  { q: 54, drawdown: 1.0000, dpi: 1.981, rvpi: 0.026 },
  { q: 55, drawdown: 1.0000, dpi: 1.995, rvpi: 0.009 },
  { q: 56, drawdown: 1.0000, dpi: 2.000, rvpi: 0.000 },
];

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

// ============================================================================
// MASTER DASHBOARD - The Big Picture
// ============================================================================

const MasterDashboard = () => {
  // All the key inputs - base case: 2% mgmt, 20% carry, 50bps expenses = 2.0x net, ~15% IRR
  const [fundSize, setFundSize] = useState(500);
  const [mgmtFeeRate, setMgmtFeeRate] = useState(0.02);
  const [expenseRate, setExpenseRate] = useState(0.005); // 50bps during investment period
  const [carryRate, setCarryRate] = useState(0.20);
  const [hurdleRate, setHurdleRate] = useState(0.08);
  const [netMultipleTarget, setNetMultipleTarget] = useState(2.0); // This scales the base curve
  const [fundLife, setFundLife] = useState(14); // 14 years = 56 quarters
  const [investmentPeriod, setInvestmentPeriod] = useState(7); // 7 years = 28 quarters to full drawdown

  // Calculate everything using base curve data
  const calculations = useMemo(() => {
    // Scale factor: how much to adjust the base 2.0x curve
    const baseNetMultiple = 2.0;
    const multipleScaleFactor = netMultipleTarget / baseNetMultiple;

    // Build quarterly cash flow data from base curve
    const quarterlyData = BASE_CURVE.map((row, i) => {
      const prevRow = i > 0 ? BASE_CURVE[i - 1] : { drawdown: 0, dpi: 0 };

      // Incremental values this quarter
      const capitalCall = (row.drawdown - prevRow.drawdown) * fundSize;
      const distribution = (row.dpi - prevRow.dpi) * fundSize * multipleScaleFactor;

      // Scale RVPI by the multiple factor (simplified - assumes proportional value growth)
      const scaledRvpi = row.rvpi * multipleScaleFactor;
      const nav = row.drawdown * fundSize * scaledRvpi;

      // TVPI at this point
      const tvpi = row.dpi * multipleScaleFactor + scaledRvpi;

      return {
        quarter: row.q,
        year: row.q / 4,
        capitalCall,
        distribution,
        cumulativeDrawdown: row.drawdown * fundSize,
        cumulativeDPI: row.dpi * fundSize * multipleScaleFactor,
        rvpiMultiple: scaledRvpi,
        nav,
        tvpi,
        isInvestmentPeriod: row.q <= investmentPeriod * 4
      };
    });

    // Calculate IRR from actual cash flows
    const cashFlows = [];
    quarterlyData.forEach((q) => {
      if (q.capitalCall > 0) {
        cashFlows.push({ period: q.quarter, amount: -q.capitalCall });
      }
      if (q.distribution > 0) {
        cashFlows.push({ period: q.quarter, amount: q.distribution });
      }
    });

    const netIRR = cashFlows.length > 2 ? calculateIRR(cashFlows, 4) : 0;

    // Total distributions and net multiple
    const totalDistributions = quarterlyData[quarterlyData.length - 1].cumulativeDPI;
    const netMultiple = totalDistributions / fundSize;
    const netProfit = totalDistributions - fundSize;

    // Calculate fees and expenses (annual basis)
    let totalMgmtFees = 0;
    let totalExpenses = 0;
    const yearlyData = [];

    for (let year = 1; year <= fundLife; year++) {
      const isInvPeriod = year <= investmentPeriod;
      const feeRate = isInvPeriod ? mgmtFeeRate : mgmtFeeRate * 0.75;

      // Fee basis: committed during investment, declining after based on realizations
      let feeBasis;
      if (isInvPeriod) {
        feeBasis = fundSize;
      } else {
        // Use DPI curve to determine remaining basis
        const quarterIndex = Math.min(year * 4 - 1, BASE_CURVE.length - 1);
        const dpiAtQuarter = BASE_CURVE[quarterIndex].dpi * multipleScaleFactor;
        const realizedPortion = Math.min(dpiAtQuarter / netMultiple, 0.9);
        feeBasis = fundSize * (1 - realizedPortion);
      }

      const fee = feeBasis * feeRate;
      totalMgmtFees += fee;

      // Expenses: higher during investment period
      const yearExpenseRate = isInvPeriod ? expenseRate : expenseRate * 0.4;
      const expense = feeBasis * yearExpenseRate;
      totalExpenses += expense;

      yearlyData.push({
        year,
        fee,
        expense,
        cumulativeFees: totalMgmtFees,
        cumulativeExpenses: totalExpenses,
        isInvestmentPeriod: isInvPeriod
      });
    }

    // Gross calculations: work backwards from net to estimate gross
    // Net = Gross - Fees - Expenses - Carry
    // For base case with 2/20/50bps: Gross ~2.5x yields Net 2.0x
    const totalFeesAndExpenses = totalMgmtFees + totalExpenses;

    // Estimate gross from net (reverse engineer the fee drag)
    // Assuming carry is ~20% of profit above hurdle
    const estimatedGrossProfit = (netProfit + totalFeesAndExpenses) / (1 - carryRate * 0.8);
    const grossValue = fundSize + estimatedGrossProfit;
    const grossMultiple = grossValue / fundSize;
    const totalGrossProfit = grossValue - fundSize;

    // Hurdle check
    const avgHoldPeriod = fundLife * 0.6;
    const hurdleAmount = fundSize * (Math.pow(1 + hurdleRate, avgHoldPeriod) - 1);
    const hurdleCleared = totalGrossProfit > hurdleAmount;

    // Carry calculation
    let carry = 0;
    if (hurdleCleared && totalGrossProfit > 0) {
      carry = totalGrossProfit * carryRate;
    }

    // Gross IRR (approximate from gross multiple)
    const grossIRR = Math.pow(grossMultiple, 1 / avgHoldPeriod) - 1;

    // Total costs
    const totalCosts = totalFeesAndExpenses + carry;

    // Fee drag as percentage of gross profit
    const feeDragPercent = totalGrossProfit > 0 ? (totalCosts / totalGrossProfit) * 100 : 0;

    // Breakdown for waterfall visualization
    const breakdown = [
      { label: 'LP Capital', value: fundSize, color: '#4ECDC4' },
      { label: 'Gross Profit', value: totalGrossProfit, color: '#6BCB77' },
      { label: 'Mgmt Fees', value: totalMgmtFees, color: '#FF6B6B', isDeduction: true },
      { label: 'Expenses', value: totalExpenses, color: '#FF8E53', isDeduction: true },
      { label: 'GP Carry', value: carry, color: '#FFD93D', isDeduction: true },
      { label: 'LP Net', value: totalDistributions, color: '#4ECDC4' },
    ];

    return {
      totalMgmtFees,
      totalExpenses,
      totalFeesAndExpenses,
      carry,
      totalCosts,
      grossValue,
      netValue: totalDistributions,
      grossMultiple,
      netMultiple,
      grossIRR,
      netIRR,
      hurdleCleared,
      feeDragPercent,
      yearlyData,
      quarterlyData,
      breakdown,
      totalGrossProfit,
      netProfit
    };
  }, [fundSize, mgmtFeeRate, expenseRate, carryRate, hurdleRate, netMultipleTarget, fundLife, investmentPeriod]);

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
        q.nav + q.cumulativeDPI,
        q.cumulativeDPI
      ))
    ) * 1.15;

    // Draw grid
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = padding.top + (i / 5) * chartHeight;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      const val = maxValue - (i / 5) * maxValue;
      ctx.fillStyle = '#666';
      ctx.font = '11px Helvetica Neue';
      ctx.textAlign = 'right';
      ctx.fillText(formatCurrency(val * 1e6, 0), padding.left - 10, y + 4);
    }

    // Draw contributed capital line (drawdown)
    ctx.strokeStyle = '#4ECDC4';
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
    ctx.strokeStyle = '#6BCB77';
    ctx.lineWidth = 3;
    ctx.beginPath();
    quarterlyData.forEach((q, i) => {
      const x = padding.left + (q.quarter / totalQuarters) * chartWidth;
      const totalValue = q.nav + q.cumulativeDPI;
      const y = padding.top + (1 - totalValue / maxValue) * chartHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw distributions area (DPI)
    ctx.fillStyle = 'rgba(78, 205, 196, 0.2)';
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top + chartHeight);
    quarterlyData.forEach((q) => {
      const x = padding.left + (q.quarter / totalQuarters) * chartWidth;
      const y = padding.top + (1 - q.cumulativeDPI / maxValue) * chartHeight;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
    ctx.closePath();
    ctx.fill();

    // Investment period marker
    const ipQuarter = investmentPeriod * 4;
    const ipX = padding.left + (ipQuarter / totalQuarters) * chartWidth;
    ctx.strokeStyle = '#FFD93D';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(ipX, padding.top);
    ctx.lineTo(ipX, padding.top + chartHeight);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#FFD93D';
    ctx.font = '10px Helvetica Neue';
    ctx.textAlign = 'center';
    ctx.fillText('Inv. Period Ends', ipX, padding.top - 10);

    // X-axis labels (years)
    const totalYears = Math.ceil(totalQuarters / 4);
    for (let year = 0; year <= totalYears; year += 2) {
      const x = padding.left + (year * 4 / totalQuarters) * chartWidth;
      ctx.fillStyle = '#666';
      ctx.font = '11px Helvetica Neue';
      ctx.textAlign = 'center';
      ctx.fillText(`Yr ${year}`, x, height - padding.bottom + 25);
    }

    // Legend
    const legendY = height - 25;
    ctx.fillStyle = '#4ECDC4';
    ctx.fillRect(padding.left, legendY, 15, 3);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#4ECDC4';
    ctx.beginPath();
    ctx.moveTo(padding.left, legendY + 1.5);
    ctx.lineTo(padding.left + 15, legendY + 1.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#888';
    ctx.font = '11px Helvetica Neue';
    ctx.textAlign = 'left';
    ctx.fillText('Capital Calls', padding.left + 22, legendY + 5);

    ctx.fillStyle = '#6BCB77';
    ctx.fillRect(padding.left + 120, legendY, 15, 3);
    ctx.fillStyle = '#888';
    ctx.fillText('NAV + DPI', padding.left + 142, legendY + 5);

    ctx.fillStyle = 'rgba(78, 205, 196, 0.4)';
    ctx.fillRect(padding.left + 230, legendY - 3, 15, 10);
    ctx.fillStyle = '#888';
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
      { label: 'LP Capital', value: fundSize, color: '#4ECDC4' },
      { label: 'Gross Profit', value: calculations.totalGrossProfit, color: '#6BCB77' },
      { label: 'Mgmt Fees', value: calculations.totalMgmtFees, color: '#FF6B6B', isDeduction: true },
      { label: 'Expenses', value: calculations.totalExpenses, color: '#FF8E53', isDeduction: true },
      { label: 'GP Carry', value: calculations.carry, color: '#FFD93D', isDeduction: true },
      { label: 'LP Net', value: calculations.netValue, color: '#4ECDC4' },
    ];

    const maxValue = Math.max(fundSize + calculations.totalGrossProfit, calculations.netValue) * 1.1;
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
        ctx.strokeStyle = '#333';
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
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px Helvetica Neue';
      ctx.textAlign = 'center';
      const valueText = stage.isDeduction ? `-${formatCurrency(stage.value * 1e6, 0)}` : formatCurrency(stage.value * 1e6, 0);
      ctx.fillText(valueText, x + barWidth / 2, barTop - 8);

      // Stage label
      ctx.fillStyle = '#888';
      ctx.font = '10px Helvetica Neue';
      ctx.textAlign = 'center';
      ctx.fillText(stage.label, x + barWidth / 2, height - padding.bottom + 20);
    });

  }, [calculations, fundSize]);

  return (
    <section className="master-dashboard">
      <div className="dashboard-header">
        <h1>The Economics of Private Equity</h1>
        <p className="dashboard-subtitle">
          Drag the sliders to see how fund terms affect your returns
        </p>
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
              accent="#FFD93D"
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
              accent="#FF6B6B"
            />
            <Slider
              value={expenseRate}
              onChange={setExpenseRate}
              min={0.001}
              max={0.01}
              step={0.001}
              label="Fund Expenses"
              format={(v) => `${(v * 10000).toFixed(0)} bps`}
              accent="#FF8E53"
            />
            <Slider
              value={carryRate}
              onChange={setCarryRate}
              min={0.15}
              max={0.30}
              step={0.01}
              label="Carried Interest"
              format={(v) => formatPercent(v)}
              accent="#FFD93D"
            />
            <Slider
              value={hurdleRate}
              onChange={setHurdleRate}
              min={0}
              max={0.10}
              step={0.005}
              label="Hurdle Rate"
              format={(v) => formatPercent(v)}
              accent="#6BCB77"
            />
          </div>

          <div className="control-group">
            <div className="control-group-header">Performance</div>
            <Slider
              value={netMultipleTarget}
              onChange={setNetMultipleTarget}
              min={1.0}
              max={3.5}
              step={0.05}
              label="Net Multiple Target"
              format={(v) => `${v.toFixed(2)}x`}
              accent="#4ECDC4"
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
              <span className="metric-value" style={{ color: '#6BCB77' }}>{grossMultiple.toFixed(2)}x</span>
            </div>
            <div className="metric-large">
              <span className="metric-label">Net Multiple</span>
              <span className="metric-value" style={{ color: '#4ECDC4' }}>{calculations.netMultiple.toFixed(2)}x</span>
            </div>
            <div className="metric-divider"></div>
            <div className="metric-small">
              <span>Gross IRR</span>
              <span style={{ color: '#6BCB77' }}>{formatPercent(calculations.grossIRR)}</span>
            </div>
            <div className="metric-small">
              <span>Net IRR</span>
              <span style={{ color: '#4ECDC4' }}>{formatPercent(calculations.netIRR)}</span>
            </div>
          </div>

          <div className="metric-group">
            <div className="metric-group-header">Fees, Expenses & Carry</div>
            <div className="metric-small">
              <span>Management Fees</span>
              <span style={{ color: '#FF6B6B' }}>{formatCurrency(calculations.totalMgmtFees * 1e6, 0)}</span>
            </div>
            <div className="metric-small">
              <span>Fund Expenses</span>
              <span style={{ color: '#FF8E53' }}>{formatCurrency(calculations.totalExpenses * 1e6, 0)}</span>
            </div>
            <div className="metric-small">
              <span>Carried Interest</span>
              <span style={{ color: '#FFD93D' }}>{formatCurrency(calculations.carry * 1e6, 0)}</span>
            </div>
            <div className="metric-divider"></div>
            <div className="metric-small">
              <span>Total Costs</span>
              <span style={{ color: '#fff' }}>{formatCurrency(calculations.totalCosts * 1e6, 0)}</span>
            </div>
            <div className="metric-small highlight">
              <span>Cost Drag</span>
              <span style={{ color: calculations.feeDragPercent > 30 ? '#FF6B6B' : '#888' }}>
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
              <span style={{ color: '#4ECDC4' }}>{formatCurrency(calculations.netValue * 1e6, 0)}</span>
            </div>
            <div className="metric-divider"></div>
            <div className="metric-small">
              <span>Net Profit</span>
              <span style={{ color: calculations.netProfit > 0 ? '#4ECDC4' : '#FF6B6B' }}>
                {formatCurrency(calculations.netProfit * 1e6, 0)}
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
        <h2>Let's break it down.</h2>
        <p>
          The visualization above captures the full complexity of PE economics.
          Below, we'll explore each component in detail—from management fees to carried interest,
          from waterfall structures to the tradeoffs that shape LP returns.
        </p>
      </div>
    </section>
  );
};

const HeroSection = () => (
  <section className="hero-section" style={{ display: 'none' }}>
    {/* Hidden - replaced by MasterDashboard */}
  </section>
);

const IntroSection = () => {
  const [grossReturn, setGrossReturn] = useState(2.0);

  const netReturn = useMemo(() => {
    // Simplified model: ~15% fee drag at 2x, scaling somewhat with returns
    const feeDrag = 0.10 + (grossReturn - 1) * 0.08;
    return Math.max(1, grossReturn - feeDrag);
  }, [grossReturn]);

  return (
    <section className="content-section">
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

        <Slider
          value={grossReturn}
          onChange={setGrossReturn}
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
            accent="#FF6B6B"
          />
          <MetricCard
            label="Fee Drag"
            value={`${((grossReturn - netReturn) / (grossReturn - 1) * 100).toFixed(0)}%`}
            subtext="Of gross profits"
            accent="#888"
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
  const [fundSize, setFundSize] = useState(500); // millions
  const [feeRate, setFeeRate] = useState(0.02);
  const [investmentPeriod, setInvestmentPeriod] = useState(5);
  const [fundLife, setFundLife] = useState(12);
  const [hasRateStepDown, setHasRateStepDown] = useState(true);
  const [postInvestmentBasis, setPostInvestmentBasis] = useState('remaining'); // 'committed' or 'remaining'
  const [showAssumptions, setShowAssumptions] = useState(false);

  const feeData = useMemo(() => {
    const data = [];
    let cumulativeFees = 0;

    // Model assumptions for a typical fund
    // Investment pacing: ramp up during investment period
    // Realization pacing: exits begin year 4, accelerate years 6-10

    for (let year = 1; year <= fundLife; year++) {
      // Called capital: cumulative amount called from LPs
      // Assume ~20% called per year during investment period
      const calledCapital = Math.min(fundSize, (year / investmentPeriod) * fundSize);

      // Invested capital (cost basis): what's actually deployed
      // Slightly lags called capital (cash drag)
      const investedCapital = Math.min(fundSize * 0.95, Math.max(0, calledCapital - fundSize * 0.05));

      // Realizations: exits return capital starting year 4
      let cumulativeRealizations = 0;
      if (year >= 4) {
        // S-curve of realizations
        const realizationProgress = Math.min(1, (year - 3) / (fundLife - 3));
        cumulativeRealizations = investedCapital * Math.pow(realizationProgress, 1.5) * 0.9;
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

  return (
    <section className="content-section">
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
            accent="#FF6B6B"
          />
          <MetricCard
            label="Average Annual Fee"
            value={formatCurrency((totalFees / fundLife) * 1e6, 0)}
            accent="#888"
          />
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
              Shaded rows indicate post-investment period. Assumptions: 95% deployment,
              realizations begin Year 4 with S-curve pacing.
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
  const [fundSize, setFundSize] = useState(500);
  const [investmentPeriod, setInvestmentPeriod] = useState(5);
  const [fundLife, setFundLife] = useState(10);
  const [expenseRate, setExpenseRate] = useState(0.005);

  const expenseData = useMemo(() => {
    const categories = [
      { name: 'Legal & Compliance', percent: 25, color: '#4ECDC4', description: 'Fund formation, transaction docs, regulatory filings' },
      { name: 'Accounting & Audit', percent: 20, color: '#6BCB77', description: 'Annual audits, tax prep, fund administration' },
      { name: 'Due Diligence', percent: 20, color: '#FFD93D', description: 'Third-party diligence providers, consultants' },
      { name: 'Travel & Meetings', percent: 15, color: '#FF8E53', description: 'Deal sourcing, portfolio company visits, AGMs' },
      { name: 'Insurance & Other', percent: 12, color: '#FF6B6B', description: 'D&O insurance, cybersecurity, bank fees' },
      { name: 'Broken Deal Costs', percent: 8, color: '#888', description: 'Costs from deals that don\'t close' },
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

  return (
    <section className="content-section">
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
            accent="#FF8E53"
          />
        </div>

        <div className="metrics-row">
          <MetricCard
            label="Total Fund Expenses"
            value={formatCurrency(expenseData.totalExpenses * 1e6, 0)}
            subtext={`${expenseData.expenseAsPercentOfCommitment.toFixed(1)}% of commitment`}
            accent="#FF8E53"
          />
          <MetricCard
            label="Investment Period"
            value={formatCurrency(expenseData.investmentPeriodExpenses * 1e6, 0)}
            subtext={`~${(expenseRate * 10000).toFixed(0)} bps annually`}
            accent="#FF8E53"
          />
          <MetricCard
            label="Harvest Period"
            value={formatCurrency(expenseData.harvestPeriodExpenses * 1e6, 0)}
            subtext={`~${(expenseRate * 0.4 * 10000).toFixed(0)} bps annually`}
            accent="#888"
          />
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
  const [fundSize] = useState(500);
  const [fundIRR, setFundIRR] = useState(0.15); // LP's actual IRR
  const [carryRate, setCarryRate] = useState(0.20);
  const [hurdleRate, setHurdleRate] = useState(0.08);
  const [holdPeriod, setHoldPeriod] = useState(5);

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
      color: '#4ECDC4',
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
          color: '#4ECDC4',
          isIncrease: true,
          valueLabel: formatCurrency(prefReturn * 1e6, 0)
        });

        // Stage 3: GP Catch-up + Carry (shown together for simplicity)
        if (gpCarry > 0) {
          stages.push({
            label: 'GP Carry (20%)',
            value: gpCarry,
            cumulative: fundSize + prefReturn + gpCarry,
            color: '#FF6B6B',
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
            color: '#4ECDC4',
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
          color: '#4ECDC4',
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
    <section className="content-section">
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

        <div className="sliders-grid">
          <Slider
            value={fundIRR}
            onChange={setFundIRR}
            min={-0.05}
            max={0.30}
            step={0.005}
            label="Fund IRR (Gross)"
            format={(v) => formatPercent(v)}
            accent={fundIRR >= hurdleRate ? '#4ECDC4' : '#FF6B6B'}
          />

          <Slider
            value={hurdleRate}
            onChange={setHurdleRate}
            min={0}
            max={0.12}
            step={0.005}
            label="Hurdle Rate"
            format={(v) => formatPercent(v)}
            accent="#FFD93D"
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
            <span className="legend-color" style={{ backgroundColor: '#4ECDC4' }}></span>
            <span>To LPs</span>
          </div>
          <div className="legend-item">
            <span className="legend-color" style={{ backgroundColor: '#FF6B6B' }}></span>
            <span>To GP (Carry)</span>
          </div>
        </div>

        <div className="metrics-row">
          <MetricCard
            label="LP Net Multiple"
            value={`${netMultiple.toFixed(2)}x`}
            subtext={`${formatPercent(lpNetIRR)} net IRR`}
            accent="#4ECDC4"
          />
          <MetricCard
            label="GP Carry"
            value={formatCurrency(waterfallData.gpCarry * 1e6, 0)}
            subtext={waterfallData.hurdleCleared ? `${formatPercent(carryRate)} of profits` : 'Hurdle not met'}
            accent={waterfallData.gpCarry > 0 ? '#FF6B6B' : '#444'}
          />
          <MetricCard
            label="Gross Multiple"
            value={`${waterfallData.grossMultiple.toFixed(2)}x`}
            subtext={`${formatPercent(fundIRR)} gross IRR`}
            accent="#888"
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

const WaterfallComparisonSection = () => {
  const [fundSize] = useState(500);
  const [grossMultiple, setGrossMultiple] = useState(2.0);
  const [exitYear, setExitYear] = useState(5);

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
    <section className="content-section">
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
                accent="#4ECDC4"
              />
              <MetricCard
                label="GP Carry"
                value={formatCurrency(comparisonData.european.carry * 1e6, 0)}
                accent="#888"
              />
            </div>
          </div>

          <div className="comparison-column american">
            <h5>American Waterfall</h5>
            <div className="metric-stack">
              <MetricCard
                label="LP Net Multiple"
                value={`${comparisonData.american.multiple.toFixed(2)}x`}
                accent="#FF6B6B"
              />
              <MetricCard
                label="GP Carry"
                value={formatCurrency(comparisonData.american.carry * 1e6, 0)}
                accent="#888"
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

const FeeTradeoffSection = () => {
  const [grossMultiple, setGrossMultiple] = useState(2.0);
  const [fundLife, setFundLife] = useState(5);

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
      twoTwenty: { ...calcNet(0.02, 0.20), label: '2% / 20%', color: '#4ECDC4' },
      onePointFiveTwentyFive: { ...calcNet(0.015, 0.25), label: '1.5% / 25%', color: '#FFD93D' },
      oneThirty: { ...calcNet(0.01, 0.30), label: '1% / 30%', color: '#FF6B6B' }
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

  // Build comparison series
  const seriesData = useMemo(() => {
    const multiples = [];
    const net220 = [];
    const net130 = [];

    for (let m = 1.0; m <= 3.5; m += 0.1) {
      const fundSize = 100;
      const mgmtFees220 = fundSize * 0.02 * fundLife * 0.8;
      const mgmtFees130 = fundSize * 0.01 * fundLife * 0.8;

      const invested220 = fundSize - mgmtFees220;
      const invested130 = fundSize - mgmtFees130;

      const profit220 = Math.max(0, invested220 * m - fundSize);
      const profit130 = Math.max(0, invested130 * m - fundSize);

      multiples.push(m);
      net220.push((invested220 * m - profit220 * 0.20) / fundSize);
      net130.push((invested130 * m - profit130 * 0.30) / fundSize);
    }

    return { multiples, net220, net130 };
  }, [fundLife]);

  return (
    <section className="content-section">
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
  const [yearlyReturns, setYearlyReturns] = useState([0.15, 0.20, -0.10, 0.25, 0.15]);

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

  return (
    <section className="content-section">
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
                accent={ret >= 0 ? '#4ECDC4' : '#FF6B6B'}
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
          colorA="#4ECDC4"
          colorB="#FF6B6B"
        />

        <div className="metrics-row">
          <MetricCard
            label="Final NAV"
            value={formatCurrency(finalData.nav * 1e6, 0)}
          />
          <MetricCard
            label="LP Value"
            value={formatCurrency(finalData.lpValue * 1e6, 0)}
            subtext={`${(finalData.lpValue / 100).toFixed(2)}x`}
            accent="#4ECDC4"
          />
          <MetricCard
            label="Accrued Carry"
            value={formatCurrency(finalData.accruedCarry * 1e6, 0)}
            accent="#FF6B6B"
          />
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
  <section className="content-section conclusion">
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
  return (
    <div className="pe-fees-app">
      <style>{`
        /* Reset and base */
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }

        .pe-fees-app {
          font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
          background: #0a0a0f;
          color: #d4d4d4;
          min-height: 100vh;
          width: 100%;
          line-height: 1.7;
        }

        /* Header */
        .site-header {
          position: sticky;
          top: 0;
          z-index: 100;
          background: rgba(10, 10, 15, 0.95);
          backdrop-filter: blur(10px);
          border-bottom: 1px solid #1a1a2e;
          padding: 16px 40px;
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
          color: #4ECDC4;
        }

        .header-nav {
          display: flex;
          align-items: center;
          gap: 24px;
        }

        .nav-tagline {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 12px;
          color: #666;
          letter-spacing: 1px;
          text-transform: uppercase;
        }

        /* Master Dashboard */
        .master-dashboard {
          background: linear-gradient(180deg, #0f0f1a 0%, #0a0a0f 100%);
          padding: 60px 40px 40px;
          border-bottom: 1px solid #1a1a2e;
        }

        .dashboard-header {
          text-align: center;
          margin-bottom: 40px;
        }

        .dashboard-header h1 {
          font-size: clamp(32px, 5vw, 48px);
          font-weight: 300;
          color: #fff;
          margin-bottom: 12px;
          letter-spacing: -0.5px;
        }

        .dashboard-subtitle {
          font-size: 16px;
          color: #888;
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
          background: #1a1a2e;
          border-radius: 8px;
          padding: 20px;
        }

        .control-group-header {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: #4ECDC4;
          margin-bottom: 16px;
          padding-bottom: 8px;
          border-bottom: 1px solid #2a2a3a;
        }

        .dashboard-main {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .viz-container {
          background: #1a1a2e;
          border-radius: 8px;
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
          color: #fff;
          margin-bottom: 4px;
        }

        .viz-subtitle {
          font-size: 12px;
          color: #666;
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
          background: #1a1a2e;
          border-radius: 8px;
          padding: 16px;
        }

        .metric-group-header {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: #666;
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
          color: #888;
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
          color: #888;
          padding: 6px 0;
        }

        .metric-small.highlight {
          background: rgba(255, 255, 255, 0.03);
          margin: 0 -16px;
          padding: 8px 16px;
          border-radius: 4px;
        }

        .metric-divider {
          height: 1px;
          background: #2a2a3a;
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
          background: rgba(78, 205, 196, 0.15);
          border: 1px solid rgba(78, 205, 196, 0.3);
          color: #4ECDC4;
        }

        .hurdle-badge.not-cleared {
          background: rgba(255, 107, 107, 0.15);
          border: 1px solid rgba(255, 107, 107, 0.3);
          color: #FF6B6B;
        }

        .breakdown-transition {
          max-width: 700px;
          margin: 60px auto 0;
          text-align: center;
        }

        .transition-line {
          width: 60px;
          height: 2px;
          background: linear-gradient(90deg, #4ECDC4, #FFD93D);
          margin: 0 auto 30px;
        }

        .breakdown-transition h2 {
          font-size: 32px;
          font-weight: 300;
          color: #fff;
          margin-bottom: 16px;
        }

        .breakdown-transition p {
          font-size: 16px;
          color: #888;
          line-height: 1.7;
        }

        @media (max-width: 1100px) {
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
          background: linear-gradient(180deg, #0f0f1a 0%, #0a0a0f 100%);
          border-bottom: 1px solid #1a1a2e;
        }

        .pathway-badge {
          display: inline-block;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          letter-spacing: 2px;
          text-transform: uppercase;
          color: #4ECDC4;
          border: 1px solid #4ECDC4;
          padding: 6px 16px;
          margin-bottom: 30px;
        }

        .hero-section h1 {
          font-size: clamp(28px, 5vw, 48px);
          font-weight: 400;
          color: #fff;
          margin-bottom: 16px;
          letter-spacing: -0.5px;
        }

        .hero-subtitle {
          font-size: 18px;
          color: #888;
          max-width: 500px;
          margin: 0 auto 40px;
        }

        .hero-flow {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 20px;
          flex-wrap: wrap;
        }

        .flow-node {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 13px;
          padding: 12px 24px;
          border-radius: 4px;
          background: #1a1a2e;
          border: 1px solid #2a2a3a;
        }

        .flow-node.gross { border-color: #4ECDC4; color: #4ECDC4; }
        .flow-node.fees { border-color: #FF6B6B; color: #FF6B6B; }
        .flow-node.net { border-color: #4ECDC4; color: #4ECDC4; }

        .flow-arrow {
          color: #444;
          font-size: 24px;
        }

        /* Content Sections */
        .content-section {
          max-width: 900px;
          margin: 0 auto;
          padding: 60px 40px;
        }

        .content-section h2 {
          font-size: 28px;
          font-weight: 400;
          color: #fff;
          margin-bottom: 24px;
          padding-bottom: 12px;
          border-bottom: 1px solid #1a1a2e;
        }

        .content-section h3 {
          font-size: 20px;
          font-weight: 400;
          color: #fff;
          margin: 40px 0 16px;
        }

        .content-section p {
          margin-bottom: 20px;
          font-size: 17px;
        }

        .content-section strong {
          color: #fff;
        }

        .content-section em {
          color: #4ECDC4;
          font-style: normal;
        }

        /* Interactive Blocks */
        .interactive-block {
          background: #0f0f1a;
          border: 1px solid #1a1a2e;
          border-radius: 8px;
          padding: 24px;
          margin: 32px 0;
        }

        .block-header {
          margin-bottom: 24px;
        }

        .block-title {
          display: block;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 14px;
          font-weight: 500;
          color: #fff;
          margin-bottom: 4px;
        }

        .block-subtitle {
          font-size: 13px;
          color: #666;
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
          color: #888;
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
          background: #fff;
          cursor: pointer;
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        }

        .slider-input::-moz-range-thumb {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #fff;
          cursor: pointer;
          border: none;
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
          color: #888;
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
          border: 1px solid #2a2a3a;
          background: transparent;
          color: #888;
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
          color: #0a0a0f;
        }

        /* Terms Section */
        .terms-section {
          background: #1a1a2e;
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
          color: #4ECDC4;
          margin-bottom: 16px;
          padding-bottom: 8px;
          border-bottom: 1px solid #2a2a3a;
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
          border: 1px dashed #2a2a3a;
          border-radius: 6px;
          color: #888;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 13px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .assumptions-toggle:hover {
          border-color: #4ECDC4;
          color: #4ECDC4;
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
          color: #666;
          text-align: right;
          padding: 8px 10px;
          border-bottom: 1px solid #2a2a3a;
          white-space: nowrap;
        }

        .assumptions-table th:first-child {
          text-align: center;
        }

        .assumptions-table td {
          text-align: right;
          padding: 8px 10px;
          border-bottom: 1px solid #1a1a2e;
          color: #aaa;
        }

        .assumptions-table td:first-child {
          text-align: center;
          color: #666;
        }

        .assumptions-table tr.post-investment {
          background: rgba(78, 205, 196, 0.05);
        }

        .assumptions-table .basis-cell {
          text-align: left;
        }

        .assumptions-table .basis-label {
          display: block;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 9px;
          color: #666;
          text-transform: uppercase;
        }

        .assumptions-table .basis-value {
          color: #4ECDC4;
        }

        .assumptions-table .fee-cell {
          color: #FF6B6B;
        }

        .table-note {
          margin-top: 12px;
          font-size: 11px;
          color: #555;
          font-style: italic;
        }

        /* Metrics */
        .metrics-row {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 16px;
          margin-top: 24px;
        }

        .metric-card {
          background: #1a1a2e;
          padding: 16px;
          border-radius: 6px;
          text-align: center;
        }

        .metric-label {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 11px;
          color: #666;
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
          color: #666;
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
          color: #fff;
          margin-bottom: 8px;
        }

        .bar-label {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 10px;
          color: #666;
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
          color: #888;
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
          background: rgba(78, 205, 196, 0.1);
          border: 1px solid rgba(78, 205, 196, 0.3);
          color: #4ECDC4;
        }

        .hurdle-status.not-cleared {
          background: rgba(255, 107, 107, 0.1);
          border: 1px solid rgba(255, 107, 107, 0.3);
          color: #FF6B6B;
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
          background: #0f0f1a;
          border: 1px solid #1a1a2e;
          border-radius: 8px;
          padding: 24px;
        }

        .comparison-card h4 {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 14px;
          font-weight: 500;
          color: #fff;
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
          color: #888;
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

        .comparison-column.european h5 { color: #4ECDC4; }
        .comparison-column.american h5 { color: #FF6B6B; }

        .metric-stack {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .difference-callout {
          background: #1a1a2e;
          padding: 16px;
          border-radius: 6px;
          text-align: center;
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 14px;
        }

        .difference-callout .positive { color: #4ECDC4; }
        .difference-callout .negative { color: #FF6B6B; }

        /* Fee Structure Comparison */
        .structure-comparison {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
          margin: 24px 0;
        }

        .structure-card {
          background: #1a1a2e;
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
          color: #fff;
          margin-bottom: 8px;
        }

        .structure-breakdown {
          display: flex;
          flex-direction: column;
          gap: 2px;
          font-size: 11px;
          color: #666;
        }

        .crossover-indicator {
          background: #1a1a2e;
          border-radius: 8px;
          padding: 20px;
          text-align: center;
          margin-top: 24px;
        }

        .crossover-line {
          height: 2px;
          background: linear-gradient(90deg, #4ECDC4, #FF6B6B);
          margin-bottom: 16px;
        }

        .crossover-text strong {
          display: block;
          font-family: 'SF Mono', 'Monaco', monospace;
          font-size: 16px;
          color: #fff;
          margin-bottom: 8px;
        }

        .crossover-text p {
          font-size: 13px;
          color: #888;
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
          color: #666;
          text-transform: uppercase;
          margin-bottom: 8px;
        }

        /* Callouts */
        .callout {
          display: flex;
          gap: 16px;
          background: #1a1a2e;
          border-left: 3px solid #4ECDC4;
          padding: 20px;
          margin: 32px 0;
          border-radius: 0 8px 8px 0;
        }

        .callout-insight {
          border-left-color: #FFD93D;
        }

        .callout-icon {
          font-size: 24px;
          flex-shrink: 0;
        }

        .callout-content {
          font-size: 15px;
        }

        .callout-content strong {
          color: #4ECDC4;
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
          background: #1a1a2e;
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
          color: #fff;
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
          color: #fff;
        }

        .expense-desc {
          font-size: 11px;
          color: #666;
        }

        /* Conclusion */
        .conclusion {
          border-top: 1px solid #1a1a2e;
          margin-top: 40px;
        }

        .final-thought {
          background: linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 100%);
          border: 1px solid #2a2a3a;
          border-radius: 8px;
          padding: 32px;
          margin: 40px 0;
          text-align: center;
        }

        .final-thought p {
          font-size: 18px;
          color: #fff;
          margin: 0;
        }

        .pathway-footer {
          text-align: center;
          padding: 40px 0;
          border-top: 1px solid #1a1a2e;
          margin-top: 40px;
        }

        .pathway-logo {
          font-family: 'Helvetica Neue', sans-serif;
          font-size: 14px;
          letter-spacing: 3px;
          text-transform: uppercase;
          color: #4ECDC4;
          margin-bottom: 8px;
        }

        .pathway-footer p {
          font-size: 13px;
          color: #666;
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

          .hero-flow {
            flex-direction: column;
          }

          .flow-arrow {
            transform: rotate(90deg);
          }
        }
      `}</style>

      <Header />
      <MasterDashboard />
      <IntroSection />
      <ManagementFeeSection />
      <ExpensesSection />
      <CarrySection />
      <WaterfallComparisonSection />
      <FeeTradeoffSection />
      <AccruedCarrySection />
      <ConclusionSection />
    </div>
  );
}
