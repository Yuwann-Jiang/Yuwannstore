# 架构与工作逻辑

本文说明系统**是怎么跑起来的**，以及**为什么这样设计**。接手项目请先读这份文档。

---

## 一、系统总览

```
┌─────────────────────────────────────────────────────────────────┐
│                            用户设备                              │
│                                                                  │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐   │
│   │ 桌面浏览器    │   │ 手机浏览器    │   │ 安卓 App (5+App) │   │
│   │ (含 PWA 安装) │   │ (含 PWA 安装) │   │  WebView 套壳    │   │
│   └──────┬───────┘   └──────┬───────┘   └────────┬─────────┘   │
│          │                  │                     │             │
│          │  ① 加载页面（/）  ② 调用 API（/api/*）  │             │
└──────────┼──────────────────┼─────────────────────┼─────────────┘
           │                  │                     │
           ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Netlify（同一域名，无跨域）                    │
│                                                                  │
│   ┌────────────────────┐        ┌──────────────────────────┐   │
│   │  静态托管           │        │  Netlify Functions       │   │
│   │  public/           │        │                          │   │
│   │   ├ index.html     │        │   api.js                 │   │
│   │   ├ sw.js          │        │    ├ /api/register       │   │
│   │   ├ manifest       │        │    ├ /api/login ...      │   │
│   │   └ icons/         │        │    └ /api/stats/.ics     │   │
│   └────────────────────┘        │                          │   │
│                                 │   notify.js（定时任务）   │   │
│                                 │    每 15 分钟执行         │   │
│                                 └────────────┬─────────────┘   │
└──────────────────────────────────────────────┼─────────────────┘
                                               │
                        ┌──────────────────────┼──────────────────────┐
                        ▼                      ▼                      ▼
              ┌──────────────────┐   ┌──────────────────┐   ┌──────────────┐
              │ Netlify Blobs    │   │ QQ 邮箱 SMTP     │   │ 浏览器本地    │
              │ （唯一数据源）    │   │ smtp.qq.com:465  │   │ localStorage │
              │                  │   │                  │   │              │
              │ user:*           │   │ 到期提醒邮件      │   │ 登录 token   │
              │ todos:*          │   │                  │   │ 待办缓存     │
              │ session:*        │   │                  │   │ 完成记录缓存 │
              │ completions:*    │   │                  │   │              │
              │ notify:lastRun   │   │                  │   │              │
              └──────────────────┘   └──────────────────┘   └──────────────┘
```

**代码模块划分**

| 文件 | 职责 |
|---|---|
| `netlify/functions/api.js` | 全部 HTTP 路由（账号 / 待办 / 统计 / 日历 / 管理员 / 运维） |
| `netlify/functions/notify.js` | 定时任务入口（每 15 分钟） |
| `lib/notify.js` | 多级提醒的判定逻辑 + 自写的 SMTP 客户端 |
| `lib/stats.js` | 统计计算（纯函数，不依赖 Netlify 环境） |
| `lib/ics.js` | 日历文件生成（纯函数） |
| `lib/memorial.js` | 纪念日的校验与规范化（纯函数） |
| `public/index.html` | 前端单文件应用 |

**关键点：前后端同源。** 前端页面和 API 都由 `yuwann-todo.netlify.app` 提供，
因此浏览器端没有任何跨域问题。安卓 App 内页面是本地文件，属于跨域，
所以后端统一返回 `Access-Control-Allow-Origin: *`。

---

## 二、一次请求的完整流程

以「用户点击某条待办的『已完成』按钮」为例：

```
1. 前端 completeTodo(id)                                   [index.html]
      ↓ 给该行加上 .removing 类（播放淡出动画）
      ↓ fetch DELETE /api/todos/<id>，带 Authorization: Bearer <token>

2. Netlify 路由：/api/* → api.js                            [netlify.toml + config.path]

3. api.js 的 handle()                                       [netlify/functions/api.js]
      ↓ 解析 URL 与 method
      ↓ 从 Authorization 头取出 Bearer token
      ↓ 查 Blobs 的 session:<token> 换取 username（鉴权）
      ↓ 若会话过期（>30 天）则删除该 session 并返回 401

4. 业务处理
      ↓ 读取 todos:<username>（强一致读）
      ↓ 找到目标待办，若不存在返回 404
      ↓ 过滤掉它，写回 todos:<username>
      ↓ 调用 recordCompletion() 落一条完成历史到 completions:<username>
      ↓ 返回 { ok: true, todos: [...], completionRecorded: true }

5. 前端收到 200
      ↓ 本地 todos 数组同步移除该项
      ↓ 重新渲染列表
      ↓ loadCompletions() 刷新热力图（新记录立刻体现在方格上）
```

---

## 三、数据模型

所有数据存在 **Netlify Blobs 的一个名为 `todo-app` 的 store** 里。
Key 使用 `类型:用户名` 的形式，Value 是 JSON。

| Key 格式 | Value 结构 | 说明 |
|---|---|---|
| `user:<用户名>` | `{ salt, hash, createdAt, email?, isAdmin? }` | 账号。<br>`salt` 16 字节随机盐（hex）<br>`hash` PBKDF2-SHA256 结果（hex，256 位）<br>`email` 可选，绑定后才有<br>`isAdmin` 可选，管理员为 `true` |
| `todos:<用户名>` | `[{ id, text, deadline, created, updatedAt?, notifiedStages?, notifiedStage?, notified?, notifiedAt? }]` | 该用户的全部待办数组<br>`deadline` 是毫秒时间戳<br>`notifiedStages` 记录**已发过的提醒档位**（`3d`/`1d`/`overdue`）<br>`notified` 是旧版布尔字段，仅为兼容保留 |
| `session:<token>` | `{ username, createdAt }` | 会话。token 是 32 字节随机值（hex）<br>有效期 30 天，**在读取时惰性判断过期** |
| `memorials:<用户名>` | `[{ id, title, date, repeat, note, created, updatedAt? }]` | 纪念日<br>`date` 是 **`"YYYY-MM-DD"` 字符串**（不是时间戳）<br>`repeat` 为 `year`（每年重复）/ `none`<br>上限 500 条 |
| `completions:<用户名>` | `[{ id, text, at, deadline, onTime }]` | 完成历史，热力图与统计的数据源<br>`id` 12 位随机串，撤销完成时用于精确回滚<br>`at` 完成时间戳<br>`onTime` 是否在截止前完成<br>**上限 3000 条**，超出丢弃最旧的 |
| `notify:lastRun` | `{ at, trigger, scannedUsers, sent, failed, error }` | 定时任务最近一次运行记录，供 `/api/notify-status` 查询 |

### 为什么待办用「一个数组」而不是「每条一个 key」

- 优点：一次读取拿到全部，读放大最小；排序、统计在客户端做很自然
- 缺点：**并发写入有覆盖风险**（读-改-写不是原子的）
- 权衡：个人/小团队场景并发极低，可接受。如果将来用户量上来，应改为
  「每条待办一个 key + `list({prefix})`」，届时写入天然无冲突

---

## 四、账号与安全

### 密码存储

```js
PBKDF2-SHA256
  迭代次数：100,000
  盐：      16 字节随机（crypto.getRandomValues）
  输出：    256 位（32 字节）
```

- 每个用户独立随机盐，绝不存明文
- 校验时用**定时安全比较**（逐字符异或累加），避免通过响应耗时推断密码
- 登录失败统一返回「用户名或密码错误」，不区分「用户不存在」与「密码错误」，避免用户名枚举

### 会话

- 登录/注册后生成 32 字节随机 token，存 `session:<token>`，有效期 30 天
- 前端把 token 存在 `localStorage`，每次请求放在 `Authorization: Bearer <token>`
- 登出即删除该 session key
- **过期判断是惰性的**：读取会话时检查 `createdAt`，超期则删除并视为未登录

### ⚠️ 存储层最关键的约定：必须区分「无数据」与「读取失败」

这是**血泪教训**，改动存储相关代码时务必遵守：

```js
// ❌ 错误做法：读取失败被当成"没有数据"
async function getVal(key) {
  try { return await store.get(key); } catch { return null; }
}
// 后果：注册时读取失败 → 误判用户名可用 → 若写入成功则覆盖已有账号
//       → 用户的待办和绑定邮箱全部静默丢失

// ✅ 正确做法：显式区分两种状态
async function storeGet(key) {
  try {
    const v = await withRetry(() => store.get(key, { type: "json", consistency: "strong" }));
    return { ok: true, value: v ?? null };
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }
}
// 调用方：读取失败一律返回 503 并中止流程，绝不继续往下走
const r = await storeGet(userKey(username));
if (!r.ok) return STORAGE_DOWN();
if (r.value) return json({ error: "该用户名已被注册" }, 409);
```

### Blobs 的四个必须注意的点

| 事项 | 说明 |
|---|---|
| **强一致读** | 默认是最终一致性，写入后要十几秒才能读到。所有 `get()` 必须带 `consistency: "strong"`，否则会出现「注册后无法立即登录」「待办删了又出现」 |
| **`list()` 不能用强一致实例** | 见下方专门说明，**这是本项目踩过最阴险的坑** |
| **延迟初始化** | `getStore()` 必须在**请求处理时**调用，不能在模块顶层。顶层调用拿不到运行上下文 |
| **重试** | 偶发超时/5xx 很常见，`withRetry()` 自动重试一次（间隔 150ms） |

#### ⚠️ `list()` 的一致性陷阱（务必理解）

`@netlify/blobs` 的请求路由逻辑：

```js
const consistency = opConsistency ?? this.consistency;   // 存储级设置会作用于所有操作
const url2 = new URL(urlPath, consistency === "strong" ? this.uncachedEdgeURL : this.edgeURL);
```

而 `ListOptions` 的类型定义里**没有 `consistency` 字段**：

```ts
interface ListOptions {
    directories?: boolean;
    paginate?: boolean;
    prefix?: string;      // ← 没有 consistency，无法按次覆盖
}
```

**后果**：如果用 `getStore({ consistency: "strong" })` 创建的实例调 `list()`，
请求会被打到 **uncached 端点**，而该端点不提供列举能力——于是
**永远返回空列表，且不抛任何异常**。

**本项目因此出现过两个静默故障**：
- 管理员后台显示「0 个用户」
- 邮件提醒扫不到任何用户，`scannedUsers` 恒为 0

两者都不报错，功能看起来"正常"，只是永远不做任何事。

**约定**：

```js
// get / set —— 用强一致实例
let _store = null;
function todoStore() {
  if (!_store) _store = getStore({ name: "todo-app", consistency: "strong" });
  return _store;
}

// list —— 必须用不带强一致的实例
let _listStore = null;
function todoListStore() {
  if (!_listStore) _listStore = getStore({ name: "todo-app" });
  return _listStore;
}
```

`get()` 的强一致读通过**按次传参**保证，不受实例设置影响：

```js
store.get(key, { type: "json", consistency: "strong" })   // ✅ 仍然强一致
```

> 📌 **写新代码时的自检清单**：凡是用到 `list()` 的地方，
> ① 确认用的是 `todoListStore()`；② 确认对返回结果做了非空验证。

---

## 五、HTTP 接口层

### 路由方式

函数入口是 `api.js` 的 `export default async function handler(req)`，
路由不依赖框架，直接判断 `URL.pathname`：

```js
const path = new URL(req.url).pathname;
if (path === "/api/register" && req.method === "POST") { ... }
```

通过 `export const config = { path: "/api/*" }` 让 `/api/` 下所有请求都进入这个函数。

### 统一约定

- 请求体：JSON
- 响应体：JSON（`Content-Type: application/json; charset=utf-8`）
  —— 唯一例外是 `/api/calendar.ics`，返回 `text/calendar`
- 认证：`Authorization: Bearer <token>`
- 响应头带 `Access-Control-Allow-Origin: *`（供 App 和 GitHub Pages 调用）
- 错误格式统一为 `{ "error": "人类可读的中文提示" }`

完整接口清单见 [`API.md`](API.md)。

---

## 六、前端工作逻辑

`public/index.html` 是**单文件应用**：HTML + CSS + JS 全在一个文件里（约 1900 行）。
没有框架、没有构建步骤——直接改完就能部署。

### 视图切换

三个视图，通过 `.hidden` 类切换：

| 视图 | id | 内容 |
|---|---|---|
| 登录/注册 | `authView` | 用户名密码表单，登录/注册 Tab 切换 |
| 主应用 | `appView` | 用户栏、邮箱栏、添加表单、待办列表、统计/导出按钮、热力图 |
| 统计 | `statsView` | 指标卡、每日/每周/星期/时段柱状图、待办时间分布 |
| 纪念 | `memorialView` | 纪念日列表（倒计时）、添加 / 编辑 / 删除 |
| 管理后台 | `adminView` | 仅管理员可见 |

启动流程（`init()`）：

```
读取 localStorage 里的 token
  ├─ 没有 token → 显示登录页
  └─ 有 token   → 请求 /api/me 验证
                   ├─ 200 → 显示主应用，加载待办与完成记录
                   ├─ 401 → 清除本地 token，回到登录页
                   └─ 其他（网络异常）→ 仍显示主应用，用本地缓存渲染
```

### 同步机制

- **轮询**：登录后每 20 秒拉一次 `/api/todos`（`POLL_MS = 20000`），实现跨设备同步
- **倒计时刷新**：每 60 秒重新渲染一次，更新「剩余时间」文字与颜色档位
- **写入后立即刷新**：添加/完成待办后直接调用加载函数，不依赖轮询

> 轮询 + 写入响应直接返回最新列表，是为了规避 Netlify Blobs 的读延迟问题。

### 离线能力

| 机制 | 实现 |
|---|---|
| 应用外壳缓存 | `sw.js` 预缓存 `index.html`、manifest、图标 |
| 页面导航 | 网络优先，失败时回退到缓存的 `index.html` |
| 静态资源 | 缓存优先 |
| **API 请求** | **永不缓存**（涉及登录态与实时性），直接走网络 |
| 数据离线可读 | 待办与完成记录写入 localStorage，断网时用缓存渲染并显示离线提示条 |
| 恢复联网 | 监听 `online` 事件，自动重新同步 |

### 热力图渲染

- 展示最近 **53 周**，每周一列、每天一行（周一为一周起点）
- 用 CSS Grid 的 `grid-auto-flow: column` 实现「按列填充」
- 按天聚合完成记录：`dateKey(new Date(c.at))` 得到本地日期字符串 `YYYY-MM-DD`
- **按本地时区归组**（而非 UTC），否则深夜/凌晨完成的任务会归错天
- 颜色分级：`0 → lv0`，`1 → lv1`，`2-3 → lv2`，`4-5 → lv3`，`6+ → lv4`
- 点击方格 → `showDayDetail(dateKey)` 展示当天任务明细

### 统计页

点主界面的「📊 统计」进入 `statsView`，数据来自 `GET /api/stats`（见 `lib/stats.js`）。

**为什么统计在服务端算，而不是前端算**

热力图在前端按本地时区聚合，统计页如果也在前端算，两套逻辑很容易漂移。
现在的做法是：前端把 `tz = -new Date().getTimezoneOffset()` 传给服务端，
由 `lib/stats.js` 统一决定所有"天"的边界；前端只负责把结果画成柱状图。

> `getTimezoneOffset()` 返回的是**相反数**（北京返回 `-480`），必须取负再传。
> 传错方向会让所有"天"整体错位 16 小时，白天测试完全看不出来。

柱状图由一个通用函数 `renderCols(el, items, opts)` 渲染，四个图共用一个实现：
每个柱子 = 竖条（按最大值等比缩放到像素高度）+ 顶部数值 + 底部标签，
鼠标悬停用 `title` 显示明细。

### 撤销「已完成」

「已完成」= 从列表删除 + 写一条完成历史，误点后无法自然恢复。为此加了撤销通道：

```
点「已完成」
  → DELETE /api/todos/<id>
  → 响应带上 completedTodo（快照）与 completionId
  → 底部浮层提示「已完成「xxx」　[撤销] ✕」，10 秒后自动消失
  → 点撤销：POST /api/todos/restore { todo, completionId }
        ├─ 200 → 待办回到列表 + 完成记录被删除 → 重画列表与热力图
        ├─ 409 → 该待办已在列表里（别的设备也撤销过）→ 刷新列表
        └─ 其它 → 提示条改成「撤销失败…[重试]」，保留状态可再点
```

**必须回滚完成记录**：热力图的格子数与统计里的完成数/准时率都读 `completions:*`。
只放回待办而不删记录，会留下"其实没完成"的记录，数据慢慢变脏且极难发现。

### 浮层提示（toast）

一个组件两用：撤销提示、导出日历结果。选它而不选 `alert()` 的原因：
撤销要"顺手点一下"，系统弹窗会打断操作，手机上也不好看。
`showToast(text, { actionLabel, onAction, ms })` 负责显示，`hideToast()` 负责收起。

### 导出到日历

点「📅 导出日历」→ 用 `fetch` 带 `Authorization` 头请求 `/api/calendar.ics`
→ 拿到文本 → `new Blob([...], { type: "text/calendar" })` → 生成临时 `<a download>`
→ 点击下载 → 5 秒后 `revokeObjectURL`（太早释放会让部分浏览器下载失败）。

> 为什么不直接 `window.open("/api/calendar.ics")`：新窗口不会带认证头，只会拿到 401；
> 也不把 token 放查询串——那会留在浏览器历史与访问日志里。
>
> 例外：**原生 App 里 `<a download>` 不会触发任何下载**（WebView 没有下载管理器），
> 所以 `window.__NATIVE_APP__` 为真时改走 5+App 的 `plus.downloader`：
> 带 `Authorization` 头下载到手机「下载」目录，再给一个「打开」按钮交给系统日历 App。

### 纪念

纪念日是「有纪念意义的日期」，独立成一个视图，数据走 `/api/memorials`。

**为什么日期存字符串、倒计时在前端算**

| 做法 | 结果 |
|---|---|
| 存时间戳（服务端算） | 北京时间 `2023-05-20 00:00` 在 UTC 是 `05-19 16:00`，换个时区就**错一天** |
| **存 `"YYYY-MM-DD"`，前端按本机时区算** | 永远不漂移；时区与夏令时交给浏览器 |

这跟统计页的取舍**正好相反**：统计页必须在服务端统一口径（否则和热力图对不上），
而纪念日只涉及单个日期，前端算最简单也最不容易错。

**倒计时规则**（`memorialInfo()`）

| 情况 | 显示 |
|---|---|
| `repeat=year`，今年这一天未到 | 还有 N 天 · 第 K 周年 |
| `repeat=year`，今年这一天已过 | 顺延到明年，还有 N 天 · 第 K+1 周年 |
| 恰好是今天 | 就是今天 🎉 |
| `repeat=none` 且已过 | 已过 N 天 |

排序：今天与将到的排前面（越近越前），已经过去的排后面（越近越前）。
主界面顶部还有一个提示条（`renderMemBanner()`）：今天有纪念日就显示「今天是「XXX」」，
7 天内有就显示「「XXX」还有 N 天」，都没有则隐藏。

---

## 七、邮件提醒机制

### 定时任务

`netlify/functions/notify.js`：

```js
export const config = { schedule: "*/15 * * * *" };  // 每 15 分钟
```

Netlify 会按此 cron 自动调用该函数。

### 判断逻辑（`lib/notify.js` 的 `runNotify()`）

提醒分**三档**（`lib/notify.js` 的 `STAGES`），每档最多发一次：

| 档位 | 触发条件（距截止） | 邮件主题 | 配色 |
|---|---|---|---|
| `3d` | ≤ 3 天 | ⏳ 待办还有 3 天到期 | 黄 |
| `1d` | ≤ 1 天 | ⏰ 待办即将到期 | 红 |
| `overdue` | < 0（已超时） | ⚠️ 待办已超时 | 深红 |

```
遍历所有 user:* 键
  ├─ 用户未绑定邮箱 → 跳过
  └─ 读取该用户的 todos:*
       └─ 逐条判断：
            ├─ currentStage(剩余时间) 为 null（还早）→ 跳过
            ├─ 该档位已在 notifiedStages 里 → 跳过（去重）
            └─ 否则 → 按该档位的文案发邮件
                 ├─ 成功 → 把「截至该档」的所有档位一起标记
                 │           notifiedStages / notifiedStage / notifiedAt / 旧字段 notified
                 └─ 失败 → 不标记（下一轮自动重试）
```

**为什么失败要"一起标记到当前档"**

如果定时任务停过一阵，一条待办可能从「剩 5 天」直接变成「已超时」。
只标记 `overdue` 的话，下一轮它仍是 `overdue`（已标记，跳过）——没有问题；
但反过来，如果只标记"当前档"而不标记更早的档位，一旦时间倒回或逻辑调整，
就可能补发一串过期邮件。现在的做法是**跳过中间档一起标记**，
语义变成"比当前更紧急的提醒都不需要再发了"。

**旧数据兼容**：只有 `notified: true` 的老待办，视为 `["3d","1d"]` 已发，
升级后不会给存量待办补发邮件（`sentStages()` 负责这层兼容）。

**改截止时间会重置全部档位**（见 `api.js` 的 PATCH 分支），只改文字不重置。

### 为什么自己写 SMTP 客户端

`lib/notify.js` 里的 `smtpSend()` 是基于 Node 内置 `node:tls` 手写的极简 SMTP 客户端，
**不是**用 nodemailer。原因：

> nodemailer 会让 Netlify 的函数打包阶段**直接卡死**——进程异常退出（退出码 13），
> 只留下一句 `Warning: Detected unsettled top-level await`，没有任何有效错误信息。
> 排查花了很长时间才定位到是它。

自己实现的协议流程：

```
TLS 连接 smtp.qq.com:465
  ← 220 问候
  → EHLO localhost            ← 250（多行响应，需正确识别最后一行 "250 "）
  → AUTH LOGIN                ← 334
  → base64(用户名)             ← 334
  → base64(授权码)             ← 235 认证成功
  → MAIL FROM:<发件人>         ← 250
  → RCPT TO:<收件人>           ← 250
  → DATA                      ← 354
  → 邮件报文 + "\r\n.\r\n"     ← 250 投递成功
  → QUIT                      ← 等服务器回应后再关闭（否则会被记为异常断开）
```

报文构造要点：
- 中文主题用 **RFC 2047** 编码：`=?UTF-8?B?<base64>?=`
- 正文用 **base64** 编码，避免点号转义（dot-stuffing）与行长限制
- 每 76 字符换行
- `multipart/alternative` 同时提供纯文本与 HTML 两个版本

### 邮件发送通道配置

通过环境变量注入，不写死在代码里：

| 变量 | 用途 |
|---|---|
| `QQ_USER` | 发件邮箱地址 |
| `QQ_AUTH_CODE` | QQ 邮箱**授权码**（不是登录密码） |
| `APP_URL` | 邮件里「打开待办清单」按钮的链接 |
| `NOTIFY_SECRET` | 手动触发 `/api/run-notify` 的密钥 |

---

## 八、安卓 App 工作逻辑

App 是 **HBuilderX 5+App**（WebView 套壳），不是原生开发。

```
todo-app-native/
├── manifest.json        应用配置（AppID / 图标 / 权限 / 版本）
├── index.html           ← 由 build-native-html.py 从网页版自动生成，勿手改
└── unpackage/res/       图标与启动图
```

### 与网页版的差异

`build-native-html.py` 在网页版 `index.html` 基础上做三处注入：

| 注入内容 | 作用 |
|---|---|
| `window.__API_BASE__ = "https://yuwann-todo.netlify.app"` | App 内页面是本地文件，必须显式指定后端地址 |
| `window.__NATIVE_APP__ = true` | 隐藏「📲 安装应用」按钮（已经是原生 App 了） |
| 禁用 Service Worker | 原生 WebView 不支持，跳过注册 |

**网页版改动后，跑一次即可同步到 App：**

```bash
cd todo-netlify && python3 build-native-html.py
```

> 注意：App 内的**界面**是打包时固化的，不会自动更新；
> 但**账号、待办数据、邮件提醒**都是实时调服务器的，始终最新。

---

## 九、关键设计决策速查

| 决策 | 原因 |
|---|---|
| 前端用单文件原生 JS，不上框架 | 功能规模小，省掉构建步骤；改完直接部署 |
| 后端零第三方运行时依赖（除 `@netlify/blobs`） | 打包更快、冷启动更快、更少供应链风险 |
| 自己实现 SMTP 客户端 | nodemailer 会导致打包卡死（见上文） |
| 待办存成一个数组 | 读放大最小；并发风险在个人场景可接受 |
| 所有 Blobs 读带 `consistency: "strong"` | 默认最终一致性会导致「写完读不到」 |
| 存储操作返回 `{ ok, value }` | 区分「无数据」与「读取失败」，避免覆盖账号 |
| 密码用 PBKDF2 而非 bcrypt/argon2 | Web Crypto 原生支持，无需引入原生依赖 |
| 前端轮询而非 WebSocket | Netlify Functions 无法维持长连接；20 秒轮询足够 |
| 热力图按本地时区归组 | 服务器是 UTC，按 UTC 归组会让凌晨完成的任务归错天 |
| 统计由服务端算，时区参数由客户端传 | 只有一处决定"哪天算哪天"，热力图与统计页不会各算一套而漂移 |
| 完成历史与待办分开存 | 待办会被删除，历史必须独立保留 |
| 完成记录带自己的 `id` | 撤销完成时要精确删掉那一条，不能靠"最后一条"猜 |
| 撤销必须回滚完成记录 | 否则热力图多一格、准时率虚高，数据慢慢变脏 |
| 日历导出用 `VEVENT` 而非 `VTODO` | Google 日历对 `VTODO` 支持极差，导入后常什么都不显示 |
| 提醒分三档而非只提醒一次 | 「剩余 1 天才提醒」对提前规划的待办太晚 |
| 纪念日日期存字符串而非时间戳 | 纪念日是日历上的一天，时间戳跨时区会错一天 |
| 纪念日单独一个存储键 | 待办完成即删除，纪念日要长期保留，生命周期不同 |

---

## 十、已知技术债

按建议处理优先级排列：

1. **待办数组的并发写覆盖风险** — 改为每条一个 key
2. **`netlify.app` 在中国大陆的 IPv4 被阻断** — 需要换域名或托管（见 `OPERATIONS.md`）
3. **无数据备份机制** — 数据只在 Netlify Blobs 单点
4. **兜底路由会隐藏真实 404** — `netlify.toml` 里 `/*` → `/index.html` 让所有错误路径都返回首页
5. **无登录频率限制** — 可被暴力破解
6. **截止时间无范围校验** — 可存入公元 52352 年这类异常值
7. **无「忘记密码」流程** — 邮件通道已具备，实现成本低
8. **App 与 Web 版本号不同步**
9. **完成历史上限 3000 条** — 超出后丢弃最旧的，所以「历史最长连续天数」在
   极重度使用下可能被截断（统计页与热力图都受此限制）
10. **日历导出是一次性快照** — 不提供订阅地址（那需要把 token 放进 URL 或另做
    公开链接，涉及凭据泄露风险），加了新待办需要重新导出一次
11. **纪念日不支持农历** — 农历生日/祭日暂时只能按公历记；要做需引入农历换算表
12. **纪念日不参与统计、也不导出到日历** — 目前只在纪念页与首页提示条出现

---

## 十一、相关文档

- [`../README.md`](../README.md) — 项目入口与快速上手
- [`../CHANGELOG.md`](../CHANGELOG.md) — 版本更新日志与踩坑记录
- [`API.md`](API.md) — 接口文档
- [`OPERATIONS.md`](OPERATIONS.md) — 部署运维与故障排查
