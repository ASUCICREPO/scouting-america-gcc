'use client';

import { useEffect, useState } from 'react';
import { getSummary, getConversations, getFaq, getFaqAll, SummaryData, ConversationPoint, FaqItem } from '../../lib/api';
import { TrendingUp, TrendingDown, Copy, Clock, Users, AlertTriangle, ChevronRight, ChevronLeft, X, Download } from 'lucide-react';

export default function OverviewPage() {
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [chartData, setChartData] = useState<ConversationPoint[]>([]);
  const [faqList, setFaqList] = useState<FaqItem[]>([]);
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showFaqModal, setShowFaqModal] = useState(false);
  const [allFaq, setAllFaq] = useState<FaqItem[]>([]);
  const [faqPage, setFaqPage] = useState(1);
  const [faqTotal, setFaqTotal] = useState(0);
  const FAQ_PER_PAGE = 30;

  useEffect(() => {
    loadData();
  }, [period]);

  async function loadData() {
    setLoading(true);
    setError('');
    try {
      const [summaryData, convData, faqData] = await Promise.all([
        getSummary(),
        getConversations(period),
        getFaq(5),
      ]);
      setSummary(summaryData);
      setChartData(convData.data);
      setFaqList(faqData.faq);
    } catch (err) {
      setError('Failed to connect to backend. Make sure the API server is running on port 3002.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function openFaqModal() {
    setShowFaqModal(true);
    setFaqPage(1);
    await loadFaqPage(1);
  }

  async function loadFaqPage(pageNum: number) {
    try {
      const offset = (pageNum - 1) * FAQ_PER_PAGE;
      const data = await getFaqAll(FAQ_PER_PAGE, offset);
      setAllFaq(data.faq);
      setFaqTotal(data.total);
      setFaqPage(pageNum);
    } catch (err) {
      console.error('Failed to load FAQ page:', err);
    }
  }

  const [showDateDropdown, setShowDateDropdown] = useState(false);
  const [dateRange, setDateRange] = useState<'7d' | '30d' | '90d' | 'today'>('7d');

  const dateRangeLabels: Record<string, string> = {
    'today': 'Today',
    '7d': 'Last 7 Days',
    '30d': 'Last 30 Days',
    '90d': 'Last 90 Days',
  };

  function handleDateChange(range: '7d' | '30d' | '90d' | 'today') {
    setDateRange(range);
    setShowDateDropdown(false);
    // Reload data — period stays the same but summary uses time window
    loadData();
  }

  function generateReport() {
    if (!summary || !faqList.length) return;
    const lines = [
      'GCC Admin Dashboard Report',
      `Generated: ${new Date().toISOString()}`,
      `Period: ${dateRangeLabels[dateRange]}`,
      '',
      'SUMMARY',
      `Total Chats,${summary.totalChats}`,
      `Total Sessions,${summary.totalSessions}`,
      `Active Users,${summary.totalUsers}`,
      `Avg Confidence,${summary.avgConfidence}`,
      `Avg Session Length,${summary.avgSessionLength}`,
      `Escalation Rate,${summary.escalationRate}%`,
      `Total Escalations,${summary.totalEscalations}`,
      '',
      'TOP FAQ',
      'Question,Occurrences,Avg Confidence',
      ...faqList.map(f => `"${f.question}",${f.count},${f.avgConfidence}`),
    ];
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gcc-dashboard-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Chart calculations
  const maxCount = Math.max(...chartData.map(d => d.count), 1);
  const chartWidth = 820;
  const chartHeight = 200;
  const points = chartData.map((item, i) => {
    const x = chartData.length > 1 ? (i / (chartData.length - 1)) * chartWidth : chartWidth / 2;
    const y = chartHeight - (item.count / maxCount) * chartHeight;
    return { x, y };
  });
  const linePath = points.length > 1
    ? `M ${points.map(p => `${p.x},${p.y}`).join(' L ')}`
    : '';
  const areaPath = linePath ? `${linePath} L ${chartWidth},${chartHeight} L 0,${chartHeight} Z` : '';

  if (loading && !summary) {
    return <div className="loading-state">Loading live data from DynamoDB...</div>;
  }

  if (error) {
    return <div className="error-state">{error}</div>;
  }

  return (
    <div className="overview-page">
      {/* Page Header */}
      <div className="overview-header">
        <div>
          <h1 className="overview-title">Overview</h1>
          <p className="overview-date">Live data from GCC Chatbot</p>
        </div>
        <div className="overview-actions">
          <div className="date-dropdown-wrapper">
            <button className="btn-outline" onClick={() => setShowDateDropdown(!showDateDropdown)}>
              <Clock size={12} />
              <span>{dateRangeLabels[dateRange]}</span>
            </button>
            {showDateDropdown && (
              <div className="date-dropdown">
                <button className={dateRange === 'today' ? 'active' : ''} onClick={() => handleDateChange('today')}>Today</button>
                <button className={dateRange === '7d' ? 'active' : ''} onClick={() => handleDateChange('7d')}>Last 7 Days</button>
                <button className={dateRange === '30d' ? 'active' : ''} onClick={() => handleDateChange('30d')}>Last 30 Days</button>
                <button className={dateRange === '90d' ? 'active' : ''} onClick={() => handleDateChange('90d')}>Last 90 Days</button>
              </div>
            )}
          </div>
          <button className="btn-primary" onClick={generateReport}>
            <Download size={12} />
            <span>Generate Report</span>
          </button>
        </div>
      </div>

      {/* Metric Cards */}
      <div className="metrics-grid">
        <MetricCard
          label="Total Sessions"
          value={summary?.totalSessions?.toLocaleString() || '0'}
          change={`${summary?.totalChats || 0} total chats`}
          icon={<Copy size={13} />}
          positive
        />
        <MetricCard
          label="Avg. Session Length"
          value={summary?.avgSessionLength || '0m 0s'}
          change="Across all sessions"
          icon={<Clock size={13} />}
          positive
        />
        <MetricCard
          label="Active Users"
          value={summary?.totalUsers?.toLocaleString() || '0'}
          change="Unique users"
          icon={<Users size={13} />}
          positive
        />
        <MetricCard
          label="Escalation Rate"
          value={`${summary?.escalationRate?.toFixed(1) || '0'}%`}
          change={`${summary?.totalEscalations || 0} total escalations`}
          icon={<AlertTriangle size={13} />}
          positive={false}
        />
      </div>

      {/* Conversation Volume Chart */}
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Conversation Volume</h2>
            <p className="card-subtitle">Live breakdown of chatbot usage over time</p>
          </div>
          <div className="toggle-group">
            <button className={`toggle-btn ${period === 'day' ? 'active' : ''}`} onClick={() => setPeriod('day')}>Daily</button>
            <button className={`toggle-btn ${period === 'week' ? 'active' : ''}`} onClick={() => setPeriod('week')}>Weekly</button>
            <button className={`toggle-btn ${period === 'month' ? 'active' : ''}`} onClick={() => setPeriod('month')}>Monthly</button>
          </div>
        </div>
        <div className="chart-container">
          {chartData.length > 1 ? (
            <svg viewBox="-40 -10 900 260" className="line-chart">
              {/* Y-axis labels */}
              {[0, 1, 2, 3, 4].map((i) => {
                const val = Math.round(maxCount - (maxCount / 4) * i);
                return (
                  <text key={i} x="-10" y={i * 50 + 5} textAnchor="end" className="chart-label">
                    {val}
                  </text>
                );
              })}
              <text x="-10" y="205" textAnchor="end" className="chart-label">0</text>
              {/* Grid lines */}
              {[0, 50, 100, 150, 200].map((y, i) => (
                <line key={i} x1="0" y1={y} x2={chartWidth} y2={y} stroke="#f0f3f9" strokeWidth="1" />
              ))}
              {/* Area fill */}
              <path d={areaPath} fill="url(#areaGradient)" />
              {/* Line */}
              <path d={linePath} fill="none" stroke="#005696" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              {/* Data points */}
              {points.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r="3" fill="#005696" />
              ))}
              {/* X-axis labels */}
              {chartData.map((item, i) => {
                if (chartData.length > 10 && i % 2 !== 0) return null;
                return (
                  <text key={i} x={points[i].x} y="230" textAnchor="middle" className="chart-label">
                    {item.date.length > 7 ? item.date.slice(5) : item.date}
                  </text>
                );
              })}
              <defs>
                <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#005696" stopOpacity="0.15" />
                  <stop offset="100%" stopColor="#005696" stopOpacity="0" />
                </linearGradient>
              </defs>
            </svg>
          ) : (
            <div className="chart-empty">Not enough data points for chart</div>
          )}
        </div>
      </div>

      {/* FAQ Table */}
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Frequently Asked Questions</h2>
            <p className="card-subtitle">Ranked by occurrence · live data</p>
          </div>
          <button className="link-btn" onClick={openFaqModal}>View all →</button>
        </div>
        <div className="faq-table">
          <div className="faq-header-row">
            <span className="faq-th faq-col-num">#</span>
            <span className="faq-th faq-col-question">Question</span>
            <span className="faq-th faq-col-occ">Occurrences</span>
            <span className="faq-th faq-col-trend">Confidence</span>
            <span className="faq-th faq-col-res">Resolution</span>
            <span className="faq-th faq-col-action" />
          </div>
          {faqList.length > 0 ? (
            faqList.map((item, i) => {
              const confPercent = Math.round(item.avgConfidence * 100);
              return (
                <div key={i} className="faq-row">
                  <span className="faq-td faq-col-num">{String(i + 1).padStart(2, '0')}</span>
                  <span className="faq-td faq-col-question">{item.question}</span>
                  <span className="faq-td faq-col-occ mono">{item.count.toLocaleString()}</span>
                  <span className={`faq-td faq-col-trend ${confPercent >= 70 ? 'positive' : 'negative'}`}>
                    {confPercent >= 70 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                    <span>{confPercent}%</span>
                  </span>
                  <span className="faq-td faq-col-res">
                    <div className="progress-bar">
                      <div className="progress-fill" style={{ width: `${confPercent}%` }} />
                    </div>
                    <span className="progress-label">{confPercent}%</span>
                  </span>
                  <span className="faq-td faq-col-action">
                    <button className="icon-btn"><ChevronRight size={14} /></button>
                  </span>
                </div>
              );
            })
          ) : (
            <div className="empty-state">No FAQ data yet</div>
          )}
        </div>
      </div>

      {/* FAQ Modal */}
      {showFaqModal && (
        <div className="modal-overlay" onClick={() => setShowFaqModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>All Frequently Asked Questions</h2>
              <button className="modal-close" onClick={() => setShowFaqModal(false)}><X size={20} /></button>
            </div>
            <div className="modal-body">
              <div className="faq-table">
                <div className="faq-header-row">
                  <span className="faq-th faq-col-num">#</span>
                  <span className="faq-th faq-col-question">Question</span>
                  <span className="faq-th faq-col-occ">Occurrences</span>
                  <span className="faq-th faq-col-trend">Confidence</span>
                  <span className="faq-th faq-col-res">Resolution</span>
                </div>
                {allFaq.map((item, i) => {
                  const confPercent = Math.round(item.avgConfidence * 100);
                  const globalIndex = (faqPage - 1) * FAQ_PER_PAGE + i + 1;
                  return (
                    <div key={i} className="faq-row">
                      <span className="faq-td faq-col-num">{String(globalIndex).padStart(2, '0')}</span>
                      <span className="faq-td faq-col-question">{item.question}</span>
                      <span className="faq-td faq-col-occ mono">{item.count.toLocaleString()}</span>
                      <span className={`faq-td faq-col-trend ${confPercent >= 70 ? 'positive' : 'negative'}`}>
                        {confPercent >= 70 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                        <span>{confPercent}%</span>
                      </span>
                      <span className="faq-td faq-col-res">
                        <div className="progress-bar">
                          <div className="progress-fill" style={{ width: `${confPercent}%` }} />
                        </div>
                        <span className="progress-label">{confPercent}%</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="modal-footer">
              <span className="pagination-info">Page {faqPage} of {Math.ceil(faqTotal / FAQ_PER_PAGE)} ({faqTotal} total)</span>
              <div className="pagination">
                <button className="page-btn" disabled={faqPage === 1} onClick={() => loadFaqPage(faqPage - 1)}><ChevronLeft size={16} /></button>
                {Array.from({ length: Math.min(Math.ceil(faqTotal / FAQ_PER_PAGE), 5) }, (_, i) => {
                  const p = i + 1;
                  return <button key={p} className={`page-btn ${p === faqPage ? 'active' : ''}`} onClick={() => loadFaqPage(p)}>{p}</button>;
                })}
                <button className="page-btn" disabled={faqPage >= Math.ceil(faqTotal / FAQ_PER_PAGE)} onClick={() => loadFaqPage(faqPage + 1)}><ChevronRight size={16} /></button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, change, icon, positive }: {
  label: string; value: string; change: string; icon: React.ReactNode; positive: boolean;
}) {
  return (
    <div className="metric-card">
      <div className="metric-header">
        <span className="metric-label">{label}</span>
        <div className="metric-icon-box">{icon}</div>
      </div>
      <p className="metric-value">{value}</p>
      <div className={`metric-change ${positive ? 'positive' : 'negative'}`}>
        {positive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
        <span>{change}</span>
      </div>
    </div>
  );
}
