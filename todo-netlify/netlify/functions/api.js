// 待办事项 API —— Netlify Functions 版本
// 存储使用 Netlify Blobs（免费额度内持久保存）
// 密码使用 PBKDF2-SHA256 加盐哈希。接口与 Node / Cloudflare / Deno 版本完全一致。

import { getStore } from "@netlify/blobs";
// 该函数运行时未暴露全局 crypto，需显式引入 Node 的 WebCrypto 实现
import { webcrypto as crypto } from "node:crypto";
import { createMailer, runNotify } from "../../lib/notify.js";

const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 会话有效期：30 天

// Blobs 存储延迟初始化：模块顶层初始化在函数运行时可能拿不到上下文，故改为首次使用时创建
// consistency: "strong" 至关重要 —— 默认的最终一致性会让「写入后立刻读取」读到旧数据
// （表现为注册后无法立即登录、新增待办后列表不刷新），强一致读可消除该问题。
let _store = null;
function todoStore() {
  if (!_store) _store = getStore({ name: "todo-app", consistency: "strong" });
  return _store;
}

// 列举专用实例 —— 这里有一个非常隐蔽的坑：
//
// @netlify/blobs 的请求路由逻辑是：
//     const consistency = opConsistency ?? this.consistency;
//     url = consistency === "strong" ? this.uncachedEdgeURL : this.edgeURL;
// 而 ListOptions 的类型定义里 **没有 consistency 字段**，也就是说 list() 无法
// 按次覆盖一致性，只能用存储实例上的设置。
//
// 后果：如果用带 consistency:"strong" 的实例调 list()，请求会被打到
// uncached 端点，而该端点不提供列举能力 —— **永远返回空列表，且不报错**。
// 这曾经导致「邮件提醒扫不到用户」和「管理员看不到任何用户」两个静默故障。
//
// 因此：凡是 list() 一律用这个不带强一致的实例，get/set 用 todoStore()。
let _listStore = null;
function todoListStore() {
  if (!_listStore) _listStore = getStore({ name: "todo-app" });
  return _listStore;
}

// 枚举所有用户名（供管理员后台与邮件提醒使用）
async function listAllUsernames() {
  const listed = await todoListStore().list({ prefix: "user:" });
  return (listed.blobs || []).map((b) => b.key.slice("user:".length));
}

// ---------------------------------------------------------------------------
// 响应工具
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

function json(obj, status = 200) {
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
function toHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

async function hashPassword(password, saltHex) {
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
// Blobs 读写（键为字符串，带前缀避免冲突）
//
// 重要：必须区分「读取成功但无数据」与「读取出错」。
// 早期版本把出错也当成 null 返回，导致存储故障时注册接口误判"用户名可用"，
// 一旦此时写入恰好成功，就会覆盖已有账号 —— 属于数据丢失级隐患。
// 因此这里统一返回 { ok, value } / { ok, error }，出错时由调用方返回 503。
// ---------------------------------------------------------------------------
const userKey = (username) => `user:${username}`;
const todosKey = (username) => `todos:${username}`;
const sessionKey = (token) => `session:${token}`;
const completionsKey = (username) => `completions:${username}`;

// 完成记录最多保留条数，防止无限增长
const MAX_COMPLETIONS = 3000;

// 存储服务不可用时的统一响应
const STORAGE_DOWN = () => json({ error: "存储服务暂时不可用，请稍后重试" }, 503);

// 瞬时故障重试（Netlify Blobs 偶发超时/5xx）
async function withRetry(fn, label, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 150));
    }
  }
  console.error(`[Blobs] ${label} 失败:`, lastErr);
  throw lastErr;
}

async function storeGet(key) {
  try {
    const v = await withRetry(
      () => todoStore().get(key, { type: "json", consistency: "strong" }),
      `读取 ${key}`,
    );
    return { ok: true, value: v ?? null };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function storeSet(key, value) {
  try {
    await withRetry(() => todoStore().setJSON(key, value), `写入 ${key}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function storeDelete(key) {
  try {
    await withRetry(() => todoStore().delete(key), `删除 ${key}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 读取待办列表；返回 { ok, todos }
async function getTodos(username) {
  const r = await storeGet(todosKey(username));
  if (!r.ok) return { ok: false };
  return { ok: true, todos: r.value ?? [] };
}

// ---------------------------------------------------------------------------
// 完成记录（用于「完成热力图」）
// 说明：点「已完成」会把待办删除，因此在删除前先落一条历史记录。
// ---------------------------------------------------------------------------
async function recordCompletion(username, todo) {
  const r = await storeGet(completionsKey(username));
  if (!r.ok) return false;

  const list = Array.isArray(r.value) ? r.value : [];
  const now = Date.now();
  list.push({
    text: String(todo.text ?? "").slice(0, 200),
    at: now,
    deadline: Number.isFinite(todo.deadline) ? todo.deadline : null,
    onTime: Number.isFinite(todo.deadline) ? now <= todo.deadline : null,
  });

  // 只保留最近 MAX_COMPLETIONS 条，避免无限增长
  const trimmed = list.length > MAX_COMPLETIONS ? list.slice(-MAX_COMPLETIONS) : list;
  const w = await storeSet(completionsKey(username), trimmed);
  return w.ok;
}

// ---------------------------------------------------------------------------
// 管理员鉴权
//
// 安全原则：管理员身份**只依据数据库里的 isAdmin 标志**判断，
// 绝不通过「用户名等于某个值」来判定 —— 否则只要有人注册同名账号
// 就能拿到全部用户数据。
// ---------------------------------------------------------------------------
async function loadUser(username) {
  const r = await storeGet(userKey(username));
  if (!r.ok) return { ok: false };
  return { ok: true, user: r.value };
}

// 返回 { ok, isAdmin }；ok=false 表示存储故障
async function checkAdmin(username) {
  const r = await loadUser(username);
  if (!r.ok) return { ok: false, isAdmin: false };
  return { ok: true, isAdmin: !!(r.user && r.user.isAdmin === true) };
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------
function validUsername(u) {
  return typeof u === "string" && /^[\w\u4e00-\u9fa5]{3,20}$/.test(u);
}
function validPassword(p) {
  return typeof p === "string" && p.length >= 6 && p.length <= 128;
}
function validEmail(e) {
  return typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

async function readJsonBody(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 业务处理
// ---------------------------------------------------------------------------
async function handle(req) {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // 提醒任务的运行状态（公开，仅返回时间与计数，不含隐私数据）
  if (path === "/api/notify-status" && req.method === "GET") {
    const r = await storeGet("notify:lastRun");
    if (!r.ok) return STORAGE_DOWN();
    const last = r.value;
    const agoMin = last && last.at ? Math.round((Date.now() - last.at) / 60000) : null;
    return json({
      configured: !!(process.env.QQ_USER && process.env.QQ_AUTH_CODE),
      schedule: "*/15 * * * *",
      lastRun: last
        ? {
            at: new Date(last.at).toISOString(),
            agoMinutes: agoMin,
            trigger: last.trigger,
            sent: last.sent,
            failed: last.failed,
            error: last.error,
          }
        : null,
    });
  }

  // 手动触发提醒检查（需密钥）：便于部署后立即验证，也可供外部定时器调用
  if (path === "/api/run-notify" && req.method === "POST") {
    const secret = process.env.NOTIFY_SECRET;
    const url = new URL(req.url);
    const provided = req.headers.get("x-notify-secret") || url.searchParams.get("secret");
    if (!secret || provided !== secret) return json({ error: "无权限" }, 403);

    const dryRun = url.searchParams.get("dry") === "1";
    const result = await runNotify({
      // 用列举实例：runNotify 需要 list() 枚举用户，强一致实例会让 list 返回空
      store: todoListStore(),
      mailer: createMailer(),
      from: process.env.QQ_USER,
      appUrl: process.env.APP_URL || "https://yuwann-todo.netlify.app/",
      dryRun,
    });

    // 非 dry-run 的手动执行也记入运行状态
    if (!dryRun) {
      await storeSet("notify:lastRun", {
        at: Date.now(),
        trigger: "manual",
        scannedUsers: result.scannedUsers,
        scannedTodos: result.scannedTodos,
        sent: result.sent,
        failed: result.failed,
        error: result.error || null,
      });
    }
    return json(result);
  }

  // ---------------- 管理员初始化（密钥保护）----------------
  // 用途：创建管理员账号，或把已有账号提升为管理员。
  // 必须携带 ADMIN_SECRET 环境变量里的密钥，否则任何人都能提权。
  // 注意：此接口不做"是否已存在管理员"的限制 —— 否则一旦管理员密码遗失
  // 就再也无法恢复。安全性完全由密钥保证。
  if (path === "/api/admin/bootstrap" && req.method === "POST") {
    const secret = process.env.ADMIN_SECRET;
    if (!secret) {
      return json({ error: "服务端未配置 ADMIN_SECRET，管理员功能未启用" }, 503);
    }

    const body = await readJsonBody(req);
    if (!body) return json({ error: "请求格式有误" }, 400);

    const provided = String(body.secret ?? req.headers.get("x-admin-secret") ?? "");
    if (!safeEqual(provided, secret)) {
      return json({ error: "密钥不正确" }, 403);
    }

    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    if (!validUsername(username)) {
      return json({ error: "用户名需为 3-20 位字母、数字、下划线或中文" }, 400);
    }
    if (!validPassword(password)) return json({ error: "密码至少 6 位" }, 400);

    const existing = await loadUser(username);
    if (!existing.ok) return STORAGE_DOWN();

    if (existing.user) {
      // 已存在 → 提升为管理员，并可选重置密码
      existing.user.isAdmin = true;
      if (body.resetPassword === true) {
        const { salt, hash } = await hashPassword(password);
        existing.user.salt = salt;
        existing.user.hash = hash;
      }
      const w = await storeSet(userKey(username), existing.user);
      if (!w.ok) return STORAGE_DOWN();
      return json({ ok: true, username, created: false, passwordReset: body.resetPassword === true });
    }

    const { salt, hash } = await hashPassword(password);
    const w1 = await storeSet(userKey(username), {
      salt, hash, createdAt: Date.now(), isAdmin: true,
    });
    if (!w1.ok) return STORAGE_DOWN();
    const w2 = await storeSet(todosKey(username), []);
    if (!w2.ok) return STORAGE_DOWN();

    return json({ ok: true, username, created: true });
  }

  // ---------------- 注册 ----------------
  if (path === "/api/register" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body) return json({ error: "请求格式有误" }, 400);

    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");

    if (!validUsername(username)) return json({ error: "用户名需为 3-20 位字母、数字、下划线或中文" }, 400);
    if (!validPassword(password)) return json({ error: "密码至少 6 位" }, 400);

    // 关键：读取失败时必须中止，绝不能当成"用户名可用"，否则可能覆盖已有账号
    const existing = await storeGet(userKey(username));
    if (!existing.ok) return STORAGE_DOWN();
    if (existing.value) return json({ error: "该用户名已被注册" }, 409);

    const { salt, hash } = await hashPassword(password);
    const w1 = await storeSet(userKey(username), { salt, hash, createdAt: Date.now() });
    if (!w1.ok) return STORAGE_DOWN();
    const w2 = await storeSet(todosKey(username), []);
    if (!w2.ok) return STORAGE_DOWN();

    const token = randomToken();
    const w3 = await storeSet(sessionKey(token), { username, createdAt: Date.now() });
    if (!w3.ok) return STORAGE_DOWN();
    return json({ token, username }, 201);
  }

  // ---------------- 登录 ----------------
  if (path === "/api/login" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body) return json({ error: "请求格式有误" }, 400);

    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    const r = await storeGet(userKey(username));
    if (!r.ok) return STORAGE_DOWN();

    const user = r.value;
    if (!user) return json({ error: "用户名或密码错误" }, 401);
    const { hash } = await hashPassword(password, user.salt);
    if (!safeEqual(hash, user.hash)) return json({ error: "用户名或密码错误" }, 401);

    const token = randomToken();
    const w = await storeSet(sessionKey(token), { username, createdAt: Date.now() });
    if (!w.ok) return STORAGE_DOWN();
    return json({ token, username }, 200);
  }

  // ---------------- 鉴权 ----------------
  const authHeader = req.headers.get("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  let currentUser = null;
  let currentToken = null;

  if (match) {
    currentToken = match[1];
    const r = await storeGet(sessionKey(currentToken));
    // 存储故障时不把用户踢下线，而是明确报错，避免误判为登录失效
    if (!r.ok) return STORAGE_DOWN();
    const session = r.value;
    if (session) {
      if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        await storeDelete(sessionKey(currentToken));
      } else {
        currentUser = session.username;
      }
    }
  }

  if (path === "/api/logout" && req.method === "POST") {
    if (currentToken) await storeDelete(sessionKey(currentToken));
    return json({ ok: true });
  }

  if (!currentUser) return json({ error: "未登录或登录已失效" }, 401);

  if (path === "/api/me" && req.method === "GET") {
    const r = await storeGet(userKey(currentUser));
    if (!r.ok) return STORAGE_DOWN();
    return json({
      username: currentUser,
      email: (r.value && r.value.email) || null,
      isAdmin: !!(r.value && r.value.isAdmin === true),
    });
  }

  // ---------------- 修改密码 ----------------
  if (path === "/api/password" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body) return json({ error: "请求格式有误" }, 400);

    const oldPw = String(body.oldPassword ?? "");
    const newPw = String(body.newPassword ?? "");
    if (!validPassword(newPw)) return json({ error: "新密码至少 6 位" }, 400);

    const r = await loadUser(currentUser);
    if (!r.ok) return STORAGE_DOWN();
    if (!r.user) return json({ error: "账号数据异常" }, 500);

    const { hash: oldHash } = await hashPassword(oldPw, r.user.salt);
    if (!safeEqual(oldHash, r.user.hash)) {
      return json({ error: "当前密码不正确" }, 401);
    }

    const { salt, hash } = await hashPassword(newPw);
    r.user.salt = salt;
    r.user.hash = hash;
    const w = await storeSet(userKey(currentUser), r.user);
    if (!w.ok) return STORAGE_DOWN();
    return json({ ok: true });
  }

  // ---------------- 管理员 ----------------
  if (path.startsWith("/api/admin/")) {
    const adm = await checkAdmin(currentUser);
    if (!adm.ok) return STORAGE_DOWN();
    if (!adm.isAdmin) return json({ error: "需要管理员权限" }, 403);

    // 全部用户概览
    if (path === "/api/admin/overview" && req.method === "GET") {
      let names = [];
      try {
        names = await listAllUsernames();
      } catch (e) {
        console.error("管理员枚举用户失败:", e);
        return STORAGE_DOWN();
      }

      const users = [];
      let totalTodos = 0;
      let totalCompletions = 0;

      for (const name of names) {
        const ur = await loadUser(name);
        if (!ur.ok || !ur.user) continue;

        const tr = await storeGet(todosKey(name));
        const todos = tr.ok && Array.isArray(tr.value) ? tr.value : [];

        const cr = await storeGet(completionsKey(name));
        const comps = cr.ok && Array.isArray(cr.value) ? cr.value : [];

        totalTodos += todos.length;
        totalCompletions += comps.length;

        // 只返回必要的字段，绝不外泄 salt / hash
        users.push({
          username: name,
          email: ur.user.email || null,
          isAdmin: ur.user.isAdmin === true,
          createdAt: ur.user.createdAt || null,
          todoCount: todos.length,
          completionCount: comps.length,
          lastCompletionAt: comps.length ? comps[comps.length - 1].at : null,
        });
      }

      users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return json({
        users,
        stats: {
          userCount: users.length,
          todoCount: totalTodos,
          completionCount: totalCompletions,
          boundEmailCount: users.filter((u) => u.email).length,
          adminCount: users.filter((u) => u.isAdmin).length,
        },
      });
    }

    // 指定用户的详情（含待办与完成记录）
    const m = path.match(/^\/api\/admin\/users\/(.+)$/);
    if (m && req.method === "GET") {
      const target = decodeURIComponent(m[1]).trim();
      if (!validUsername(target)) return json({ error: "用户名不合法" }, 400);

      // 注意：loadUser() 返回 { ok, user }，而 storeGet() 返回 { ok, value }，
      // 两者不可混用（这里曾因写成 storeGet(...).user 而恒返回 404）
      const ur = await loadUser(target);
      if (!ur.ok) return STORAGE_DOWN();
      if (!ur.user) return json({ error: "该用户不存在" }, 404);

      const tr = await storeGet(todosKey(target));
      if (!tr.ok) return STORAGE_DOWN();
      const cr = await storeGet(completionsKey(target));
      if (!cr.ok) return STORAGE_DOWN();

      return json({
        username: target,
        email: ur.user.email || null,
        isAdmin: ur.user.isAdmin === true,
        createdAt: ur.user.createdAt || null,
        todos: Array.isArray(tr.value) ? tr.value : [],
        completions: Array.isArray(cr.value) ? cr.value : [],
      });
    }

    return json({ error: "管理员接口不存在" }, 404);
  }

  // ---------------- 提醒邮箱 ----------------
  // 查询已绑定的邮箱
  if (path === "/api/profile" && req.method === "GET") {
    const r = await storeGet(userKey(currentUser));
    if (!r.ok) return STORAGE_DOWN();
    return json({
      username: currentUser,
      email: (r.value && r.value.email) || null,
      isAdmin: !!(r.value && r.value.isAdmin === true),
    });
  }

  // 绑定 / 修改 / 解绑提醒邮箱
  if (path === "/api/profile" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body) return json({ error: "请求格式有误" }, 400);

    const raw = String(body.email ?? "").trim();
    const r = await storeGet(userKey(currentUser));
    if (!r.ok) return STORAGE_DOWN();
    const user = r.value;
    if (!user) return json({ error: "账号数据异常" }, 500);

    // 传空字符串表示解绑
    if (raw === "") {
      delete user.email;
      const w = await storeSet(userKey(currentUser), user);
      if (!w.ok) return STORAGE_DOWN();
      return json({ ok: true, email: null });
    }

    if (!validEmail(raw)) {
      return json({ error: "邮箱格式不正确" }, 400);
    }

    user.email = raw;
    const w = await storeSet(userKey(currentUser), user);
    if (!w.ok) return STORAGE_DOWN();
    return json({ ok: true, email: raw });
  }

  // 待办列表
  if (path === "/api/todos" && req.method === "GET") {
    const r = await getTodos(currentUser);
    if (!r.ok) return STORAGE_DOWN();
    return json({ todos: r.todos });
  }

  // 新增待办（同时返回最新完整列表）
  if (path === "/api/todos" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body) return json({ error: "请求格式有误" }, 400);

    const text = String(body.text ?? "").trim();
    const deadline = Number(body.deadline);
    if (!text) return json({ error: "待办内容不能为空" }, 400);
    if (!Number.isFinite(deadline)) return json({ error: "截止时间无效" }, 400);

    const r = await getTodos(currentUser);
    if (!r.ok) return STORAGE_DOWN();
    const list = r.todos;
    const item = {
      id: randomToken().slice(0, 18),
      text: text.slice(0, 500),
      deadline,
      created: Date.now(),
    };
    list.push(item);
    const w = await storeSet(todosKey(currentUser), list);
    if (!w.ok) return STORAGE_DOWN();
    return json({ todo: item, todos: list }, 201);
  }

  // 编辑待办 —— 可修改名称（text）与截止时间（deadline），只改传入的字段
  const editMatch = path.match(/^\/api\/todos\/([A-Za-z0-9]+)$/);
  if (editMatch && req.method === "PATCH") {
    const id = editMatch[1];
    const body = await readJsonBody(req);
    if (!body) return json({ error: "请求格式有误" }, 400);

    const r = await getTodos(currentUser);
    if (!r.ok) return STORAGE_DOWN();
    const list = r.todos;
    const target = list.find((t) => t.id === id);
    if (!target) return json({ error: "该待办不存在" }, 404);

    let changed = false;

    if (body.text !== undefined) {
      const text = String(body.text).trim();
      if (!text) return json({ error: "待办内容不能为空" }, 400);
      const nextText = text.slice(0, 500);
      if (nextText !== target.text) {
        target.text = nextText;
        changed = true;
      }
    }

    if (body.deadline !== undefined) {
      const dl = Number(body.deadline);
      if (!Number.isFinite(dl)) return json({ error: "截止时间无效" }, 400);
      if (dl !== target.deadline) {
        target.deadline = dl;
        // 截止时间变了 → 之前发过的提醒已失效，重置提醒状态以便按新时间重新提醒。
        // 注意：只在时间变化时重置。单纯改文字不重置，否则会收到重复邮件。
        delete target.notified;
        delete target.notifiedAt;
        changed = true;
      }
    }

    if (changed) {
      target.updatedAt = Date.now();
      const w = await storeSet(todosKey(currentUser), list);
      if (!w.ok) return STORAGE_DOWN();
    }

    return json({ todo: target, todos: list });
  }

  // 完成（删除）待办 —— 同时记入完成历史，供热力图统计
  const delMatch = path.match(/^\/api\/todos\/([A-Za-z0-9]+)$/);
  if (delMatch && req.method === "DELETE") {
    const id = delMatch[1];
    const r = await getTodos(currentUser);
    if (!r.ok) return STORAGE_DOWN();
    const list = r.todos;
    const target = list.find((t) => t.id === id);
    if (!target) return json({ error: "该待办不存在" }, 404);

    const next = list.filter((t) => t.id !== id);
    const w = await storeSet(todosKey(currentUser), next);
    if (!w.ok) return STORAGE_DOWN();

    // 记录历史；即使记录失败也不影响"已完成"本身
    const recorded = await recordCompletion(currentUser, target);
    return json({ ok: true, todos: next, completionRecorded: recorded });
  }

  // 完成历史（热力图数据源）
  if (path === "/api/completions" && req.method === "GET") {
    const r = await storeGet(completionsKey(currentUser));
    if (!r.ok) return STORAGE_DOWN();
    return json({ completions: Array.isArray(r.value) ? r.value : [] });
  }

  return json({ error: "接口不存在", path }, 404);
}

// 对外入口：捕获异常并返回可读提示，避免 502 无法定位问题
export default async function handler(req) {
  try {
    return await handle(req);
  } catch (err) {
    console.error("API 处理异常:", err);
    return json({ error: "服务器内部错误，请稍后重试" }, 500);
  }
}

// 让 /api/* 的所有请求都进入这个函数，并保留原始路径
export const config = { path: "/api/*" };
