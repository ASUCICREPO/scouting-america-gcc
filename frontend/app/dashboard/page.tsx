'use client';

import { useEffect, useState } from 'react';
import { getSummary, getConversations, getFaq, getFeedbackConversations, getSessionTranscript, SummaryData, ConversationPoint, FaqItem, FeedbackConversation, SessionTurn, FeedbackValue } from '@/lib/dashboard/api';
import MarkdownContent from '@/components/MarkdownContent';
import { TrendingUp, TrendingDown, Copy, Clock, AlertTriangle, ChevronLeft, ChevronRight, X, Download, Eye, ThumbsUp, ThumbsDown } from 'lucide-react';

function truncate(text: string, n: number): string {
  if (!text) return '';
  return text.length > n ? text.slice(0, n) + '…' : text;
}

export default function OverviewPage() {
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [chartData, setChartData] = useState<ConversationPoint[]>([]);
  const [faqList, setFaqList] = useState<FaqItem[]>([]);
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Conversation feedback table
  const [feedback, setFeedback] = useState<FeedbackConversation[]>([]);
  const [feedbackFilter, setFeedbackFilter] = useState<'all' | FeedbackValue>('all');
  const [feedbackPage, setFeedbackPage] = useState(0);
  const [feedbackTotal, setFeedbackTotal] = useState(0);
  const FEEDBACK_PER_PAGE = 10;

  // Session transcript modal (opened via the eye icon)
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [sessionTurns, setSessionTurns] = useState<SessionTurn[]>([]);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);

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

  // Reload the feedback table when the filter or page changes.
  useEffect(() => {
    loadFeedback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedbackFilter, feedbackPage]);

  async function loadFeedback() {
    try {
      const data = await getFeedbackConversations(feedbackFilter, FEEDBACK_PER_PAGE, feedbackPage * FEEDBACK_PER_PAGE);
      setFeedback(data.conversations);
      setFeedbackTotal(data.total);
    } catch (err) {
      console.error('Failed to load feedback:', err);
    }
  }

  // Open the full session transcript and highlight the rated turn.
  async function openSession(sessionId: string, messageId: string) {
    setOpenSessionId(sessionId);
    setHighlightId(messageId);
    setSessionLoading(true);
    setSessionTurns([]);
    try {
      const data = await getSessionTranscript(sessionId);
      setSessionTurns(data.turns);
    } catch (err) {
      console.error('Failed to load session:', err);
    } finally {
      setSessionLoading(false);
    }
  }

  function closeSession() {
    setOpenSessionId(null);
    setHighlightId(null);
    setSessionTurns([]);
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

  // Chart pagination — window size based on period
  const [chartPage, setChartPage] = useState(0);

  const WINDOW_SIZES: Record<string, number> = { day: 7, week: 4, month: 6 };
  const windowSize = WINDOW_SIZES[period] || 7;

  // Reset page when period changes
  useEffect(() => { setChartPage(0); }, [period]);

  // Calculate windowed chart data
  const totalPages = Math.ceil(chartData.length / windowSize);
  // chartPage 0 = latest data (rightmost), negative = older
  const startIdx = Math.max(0, chartData.length - windowSize * (chartPage + 1));
  const endIdx = chartData.length - windowSize * chartPage;
  const windowedData = chartData.slice(startIdx, endIdx);

  const canGoBack = endIdx < chartData.length; // there's older data
  const canGoForward = chartPage > 0; // we're looking at older data

  // Chart calculations on windowed data
  const maxCount = Math.max(...windowedData.map(d => d.count), 1);
  const chartWidth = 820;
  const chartHeight = 200;
  const points = windowedData.map((item, i) => {
    const x = windowedData.length > 1 ? (i / (windowedData.length - 1)) * chartWidth : chartWidth / 2;
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
          label="Total Conversations"
          value={summary?.totalSessions?.toLocaleString() || '0'}
          change={`+${summary?.totalChats || 0} today`}
          icon={<Copy size={13} />}
          positive
        />
        <MetricCard
          label="Total Upvotes"
          value={summary?.positiveCount?.toLocaleString() || '0'}
          change={`${summary?.satisfactionRate?.toFixed(0) || 0}% satisfaction`}
          icon={<TrendingUp size={13} />}
          positive
        />
        <MetricCard
          label="Total Downvotes"
          value={summary?.negativeCount?.toLocaleString() || '0'}
          change={`${summary?.totalFeedback || 0} total feedback`}
          icon={<TrendingDown size={13} />}
          positive={false}
        />
        <MetricCard
          label="Escalations"
          value={summary?.totalEscalations?.toLocaleString() || '0'}
          change=""
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
        <div className="chart-with-arrows">
          <button className="chart-side-arrow left" disabled={!canGoBack} onClick={() => setChartPage(p => p + 1)}>
            <ChevronLeft size={18} />
          </button>
          <div className="chart-container">
          {windowedData.length > 1 ? (
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
              {windowedData.map((item, i) => {
                if (windowedData.length > 10 && i % 2 !== 0) return null;
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
          <button className="chart-side-arrow right" disabled={!canGoForward} onClick={() => setChartPage(p => p - 1)}>
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {/* Conversation Feedback Table */}
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Conversation Feedback</h2>
            <p className="card-subtitle">Responses volunteers rated · click the eye to open the full chat</p>
          </div>
          <div className="fb-filter-group">
            {(['all', 'positive', 'negative'] as const).map(f => (
              <button
                key={f}
                className={`toggle-btn ${feedbackFilter === f ? 'active' : ''}`}
                onClick={() => { setFeedbackFilter(f); setFeedbackPage(0); }}
              >
                {f === 'all' ? 'All' : f === 'positive' ? 'Upvoted' : 'Downvoted'}
              </button>
            ))}
          </div>
        </div>
        <div className="fb-table">
          <div className="fb-header-row">
            <span className="fb-th fb-col-num">#</span>
            <span className="fb-th fb-col-question">Question</span>
            <span className="fb-th fb-col-feedback">Feedback</span>
            <span className="fb-th fb-col-date">Date</span>
            <span className="fb-th fb-col-action" />
          </div>
          {feedback.length > 0 ? (
            feedback.map((conv, i) => (
              <div key={`${conv.sessionId}-${conv.messageId}`} className="fb-row">
                <span className="fb-td fb-col-num">{String(feedbackPage * FEEDBACK_PER_PAGE + i + 1).padStart(2, '0')}</span>
                <span className="fb-td fb-col-question" title={conv.question}>{truncate(conv.question, 80)}</span>
                <span className="fb-td fb-col-feedback">
                  <span className={`fb-badge ${conv.feedback}`}>
                    {conv.feedback === 'positive'
                      ? <><ThumbsUp size={11} /> Up</>
                      : <><ThumbsDown size={11} /> Down</>}
                  </span>
                </span>
                <span className="fb-td fb-col-date">
                  {new Date(conv.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="fb-td fb-col-action">
                  <button className="icon-btn" title="View conversation" onClick={() => openSession(conv.sessionId, conv.messageId)}>
                    <Eye size={15} />
                  </button>
                </span>
              </div>
            ))
          ) : (
            <div className="empty-state">No feedback yet</div>
          )}
        </div>
        {feedbackTotal > FEEDBACK_PER_PAGE && (
          <div className="pagination" style={{ padding: '14px 0' }}>
            <button className="page-btn" disabled={feedbackPage === 0} onClick={() => setFeedbackPage(p => Math.max(0, p - 1))}><ChevronLeft size={16} /></button>
            <span className="pagination-info">
              {feedbackPage * FEEDBACK_PER_PAGE + 1}–{Math.min((feedbackPage + 1) * FEEDBACK_PER_PAGE, feedbackTotal)} of {feedbackTotal}
            </span>
            <button className="page-btn" disabled={(feedbackPage + 1) * FEEDBACK_PER_PAGE >= feedbackTotal} onClick={() => setFeedbackPage(p => p + 1)}><ChevronRight size={16} /></button>
          </div>
        )}
      </div>

      {/* Session Transcript Modal */}
      {openSessionId && (
        <div className="modal-overlay" onClick={closeSession}>
          <div className="modal-content session-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Conversation</h2>
                <p className="card-subtitle">Session {openSessionId.slice(0, 12)}… · the highlighted response received the feedback</p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={closeSession}
                aria-label="Close conversation"
                title="Close conversation"
              >
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              {sessionLoading ? (
                <div className="empty-state">Loading conversation…</div>
              ) : sessionTurns.length > 0 ? (
                <div className="session-thread">
                  {sessionTurns.map((turn) => {
                    const isHighlight = turn.messageId === highlightId;
                    return (
                      <div key={turn.messageId} className={`session-turn ${isHighlight ? 'highlight' : ''}`}>
                        <div className="session-msg user">
                          <div className="session-bubble user">{turn.question}</div>
                        </div>
                        <div className="session-msg assistant">
                          <div className="session-bubble assistant">
                            <MarkdownContent content={turn.answer} className="session-answer ai-response-body" />
                            {isHighlight && turn.feedback && (
                              <span className={`fb-badge ${turn.feedback}`}>
                                {turn.feedback === 'positive'
                                  ? <><ThumbsUp size={11} /> Upvoted</>
                                  : <><ThumbsDown size={11} /> Downvoted</>}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-state">No messages found for this session</div>
              )}
            </div>
            <div className="modal-footer">
              <span className="pagination-info">{sessionTurns.length} message{sessionTurns.length === 1 ? '' : 's'}</span>
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
