/**
 * ============================================================================
 * SpendWise Central SQLite Backend Server (server.js)
 * Single SQLite Database Engine for Multi-User & Multi-Device Synchronization
 * ============================================================================
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'spendwise.db');
const PUBLIC_DIR = __dirname;

// ============================================================================
// 1. SQLITE DATABASE SETUP & SCHEMA
// ============================================================================
const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for high concurrency and Foreign Keys for user data integrity
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Create Users table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Create Sessions table (persistent cross-device auth tokens)
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Create Transactions table (strictly isolated by foreign key user_id)
db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT NOT NULL,
    date TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Performance indexes
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
`);

// Helper: SHA-256 password hash
function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

// Seed demo users if empty database
function seedDatabaseIfEmpty() {
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users;').get().count;
  if (userCount > 0) return;

  console.log('Seeding demo accounts (alex & sarah) into central SQLite database...');
  const defaultPasswordHash = hashPassword('password123');

  const insertUser = db.prepare('INSERT INTO users (username, password) VALUES (?, ?);');
  insertUser.run('alex', defaultPasswordHash);   // ID: 1
  insertUser.run('sarah', defaultPasswordHash);  // ID: 2

  const insertTx = db.prepare(`
    INSERT INTO transactions (user_id, type, description, amount, category, date)
    VALUES (?, ?, ?, ?, ?, ?);
  `);

  // Alex starter data (User 1)
  insertTx.run(1, 'income', 'Software Engineer Salary', 4800.00, 'salary', '2026-10-01');
  insertTx.run(1, 'expense', 'Luxury Apartment Rent', 1600.00, 'housing', '2026-10-02');
  insertTx.run(1, 'expense', 'Whole Foods Market', 165.40, 'food', '2026-10-06');
  insertTx.run(1, 'expense', 'High-Speed Internet & Power', 120.00, 'utilities', '2026-10-10');
  insertTx.run(1, 'income', 'Freelance Mobile App Milestone', 1100.00, 'freelance', '2026-10-18');

  // Sarah starter data (User 2)
  insertTx.run(2, 'income', 'Marketing Lead Salary', 4200.00, 'salary', '2026-10-01');
  insertTx.run(2, 'expense', 'Co-op Studio Lease', 1350.00, 'housing', '2026-10-03');
  insertTx.run(2, 'expense', 'Art Studio Supplies & Books', 145.25, 'shopping', '2026-10-07');
  insertTx.run(2, 'income', 'Graphic Design Commission', 650.00, 'freelance', '2026-10-15');
  insertTx.run(2, 'expense', 'Acoustic Concert Tickets', 85.00, 'entertainment', '2026-10-21');

  console.log('Demo accounts seeded successfully.');
}

seedDatabaseIfEmpty();

// ============================================================================
// 2. HTTP SERVER & REQUEST HELPERS
// ============================================================================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.sqlite': 'application/x-sqlite3',
  '.db': 'application/x-sqlite3'
};

function sendJson(res, statusCode, data, isHead = false) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  if (isHead) return res.end();
  res.end(payload);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { // 1MB limit
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Authentication middleware
function getAuthenticatedUser(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  try {
    const session = db.prepare(`
      SELECT u.id, u.username
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ?
    `).get(token);
    return session || null;
  } catch (err) {
    console.error('Session verification error:', err);
    return null;
  }
}

// ============================================================================
// 3. REQUEST ROUTER
// ============================================================================
const server = http.createServer(async (req, res) => {
  // Global CORS preflight handler
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  try {
    // ------------------------------------------------------------------------
    // API ROUTE: GET /api/health
    // ------------------------------------------------------------------------
    if (pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(res, 200, {
        status: 'ok',
        engine: 'SQLite3 Central Server',
        database: path.basename(DB_PATH),
        time: new Date().toISOString()
      }, req.method === 'HEAD');
    }

    // ------------------------------------------------------------------------
    // API ROUTE: POST /api/auth/register
    // ------------------------------------------------------------------------
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const username = (body.username || '').trim().toLowerCase();
      const password = body.password || '';

      if (!username || username.length < 2) {
        return sendJson(res, 400, { error: 'Username must be at least 2 characters.' });
      }
      if (!password || password.length < 4) {
        return sendJson(res, 400, { error: 'Password must be at least 4 characters.' });
      }

      // Check username uniqueness
      const existingUser = db.prepare('SELECT id FROM users WHERE username = ?;').get(username);
      if (existingUser) {
        return sendJson(res, 409, { error: `Username "${username}" is already taken.` });
      }

      const hashedPassword = hashPassword(password);
      const insertUserStmt = db.prepare('INSERT INTO users (username, password) VALUES (?, ?);');
      const userResult = insertUserStmt.run(username, hashedPassword);
      const userId = Number(userResult.lastInsertRowid);

      // Create session token
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?);').run(token, userId);

      return sendJson(res, 201, {
        ok: true,
        user: { id: userId, username },
        token
      });
    }

    // ------------------------------------------------------------------------
    // API ROUTE: POST /api/auth/login
    // ------------------------------------------------------------------------
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const username = (body.username || '').trim().toLowerCase();
      const password = body.password || '';

      if (!username || !password) {
        return sendJson(res, 400, { error: 'Username and password are required.' });
      }

      const hashedPassword = hashPassword(password);
      const user = db.prepare('SELECT id, username, password FROM users WHERE username = ?;').get(username);

      if (!user || user.password !== hashedPassword) {
        return sendJson(res, 401, { error: 'Invalid username or password.' });
      }

      // Create session token
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?);').run(token, user.id);

      return sendJson(res, 200, {
        ok: true,
        user: { id: user.id, username: user.username },
        token
      });
    }

    // ------------------------------------------------------------------------
    // API ROUTE: GET /api/auth/me
    // ------------------------------------------------------------------------
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Unauthorized. Please sign in.' });
      }
      return sendJson(res, 200, { ok: true, user });
    }

    // ------------------------------------------------------------------------
    // API ROUTE: POST /api/auth/logout
    // ------------------------------------------------------------------------
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim();
        db.prepare('DELETE FROM sessions WHERE token = ?;').run(token);
      }
      return sendJson(res, 200, { ok: true, message: 'Logged out successfully' });
    }

    // ------------------------------------------------------------------------
    // API ROUTE: GET /api/metrics
    // ------------------------------------------------------------------------
    if (pathname === '/api/metrics' && req.method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Unauthorized.' });
      }

      const stats = db.prepare(`
        SELECT 
          COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
          COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense,
          COUNT(CASE WHEN type = 'income' THEN 1 END) AS income_count,
          COUNT(CASE WHEN type = 'expense' THEN 1 END) AS expense_count
        FROM transactions
        WHERE user_id = ?;
      `).get(user.id);

      const totalIncome = parseFloat(stats.total_income) || 0;
      const totalExpense = parseFloat(stats.total_expense) || 0;
      const netBalance = totalIncome - totalExpense;

      return sendJson(res, 200, {
        totalIncome,
        totalExpense,
        netBalance,
        incomeCount: stats.income_count || 0,
        expenseCount: stats.expense_count || 0
      });
    }

    // ------------------------------------------------------------------------
    // API ROUTE: GET /api/transactions
    // ------------------------------------------------------------------------
    if (pathname === '/api/transactions' && req.method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Unauthorized.' });
      }

      const filter = parsedUrl.searchParams.get('filter') || 'all';
      const search = (parsedUrl.searchParams.get('search') || '').trim();

      let sql = `SELECT id, user_id, type, description, amount, category, date, created_at FROM transactions WHERE user_id = ?`;
      const params = [user.id];

      if (filter === 'income' || filter === 'expense') {
        sql += ` AND type = ?`;
        params.push(filter);
      }

      if (search) {
        sql += ` AND (description LIKE ? OR category LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
      }

      sql += ` ORDER BY id DESC;`;

      const rows = db.prepare(sql).all(...params);
      return sendJson(res, 200, rows);
    }

    // ------------------------------------------------------------------------
    // API ROUTE: POST /api/transactions
    // ------------------------------------------------------------------------
    if (pathname === '/api/transactions' && req.method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Unauthorized.' });
      }

      const body = await parseJsonBody(req);
      const type = body.type === 'income' ? 'income' : 'expense';
      const description = (body.description || '').trim();
      const amount = parseFloat(body.amount);
      const category = (body.category || '').trim();
      const date = (body.date || '').trim() || new Date().toISOString().split('T')[0];

      if (!description) {
        return sendJson(res, 400, { error: 'Description is required.' });
      }
      if (isNaN(amount) || amount <= 0) {
        return sendJson(res, 400, { error: 'Amount must be greater than zero.' });
      }
      if (!category) {
        return sendJson(res, 400, { error: 'Category is required.' });
      }

      const roundedAmount = Math.round(amount * 100) / 100;
      const stmt = db.prepare(`
        INSERT INTO transactions (user_id, type, description, amount, category, date)
        VALUES (?, ?, ?, ?, ?, ?);
      `);

      const result = stmt.run(user.id, type, description, roundedAmount, category, date);
      const newId = Number(result.lastInsertRowid);

      return sendJson(res, 201, {
        ok: true,
        transaction: {
          id: newId,
          user_id: user.id,
          type,
          description,
          amount: roundedAmount,
          category,
          date
        }
      });
    }

    // ------------------------------------------------------------------------
    // API ROUTE: DELETE /api/transactions/:id
    // ------------------------------------------------------------------------
    if (pathname.startsWith('/api/transactions/') && req.method === 'DELETE') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Unauthorized.' });
      }

      const idParam = pathname.slice('/api/transactions/'.length);
      const id = parseInt(idParam, 10);
      if (isNaN(id)) {
        return sendJson(res, 400, { error: 'Invalid transaction ID.' });
      }

      const result = db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?;').run(id, user.id);

      if (result.changes === 0) {
        return sendJson(res, 404, { error: 'Transaction not found or not owned by active user.' });
      }

      return sendJson(res, 200, { ok: true, id });
    }

    // ------------------------------------------------------------------------
    // API ROUTE: GET /api/export-db (Download SQLite DB binary file)
    // ------------------------------------------------------------------------
    if (pathname === '/api/export-db' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!fs.existsSync(DB_PATH)) {
        return sendJson(res, 404, { error: 'Database file not found.' }, req.method === 'HEAD');
      }

      const stat = fs.statSync(DB_PATH);
      res.writeHead(200, {
        'Content-Type': 'application/x-sqlite3',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="spendwise_central_${new Date().toISOString().split('T')[0]}.sqlite"`,
        'Access-Control-Allow-Origin': '*'
      });

      if (req.method === 'HEAD') {
        return res.end();
      }

      const readStream = fs.createReadStream(DB_PATH);
      readStream.pipe(res);
      return;
    }

    // ------------------------------------------------------------------------
    // 4. STATIC FILE SERVING
    // ------------------------------------------------------------------------
    let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    if (safePath === '/' || safePath === '\\') safePath = '/index.html';

    const filePath = path.join(PUBLIC_DIR, safePath);

    // Prevent directory traversal outside of project directory
    if (!filePath.startsWith(PUBLIC_DIR)) {
      return sendJson(res, 403, { error: 'Forbidden' }, req.method === 'HEAD');
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        if (pathname.startsWith('/api/')) {
          return sendJson(res, 404, { error: 'API endpoint not found.' }, req.method === 'HEAD');
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('404 Not Found');
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stats.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
      });

      if (req.method === 'HEAD') {
        return res.end();
      }

      fs.createReadStream(filePath).pipe(res);
    });

  } catch (err) {
    console.error('Unhandled server error:', err);
    sendJson(res, 500, { error: 'Internal server error: ' + err.message });
  }
});

// Helper: list local network IP addresses
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

// Start HTTP server on 0.0.0.0
server.listen(PORT, '0.0.0.0', () => {
  const localIps = getLocalIpAddresses();
  console.log('================================================================');
  console.log(` SpendWise Central SQLite Server is running on port ${PORT}!`);
  console.log('================================================================');
  console.log(` Database File: ${DB_PATH}`);
  console.log(` Local Access:   http://localhost:${PORT}`);
  if (localIps.length > 0) {
    console.log(` Network Access: http://${localIps[0]}:${PORT}`);
    console.log(' (Open this Network URL on any phone/device on the same WiFi!)');
  }
  console.log('================================================================');
});
