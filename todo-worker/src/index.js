// 待办事项 API — Cloudflare Worker 版本
// 存储使用 Workers KV，密码使用 PBKDF2-SHA256 加盐哈希。
// 接口与本地 Node 版完全一致，因此前端可以在两个后端之间无缝切换。

const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL = 60 * 60 * 24 * 30; // 会话有效期：30 天（秒）

// ---------------------------------------------------------------------------
// 响应工具
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      CORS_HEADERS
    ),
  });
}

// ---------------------------------------------------------------------------
// 编解码 / 哈希
// ---------------------------------------------------------------------------
function toHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

async function hashPassword(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return { salt: toHex(salt), hash: toHex(bits) };
}

// 定时安全比较，避免通过响应耗时推断密码
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

// ---------------------------------------------------------------------------
// KV 读写
// ---------------------------------------------------------------------------
async function getJson(env, key) {
  const raw = await env.TODO_KV.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function putJson(env, key, value, opts) {
  await env.TODO_KV.put(key, JSON.stringify(value), opts);
}

function getTodos(env, username) {
  return getJson(env, 'todos:' + username).then((v) => v || []);
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------
function validUsername(u) {
  return typeof u === 'string' && /^[\w\u4e00-\u9fa5]{3,20}$/.test(u);
}
function validPassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 128;
}

async function readJsonBody(req) {
  try { return await req.json(); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// 主处理
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!path.startsWith('/api/')) {
      return json({ service: '待办事项 API', status: 'running', endpoint: '/api/*' });
    }

    // ---------------- 注册 ----------------
    if (path === '/api/register' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body) return json({ error: '请求格式有误' }, 400);

      const username = String(body.username || '').trim();
      const password = String(body.password || '');

      if (!validUsername(username)) return json({ error: '用户名需为 3-20 位字母、数字、下划线或中文' }, 400);
      if (!validPassword(password)) return json({ error: '密码至少 6 位' }, 400);

      const existing = await getJson(env, 'user:' + username);
      if (existing) return json({ error: '该用户名已被注册' }, 409);

      const { salt, hash } = await hashPassword(password);
      await putJson(env, 'user:' + username, { salt, hash, createdAt: Date.now() });
      await putJson(env, 'todos:' + username, []);

      const token = randomToken();
      await putJson(env, 'session:' + token, { username, createdAt: Date.now() }, { expirationTtl: SESSION_TTL });
      return json({ token, username }, 201);
    }

    // ---------------- 登录 ----------------
    if (path === '/api/login' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body) return json({ error: '请求格式有误' }, 400);

      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const user = await getJson(env, 'user:' + username);

      if (!user) return json({ error: '用户名或密码错误' }, 401);
      const { hash } = await hashPassword(password, user.salt);
      if (!safeEqual(hash, user.hash)) return json({ error: '用户名或密码错误' }, 401);

      const token = randomToken();
      await putJson(env, 'session:' + token, { username, createdAt: Date.now() }, { expirationTtl: SESSION_TTL });
      return json({ token, username }, 200);
    }

    // ---------------- 鉴权 ----------------
    const authHeader = request.headers.get('Authorization') || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    let currentUser = null;
    let currentToken = null;

    if (match) {
      currentToken = match[1];
      const session = await getJson(env, 'session:' + currentToken);
      if (session) currentUser = session.username;
    }

    if (path === '/api/logout' && request.method === 'POST') {
      if (currentToken) await env.TODO_KV.delete('session:' + currentToken);
      return json({ ok: true });
    }

    if (!currentUser) return json({ error: '未登录或登录已失效' }, 401);

    if (path === '/api/me' && request.method === 'GET') {
      return json({ username: currentUser });
    }

    // 待办列表
    if (path === '/api/todos' && request.method === 'GET') {
      return json({ todos: await getTodos(env, currentUser) });
    }

    // 新增待办（直接返回最新完整列表，规避 KV 最终一致性带来的读到旧数据问题）
    if (path === '/api/todos' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body) return json({ error: '请求格式有误' }, 400);

      const text = String(body.text || '').trim();
      const deadline = Number(body.deadline);
      if (!text) return json({ error: '待办内容不能为空' }, 400);
      if (!Number.isFinite(deadline)) return json({ error: '截止时间无效' }, 400);

      const list = await getTodos(env, currentUser);
      const item = {
        id: randomToken().slice(0, 18),
        text: text.slice(0, 500),
        deadline,
        created: Date.now(),
      };
      list.push(item);
      await putJson(env, 'todos:' + currentUser, list);
      return json({ todo: item, todos: list }, 201);
    }

    // 完成（删除）待办
    const delMatch = path.match(/^\/api\/todos\/([A-Za-z0-9]+)$/);
    if (delMatch && request.method === 'DELETE') {
      const id = delMatch[1];
      const list = await getTodos(env, currentUser);
      const next = list.filter((t) => t.id !== id);
      if (next.length === list.length) return json({ error: '该待办不存在' }, 404);
      await putJson(env, 'todos:' + currentUser, next);
      return json({ ok: true, todos: next });
    }

    return json({ error: '接口不存在' }, 404);
  },
};
