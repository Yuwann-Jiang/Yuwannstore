// 待办事项网站后端：用户注册/登录 + 待办同步
// 零外部依赖，仅使用 Node 内置模块。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = Number(process.env.PORT || 8123);
const HOST = process.env.HOST || '0.0.0.0';

// ---------------------------------------------------------------------------
// 数据存储（JSON 文件），结构：
// { users: { username: { salt, hash, createdAt } },
//   todos: { username: [ { id, text, deadline, created } ] },
//   sessions: { token: { username, createdAt } } }
// ---------------------------------------------------------------------------
let db = { users: {}, todos: {}, sessions: {} };

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db = {
        users: parsed.users || {},
        todos: parsed.todos || {},
        sessions: parsed.sessions || {},
      };
    }
  } catch (e) {
    console.error('读取数据文件失败，使用空数据库:', e.message);
  }
}

function saveDb() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// 密码哈希：scrypt + 随机盐 + 定时安全比较
// ---------------------------------------------------------------------------
function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, useSalt, 64).toString('hex');
  return { salt: useSalt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { username, createdAt: Date.now() };
  saveDb();
  return token;
}

function getSessionUser(req) {
  const header = req.headers['authorization'] || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const session = db.sessions[m[1]];
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    delete db.sessions[m[1]];
    saveDb();
    return null;
  }
  return session.username;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) tooBig = true; // 1MB 上限
    });
    req.on('end', () => {
      if (tooBig) return resolve(null);
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// 用户名：3-20 位，字母/数字/下划线/中文，不含空格
function validUsername(u) {
  return typeof u === 'string' && /^[\w\u4e00-\u9fa5]{3,20}$/.test(u);
}
function validPassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 128;
}

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// 请求处理
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  // 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    });
    res.end();
    return;
  }

  if (!urlPath.startsWith('/api/')) {
    serveStatic(req, res, urlPath);
    return;
  }

  // ---------------- 注册 ----------------
  if (urlPath === '/api/register' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: '请求格式有误' });

    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    if (!validUsername(username)) {
      return sendJson(res, 400, { error: '用户名需为 3-20 位字母、数字、下划线或中文' });
    }
    if (!validPassword(password)) {
      return sendJson(res, 400, { error: '密码至少 6 位' });
    }
    if (db.users[username]) {
      return sendJson(res, 409, { error: '该用户名已被注册' });
    }

    const { salt, hash } = hashPassword(password);
    db.users[username] = { salt, hash, createdAt: Date.now() };
    db.todos[username] = db.todos[username] || [];
    const token = createSession(username);
    return sendJson(res, 201, { token, username });
  }

  // ---------------- 登录 ----------------
  if (urlPath === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: '请求格式有误' });

    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const user = db.users[username];

    // 统一提示，避免暴露用户名是否存在
    if (!user || !verifyPassword(password, user.salt, user.hash)) {
      return sendJson(res, 401, { error: '用户名或密码错误' });
    }
    const token = createSession(username);
    return sendJson(res, 200, { token, username });
  }

  // ---------------- 以下均需登录 ----------------
  const currentUser = getSessionUser(req);

  if (urlPath === '/api/logout' && req.method === 'POST') {
    const header = req.headers['authorization'] || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m && db.sessions[m[1]]) {
      delete db.sessions[m[1]];
      saveDb();
    }
    return sendJson(res, 200, { ok: true });
  }

  if (!currentUser) {
    return sendJson(res, 401, { error: '未登录或登录已失效' });
  }

  // 当前用户信息
  if (urlPath === '/api/me' && req.method === 'GET') {
    return sendJson(res, 200, { username: currentUser });
  }

  // 待办列表
  if (urlPath === '/api/todos' && req.method === 'GET') {
    const list = db.todos[currentUser] || [];
    return sendJson(res, 200, { todos: list });
  }

  // 新增待办
  if (urlPath === '/api/todos' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: '请求格式有误' });

    const text = String(body.text || '').trim();
    const deadline = Number(body.deadline);

    if (!text) return sendJson(res, 400, { error: '待办内容不能为空' });
    if (!Number.isFinite(deadline)) return sendJson(res, 400, { error: '截止时间无效' });

    const item = {
      id: crypto.randomBytes(9).toString('hex'),
      text: text.slice(0, 500),
      deadline,
      created: Date.now(),
    };
    db.todos[currentUser] = db.todos[currentUser] || [];
    db.todos[currentUser].push(item);
    saveDb();
    return sendJson(res, 201, { todo: item });
  }

  // 完成（删除）待办  DELETE /api/todos/:id
  const delMatch = urlPath.match(/^\/api\/todos\/([A-Za-z0-9]+)$/);
  if (delMatch && req.method === 'DELETE') {
    const id = delMatch[1];
    const list = db.todos[currentUser] || [];
    const idx = list.findIndex((t) => t.id === id);
    if (idx === -1) return sendJson(res, 404, { error: '该待办不存在' });
    list.splice(idx, 1);
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: '接口不存在' });
});

loadDb();
server.listen(PORT, HOST, () => {
  console.log('待办服务已启动: http://127.0.0.1:' + PORT + '/');
  console.log('局域网访问: http://<本机IP>:' + PORT + '/');
});
