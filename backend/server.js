const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'; // set to https://dxxxx.cloudfront.net in AWS

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'staffdesk',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false, // RDS PG15+ requires SSL
});

const app = express();
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(','), credentials: true }));
app.use(express.json());

// ---------- DB init (with retry so it works under docker-compose) ----------
async function initDb() {
  for (let i = 1; i <= 15; i++) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin')`);
      await pool.query(`CREATE TABLE IF NOT EXISTS staff (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
        department TEXT NOT NULL, position TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Active', created_at TIMESTAMPTZ DEFAULT now())`);
      const email = process.env.ADMIN_EMAIL || 'admin@staffdesk.com';
      const pass = process.env.ADMIN_PASSWORD || 'Admin@123';
      const hash = await bcrypt.hash(pass, 10);
      await pool.query(
        `INSERT INTO users(email,password_hash,name,role) VALUES($1,$2,'Administrator','admin')
         ON CONFLICT (email) DO NOTHING`, [email, hash]);
      console.log('Database ready');
      return;
    } catch (e) {
      console.log(`DB not ready (${i}/15): ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  process.exit(1);
}

// ---------- auth middleware ----------
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
}

// ---------- routes ----------
app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', db: 'connected' }); }
  catch (e) { res.status(500).json({ status: 'error', db: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password || '', u.password_hash)))
    return res.status(401).json({ error: 'Invalid email or password' });
  const token = jwt.sign({ id: u.id, email: u.email, name: u.name }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: u.id, email: u.email, name: u.name, role: u.role } });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));

app.get('/api/staff', auth, async (req, res) => {
  const q = `%${req.query.search || ''}%`;
  const { rows } = await pool.query(
    `SELECT * FROM staff WHERE name ILIKE $1 OR department ILIKE $1 OR email ILIKE $1 ORDER BY id DESC`, [q]);
  res.json(rows);
});

app.post('/api/staff', auth, async (req, res) => {
  const { name, email, department, position, status } = req.body || {};
  if (!name || !email || !department || !position) return res.status(400).json({ error: 'All fields are required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO staff(name,email,department,position,status) VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [name, email, department, position, status || 'Active']);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(e.code === '23505' ? 409 : 500).json({ error: e.code === '23505' ? 'Email already exists' : e.message });
  }
});

app.put('/api/staff/:id', auth, async (req, res) => {
  const { name, email, department, position, status } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE staff SET name=$1,email=$2,department=$3,position=$4,status=$5 WHERE id=$6 RETURNING *`,
    [name, email, department, position, status, req.params.id]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Not found' });
});

app.delete('/api/staff/:id', auth, async (req, res) => {
  const r = await pool.query('DELETE FROM staff WHERE id=$1', [req.params.id]);
  r.rowCount ? res.json({ deleted: true }) : res.status(404).json({ error: 'Not found' });
});

initDb().then(() => app.listen(PORT, '0.0.0.0', () => console.log(`API listening on ${PORT}`)));
