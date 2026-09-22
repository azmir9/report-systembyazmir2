let currentUser = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Request failed (${response.status})`);
    Object.assign(error, data);
    throw error;
  }

  return data;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function showMessage(id, text, type = '') {
  const element = document.getElementById(id);
  if (!element) return;
  element.className = `message ${type}`;
  element.textContent = text;
}

function formatNumber(value) {
  const safeValue = Number(value || 0);
  return safeValue.toLocaleString('en-US');
}

function renderReports(id, data) {
  const target = document.getElementById(id);
  if (!target) return;

  if (!data.reports || !data.reports.length) {
    target.innerHTML = '<div class="message">No Reports Found</div>';
    return;
  }

  const groups = data.reports.reduce((map, report) => {
    (map[report.username] ||= []).push(report);
    return map;
  }, {});

  target.innerHTML = Object.entries(groups).map(([username, reports]) => `
    <div class="result-card">
      <strong>${escapeHtml(username)} · ${escapeHtml(reports[0].report_date)}</strong>
      ${reports.map(report => `<div class="report-line">${escapeHtml(report.report)}</div>`).join('')}
    </div>
  `).join('');
}

function renderDailyLeadSummary(data) {
  const summaryEl = document.getElementById('dailyLeadSummary');
  const historyEl = document.getElementById('adminLeadHistory');

  if (!summaryEl || !historyEl) return;

  if (!data || !data.hasReports) {
    summaryEl.innerHTML = '<div class="lead-empty">No Report Found</div>';
    historyEl.innerHTML = '<div class="history-empty">No Report Found</div>';
    return;
  }

  const totalLeads = Number(data.total_leads || 0);
  const selectedDate = data.date || '—';
  summaryEl.innerHTML = `
    <div class="lead-label">${escapeHtml(selectedDate)}</div>
    <div class="lead-value">${formatNumber(totalLeads)}</div>
    <div class="lead-caption">Total Leads</div>
  `;

  const rows = Array.isArray(data.history) && data.history.length ? data.history : [{ report_date: selectedDate, total_leads: totalLeads }];
  historyEl.innerHTML = `
    <div class="history-row history-header">
      <span>Date</span>
      <span>Total Leads</span>
    </div>
    ${rows.map((entry) => `
      <div class="history-row">
        <span>${escapeHtml(entry.report_date)}</span>
        <span>${formatNumber(entry.total_leads)}</span>
      </div>
    `).join('')}
  `;
}

async function loadAdminDailyLeads(date = document.getElementById('adminDate')?.value || todayISO()) {
  if (!currentUser || currentUser.role !== 'admin') return;

  const summaryEl = document.getElementById('dailyLeadSummary');
  if (summaryEl) summaryEl.innerHTML = '<div class="lead-empty">Loading...</div>';

  try {
    const data = await api(`/api/admin/daily-leads?date=${encodeURIComponent(date)}`);
    renderDailyLeadSummary(data);
  } catch (error) {
    if (summaryEl) summaryEl.innerHTML = `<div class="lead-empty">${escapeHtml(error.message)}</div>`;
  }
}

function renderAdminReportTable(rows) {
  const container = document.getElementById('adminReportTable');
  if (!container) return;

  if (!rows.length) {
    container.innerHTML = '<div class="table-empty">No Report Found</div>';
    return;
  }

  container.innerHTML = `
    <div class="table-wrap">
      <table class="report-management-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Worker</th>
            <th>Leads</th>
            <th>Details</th>
            <th>Payment</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((report) => `
            <tr>
              <td>${escapeHtml(report.report_date)}</td>
              <td>${escapeHtml(report.username)}</td>
              <td>${formatNumber(report.report)}</td>
              <td>${escapeHtml(report.report_details || report.details || '') || '—'}</td>
              <td>${escapeHtml(report.payment_info || report.payment_details || '') || '—'}</td>
              <td class="action-cell">
                <button type="button" class="table-action view" data-report-action="view" data-report-id="${report.id}">View</button>
                <button type="button" class="table-action edit" data-report-action="edit" data-report-id="${report.id}">Edit</button>
                <button type="button" class="table-action delete" data-report-action="delete" data-report-id="${report.id}">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function loadAdminReportManager(date = document.getElementById('adminManagementDate')?.value || todayISO()) {
  if (!currentUser || currentUser.role !== 'admin') return;

  const container = document.getElementById('adminReportTable');
  if (container) container.innerHTML = '<div class="table-empty">Loading...</div>';

  try {
    const data = await api(`/api/admin/reports?date=${encodeURIComponent(date)}`);
    renderAdminReportTable(Array.isArray(data.reports) ? data.reports : []);
  } catch (error) {
    if (container) container.innerHTML = `<div class="table-empty">${escapeHtml(error.message)}</div>`;
  }
}

function openReportModal(mode, report = null) {
  const modal = document.getElementById('reportModal');
  const form = document.getElementById('reportForm');
  const title = document.getElementById('reportModalTitle');
  const saveBtn = document.getElementById('saveReportBtn');

  if (!modal || !form) return;

  const isView = mode === 'view';
  const date = report ? (report.report_date || report.date || todayISO()) : (document.getElementById('adminDate')?.value || todayISO());

  document.getElementById('reportModalId').value = report ? String(report.id) : '';
  document.getElementById('reportDate').value = date;
  document.getElementById('reportUsername').value = report ? (report.username || '') : '';
  document.getElementById('reportLead').value = report ? (report.report ?? '') : '';
  document.getElementById('reportDetails').value = report ? (report.report_details || report.details || '') : '';
  document.getElementById('reportPayment').value = report ? (report.payment_info || report.payment_details || '') : '';
  form.dataset.mode = mode;

  const fields = document.querySelectorAll('#reportForm input, #reportForm textarea');
  fields.forEach((field) => {
    field.disabled = isView;
  });

  title.textContent = mode === 'edit' ? 'Edit Report' : mode === 'view' ? 'View Report' : 'Add Report';
  saveBtn.textContent = mode === 'edit' ? 'Update Report' : mode === 'view' ? 'Close' : 'Save Report';
  saveBtn.classList.toggle('hidden', isView);
  modal.classList.remove('hidden');
}

function closeReportModal() {
  const modal = document.getElementById('reportModal');
  if (modal) modal.classList.add('hidden');
  showMessage('reportModalMessage', '', '');
}

async function submitReportModal(event) {
  event.preventDefault();

  const mode = document.getElementById('reportForm').dataset.mode || 'add';
  if (mode === 'view') {
    closeReportModal();
    return;
  }

  const id = document.getElementById('reportModalId').value;
  const payload = {
    date: document.getElementById('reportDate').value,
    username: document.getElementById('reportUsername').value.trim(),
    report: document.getElementById('reportLead').value,
    details: document.getElementById('reportDetails').value,
    payment_details: document.getElementById('reportPayment').value
  };

  if (!payload.date || !payload.username || payload.report === '' || Number(payload.report) < 0 || !Number.isFinite(Number(payload.report))) {
    showMessage('reportModalMessage', 'Date, worker name, and valid lead count are required.', 'error');
    return;
  }

  try {
    if (mode === 'edit' && id) {
      await api(`/api/reports/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showMessage('reportModalMessage', 'Report updated successfully.', 'success');
    } else {
      await api('/api/admin/reports', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showMessage('reportModalMessage', 'Report added successfully.', 'success');
    }

    const nextDate = payload.date;
    document.getElementById('adminDate').value = nextDate;
    document.getElementById('adminManagementDate').value = nextDate;
    loadAdminDailyLeads(nextDate);
    loadAdminReportManager(nextDate);
    closeReportModal();
  } catch (error) {
    showMessage('reportModalMessage', error.message, 'error');
  }
}

async function handleTableAction(action, id) {
  if (action === 'delete') {
    const confirmed = window.confirm('Are you sure you want to delete this report?');
    if (!confirmed) return;

    try {
      await api(`/api/reports/${id}`, { method: 'DELETE' });
      const selectedDate = document.getElementById('adminManagementDate').value || todayISO();
      loadAdminDailyLeads(selectedDate);
      loadAdminReportManager(selectedDate);
    } catch (error) {
      showMessage('reportModalMessage', error.message, 'error');
    }
    return;
  }

  try {
    const data = await api(`/api/reports/${id}`);
    if (action === 'view' || action === 'edit') {
      document.getElementById('reportForm').dataset.mode = action;
      openReportModal(action, data.report);
    }
  } catch (error) {
    showMessage('reportModalMessage', error.message, 'error');
  }
}

async function login() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;

  if (!username || !password) {
    showMessage('loginMsg', 'Enter username and password.', 'error');
    return;
  }

  const button = document.getElementById('loginBtn');
  button.disabled = true;

  try {
    currentUser = (await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    })).user;
    enterApp();
  } catch (error) {
    showMessage('loginMsg', error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {}
  currentUser = null;
  document.getElementById('appView').classList.add('hidden');
  document.getElementById('loginView').classList.remove('hidden');
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  showMessage('loginMsg', '', '');
}

function showSection(name) {
  document.querySelectorAll('.section').forEach((section) => section.classList.remove('active'));
  const target = document.getElementById(name);
  if (target) target.classList.add('active');

  document.querySelectorAll('.tabs button').forEach((button) => {
    button.classList.toggle('active', button.id === `tab${name[0].toUpperCase()}${name.slice(1)}`);
  });

  if (name === 'admin' && currentUser && currentUser.role === 'admin') {
    const date = document.getElementById('adminDate')?.value || todayISO();
    document.getElementById('adminManagementDate').value = date;
    loadAdminDailyLeads(date);
    loadAdminReportManager(date);
  }
}

function enterApp() {
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');
  document.getElementById('currentUser').textContent = currentUser.username;
  document.getElementById('currentRole').textContent = currentUser.role;

  const today = todayISO();
  document.getElementById('workerDate').value = today;
  document.getElementById('adminDate').value = today;
  document.getElementById('adminManagementDate').value = today;

  document.getElementById('tabAdmin').classList.toggle('hidden', currentUser.role !== 'admin');
  if (currentUser.role === 'admin') {
    loadAdminDailyLeads(today);
    loadAdminReportManager(today);
    showSection('admin');
  } else {
    showSection('worker');
  }
}

async function searchReports(dateId, usernameId, resultId) {
  const date = document.getElementById(dateId).value;
  const username = document.getElementById(usernameId).value.trim();

  if (!date || !username) {
    showMessage(resultId, 'Select a date and enter a username.', 'error');
    return;
  }

  document.getElementById(resultId).textContent = 'Searching...';

  try {
    renderReports(resultId, await api(`/api/reports?date=${encodeURIComponent(date)}&username=${encodeURIComponent(username)}`));
  } catch (error) {
    showMessage(resultId, error.message, 'error');
  }
}

async function importReports(mode) {
  const date = document.getElementById('adminDate').value;
  const text = document.getElementById('reportText').value.trim();

  if (!date || !text) {
    showMessage('importMessage', 'Select a date and paste reports.', 'error');
    return;
  }

  const button = document.getElementById('importBtn');
  button.disabled = true;

  try {
    const data = await api('/api/reports/import', {
      method: 'POST',
      body: JSON.stringify({ date, text, mode })
    });

    document.getElementById('reportText').value = '';
    showMessage('importMessage', `${data.imported} reports imported for ${data.date}.`, 'success');
    loadAdminDailyLeads(date);
    loadAdminReportManager(date);
  } catch (error) {
    if (error.needsConfirm && confirm(`${error.message}\n\nChoose OK to replace the existing reports, or Cancel to keep them.`)) {
      await importReports('replace');
    } else if (!error.needsConfirm) {
      showMessage('importMessage', error.message, 'error');
    }
  } finally {
    button.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const loginBtn = document.getElementById('loginBtn');
  const loginPass = document.getElementById('loginPass');
  const adminDate = document.getElementById('adminDate');
  const adminManagementDate = document.getElementById('adminManagementDate');

  loginBtn.addEventListener('click', login);
  loginPass.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') login();
  });

  document.getElementById('tabWorker').addEventListener('click', () => showSection('worker'));
  document.getElementById('tabAdmin').addEventListener('click', () => {
    if (currentUser && currentUser.role === 'admin') showSection('admin');
  });

  document.getElementById('workerSearch').addEventListener('click', () => searchReports('workerDate', 'workerUsername', 'workerResult'));
  document.getElementById('adminSearch').addEventListener('click', () => searchReports('adminDate', 'adminUsername', 'adminResult'));
  document.getElementById('importBtn').addEventListener('click', () => importReports());
  document.getElementById('addReportBtn').addEventListener('click', () => {
    document.getElementById('reportForm').dataset.mode = 'add';
    openReportModal('add');
  });
  document.getElementById('closeReportModal').addEventListener('click', closeReportModal);
  document.getElementById('cancelReportModal').addEventListener('click', closeReportModal);
  document.getElementById('reportForm').addEventListener('submit', submitReportModal);

  if (adminDate) {
    adminDate.addEventListener('change', () => {
      if (currentUser && currentUser.role === 'admin') {
        const selected = adminDate.value;
        document.getElementById('adminManagementDate').value = selected;
        loadAdminDailyLeads(selected);
        loadAdminReportManager(selected);
      }
    });
  }

  if (adminManagementDate) {
    adminManagementDate.addEventListener('change', () => {
      if (currentUser && currentUser.role === 'admin') {
        const selected = adminManagementDate.value;
        document.getElementById('adminDate').value = selected;
        loadAdminDailyLeads(selected);
        loadAdminReportManager(selected);
      }
    });
  }

  document.getElementById('adminReportTable').addEventListener('click', (event) => {
    const button = event.target.closest('[data-report-action]');
    if (!button) return;
    const id = Number(button.dataset.reportId);
    const action = button.dataset.reportAction;
    if (Number.isFinite(id)) handleTableAction(action, id);
  });

  try {
    currentUser = (await api('/api/auth/me')).user;
    enterApp();
  } catch {}
});

