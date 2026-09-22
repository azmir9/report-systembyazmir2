require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

// ============================================================
// DATABASE SETUP
// ============================================================
const db = new Database(path.join(__dirname, 'reports.db'));
db.pragma('journal_mode = WAL');

function addColumnIfMissing(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = columns.some((column) => column.name === columnName);

  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','worker')),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date TEXT NOT NULL,
    username TEXT NOT NULL,
    report INTEGER NOT NULL,
    details TEXT DEFAULT '',
    payment_details TEXT DEFAULT '',
    updated_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS report_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER,
    action TEXT NOT NULL,
    old_values TEXT,
    new_values TEXT,
    changed_by TEXT,
    changed_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_reports_date_user
    ON reports(report_date, username);
`);

addColumnIfMissing('reports', 'details', 'TEXT DEFAULT ""');
addColumnIfMissing('reports', 'payment_details', 'TEXT DEFAULT ""');
addColumnIfMissing('reports', 'updated_by', 'TEXT');

function logReportAudit({ reportId, action, oldValues, newValues, changedBy }) {
  db.prepare(`
    INSERT INTO report_audit_log (report_id, action, old_values, new_values, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    reportId ?? null,
    action,
    oldValues === null || oldValues === undefined ? null : JSON.stringify(oldValues),
    newValues === null || newValues === undefined ? null : JSON.stringify(newValues),
    changedBy || null
  );
}

function ensureDefaultUsers() {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  );

  insert.run('Admin', bcrypt.hashSync('azmir99', 10), 'admin');
  insert.run('worker', bcrypt.hashSync('azmir1122', 10), 'worker');

  // Keep the documented local accounts usable when the database already exists.
  db.prepare('UPDATE users SET password_hash = ?, role = ?, updated_at = CURRENT_TIMESTAMP WHERE LOWER(username) = LOWER(?)')
    .run(bcrypt.hashSync('azmir99', 10), 'admin', 'Admin');
  db.prepare('UPDATE users SET password_hash = ?, role = ?, updated_at = CURRENT_TIMESTAMP WHERE LOWER(username) = LOWER(?)')
    .run(bcrypt.hashSync('azmir1122', 10), 'worker', 'worker');

  const adminUser = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get('Admin');
  if (adminUser && adminUser.role !== 'admin') {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', adminUser.id);
  }

  const workerUser = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get('worker');
  if (workerUser && workerUser.role !== 'worker') {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('worker', workerUser.id);
  }
}

ensureDefaultUsers();

console.log('\n✅ Default users available:');
console.log('   Admin  → Admin / azmir99');
console.log('   Worker → worker / azmir1122\n');

// ============================================================
// SESSIONS (in-memory)
// ============================================================
const sessions = new Map();

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, expires: Date.now() + 86400000 });
  return token;
}

function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s;
}

// ============================================================
// EXPRESS APP
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// MIDDLEWARE
// ============================================================
function requireAuth(req, res, next) {
  const token = req.cookies.session;
  const s = getSession(token);
  if (!s) return res.status(401).json({ error: 'Not logged in' });
  req.user = s.user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const normalizedUsername = String(username).trim();
  const user = db.prepare(
    'SELECT * FROM users WHERE LOWER(username) = LOWER(?)'
  ).get(normalizedUsername);

  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = createSession({
    id: user.id,
    username: user.username,
    role: user.role
  });

  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 86400000
  });

  res.json({
    user: { id: user.id, username: user.username, role: user.role }
  });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  sessions.delete(req.cookies.session);
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ============================================================
// REPORT ROUTES
// ============================================================

app.get('/api/reports', requireAuth, (req, res) => {
  const { date, username } = req.query;

  if (!date) {
    return res.status(400).json({ error: 'Date is required' });
  }

  let rows;

  if (username && username.trim()) {
    rows = db.prepare(
      `SELECT id, report_date, username, report, details, payment_details, updated_by, created_at, updated_at
       FROM reports
       WHERE report_date = ? AND LOWER(username) = LOWER(?)
       ORDER BY id ASC`
    ).all(date, username.trim());
  } else {
    rows = db.prepare(
      `SELECT id, report_date, username, report, details, payment_details, updated_by, created_at, updated_at
       FROM reports
       WHERE report_date = ?
       ORDER BY username ASC, id ASC`
    ).all(date);
  }

  if (rows.length === 0) {
    return res.json({
      success: true,
      reports: [],
      message: 'No Reports Found'
    });
  }

  res.json({
    success: true,
    reports: rows,
    message: 'Reports loaded'
  });
});

app.get('/api/reports/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  const report = db.prepare(
    `SELECT id, report_date, username, report, details, payment_details, updated_by, created_at, updated_at
     FROM reports WHERE id = ?`
  ).get(id);

  if (!report) {
    return res.status(404).json({ error: 'Report not found' });
  }

  res.json({ success: true, report });
});

app.get('/api/admin/reports', requireAuth, requireAdmin, (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';

  let rows;
  if (date) {
    rows = db.prepare(
      `SELECT id, report_date, username, report, details, payment_details, updated_by, created_at, updated_at
       FROM reports
       WHERE report_date = ?
       ORDER BY username ASC, id ASC`
    ).all(date);
  } else {
    rows = db.prepare(
      `SELECT id, report_date, username, report, details, payment_details, updated_by, created_at, updated_at
       FROM reports
       ORDER BY report_date DESC, username ASC, id ASC`
    ).all();
  }

  res.json({
    success: true,
    reports: rows,
    message: rows.length ? 'Reports loaded' : 'No Report Found'
  });
});

app.get('/api/admin/daily-leads', requireAuth, requireAdmin, (req, res) => {
  const selectedDate = typeof req.query.date === 'string' ? req.query.date.trim() : '';

  if (selectedDate) {
    const row = db.prepare(
      `SELECT COALESCE(SUM(report), 0) AS total_leads, COUNT(*) AS report_count
       FROM reports WHERE report_date = ?`
    ).get(selectedDate);

    if (Number(row.report_count) === 0) {
      return res.json({
        success: true,
        date: selectedDate,
        total_leads: 0,
        report_count: 0,
        hasReports: false,
        message: 'No Report Found',
        history: []
      });
    }

    return res.json({
      success: true,
      date: selectedDate,
      total_leads: Number(row.total_leads || 0),
      report_count: Number(row.report_count || 0),
      hasReports: true,
      message: 'Reports loaded',
      history: [{ report_date: selectedDate, total_leads: Number(row.total_leads || 0) }]
    });
  }

  const history = db.prepare(
    `SELECT report_date, COALESCE(SUM(report), 0) AS total_leads
     FROM reports
     GROUP BY report_date
     ORDER BY report_date DESC`
  ).all();

  res.json({
    success: true,
    total_leads: history.reduce((sum, row) => sum + Number(row.total_leads || 0), 0),
    date: null,
    hasReports: history.length > 0,
    message: history.length ? 'Reports loaded' : 'No Report Found',
    history: history.map((row) => ({
      report_date: row.report_date,
      total_leads: Number(row.total_leads || 0)
    }))
  });
});

app.post('/api/reports', requireAuth, requireAdmin, (req, res) => {
  const { report_date, date, username, report, details, payment_details } = req.body || {};
  const finalDate = report_date || date;
  const trimmedUsername = String(username || '').trim();
  const leadValue = Number(report);

  if (!finalDate || !/^\d{4}-\d{2}-\d{2}$/.test(finalDate)) {
    return res.status(400).json({ error: 'Valid date required (YYYY-MM-DD)' });
  }

  if (!trimmedUsername) {
    return res.status(400).json({ error: 'Username is required' });
  }

  if (!Number.isFinite(leadValue) || leadValue < 0) {
    return res.status(400).json({ error: 'Report value must be a valid number' });
  }

  const insert = db.prepare(`
    INSERT INTO reports (report_date, username, report, details, payment_details, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  const info = insert.run(
    finalDate,
    trimmedUsername,
    leadValue,
    details != null ? String(details) : '',
    payment_details != null ? String(payment_details) : '',
    req.user.username
  );

  const createdReport = db.prepare(
    `SELECT * FROM reports WHERE id = ?`
  ).get(info.lastInsertRowid);

  logReportAudit({
    reportId: info.lastInsertRowid,
    action: 'create',
    oldValues: null,
    newValues: createdReport,
    changedBy: req.user.username
  });

  res.json({ success: true, report: createdReport, message: 'Report added' });
});

app.post('/api/admin/reports', requireAuth, requireAdmin, (req, res) => {
  const { report_date, date, username, report, details, payment_details } = req.body || {};
  const finalDate = report_date || date;
  const trimmedUsername = String(username || '').trim();
  const leadValue = Number(report);

  if (!finalDate || !/^\d{4}-\d{2}-\d{2}$/.test(finalDate)) {
    return res.status(400).json({ error: 'Valid date required (YYYY-MM-DD)' });
  }

  if (!trimmedUsername) {
    return res.status(400).json({ error: 'Username is required' });
  }

  if (!Number.isFinite(leadValue) || leadValue < 0) {
    return res.status(400).json({ error: 'Report value must be a valid number' });
  }

  const insert = db.prepare(`
    INSERT INTO reports (report_date, username, report, details, payment_details, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  const info = insert.run(
    finalDate,
    trimmedUsername,
    leadValue,
    details != null ? String(details) : '',
    payment_details != null ? String(payment_details) : '',
    req.user.username
  );

  const createdReport = db.prepare(
    `SELECT * FROM reports WHERE id = ?`
  ).get(info.lastInsertRowid);

  logReportAudit({
    reportId: info.lastInsertRowid,
    action: 'create',
    oldValues: null,
    newValues: createdReport,
    changedBy: req.user.username
  });

  res.json({ success: true, report: createdReport, message: 'Report added' });
});

app.post('/api/reports/import', requireAuth, requireAdmin, (req, res) => {
  const { date, text, mode } = req.body || {};

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Valid date required (YYYY-MM-DD)' });
  }

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Report text required' });
  }

  const lines = text.split('\n');
  const parsed = [];
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 2) {
      errors.push(`Line ${i + 1}: invalid format → "${line}"`);
      continue;
    }

    const username = parts[0].trim();
    const reportStr = parts[parts.length - 1].trim();
    const reportNum = Number(reportStr);

    if (!username) {
      errors.push(`Line ${i + 1}: empty username`);
      continue;
    }

    if (!Number.isFinite(reportNum)) {
      errors.push(`Line ${i + 1}: invalid number → "${reportStr}"`);
      continue;
    }

    parsed.push({ username, report: reportNum });
  }

  if (parsed.length === 0) {
    return res.status(400).json({
      error: 'No valid reports found',
      errors
    });
  }

  const existingCount = db.prepare(
    'SELECT COUNT(*) AS c FROM reports WHERE report_date = ?'
  ).get(date).c;

  if (existingCount > 0 && mode !== 'replace' && mode !== 'add') {
    return res.status(409).json({
      needsConfirm: true,
      existing: existingCount,
      parsed: parsed.length,
      message: `Reports already exist for ${date}. Do you want to replace them?`
    });
  }

  const insertStmt = db.prepare(
    `INSERT INTO reports (report_date, username, report, details, payment_details, updated_by)
     VALUES (?, ?, ?, '', '', ?)`
  );

  const tx = db.transaction(() => {
    if (mode === 'replace') {
      db.prepare('DELETE FROM reports WHERE report_date = ?').run(date);
    }
    for (const p of parsed) {
      const info = insertStmt.run(date, p.username, p.report, req.user.username);
      const created = db.prepare('SELECT * FROM reports WHERE id = ?').get(info.lastInsertRowid);
      logReportAudit({
        reportId: info.lastInsertRowid,
        action: 'create',
        oldValues: null,
        newValues: created,
        changedBy: req.user.username
      });
    }
  });

  try {
    tx();
  } catch (err) {
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }

  res.json({
    success: true,
    imported: parsed.length,
    replaced: mode === 'replace' ? existingCount : 0,
    date,
    errors: errors.length ? errors : undefined
  });
});

app.put('/api/reports/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { username, report, date, report_date, details, payment_details } = req.body || {};

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  const existing = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Report not found' });
  }

  const finalDate = report_date || date || existing.report_date;
  const newUser = username != null ? String(username).trim() : existing.username;
  const newReport = report != null ? Number(report) : existing.report;
  const nextDetails = details != null ? String(details) : existing.details || '';
  const nextPaymentDetails = payment_details != null ? String(payment_details) : existing.payment_details || '';

  if (!finalDate || !/^\d{4}-\d{2}-\d{2}$/.test(finalDate)) {
    return res.status(400).json({ error: 'Valid date required (YYYY-MM-DD)' });
  }

  if (!newUser) {
    return res.status(400).json({ error: 'Username cannot be empty' });
  }
  if (!Number.isFinite(newReport) || newReport < 0) {
    return res.status(400).json({ error: 'Report must be a positive number' });
  }

  const updatedValues = {
    ...existing,
    report_date: finalDate,
    username: newUser,
    report: newReport,
    details: nextDetails,
    payment_details: nextPaymentDetails,
    updated_by: req.user.username,
    updated_at: new Date().toISOString()
  };

  db.prepare(
    `UPDATE reports
     SET report_date = ?, username = ?, report = ?, details = ?, payment_details = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(finalDate, newUser, newReport, nextDetails, nextPaymentDetails, req.user.username, id);

  logReportAudit({
    reportId: id,
    action: 'update',
    oldValues: existing,
    newValues: updatedValues,
    changedBy: req.user.username
  });

  res.json({ ok: true, report: updatedValues });
});

app.delete('/api/reports/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  const existing = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Report not found' });
  }

  db.prepare('DELETE FROM reports WHERE id = ?').run(id);
  logReportAudit({
    reportId: id,
    action: 'delete',
    oldValues: existing,
    newValues: null,
    changedBy: req.user.username
  });

  res.json({ ok: true, deleted: id });
});

app.delete('/api/reports/date/:date', requireAuth, requireAdmin, (req, res) => {
  const date = req.params.date;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  const rows = db.prepare('SELECT * FROM reports WHERE report_date = ?').all(date);
  const info = db.prepare('DELETE FROM reports WHERE report_date = ?').run(date);

  rows.forEach((row) => {
    logReportAudit({
      reportId: row.id,
      action: 'delete',
      oldValues: row,
      newValues: null,
      changedBy: req.user.username
    });
  });

  res.json({ ok: true, deleted: info.changes });
});

app.listen(PORT, () => {
  console.log(`\n✅ Server running: http://localhost:${PORT}\n`);
});
