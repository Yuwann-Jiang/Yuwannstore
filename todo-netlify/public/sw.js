// 待办事项 —— Service Worker
// 作用：
//   1. 缓存应用外壳，实现**离线也能打开**（打开后显示上次同步的待办）
//   2. 静态资源缓存优先，加快二次打开速度
//   3. API 请求永不缓存（涉及登录态，且必须实时）

const VERSION = "v1";
const SHELL_CACHE = `todo-shell-${VERSION}`;
const SHELL_KEY = "/index.html";

// 应用外壳资源
const SHELL_ASSETS = [
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
];

// ---------------------------------------------------------------------------
// 安装：预缓存外壳
// ---------------------------------------------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 逐个缓存，单个失败不影响整体安装
      await Promise.all(
        SHELL_ASSETS.map(async (url) => {
          try {
            const res = await fetch(new Request(url, { cache: "reload" }));
            if (res && res.ok) await cache.put(url, res);
          } catch (e) {
            // 忽略：离线安装时会走到这里
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

// ---------------------------------------------------------------------------
// 激活：清理旧版本缓存 + 立即接管页面
// ---------------------------------------------------------------------------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// ---------------------------------------------------------------------------
// 请求拦截
// ---------------------------------------------------------------------------
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // 只处理 GET
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }

  // 只处理同源请求
  if (url.origin !== self.location.origin) return;

  // API 一律走网络，绝不缓存（登录态 + 数据实时性）
  if (url.pathname.startsWith("/api/")) return;

  // 页面导航：网络优先，失败时回退到缓存的外壳
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(SHELL_KEY, fresh.clone());
          }
          return fresh;
        } catch (e) {
          const cache = await caches.open(SHELL_CACHE);
          const cached = (await cache.match(SHELL_KEY)) || (await cache.match("/"));
          if (cached) return cached;
          return new Response(
            "<!doctype html><meta charset=utf-8><title>离线</title>" +
              "<body style=\"font-family:-apple-system,sans-serif;padding:40px;text-align:center;color:#6b7280\">" +
              "<h2>暂时离线</h2><p>请检查网络后重试。</p></body>",
            { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }
      })()
    );
    return;
  }

  // 其他静态资源：缓存优先
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) await cache.put(req, res.clone());
        return res;
      } catch (e) {
        return new Response("", { status: 504, statusText: "Offline" });
      }
    })()
  );
});

// ---------------------------------------------------------------------------
// 允许页面主动触发更新
// ---------------------------------------------------------------------------
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
