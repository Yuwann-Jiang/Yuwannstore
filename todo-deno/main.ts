// 待办事项 API —— Deno Deploy 版本
// 存储使用 Deno KV（免费额度内持久保存），密码使用 PBKDF2-SHA256 加盐哈希。
// 接口与 Node / Cloudflare 版本完全一致，前端可无缝切换。
//
// 注意：Deno KV 的键必须是数组（Deno.KvKey），不能是字符串，这与 Cloudflare KV 不同。

const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 会话有效期：30 天（毫秒）

const kv = await Deno.openKv();

// ---------------------------------------------------------------------------
// 响应工具
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

// ---------------------------------------------------------------------------
// 编解码 / 哈希
// ---------------------------------------------------------------------------
function toHex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(buf as ArrayBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

async function hashPassword(
  password: string,
  saltHex?: string,
): Promise<{ salt: string; hash: string }> {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return { salt: toHex(salt), hash: toHex(bits) };
}

// 定时安全比较，避免通过响应耗时推断密码
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

// ---------------------------------------------------------------------------
// KV 读写（键一律使用数组形式）
// ---------------------------------------------------------------------------
type User = { salt: string; hash: string; createdAt: number };
type Todo = { id: string; text: string; deadline: number; created: number };
type Session = { username: string; createdAt: number };

const userKey = (username: string): Deno.KvKey => ["user", username];
const todosKey = (username: string): Deno.KvKey => ["todos", username];
const sessionKey = (token: string): Deno.KvKey => ["session", token];

async function getVal<T>(key: Deno.KvKey): Promise<T | null> {
  const res = await kv.get<T>(key);
  return res.value ?? null;
}

async function getTodos(username: string): Promise<Todo[]> {
  return (await getVal<Todo[]>(todosKey(username))) ?? [];
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------
function validUsername(u: unknown): boolean {
  return typeof u === "string" && /^[\w\u4e00-\u9fa5]{3,20}$/.test(u);
}
function validPassword(p: unknown): boolean {
  return typeof p === "string" && p.length >= 6 && p.length <= 128;
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 主处理
// ---------------------------------------------------------------------------
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!path.startsWith("/api/")) {
    return json({ service: "待办事项 API", runtime: "deno-deploy", status: "running" });
  }

  // ---------------- 注册 ----------------
  if (path === "/api/register" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body) return json({ error: "请求格式有误" }, 400);

    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");

    if (!validUsername(username)) return json({ error: "用户名需为 3-20 位字母、数字、下划线或中文" }, 400);
    if (!validPassword(password)) return json({ error: "密码至少 6 位" }, 400);

    const existing = await getVal<User>(userKey(username));
    if (existing) return json({ error: "该用户名已被注册" }, 409);

    const { salt, hash } = await hashPassword(password);
    await kv.set(userKey(username), { salt, hash, createdAt: Date.now() } satisfies User);
    await kv.set(todosKey(username), []);

    const token = randomToken();
    await kv.set(
      sessionKey(token),
      { username, createdAt: Date.now() } satisfies Session,
      { expireIn: SESSION_TTL_MS },
    );
    return json({ token, username }, 201);
  }

  // ---------------- 登录 ----------------
  if (path === "/api/login" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body) return json({ error: "请求格式有误" }, 400);

    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    const user = await getVal<User>(userKey(username));

    if (!user) return json({ error: "用户名或密码错误" }, 401);
    const { hash } = await hashPassword(password, user.salt);
    if (!safeEqual(hash, user.hash)) return json({ error: "用户名或密码错误" }, 401);

    const token = randomToken();
    await kv.set(
      sessionKey(token),
      { username, createdAt: Date.now() } satisfies Session,
      { expireIn: SESSION_TTL_MS },
    );
    return json({ token, username }, 200);
  }

  // ---------------- 鉴权 ----------------
  const authHeader = req.headers.get("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  let currentUser: string | null = null;
  let currentToken: string | null = null;

  if (match) {
    currentToken = match[1];
    const session = await getVal<Session>(sessionKey(currentToken));
    if (session) currentUser = session.username;
  }

  if (path === "/api/logout" && req.method === "POST") {
    if (currentToken) await kv.delete(sessionKey(currentToken));
    return json({ ok: true });
  }

  if (!currentUser) return json({ error: "未登录或登录已失效" }, 401);

  if (path === "/api/me" && req.method === "GET") {
    return json({ username: currentUser });
  }

  // 待办列表
  if (path === "/api/todos" && req.method === "GET") {
    return json({ todos: await getTodos(currentUser) });
  }

  // 新增待办（同时返回最新完整列表）
  if (path === "/api/todos" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body) return json({ error: "请求格式有误" }, 400);

    const text = String(body.text ?? "").trim();
    const deadline = Number(body.deadline);
    if (!text) return json({ error: "待办内容不能为空" }, 400);
    if (!Number.isFinite(deadline)) return json({ error: "截止时间无效" }, 400);

    const list = await getTodos(currentUser);
    const item: Todo = {
      id: randomToken().slice(0, 18),
      text: text.slice(0, 500),
      deadline,
      created: Date.now(),
    };
    list.push(item);
    await kv.set(todosKey(currentUser), list);
    return json({ todo: item, todos: list }, 201);
  }

  // 完成（删除）待办
  const delMatch = path.match(/^\/api\/todos\/([A-Za-z0-9]+)$/);
  if (delMatch && req.method === "DELETE") {
    const id = delMatch[1];
    const list = await getTodos(currentUser);
    const next = list.filter((t) => t.id !== id);
    if (next.length === list.length) return json({ error: "该待办不存在" }, 404);
    await kv.set(todosKey(currentUser), next);
    return json({ ok: true, todos: next });
  }

  return json({ error: "接口不存在" }, 404);
}

Deno.serve(handler);
