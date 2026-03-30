/**
 * Sita Retail Dashboards — App Controller
 * Matches Cita / Budget Air report design.
 * Fetches Retell AI data and renders the live dashboard.
 */

(function () {
  'use strict';

  // ---- Configuration ----
  const CONFIG = {
    dataUrl: 'data/demo.json',
    sheetsUrl: 'data/sheets_widget.json',
    refreshInterval: 60000,
    clientName: '',
    primaryColor: '',
  };

  // ---- Per-client password hashes (SHA-256) ----
  // To add a new client: generate hash with:  echo -n "password" | shasum -a 256
  // or use the browser console:  crypto.subtle.digest('SHA-256', new TextEncoder().encode('password')).then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('')))
  const PASSWORD_HASHES = {
    // Budget Heating, Cooling, and Plumbing — password: CitaBudget2026!
    'default': 'a78095b990fc3e3b0734d1962b6fc42f11f52f1181a02b6d0123050163db6214',
  };

  // ---- State ----
  let dashboardData = null;
  let activePeriod = 'today';

  // ---- Auth ----
  async function sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  function isAuthenticated() {
    return sessionStorage.getItem('cita_auth') === 'true';
  }

  function showLoginScreen() {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('dashboard-header').style.display = 'none';
    document.querySelector('.client-banner').style.display = 'none';
    document.getElementById('dashboard').style.display = 'none';
    document.querySelector('.footer').style.display = 'none';
    document.getElementById('loading-overlay').classList.add('hidden');
  }

  function hideLoginScreen() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('dashboard-header').style.display = '';
    document.querySelector('.client-banner').style.display = '';
    document.getElementById('dashboard').style.display = '';
    document.querySelector('.footer').style.display = '';
  }

  function bindLoginForm() {
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('login-password').value;
      const hash = await sha256(pw);

      // Check against client-specific hash or default
      const clientKey = CONFIG.clientName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'default';
      const validHash = PASSWORD_HASHES[clientKey] || PASSWORD_HASHES['default'];

      if (hash === validHash) {
        sessionStorage.setItem('cita_auth', 'true');
        document.getElementById('login-error').style.display = 'none';
        hideLoginScreen();
        fetchData();
        staggerFadeUps();
      } else {
        document.getElementById('login-error').style.display = 'block';
        document.getElementById('login-password').value = '';
        document.getElementById('login-password').focus();
      }
    });
  }

  // ---- Init ----
  function init() {
    parseUrlParams();
    bindLoginForm();
    bindEvents();

    if (isAuthenticated()) {
      hideLoginScreen();
      fetchData();
      staggerFadeUps();
    } else {
      showLoginScreen();
    }

    if (CONFIG.refreshInterval > 0) {
      setInterval(() => {
        if (isAuthenticated()) fetchData();
      }, CONFIG.refreshInterval);
    }
  }

  function parseUrlParams() {
    const p = new URLSearchParams(window.location.search);
    if (p.get('data')) CONFIG.dataUrl = p.get('data');
    if (p.get('sheets')) CONFIG.sheetsUrl = p.get('sheets');
    if (p.get('client')) CONFIG.clientName = p.get('client');
    if (p.get('refresh')) CONFIG.refreshInterval = parseInt(p.get('refresh')) * 1000;
  }

  function staggerFadeUps() {
    document.querySelectorAll('.fade-up').forEach((el) => {
      const delay = parseFloat(el.style.animationDelay) || 0;
      el.style.animationDelay = delay + 's';
    });
  }

  function bindEvents() {
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activePeriod = btn.dataset.period;
        if (dashboardData) renderDashboard(dashboardData);
      });
    });
    document.getElementById('error-retry').addEventListener('click', fetchData);
  }

  // ---- Data Fetching ----
  async function fetchData() {
    try {
      const res = await fetch(CONFIG.dataUrl + '?t=' + Date.now());
      if (!res.ok) throw new Error('HTTP ' + res.status);

      dashboardData = await res.json();
      renderDashboard(dashboardData);
      hideLoading();
      hideError();
      updateTimestamp();

      if (CONFIG.sheetsUrl) fetchSheetsData();
    } catch (err) {
      console.error('Data fetch failed:', err);
      hideLoading();
      showError('Unable to load dashboard data.');
    }
  }

  async function fetchSheetsData() {
    try {
      const res = await fetch(CONFIG.sheetsUrl + '?t=' + Date.now());
      if (!res.ok) return;
      const data = await res.json();
      renderSheetsWidget(data);
    } catch (err) {
      console.error('Sheets fetch failed:', err);
    }
  }

  // ---- Period Filtering ----
  function filterByPeriod(calls) {
    if (!calls || !calls.length) return calls;
    const now = new Date();
    let cutoff;
    switch (activePeriod) {
      case 'today':
        cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case '7d':
        cutoff = new Date(now.getTime() - 7 * 86400000);
        break;
      case '30d': default:
        return calls;
    }
    return calls.filter(c => new Date(c.timestamp) >= cutoff);
  }

  function computeFilteredStats(calls) {
    if (!calls || !calls.length) {
      return { total_calls: 0, avg_duration_seconds: 0, success_rate_pct: 0,
        sentiment: { positive: 0, neutral: 0, negative: 0, positive_pct: 0, neutral_pct: 0, negative_pct: 0 },
        disconnection_reasons: {}, direction: { inbound: 0, outbound: 0, inbound_pct: 0, outbound_pct: 0 },
        cost: { total: 0, avg_per_call: 0, by_product: {} },
        voicemail: { count: 0, pct: 0 }, successful_calls: 0, failed_calls: 0,
        custom_analysis: {}, daily_volume: {} };
    }
    const total = calls.length;
    const avgD = calls.reduce((s, c) => s + (c.duration_seconds || 0), 0) / total;
    const succ = calls.filter(c => c.successful).length;
    const pos = calls.filter(c => c.sentiment === 'Positive').length;
    const neu = calls.filter(c => c.sentiment === 'Neutral').length;
    const neg = calls.filter(c => c.sentiment === 'Negative').length;

    // Disconnection
    const disc = {};
    calls.forEach(c => { const r = c.disconnection_reason || 'unknown'; disc[r] = (disc[r] || 0) + 1; });

    // Direction
    const inb = calls.filter(c => c.direction === 'inbound').length;
    const outb = calls.filter(c => c.direction === 'outbound').length;

    // Cost
    const totalCost = calls.reduce((s, c) => s + (c.cost || 0), 0);

    // Voicemail
    const vm = calls.filter(c => c.in_voicemail).length;

    // Daily volume
    const dv = {};
    calls.forEach(c => {
      if (c.timestamp) { const d = c.timestamp.split('T')[0]; dv[d] = (dv[d] || 0) + 1; }
    });

    return {
      total_calls: total,
      avg_duration_seconds: Math.round(avgD * 10) / 10,
      success_rate_pct: Math.round(succ / total * 1000) / 10,
      successful_calls: succ,
      failed_calls: total - succ,
      sentiment: {
        positive: pos, neutral: neu, negative: neg,
        positive_pct: Math.round(pos / total * 1000) / 10,
        neutral_pct: Math.round(neu / total * 1000) / 10,
        negative_pct: Math.round(neg / total * 1000) / 10,
      },
      disconnection_reasons: disc,
      direction: {
        inbound: inb, outbound: outb,
        inbound_pct: total ? Math.round(inb / total * 1000) / 10 : 0,
        outbound_pct: total ? Math.round(outb / total * 1000) / 10 : 0,
      },
      cost: { total: Math.round(totalCost * 100) / 100, avg_per_call: Math.round(totalCost / total * 100) / 100, by_product: {} },
      voicemail: { count: vm, pct: total ? Math.round(vm / total * 1000) / 10 : 0 },
      custom_analysis: {},
      daily_volume: dv,
    };
  }

  function getStatsForPeriod() {
    switch (activePeriod) {
      case 'today': return dashboardData.stats_today || dashboardData.stats;
      case '7d': return dashboardData.stats_7d || dashboardData.stats;
      case '30d': default: return dashboardData.stats;
    }
  }

  // ---- Main Render ----
  function renderDashboard(data) {
    const stats = getStatsForPeriod();
    renderHero(stats);
    renderStats(stats);
    renderInsights(stats);
    renderTransfer(stats);
    renderCustomAnalysis(stats);
    renderVolumeChart(stats);
    renderCallLog(data.recent_calls);
  }

  // ---- Hero Section ----
  function renderHero(stats) {
    animateCounter('hero-total-calls', stats.total_calls, '', 0);

    const avgSec = stats.avg_duration_seconds || 0;
    const mins = Math.floor(avgSec / 60);
    const secs = Math.round(avgSec % 60);
    const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    document.getElementById('hero-avg-duration').textContent = durationStr;

    document.getElementById('hero-success-rate').textContent = stats.success_rate_pct + '%';

    const trendEl = document.getElementById('hero-trend-text');
    if (stats.total_calls > 0) {
      trendEl.textContent = `↑ ${stats.total_calls.toLocaleString()} calls handled · ${stats.success_rate_pct}% successful`;
    } else {
      trendEl.textContent = 'No calls in this period';
    }
  }

  // ---- Stat Cards ----
  function renderStats(stats) {
    document.getElementById('stat-calls').textContent = stats.total_calls.toLocaleString();
    document.getElementById('stat-calls-sub').textContent = activePeriod === 'today' ? 'Today' : activePeriod === '7d' ? 'Last 7 days' : 'Last 30 days';
    document.getElementById('stat-success').textContent = stats.success_rate_pct + '%';
    
    const avgSec = stats.avg_duration_seconds || 0;
    const mins = Math.floor(avgSec / 60);
    const secs = Math.round(avgSec % 60);
    document.getElementById('stat-duration').textContent = mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `0:${String(secs).padStart(2, '0')}`;

    const posPct = stats.sentiment ? stats.sentiment.positive_pct : 0;
    document.getElementById('stat-sentiment').textContent = posPct + '%';
  }

  // ---- Insights (Sentiment + Disconnection + Outcomes) ----
  function renderInsights(stats) {
    if (!stats || !stats.total_calls) return;
    const total = stats.total_calls;

    // Sentiment bars
    const s = stats.sentiment || {};
    const posPct = s.positive_pct || 0;
    const neuPct = s.neutral_pct || 0;
    const negPct = s.negative_pct || 0;

    document.getElementById('bar-positive').style.width = posPct + '%';
    document.getElementById('bar-neutral').style.width = neuPct + '%';
    document.getElementById('bar-negative').style.width = negPct + '%';
    document.getElementById('val-positive').textContent = posPct + '%';
    document.getElementById('val-neutral').textContent = neuPct + '%';
    document.getElementById('val-negative').textContent = negPct + '%';
    document.getElementById('sentiment-note').textContent =
      `${Math.round(posPct + neuPct)}% of callers had a positive or neutral experience.`;

    // Disconnection bars (dynamically generated)
    const discEl = document.getElementById('disconnection-bars');
    const disc = stats.disconnection_reasons || {};
    const discColors = {
      'call_transfer': 'var(--teal)', 'user_hangup': 'var(--amber)',
      'agent_hangup': 'var(--accent)', 'inactivity': 'var(--text-dim)',
      'voicemail_reached': 'var(--blue)', 'error_retell': 'var(--red)',
    };
    const discLabels = {
      'call_transfer': 'Call Transfer', 'user_hangup': 'Caller Hung Up',
      'agent_hangup': 'Agent Ended', 'inactivity': 'Inactivity',
      'voicemail_reached': 'Voicemail', 'error_retell': 'Error',
    };
    const sortedDisc = Object.entries(disc).sort((a, b) => b[1] - a[1]);
    discEl.innerHTML = sortedDisc.map(([reason, count]) => {
      const pct = Math.round(count / total * 100);
      const color = discColors[reason] || 'var(--text-dim)';
      const label = discLabels[reason] || reason.replace(/_/g, ' ');
      return `<div class="bar-row">
        <span class="b-label">${escapeHtml(label)}</span>
        <div class="b-track"><div class="b-fill" style="width:${pct}%;background:${color};"></div></div>
        <span class="b-val">${pct}%</span>
      </div>`;
    }).join('');
    const topReason = sortedDisc[0];
    document.getElementById('disconnection-note').textContent =
      topReason ? `${Math.round(topReason[1] / total * 100)}% of calls ended via ${(discLabels[topReason[0]] || topReason[0]).toLowerCase()}.` : '';

    // Outcomes
    document.getElementById('outcome-success').textContent = (stats.successful_calls || 0).toLocaleString();
    document.getElementById('outcome-fail').textContent = (stats.failed_calls || 0).toLocaleString();
    document.getElementById('outcome-voicemail').textContent = stats.voicemail ? stats.voicemail.count : '0';
    document.getElementById('outcome-cost').textContent = stats.cost ? '$' + stats.cost.avg_per_call.toFixed(2) : '—';
  }

  // ---- Call Transfer Panel ----
  function renderTransfer(stats) {
    const disc = stats.disconnection_reasons || {};
    const transfers = disc.call_transfer || 0;
    const total = stats.total_calls || 0;
    const rate = total ? Math.round(transfers / total * 1000) / 10 : 0;

    document.getElementById('transfer-count').textContent = transfers.toLocaleString();
    document.getElementById('transfer-rate').textContent = rate + '%';
    document.getElementById('bar-transfer').style.width = rate + '%';
    document.getElementById('transfer-note').textContent =
      total ? `${transfers.toLocaleString()} of ${total.toLocaleString()} calls were transferred to a live agent.` : 'No calls in this period';
  }

  // ---- Custom Analysis Panel ----
  function renderCustomAnalysis(stats) {
    const el = document.getElementById('custom-analysis-bars');
    const ca = stats.custom_analysis || {};
    // Show call_status first, then other fields
    const fieldOrder = ['call_status', 'maintenance_interest'];
    let html = '';
    const colours = ['var(--accent)', 'var(--teal)', 'var(--amber)', 'var(--green)', 'var(--red)', 'var(--blue)'];

    fieldOrder.forEach(field => {
      const vals = ca[field];
      if (!vals) return;
      const total = Object.values(vals).reduce((s, v) => s + v, 0);
      const sorted = Object.entries(vals).sort((a, b) => b[1] - a[1]);
      html += `<div style="margin-bottom:12px;"><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:8px;">${escapeHtml(field.replace(/_/g, ' '))}</div>`;
      sorted.forEach(([val, count], i) => {
        const pct = Math.round(count / total * 100);
        html += `<div class="bar-row">
          <span class="b-label">${escapeHtml(val.replace(/_/g, ' '))}</span>
          <div class="b-track"><div class="b-fill" style="width:${pct}%;background:${colours[i % colours.length]};"></div></div>
          <span class="b-val">${pct}%</span>
        </div>`;
      });
      html += '</div>';
    });
    el.innerHTML = html || '<p style="color:var(--text-dim);font-size:13px;">No custom analysis data</p>';
  }

  // ---- Daily Call Counts Grid ----
  function renderVolumeChart(stats) {
    const el = document.getElementById('daily-counts-grid');
    const dv = stats.daily_volume || {};
    const dates = Object.keys(dv).sort();
    if (!dates.length) {
      el.innerHTML = '<p style="color:var(--text-dim);font-size:13px;text-align:center;padding:20px;">No call data for this period</p>';
      return;
    }
    // Fill in all days between first and last date
    const start = new Date(dates[0]);
    const end = new Date(dates[dates.length - 1]);
    const allDays = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().split('T')[0];
      allDays.push({ date: key, count: dv[key] || 0, dayObj: new Date(d) });
    }
    const entries = allDays.slice(-30);
    const maxVal = Math.max(...entries.map(e => e.count), 1);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    el.innerHTML = entries.map(({ date, count, dayObj }) => {
      const dayName = dayNames[dayObj.getDay()];
      const dateLabel = date.slice(5); // MM-DD
      let tier = 'zero';
      if (count > 0 && count <= maxVal * 0.25) tier = 'low';
      else if (count > maxVal * 0.25 && count <= maxVal * 0.5) tier = 'mid';
      else if (count > maxVal * 0.5 && count <= maxVal * 0.8) tier = 'high';
      else if (count > maxVal * 0.8) tier = 'peak';

      return `<div class="day-count-tile ${tier}">
        <div class="day-date">${dateLabel}</div>
        <div class="day-name">${dayName}</div>
        <div class="day-num">${count}</div>
      </div>`;
    }).join('');
  }

  // ---- Call Log Table ----
  function renderCallLog(calls) {
    const tbody = document.getElementById('call-table-body');
    const countEl = document.getElementById('call-count');

    if (!calls || !calls.length) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><p>No calls recorded for this period</p></div></td></tr>';
      countEl.textContent = '0 calls';
      return;
    }

    countEl.textContent = `${calls.length} call${calls.length !== 1 ? 's' : ''}`;

    tbody.innerHTML = calls.map(call => {
      const t = formatCallTime(call.timestamp);
      const sentClass = (call.sentiment || 'neutral').toLowerCase();
      const statusClass = call.successful ? 'success' : 'failed';
      const statusText = call.successful ? '✓ Successful' : '✗ Unsuccessful';
      const dirClass = (call.direction || 'inbound').toLowerCase();
      const dirLabel = dirClass === 'inbound' ? 'IN' : 'OUT';

      return `<tr>
        <td><div class="call-time">${t.time}<span class="date">${t.date}</span></div></td>
        <td><span class="dir-badge ${dirClass}">${dirLabel}</span></td>
        <td><span class="call-duration">${call.duration}</span></td>
        <td><span class="sentiment-tag ${sentClass}">${getSentimentEmoji(call.sentiment)} ${call.sentiment || 'Unknown'}</span></td>
        <td><span class="status-tag ${statusClass}">${statusText}</span></td>
        <td><span class="call-summary">${escapeHtml(call.summary || '—')}</span></td>
      </tr>`;
    }).join('');
  }

  // ---- Sheets Widget ----
  function renderSheetsWidget(data) {
    if (!data) return;

    // Render hero widgets from totals (Appointments + Revenue)
    if (data.totals) {
      if (data.totals.appointments_booked !== undefined) {
        animateCounter('hero-appointments', data.totals.appointments_booked, '', 0);
        document.getElementById('hero-appt-trend').textContent =
          `↑ ${data.totals.appointments_booked} appointments booked by AI`;
      }
      if (data.totals.revenue_generated !== undefined) {
        animateCurrency('hero-revenue', data.totals.revenue_generated);
        document.getElementById('hero-revenue-trend').textContent =
          `↑ $${data.totals.revenue_generated.toLocaleString()} closed revenue`;
      }
    }

    // Render table if rows exist
    if (!data.headers || !data.rows || !data.rows.length) return;

    const section = document.getElementById('sheets-section');
    const thead = document.getElementById('sheets-thead');
    const tbody = document.getElementById('sheets-tbody');

    section.style.display = 'block';
    thead.innerHTML = '<tr>' + data.headers.map(h => '<th>' + escapeHtml(h) + '</th>').join('') + '</tr>';
    tbody.innerHTML = data.rows.map(row =>
      '<tr>' + data.headers.map(h => '<td>' + escapeHtml(row[h] || '—') + '</td>').join('') + '</tr>'
    ).join('');
  }

  // ---- Counter Animation ----
  function animateCounter(elementId, target, suffix, decimals) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const duration = 1400;
    const start = Date.now();

    function tick() {
      const p = Math.min((Date.now() - start) / duration, 1);
      const e = 1 - Math.pow(1 - p, 3);
      const current = e * target;
      el.textContent = (decimals > 0 ? current.toFixed(decimals) : Math.round(current).toLocaleString()) + (suffix || '');
      if (p < 1) requestAnimationFrame(tick);
    }
    tick();
  }

  function animateCurrency(elementId, target) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const duration = 1400;
    const start = Date.now();

    function tick() {
      const p = Math.min((Date.now() - start) / duration, 1);
      const e = 1 - Math.pow(1 - p, 3);
      const current = Math.round(e * target);
      el.textContent = '$' + current.toLocaleString();
      if (p < 1) requestAnimationFrame(tick);
    }
    tick();
  }

  // ---- Helpers ----
  function formatCallTime(timestamp) {
    if (!timestamp) return { time: '—', date: '' };
    const d = new Date(timestamp);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    return {
      time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      date: isToday ? 'Today' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
    };
  }

  function getSentimentEmoji(s) {
    switch ((s || '').toLowerCase()) {
      case 'positive': return '😊';
      case 'neutral': return '😐';
      case 'negative': return '😞';
      default: return '❓';
    }
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function updateTimestamp() {
    const el = document.getElementById('last-updated');
    const now = new Date();
    el.textContent = 'Updated ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('footer-generated').textContent =
      'Live Dashboard · ' + now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function hideLoading() {
    document.getElementById('loading-overlay').classList.add('hidden');
  }

  function showError(msg) {
    document.getElementById('error-message').textContent = msg;
    document.getElementById('error-toast').style.display = 'flex';
  }

  function hideError() {
    document.getElementById('error-toast').style.display = 'none';
  }

  // ---- Boot ----
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
