/**
 * ============================================================================
 * SpendWise Unified API Handler (api/index.js)
 * Compatible with Vercel Serverless Functions, Node.js http, and Cloud / Local SQLite
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { createClient } = require('@libsql/client');

// --- 1. DATABASE CLIENT INITIALIZATION ---
const isVercel = Boolean(process.env.VERCEL);
const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN;

let dbUrl;
if (tursoUrl) {
  // Cloud SQLite (Turso / LibSQL) - best for Vercel multi-device sync
  dbUrl = tursoUrl;
} else if (isVercel) {
  // Vercel Serverless fallback storage in writable /tmp
  dbUrl = `file:${path.join(os.tmpdir(), 'spendwise.db')}`;
} else {
  // Local disk SQLite for Node server (server.js, Render, local dev)
  const localFile = process.env.DB_PATH || path.join(__dirname, '..', 'spendwise.db');
  dbUrl = `file:${localFile}`;
}

const db = createClient({
  url: dbUrl,
  authToken: tursoToken
});

const PUBLIC_DIR = path.join(__dirname, '..');

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

// --- 2. CRYPTO & SCHEMA INITIALIZATION ---
function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

let isInitialized = false;
let initPromise = null;

async function ensureDbInitialized() {
  if (isInitialized) return;
  if (!initPromise) {
    initPromise = (async () => {
      try {
        await db.execute('PRAGMA foreign_keys = ON;');
      } catch (e) {
        // Ignored on some cloud drivers
      }

      await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL COLLATE NOCASE,
          password TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
      `);

      await db.execute(`
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

      await db.execute(`CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);`);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);`);

      // Seed initial accounts (alex & sarah) if empty
      const userCountRes = await db.execute('SELECT COUNT(*) AS count FROM users;');
      const userCount = Number(userCountRes.rows[0].count);

      if (userCount === 0) {
        const defaultPasswordHash = hashPassword('password123');
        await db.execute({
          sql: 'INSERT INTO users (username, password) VALUES (?, ?);',
          args: ['alex', defaultPasswordHash]
        });
        await db.execute({
          sql: 'INSERT INTO users (username, password) VALUES (?, ?);',
          args: ['sarah', defaultPasswordHash]
        });

        const seedTxs = [
          [1, 'income', 'Software Engineer Salary', 4800.00, 'salary', '2026-10-01'],
          [1, 'expense', 'Luxury Apartment Rent', 1600.00, 'housing', '2026-10-02'],
          [1, 'expense', 'Whole Foods Market', 165.40, 'food', '2026-10-06'],
          [1, 'expense', 'High-Speed Internet & Power', 120.00, 'utilities', '2026-10-10'],
          [1, 'income', 'Freelance Mobile App Milestone', 1100.00, 'freelance', '2026-10-18'],
          [2, 'income', 'Marketing Lead Salary', 4200.00, 'salary', '2026-10-01'],
          [2, 'expense', 'Co-op Studio Lease', 1350.00, 'housing', '2026-10-03'],
          [2, 'expense', 'Art Studio Supplies & Books', 145.25, 'shopping', '2026-10-07'],
          [2, 'income', 'Graphic Design Commission', 650.00, 'freelance', '2026-10-15'],
          [2, 'expense', 'Acoustic Concert Tickets', 85.00, 'entertainment', '2026-10-21']
        ];

        for (const [uid, type, desc, amt, cat, dt] of seedTxs) {
          await db.execute({
            sql: `INSERT INTO transactions (user_id, type, description, amount, category, date) VALUES (?, ?, ?, ?, ?, ?);`,
            args: [uid, type, desc, amt, cat, dt]
          });
        }
      }

      isInitialized = true;
    })();
  }
  return initPromise;
}

// --- 3. REQUEST / RESPONSE HELPERS ---
function sendJson(res, statusCode, data, isHead = false) {
  // Support Vercel helpers if available
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (isHead) return res.status(statusCode).end();
    return res.status(statusCode).json(data);
  }

  // Standard Node.js http.ServerResponse
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

async function getRequestBody(req) {
  if (req.body) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
  }

  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

async function getAuthenticatedUser(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  try {
    const rs = await db.execute({
      sql: `
        SELECT u.id, u.username
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.token = ?;
      `,
      args: [token]
    });
    return rs.rows[0] || null;
  } catch (err) {
    console.error('Session verification error:', err);
    return null;
  }
}

// --- 4. MAIN REQUEST HANDLER (VERCEL SERVERLESS + NODE) ---
async function handler(req, res) {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = parsedUrl.pathname;

  // Trim trailing slash (except root)
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  // Handle both /api/... and direct rewritten /... routes
  let apiPath = pathname;
  if (!apiPath.startsWith('/api') && (
    apiPath.startsWith('/auth') ||
    apiPath.startsWith('/metrics') ||
    apiPath.startsWith('/transactions') ||
    apiPath.startsWith('/health') ||
    apiPath.startsWith('/export-db')
  )) {
    apiPath = '/api' + apiPath;
  }

  try {
    // ------------------------------------------------------------------------
    // API ROUTE: GET /api/health
    // ------------------------------------------------------------------------
    if (apiPath === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(res, 200, {
        status: 'ok',
        engine: 'SpendWise Unified SQLite Engine',
        storage: tursoUrl ? 'Turso Cloud SQLite' : (isVercel ? 'Vercel Serverless' : 'Local SQLite'),
        time: new Date().toISOString()
      }, req.method === 'HEAD');
    }

    // All other /api routes require database tables to be initialized
    if (apiPath.startsWith('/api/')) {
      await ensureDbInitialized();
    }

    // ------------------------------------------------------------------------
    // API ROUTE: POST /api/auth/register
    // ------------------------------------------------------------------------
    if (apiPath === '/api/auth/register' && req.method === 'POST') {
      const body = await getRequestBody(req);
      const username = (body.username || '').trim().toLowerCase();
      const password = body.password || '';

      if (!username || username.length < 2) {
        return sendJson(res, 400, { error: 'Username must be at least 2 characters.' });
      }
      if (!password || password.length < 4) {
        return sendJson(res, 400, { error: 'Password must be at least 4 characters.' });
      }

      const existingUser = await db.execute({
        sql: 'SELECT id FROM users WHERE username = ?;',
        args: [username]
      });

      if (existingUser.rows.length > 0) {
        return sendJson(res, 409, { error: `Username "${username}" is already taken.` });
      }

      const hashedPassword = hashPassword(password);
      const userRes = await db.execute({
        sql: 'INSERT INTO users (username, password) VALUES (?, ?);',
        args: [username, hashedPassword]
      });
      const userId = Number(userRes.lastInsertRowid);

      const token = crypto.randomBytes(32).toString('hex');
      await db.execute({
        sql: 'INSERT INTO sessions (token, user_id) VALUES (?, ?);',
        args: [token, userId]
      });

      return sendJson(res, 201, {
        ok: true,
        user: { id: userId, username },
        token
      });
    }

    // ------------------------------------------------------------------------
    // API ROUTE: POST /api/auth/login
    // ------------------------------------------------------------------------
    if (apiPath === '/api/auth/login' && req.method === 'POST') {
      const body = await getRequestBody(req);
      const username = (body.username || '').trim().toLowerCase();
      const password = body.password || '';

      if (!username || !password) {
        return sendJson(res, 400, { error: 'Username and password are required.' });
      }

      const hashedPassword = hashPassword(password);
      const rs = await db.execute({
        sql: 'SELECT id, username, password FROM users WHERE username = ?;',
        args: [username]
      });

      const user = rs.rows[0];
      if (!user || user.password !== hashedPassword) {
        return sendJson(res, 401, { error: 'Invalid username or password.' });
      }

      const token = crypto.randomBytes(32).toString('hex');
      await db.execute({
        sql: 'INSERT INTO sessions (token, user_id) VALUES (?, ?);',
        args: [token, user.id]
      });

      return sendJson(res, 200, {
        ok: true,
        user: { id: Number(user.id), username: user.username },
        token
      });
    }

    // ------------------------------------------------------------------------
    // API ROUTE: GET /api/auth/me
    // ------------------------------------------------------------------------
    if (apiPath === '/api/auth/me' && req.method === 'GET') {
      const user = await getAuthenticatedUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Unauthorized. Please sign in.' });
      }
      return sendJson(res, 200, {
        ok: true,
        user: { id: Number(user.id), username: user.username }
      });
    }

    // ------------------------------------------------------------------------
    // API ROUTE: POST /api/auth/logout
    // ------------------------------------------------------------------------
    if (apiPath === '/api/auth/logout' && req.method === 'POST') {
      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim();
        await db.execute({
          sql: 'DELETE FROM sessions WHERE token = ?;',
          args: [token]
        });
      }
      return sendJson(res, 200, { ok: true, message: 'Logged out successfully' });
    }

    // ------------------------------------------------------------------------
    // API ROUTE: GET /api/metrics
    // ------------------------------------------------------------------------
    if (apiPath === '/api/metrics' && req.method === 'GET') {
      const user = await getAuthenticatedUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Unauthorized.' });
      }

      const rs = await db.execute({
        sql: `
          SELECT 
            COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
            COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense,
            COUNT(CASE WHEN type = 'income' THEN 1 END) AS income_count,
            COUNT(CASE WHEN type = 'expense' THEN 1 END) AS expense_count
          FROM transactions
          WHERE user_id = ?;
        `,
        args: [user.id]
      });

      const stats = rs.rows[0];
      const totalIncome = parseFloat(stats.total_income) || 0;
      const totalExpense = parseFloat(stats.total_expense) || 0;
      const netBalance = totalIncome - totalExpense;

      return sendJson(res, 200, {
        totalIncome,
        totalExpense,
        netBalance,
        incomeCount: Number(stats.income_count) || 0,
        expenseCount: Number(stats.expense_count) || 0
      });
    }

    // ------------------------------------------------------------------------
    // API ROUTE: GET /api/transactions
    // ------------------------------------------------------------------------
    if (apiPath === '/api/transactions' && req.method === 'GET') {
      const user = await getAuthenticatedUser(req);
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

      const rs = await db.execute({ sql, args: params });
      return sendJson(res, 200, rs.rows);
    }

    // ------------------------------------------------------------------------
    // API ROUTE: POST /api/transactions
    // ------------------------------------------------------------------------
    if (apiPath === '/api/transactions' && req.method === 'POST') {
      const user = await getAuthenticatedUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Unauthorized.' });
      }

      const body = await getRequestBody(req);
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
      const resInsert = await db.execute({
        sql: `
          INSERT INTO transactions (user_id, type, description, amount, category, date)
          VALUES (?, ?, ?, ?, ?, ?);
        `,
        args: [user.id, type, description, roundedAmount, category, date]
      });

      const newId = Number(resInsert.lastInsertRowid);

      return sendJson(res, 201, {
        ok: true,
        transaction: {
          id: newId,
          user_id: Number(user.id),
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
    if (apiPath.startsWith('/api/transactions/') && req.method === 'DELETE') {
      const user = await getAuthenticatedUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Unauthorized.' });
      }

      const idParam = apiPath.slice('/api/transactions/'.length);
      const id = parseInt(idParam, 10);
      if (isNaN(id)) {
        return sendJson(res, 400, { error: 'Invalid transaction ID.' });
      }

      const resDelete = await db.execute({
        sql: 'DELETE FROM transactions WHERE id = ? AND user_id = ?;',
        args: [id, user.id]
      });

      if (resDelete.rowsAffected === 0) {
        return sendJson(res, 404, { error: 'Transaction not found or not owned by active user.' });
      }

      return sendJson(res, 200, { ok: true, id });
    }

    // ------------------------------------------------------------------------
    // API ROUTE: GET /api/export-db
    // ------------------------------------------------------------------------
    if (apiPath === '/api/export-db' && (req.method === 'GET' || req.method === 'HEAD')) {
      const filePath = process.env.DB_PATH || path.join(PUBLIC_DIR, 'spendwise.db');
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        res.writeHead(200, {
          'Content-Type': 'application/x-sqlite3',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="spendwise_central_${new Date().toISOString().split('T')[0]}.sqlite"`,
          'Access-Control-Allow-Origin': '*'
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(filePath).pipe(res);
      }
      return sendJson(res, 404, { error: 'Local database file not available for direct export.' });
    }

    // If an unknown /api route is called, return JSON 404
    if (apiPath.startsWith('/api/')) {
      return sendJson(res, 404, { error: `Endpoint ${pathname} not found.` });
    }

    // ------------------------------------------------------------------------
    // 5. STATIC FILE SERVING (For local Node server / Render / Docker)
    // ------------------------------------------------------------------------
    let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    if (safePath === '/' || safePath === '\\') safePath = '/index.html';

    const localStaticFile = path.join(PUBLIC_DIR, safePath);

    if (!localStaticFile.startsWith(PUBLIC_DIR)) {
      return sendJson(res, 403, { error: 'Forbidden' });
    }

    fs.stat(localStaticFile, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('404 Not Found');
      }

      const ext = path.extname(localStaticFile).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stats.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
      });

      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(localStaticFile).pipe(res);
    });

  } catch (err) {
    console.error('Unhandled API error:', err);
    sendJson(res, 500, { error: 'Internal server error: ' + err.message });
  }
}

module.exports = handler;
