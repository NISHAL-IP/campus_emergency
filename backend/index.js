require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const bcrypt = require('bcrypt');
const cors = require('cors');

const app = express();

// middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// allow frontend origin (change via .env)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin: FRONTEND_ORIGIN }));

// In-memory stores for admin dashboard (alerts/devices stay in-memory for UI), logs are DB-backed with in-memory fallback
const alerts = []; // { id, title, message, severity, createdAt, status, acknowledgedCount, totalTargets }
const users = []; // { id, role, name, email, createdAt }
const devices = []; // { id, userEmail, platform, token, createdAt, active }
const deliveryLogs = []; // fallback buffer if DB insert/read fails

// Simple ID generator
let idCounter = 1;
const generateId = () => String(idCounter++);

// SSE client registry
const sseClients = new Set();
function broadcastEvent(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach((res) => {
    try {
      res.write(payload);
    } catch (_) {
      // drop failed connection
      sseClients.delete(res);
    }
  });
}

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT || '1433', 10),
  options: {
    encrypt: true,
    trustServerCertificate: false,
    enableArithAbort: true,
    connectionTimeout: 30000,
    requestTimeout: 30000,
    loginTimeout: 30
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

// ==========================
// 🌐 Translation function using Gemini API
// ==========================
async function translateText(text, targetLanguage) {
  // If target language is 'en', 'english', or not provided, return original text without API call
  if (!targetLanguage) {
    return text;
  }
  
  const normalizedLang = targetLanguage.toLowerCase().trim();
  if (normalizedLang === 'en' || normalizedLang === 'english') {
    return text; // No API call for English
  }

  try {
    if (!process.env.GEMINI_API_KEY) {
      console.warn('GEMINI_API_KEY not configured, returning original text');
      return text;
    }

    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `Translate the following text to ${targetLanguage}. Only return the translated text, no explanations or additional text:\n\n${text}`;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const translatedText = response.text().trim();
    
    return translatedText || text; // Fallback to original if translation fails
  } catch (error) {
    console.error('Translation error:', error);
    return text; // Fallback to original text on error
  }
}

// Create a poolPromise so routes can reuse the same connection pool
let poolPromise;
let dbConnected = false;

const connectToDatabase = async () => {
  try {
    const pool = await sql.connect(dbConfig);
    console.log('✅ Connected to Azure SQL Database!');
    dbConnected = true;
    return pool;
  } catch (err) {
    console.error('❌ DB Connection Failed:', err);
    console.log('⚠️  Running in fallback mode without database');
    dbConnected = false;
    return null;
  }
};

poolPromise = connectToDatabase();

// Test route
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ==========================
// 📡 Server-Sent Events (SSE)
// ==========================
app.get('/admin/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.add(res);
  // send initial snapshot
  res.write(`data: ${JSON.stringify({ type: 'snapshot', alerts, users, devices })}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// ==========================
// 🔔 Alerts admin API
// ==========================
app.get('/admin/alerts', (req, res) => {
  res.json({ alerts });
});

app.post('/admin/alerts', async (req, res) => {
  const { title, message, severity = 'info', target = 'all' } = req.body || {};
  if (!title || !message) return res.status(400).json({ message: 'title and message are required' });

  const alert = {
    id: generateId(),
    title,
    message,
    severity,
    createdAt: new Date().toISOString(),
    status: 'pending',
    acknowledgedCount: 0,
    totalTargets: 0
  };
  alerts.unshift(alert);
  broadcastEvent({ type: 'alert_created', alert });

  // fan out delivery
  fanoutAlert(alert, target).catch(() => { });

  res.status(201).json({ alert });
});

app.patch('/admin/alerts/:id/ack', (req, res) => {
  const { id } = req.params;
  const alert = alerts.find(a => a.id === id);
  if (!alert) return res.status(404).json({ message: 'Alert not found' });
  alert.acknowledgedCount += 1;
  broadcastEvent({ type: 'alert_acknowledged', alertId: id, acknowledgedCount: alert.acknowledgedCount });
  res.json({ alert });
});

// ==========================
// 🔐 Authentication Middleware
// ==========================
const authenticateAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authorization token required' });
    }

    const token = authHeader.substring(7);
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString());

    if (!decoded.email || !decoded.role) {
      return res.status(401).json({ message: 'Invalid token format' });
    }

    if (decoded.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid authorization token' });
  }
};

// ==========================
// 👥 Users admin API
// ==========================
app.get('/admin/users', (req, res) => res.json({ users }));
app.post('/admin/users', authenticateAdmin, (req, res) => {
  const { name, email, role = 'student' } = req.body || {};
  if (!name || !email) return res.status(400).json({ message: 'name and email are required' });
  const user = { id: generateId(), name, email, role, createdAt: new Date().toISOString() };
  users.unshift(user);
  broadcastEvent({ type: 'user_created', user });
  res.status(201).json({ user });
});
app.delete('/admin/users/:id', authenticateAdmin, (req, res) => {
  const { id } = req.params;
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return res.status(404).json({ message: 'User not found' });
  const [removed] = users.splice(idx, 1);
  broadcastEvent({ type: 'user_deleted', id });
  res.json({ user: removed });
});

// ==========================
// 📱 Devices admin API
// ==========================
app.get('/admin/devices', (req, res) => res.json({ devices }));
app.post('/admin/devices', authenticateAdmin, (req, res) => {
  const { userEmail, platform = 'web', token } = req.body || {};
  if (!userEmail || !token) return res.status(400).json({ message: 'userEmail and token are required' });
  const device = { id: generateId(), userEmail, platform, token, createdAt: new Date().toISOString(), active: true };
  devices.unshift(device);
  broadcastEvent({ type: 'device_registered', device });
  res.status(201).json({ device });
});
app.patch('/admin/devices/:id/toggle', authenticateAdmin, (req, res) => {
  const { id } = req.params;
  const device = devices.find(d => d.id === id);
  if (!device) return res.status(404).json({ message: 'Device not found' });
  device.active = !device.active;
  broadcastEvent({ type: 'device_toggled', device });
  res.json({ device });
});

// ==========================
// 🧾 Delivery logs
// ==========================
app.get('/admin/logs', (req, res) => {
  (async () => {
    try {
      const pool = await poolPromise;
      const result = await pool.request()
        .query('SELECT TOP (500) LogID, AlertId, Channel, Recipient, Status, Detail, CreatedAt FROM dbo.DeliveryLogs ORDER BY CreatedAt DESC');
      const logs = (result.recordset || []).map(r => ({
        id: String(r.LogID),
        alertId: r.AlertId,
        deviceToken: r.Recipient,
        status: r.Status,
        timestamp: r.CreatedAt,
        detail: `${r.Channel}: ${r.Detail || ''}`.trim()
      }));
      return res.json({ logs });
    } catch (_) {
      return res.json({ logs: deliveryLogs.slice(0, 500) });
    }
  })();
});

// ==========================
// 🔁 Simulated delivery engine
// ==========================
async function insertDeliveryLog(pool, alertId, channel, recipient, status, detail) {
  try {
    const result = await pool.request()
      .input('AlertId', sql.NVarChar, alertId)
      .input('Channel', sql.NVarChar, channel)
      .input('Recipient', sql.NVarChar, recipient)
      .input('Status', sql.NVarChar, status)
      .input('Detail', sql.NVarChar, detail || '')
      .query(`INSERT INTO dbo.DeliveryLogs (AlertId, Channel, Recipient, Status, Detail)
              OUTPUT INSERTED.LogID, INSERTED.CreatedAt
              VALUES (@AlertId, @Channel, @Recipient, @Status, @Detail)`);
    const row = result.recordset[0];
    const log = { id: String(row.LogID), alertId, deviceToken: recipient, status, timestamp: row.CreatedAt, detail: `${channel}: ${detail || ''}`.trim() };
    broadcastEvent({ type: 'delivery_log', log });
  } catch (e) {
    const log = { id: generateId(), alertId, deviceToken: recipient, status, timestamp: new Date().toISOString(), detail: `${channel}: ${e.message}` };
    deliveryLogs.unshift(log);
    broadcastEvent({ type: 'delivery_log', log });
  }
}

async function fanoutAlert(alert, target) {
  alert.status = 'sending';
  broadcastEvent({ type: 'alert_status', alertId: alert.id, status: alert.status });

  let recipients = [];
  let pool;
  try {
    if (dbConnected) {
      pool = await poolPromise;
      if (pool) {
      let query = 'SELECT Username, Email, PhoneNumber, Language FROM dbo.Users';
      if (target && target !== 'all') query += ' WHERE LOWER(Email) = LOWER(@email)';
      const req = pool.request();
      if (target && target !== 'all') req.input('email', sql.NVarChar, String(target).toLowerCase());
      const rs = await req.query(query);
      recipients = (rs.recordset || []).map(r => ({ name: r.Username, email: r.Email, phone: r.PhoneNumber, language: r.Language || 'en' }));
      }
    }
  } catch (_) { }

  alert.totalTargets = recipients.length;
  broadcastEvent({ type: 'alert_status', alertId: alert.id, status: 'sending', totalTargets: alert.totalTargets });

  // Push via Azure Notification Hubs (broadcast)
  (async () => {
    try {
      if (process.env.ANH_CONNECTION_STRING && process.env.ANH_HUB_NAME) {
        const { NotificationHubsClient } = require('@azure/notification-hubs');
        const client = new NotificationHubsClient(process.env.ANH_CONNECTION_STRING, process.env.ANH_HUB_NAME);
        const payload = { title: `[${alert.severity.toUpperCase()}] ${alert.title}`, body: `${alert.message}`, data: { alertId: alert.id, severity: alert.severity, createdAt: alert.createdAt } };
        await client.sendNotification({
          fcmPayload: {
            notification: { title: payload.title, body: payload.body },
            data: payload.data
          }
        });
        await insertDeliveryLog(pool, alert.id, 'PUSH', 'broadcast', 'delivered', 'Notification Hubs broadcast sent');
      } else {
        await insertDeliveryLog(pool, alert.id, 'PUSH', 'broadcast', 'failed', 'Notification Hubs not configured');
      }
    } catch (e) {
      await insertDeliveryLog(pool, alert.id, 'PUSH', 'broadcast', 'failed', e.message);
    }
  })();

  const nodemailer = require('nodemailer');

  await Promise.all(recipients.map(async (r) => {
    try {
      if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
        // Configure transporter for Gmail
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_PASS
          }
        });

        // Get user's language preference (default to 'en' if not set)
        const userLanguage = (r.language || 'en').toLowerCase().trim();
        const isEnglish = userLanguage === 'en' || userLanguage === 'english';

        // Translate email content based on user's language preference
        const originalSubject = `[EMERGENCY] ${alert.title}`;
        const originalText = `${alert.message}\n\nTime: ${new Date(alert.createdAt).toLocaleString()}\nSeverity: ${alert.severity}\n\nInstructions: Please follow the emergency procedures immediately.`;
        const originalHtml = `<strong>${alert.message}</strong><br/>Time: ${new Date(alert.createdAt).toLocaleString()}<br/>Severity: ${alert.severity}<br/><br/>Instructions: Please follow the emergency procedures immediately.`;

        let subject, text, html;
        
        // Only make AI requests if language is NOT English
        if (!isEnglish) {
          // Translate all content
          subject = await translateText(originalSubject, userLanguage);
          text = await translateText(originalText, userLanguage);
          
          // Translate HTML content - extract text parts and translate them
          const timeStr = `Time: ${new Date(alert.createdAt).toLocaleString()}`;
          const severityStr = `Severity: ${alert.severity}`;
          const instructionsStr = 'Instructions: Please follow the emergency procedures immediately.';
          
          const translatedMessage = await translateText(alert.message, userLanguage);
          const translatedTime = await translateText(timeStr, userLanguage);
          const translatedSeverity = await translateText(severityStr, userLanguage);
          const translatedInstructions = await translateText(instructionsStr, userLanguage);
          
          html = `<strong>${translatedMessage}</strong><br/>${translatedTime}<br/>${translatedSeverity}<br/><br/>${translatedInstructions}`;
        } else {
          // Use original content for English
          subject = originalSubject;
          text = originalText;
          html = originalHtml;
        }

        // Send mail
        const info = await transporter.sendMail({
          from: `"Emergency Alerts" <${process.env.GMAIL_USER}>`,
          to: r.email,
          subject,
          text,
          html
        });

        const ok = info.accepted && info.accepted.length > 0;
        await insertDeliveryLog(pool, alert.id, 'EMAIL', r.email, ok ? 'delivered' : 'failed', ok ? `Gmail sent (${userLanguage})` : 'Gmail failed');
      } else {
        await insertDeliveryLog(pool, alert.id, 'EMAIL', r.email, 'failed', 'Gmail not configured');
      }
    } catch (e) {
      await insertDeliveryLog(pool, alert.id, 'EMAIL', r.email, 'failed', e.message);
    }
  }));

  // SMS via Twilio or Azure Communication Services
  await Promise.all(recipients.map(async (r) => {
    if (!r.phone) return insertDeliveryLog(pool, alert.id, 'SMS', r.email || 'unknown', 'failed', 'No phone on record');
    try {
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) {
        const twilio = require('twilio');
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const body = `[EMERGENCY] ${alert.title} - ${alert.message} | ${new Date(alert.createdAt).toLocaleString()} | Follow emergency procedures.`;
        await client.messages.create({ from: process.env.TWILIO_FROM, to: r.phone, body });
        await insertDeliveryLog(pool, alert.id, 'SMS', r.phone, 'delivered', 'Twilio accepted');
      } else if (process.env.ACS_CONNECTION_STRING && process.env.ACS_FROM_PHONE) {
        const { SmsClient } = require('@azure/communication-sms');
        const smsClient = new SmsClient(process.env.ACS_CONNECTION_STRING);
        const body = `[EMERGENCY] ${alert.title} - ${alert.message} | ${new Date(alert.createdAt).toLocaleString()} | Follow emergency procedures.`;
        const res = await smsClient.send({ from: process.env.ACS_FROM_PHONE, to: [r.phone], message: body });
        const ok = res?.value?.[0]?.successful;
        await insertDeliveryLog(pool, alert.id, 'SMS', r.phone, ok ? 'delivered' : 'failed', ok ? 'ACS sent' : (res?.value?.[0]?.errorMessage || 'ACS error'));
      } else {
        await insertDeliveryLog(pool, alert.id, 'SMS', r.phone, 'failed', 'SMS provider not configured');
      }
    } catch (e) {
      await insertDeliveryLog(pool, alert.id, 'SMS', r.phone, 'failed', e.message);
    }
  }));

  // finalize aggregate status from DB
  try {
    const result = await pool.request()
      .input('AlertId', sql.NVarChar, alert.id)
      .query(`SELECT 
        SUM(CASE WHEN Status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN Status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM dbo.DeliveryLogs WHERE AlertId = @AlertId`);
    const delivered = Number(result.recordset?.[0]?.delivered || 0);
    const failed = Number(result.recordset?.[0]?.failed || 0);
    alert.status = failed === 0 ? 'delivered' : (delivered > 0 ? 'partial' : 'failed');
    broadcastEvent({ type: 'alert_status', alertId: alert.id, status: alert.status, delivered, failed });
  } catch (_) { }
}

// ==========================
// 📝 SIGNUP
// ==========================
app.post('/signup', async (req, res) => {
  console.log('Signup body:', req.body);
  const { username, email, password, phone, role = 'student', language = 'en' } = req.body;

  const normalizedUsername = typeof username === 'string' ? username.trim() : '';
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const rawPassword = typeof password === 'string' ? password : '';
  const normalizedRole = typeof role === 'string' ? role.toLowerCase() : 'student';
  const normalizedLanguage = typeof language === 'string' ? language.toLowerCase() : 'en';

  if (!normalizedUsername || !normalizedEmail || !rawPassword) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  // Validate role
  if (!['student', 'staff', 'admin'].includes(normalizedRole)) {
    return res.status(400).json({ message: 'Invalid role. Must be student, staff, or admin.' });
  }

  try {
    if (!dbConnected) {
      return res.status(503).json({ message: 'Database unavailable. Please try again later.' });
    }

    const pool = await poolPromise;
    if (!pool) {
      return res.status(503).json({ message: 'Database unavailable. Please try again later.' });
    }

    // Check if email already exists
    const checkUser = await pool.request()
      .input('email', sql.NVarChar, normalizedEmail)
      .query('SELECT * FROM dbo.Users WHERE LOWER(Email) = LOWER(@email)');

    if (checkUser.recordset.length > 0) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    await pool.request()
      .input('username', sql.NVarChar, normalizedUsername)
      .input('email', sql.NVarChar, normalizedEmail)
      .input('passwordHash', sql.NVarChar, hashedPassword)
      .input('phone', sql.NVarChar, phone || null)
      .input('role', sql.NVarChar, normalizedRole)
      .input('language', sql.NVarChar, normalizedLanguage)
      .query(`INSERT INTO dbo.Users (Username, Email, PasswordHash, PhoneNumber, Role, Language)
              VALUES (@username, @email, @passwordHash, @phone, @role, @language)`);

    res.status(201).json({ message: 'User registered successfully' });

  } catch (err) {
    console.error('Signup error:', err);
    // if SQL error, include message for dev (remove in prod)
    res.status(500).json({ message: 'Error during signup', detail: err.message });
  }
});

// ==========================
// 🔐 LOGIN
// ==========================
app.post('/login', async (req, res) => {
  console.log('Login body:', req.body);
  const { email, password } = req.body;
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const rawPassword = typeof password === 'string' ? password : '';
  if (!normalizedEmail || !rawPassword)
    return res.status(400).json({ message: 'Email and password required' });

  try {
    if (!dbConnected) {
      return res.status(503).json({ message: 'Database unavailable. Please try again later.' });
    }

    const pool = await poolPromise;
    if (!pool) {
      return res.status(503).json({ message: 'Database unavailable. Please try again later.' });
    }

    const result = await pool.request()
      .input('email', sql.NVarChar, normalizedEmail)
      .query('SELECT * FROM dbo.Users WHERE LOWER(Email) = LOWER(@email)');

    if (result.recordset.length === 0)
      return res.status(404).json({ message: 'User not found' });

    const user = result.recordset[0];

    const isMatch = await bcrypt.compare(rawPassword, user.PasswordHash);

    if (!isMatch)
      return res.status(401).json({ message: 'Invalid password' });

    // Create auth token
    const tokenData = {
      email: user.Email,
      username: user.Username,
      role: user.Role || 'student',
      userId: user.UserID
    };
    const token = Buffer.from(JSON.stringify(tokenData)).toString('base64');

    // success - return basic user info with token
    res.json({
      message: 'Login successful',
      username: user.Username,
      email: user.Email,
      role: user.Role || 'student',
      token: token
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error during login', detail: err.message });
  }
});

// Fallback route
app.use((req, res) => {
  res.status(404).json({ message: 'Not Found' });
});

// Start server
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
