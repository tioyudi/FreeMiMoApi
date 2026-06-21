const express = require('express');
const crypto = require('crypto');
const os = require('os');
const { Readable } = require('stream');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── CONFIG ───
const BOOTSTRAP_URL = 'https://api.xiaomimimo.com/api/free-ai/bootstrap';
const CHAT_URL       = 'https://api.xiaomimimo.com/api/free-ai/openai/chat';
const PORT           = process.env.PORT || 9656;

const SYSTEM_MARKER = "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

// ─── JWT CACHE ───
let cachedJwt = null;
let jwtExpiresAt = 0;

function parseJwtExp(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    if (payload.exp) return payload.exp * 1000;
  } catch {}
  return Date.now() + 3000 * 1000;
}

// ─── FINGERPRINT ───
function generateFingerprint() {
  let username = 'unknown-user';
  try { username = os.userInfo().username; } catch {}
  const cpu = (os.cpus()[0]?.model || 'unknown-cpu').trim();
  const seed = `${os.hostname()}|${os.platform()}|${os.arch()}|${cpu}|${username}`;
  return crypto.createHash('sha256').update(seed).digest('hex');
}

// ─── SESSION ID ───
function generateSessionId() {
  return 'ses_' + crypto.randomBytes(12).toString('hex');
}

// ─── BOOTSTRAP ───
async function bootstrapJwt() {
  const UA = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const res = await fetch(BOOTSTRAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ client: generateFingerprint() }),
  });
  if (!res.ok) throw new Error(`Bootstrap failed: ${res.status}`);
  const data = await res.json();
  if (!data.jwt) throw new Error('No JWT in bootstrap response');
  cachedJwt = data.jwt;
  jwtExpiresAt = parseJwtExp(data.jwt);
  return cachedJwt;
}

// ─── GET VALID JWT ───
async function getJwt() {
  if (cachedJwt && Date.now() < jwtExpiresAt - 300_000) return cachedJwt;
  return bootstrapJwt();
}

// ─── SYSTEM MARKER INJECT ───
function injectMarker(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs)) return body;
  const has = msgs.some(m => m?.role === 'system' && typeof m.content === 'string' && m.content.includes(SYSTEM_MARKER));
  if (has) return body;
  return { ...body, messages: [{ role: 'system', content: SYSTEM_MARKER }, ...msgs] };
}

// ─── OPENAI-COMPATIBLE ENDPOINT ───
app.post('/v1/chat/completions', async (req, res) => {
  const start = Date.now();
  try {
    const jwt = await getJwt();
    const UA = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const sessionId = generateSessionId();
    const stream = req.body?.stream !== false;
    const body = injectMarker(req.body);
    const maxTokens = body.max_tokens || 2048;

    console.log(`[REQ] stream=${stream} model=${body.model} msgs=${body.messages?.length} tokens=${maxTokens}`);

    const xiaomiRes = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`,
        'X-Mimo-Source': 'mimocode-cli-free',
        'User-Agent': UA,
        'x-session-affinity': sessionId,
        'Accept': stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
    });

    console.log(`[UPSTREAM] status=${xiaomiRes.status} type=${xiaomiRes.headers.get('content-type')}`);

    // Kalau 401/403 → re-bootstrap & retry sekali
    if (xiaomiRes.status === 401 || xiaomiRes.status === 403) {
      console.log('[AUTH] JWT expired, re-bootstrapping...');
      cachedJwt = null;
      const jwt2 = await bootstrapJwt();
      const UA2 = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      const sessionId2 = generateSessionId();
      const retryRes = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt2}`,
          'X-Mimo-Source': 'mimocode-cli-free',
          'User-Agent': UA2,
          'x-session-affinity': sessionId2,
          'Accept': stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!retryRes.ok) {
        console.log(`[RETRY FAILED] ${retryRes.status}`);
        return res.status(retryRes.status).json({ error: `Upstream: ${retryRes.status}` });
      }
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        Readable.fromWeb(retryRes.body).pipe(res);
      } else {
        const json = await retryRes.json();
        res.json(json);
      }
      console.log(`[OK] retry ${Date.now() - start}ms`);
      return;
    }

    if (!xiaomiRes.ok) {
      const text = await xiaomiRes.text().catch(() => '');
      console.log(`[UPSTREAM ERROR] ${xiaomiRes.status}: ${text.slice(0, 200)}`);
      return res.status(xiaomiRes.status).json({ error: `Upstream: ${xiaomiRes.status}`, detail: text.slice(0, 500) });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      Readable.fromWeb(xiaomiRes.body).pipe(res);
    } else {
      const json = await xiaomiRes.json();
      // Forward clean headers
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.json(json);
    }
    console.log(`[OK] ${Date.now() - start}ms`);

  } catch (err) {
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── MODELS LIST ───
app.get('/v1/models', (_, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'mimo-auto', object: 'model', owned_by: 'mimo-free', created: Math.floor(Date.now()/1000) },
    ],
  });
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 FreeMiMoApi running on :${PORT} | model: mimo-auto`));
