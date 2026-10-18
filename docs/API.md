# HTTP 接口文档

**Base URL**：`https://yuwann-todo.netlify.app`

所有接口都在 `/api/` 前缀下，由 `todo-netlify/netlify/functions/api.js` 统一处理。

---

## 通用约定

| 项目 | 约定 |
|---|---|
| 请求体 | JSON，需带 `Content-Type: application/json` |
| 响应体 | JSON，`Content-Type: application/json; charset=utf-8` |
| 认证方式 | 请求头 `Authorization: Bearer <token>` |
| 跨域 | 所有响应带 `Access-Control-Allow-Origin: *`，允许 App 与 GitHub Pages 调用 |
| 缓存 | 响应带 `Cache-Control: no-store` |
| 错误格式 | `{ "error": "人类可读的中文提示" }` |

### 状态码一览

| 状态码 | 含义 | 前端应如何处理 |
|---|---|---|
| `200` | 成功 | 正常渲染 |
| `201` | 创建成功 | 正常渲染 |
| `400` | 参数不合法 | 直接把 `error` 展示给用户 |
| `401` | 未登录 / 登录已失效 | 清除本地 token，回到登录页 |
| `403` | 无权限（仅手动触发接口） | 提示无权限 |
| `404` | 资源不存在 | 提示该对象不存在 |
| `409` | 冲突（用户名已被注册） | 提示换一个用户名 |
| `500` | 服务端异常 | 提示稍后重试 |
| `503` | **存储服务暂时不可用** | 提示稍后重试；**不要**清除登录态 |

> ⚠️ **`503` 与 `401` 必须区分对待。** `503` 是存储故障，不代表用户未登录。
> 早期版本把两者混为一谈，导致存储抖动时用户被反复踢回登录页。

---

## 一、账号

### 1.1 注册

```
POST /api/register
```

**请求体**

```json
{ "username": "alice", "password": "secret123" }
```

**参数校验**

| 字段 | 规则 |
|---|---|
| `username` | 3–20 位，仅允许字母、数字、下划线、中文（正则 `^[\w\u4e00-\u9fa5]{3,20}$`），首尾空格会被去除 |
| `password` | 6–128 位 |

**成功响应 `201`**

```json
{
  "token": "e2c332178a38934cdca7225d3380bbede219f2252dc221fd8fac0f3a628ae84f",
  "username": "alice"
}
```

注册后**直接返回 token**，无需再调登录接口。

**错误响应**

| 状态码 | error |
|---|---|
| `400` | `请求格式有误` / `用户名需为 3-20 位字母、数字、下划线或中文` / `密码至少 6 位` |
| `409` | `该用户名已被注册` |
| `503` | `存储服务暂时不可用，请稍后重试` |

**示例**

```bash
curl -X POST https://yuwann-todo.netlify.app/api/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"secret123"}'
```

---

### 1.2 登录

```
POST /api/login
```

**请求体**

```json
{ "username": "alice", "password": "secret123" }
```

**成功响应 `200`**

```json
{
  "token": "b55a2934422fa854f7415fde695fcdac23a9cd41d9724bf6ad385a8b977a23f5",
  "username": "alice"
}
```

**错误响应**

| 状态码 | error |
|---|---|
| `400` | `请求格式有误` |
| `401` | `用户名或密码错误` |
| `503` | `存储服务暂时不可用，请稍后重试` |

> 安全设计：用户不存在与密码错误返回**完全相同**的提示，避免攻击者枚举用户名。

---

### 1.3 登出

```
POST /api/logout
Authorization: Bearer <token>
```

删除服务端的会话记录。

**响应 `200`**

```json
{ "ok": true }
```

> 即使 token 无效也返回 200（幂等）。

---

### 1.4 查询当前用户

```
GET /api/me
Authorization: Bearer <token>
```

**响应 `200`**

```json
{ "username": "alice", "email": "alice@qq.com" }
```

`email` 未绑定时为 `null`。

**错误响应**：`401`（未登录）、`503`（存储故障）

---

## 二、提醒邮箱

### 2.1 查询绑定的邮箱

```
GET /api/profile
Authorization: Bearer <token>
```

**响应 `200`**

```json
{ "username": "alice", "email": "alice@qq.com" }
```

与 `/api/me` 返回内容一致，保留两个接口是为了语义清晰。

---

### 2.2 绑定 / 修改 / 解绑邮箱

```
POST /api/profile
Authorization: Bearer <token>
```

**请求体**

```json
{ "email": "alice@qq.com" }
```

| 传入值 | 行为 |
|---|---|
| 合法邮箱 | 绑定或修改 |
| `""`（空字符串） | **解绑** |

**校验规则**：长度 ≤ 254，且匹配 `^[^\s@]+@[^\s@]+\.[^\s@]+$`

**成功响应 `200`**

```json
{ "ok": true, "email": "alice@qq.com" }
```

解绑时返回 `{ "ok": true, "email": null }`。

**错误响应**

| 状态码 | error |
|---|---|
| `400` | `请求格式有误` / `邮箱格式不正确` |
| `401` | `未登录或登录已失效` |
| `500` | `账号数据异常`（用户记录缺失） |
| `503` | `存储服务暂时不可用，请稍后重试` |

---

## 三、待办事项

### 3.1 获取待办列表

```
GET /api/todos
Authorization: Bearer <token>
```

**响应 `200`**

```json
{
  "todos": [
    {
      "id": "a79b3c1d2e4f5a6b7c",
      "text": "提交周报",
      "deadline": 1790046600000,
      "created": 1789873848395,
      "notified": true,
      "notifiedAt": 1790062898158
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 18 位十六进制随机串 |
| `text` | string | 待办内容，最长 500 字符 |
| `deadline` | number | 截止时间（毫秒时间戳） |
| `created` | number | 创建时间（毫秒时间戳） |
| `notified` | boolean? | 是否已发过提醒邮件（未发过则无此字段） |
| `notifiedAt` | number? | 提醒发送时间 |

列表**不保证排序**，排序由前端完成（支持按剩余时间升/降序、按创建顺序）。

---

### 3.2 新增待办

```
POST /api/todos
Authorization: Bearer <token>
```

**请求体**

```json
{ "text": "提交周报", "deadline": 1790046600000 }
```

| 字段 | 校验 |
|---|---|
| `text` | 去除首尾空格后不能为空；超过 500 字符会被截断 |
| `deadline` | 必须是有限数字（毫秒时间戳） |

> ⚠️ 目前**没有范围校验**，可以传入不合理的时间值（如公元 52352 年）。
> 这是已知技术债，见 `ARCHITECTURE.md`。

**成功响应 `201`**

```json
{
  "todo": { "id": "a79b3c1d2e4f5a6b7c", "text": "提交周报", "deadline": 1790046600000, "created": 1789873848395 },
  "todos": [ /* 更新后的完整列表 */ ]
}
```

> 同时返回完整列表，是为了规避 Netlify Blobs 的读延迟——前端拿到响应即可直接渲染，
> 无需再发一次 GET。

**错误响应**

| 状态码 | error |
|---|---|
| `400` | `请求格式有误` / `待办内容不能为空` / `截止时间无效` |
| `401` | `未登录或登录已失效` |
| `503` | `存储服务暂时不可用，请稍后重试` |

---

### 3.3 标记完成（删除）

```
DELETE /api/todos/<id>
Authorization: Bearer <token>
```

「已完成」在数据层面的含义就是**从列表中删除**；同时会往完成历史里落一条记录。

**路径参数**：`id` 为 1–32 位字母数字组合（正则 `[A-Za-z0-9]+`）

**成功响应 `200`**

```json
{
  "ok": true,
  "todos": [ /* 删除后的完整列表 */ ],
  "completionRecorded": true
}
```

`completionRecorded` 表示完成历史是否写入成功。即使历史写入失败，待办本身也已删除，
接口仍返回 200（历史记录失败不影响「完成」这个动作本身）。

**错误响应**

| 状态码 | error |
|---|---|
| `401` | `未登录或登录已失效` |
| `404` | `该待办不存在` |
| `503` | `存储服务暂时不可用，请稍后重试` |

### 3.4 编辑待办

```
PATCH /api/todos/<id>
Authorization: Bearer <token>
```

**只修改传入的字段**，未传入的字段保持不变。

**请求体**（两个字段都可选，至少传一个）

```json
{ "text": "新的名称", "deadline": 1790046600000 }
```

| 字段 | 校验 |
|---|---|
| `text` | 去除首尾空格后不能为空；超过 500 字符会被截断 |
| `deadline` | 必须是有限数字（毫秒时间戳） |

**成功响应 `200`**

```json
{
  "todo": {
    "id": "a79b3c1d2e4f5a6b7c",
    "text": "新的名称",
    "deadline": 1790046600000,
    "created": 1789873848395,
    "updatedAt": 1790062898158
  },
  "todos": [ /* 更新后的完整列表 */ ]
}
```

`updatedAt` 仅在确实发生变更时才会写入；前端据此显示「✎ 已编辑」标记。

#### ⚠️ 提醒状态的特殊处理（重要）

| 改动内容 | 对 `notified` 的影响 | 原因 |
|---|---|---|
| **只改 `text`** | **保留** | 避免收到重复的提醒邮件 |
| **改了 `deadline`** | **清除**（连同 `notifiedAt`） | 旧的提醒已失效，应按新时间重新提醒 |

这条规则已在代码中实现并有注释说明，修改此接口时**务必保持该行为**。

**错误响应**

| 状态码 | error |
|---|---|
| `400` | `请求格式有误` / `待办内容不能为空` / `截止时间无效` |
| `401` | `未登录或登录已失效` |
| `404` | `该待办不存在` |
| `503` | `存储服务暂时不可用，请稍后重试` |

> CORS 已允许 `PATCH` 方法（`Access-Control-Allow-Methods` 含 PATCH），
> 安卓 App 与 GitHub Pages 均可正常调用。

---

## 四、完成历史（热力图数据源）

### 4.1 获取完成历史

```
GET /api/completions
Authorization: Bearer <token>
```

**响应 `200`**

```json
{
  "completions": [
    {
      "text": "提交周报",
      "at": 1790062898158,
      "deadline": 1790046600000,
      "onTime": false
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string | 完成时的待办内容，最长 200 字符 |
| `at` | number | 完成时间（毫秒时间戳） |
| `deadline` | number \| null | 该待办原本的截止时间 |
| `onTime` | boolean \| null | 是否在截止时间之前完成；原待办无有效截止时间时为 `null` |

**重要说明**

- **上限 3000 条**，超出后自动丢弃最旧的记录
- 按 `at` 升序排列（即时间从早到晚）
- 前端按**本地时区**把 `at` 归入 `YYYY-MM-DD` 再统计——服务端不做日期聚合，
  否则跨时区会把凌晨完成的任务归错天

---

## 五、管理员接口

> ⚠️ **权限判定依据数据库里的 `isAdmin` 标志**，不是用户名。
> 非管理员访问一律返回 `403 需要管理员权限`。

### 5.1 初始化 / 提升管理员（密钥保护，无需登录）

```
POST /api/admin/bootstrap
```

**请求体**

```json
{
  "secret": "<ADMIN_SECRET 的值>",
  "username": "admin",
  "password": "至少6位",
  "resetPassword": false
}
```

| 字段 | 说明 |
|---|---|
| `secret` | 必须与服务端 `ADMIN_SECRET` 环境变量一致；也可改用请求头 `x-admin-secret` |
| `username` | 用户名；**已存在则提升为管理员**，不存在则新建 |
| `password` | 新建时用作密码；已存在时仅在 `resetPassword: true` 时才会重置 |
| `resetPassword` | 可选，布尔。为 `true` 且用户已存在时，会同时重置密码 |

**响应 `200`**

```json
{ "ok": true, "username": "admin", "created": true }
```

**错误响应**

| 状态码 | error |
|---|---|
| `400` | 参数不合法 |
| `403` | `密钥不正确` |
| `503` | `服务端未配置 ADMIN_SECRET，管理员功能未启用` / 存储故障 |

> 此接口**不限制「是否已存在管理员」**——否则管理员密码一旦遗失就再也无法恢复。
> 安全性完全由密钥保证。

---

### 5.2 全部用户概览

```
GET /api/admin/overview
Authorization: Bearer <管理员 token>
```

**响应 `200`**

```json
{
  "users": [
    {
      "username": "alice",
      "email": "alice@qq.com",
      "isAdmin": false,
      "createdAt": 1789873848395,
      "todoCount": 3,
      "completionCount": 12,
      "lastCompletionAt": 1790062898158
    }
  ],
  "stats": {
    "userCount": 37,
    "todoCount": 17,
    "completionCount": 9,
    "boundEmailCount": 3,
    "adminCount": 1
  }
}
```

用户按注册时间倒序排列。**响应中不含密码盐与哈希。**

**错误响应**：`403`（非管理员）、`503`（存储故障）

---

### 5.3 指定用户详情

```
GET /api/admin/users/<用户名>
Authorization: Bearer <管理员 token>
```

用户名需 URL 编码（中文用户名必须编码）。

**响应 `200`**

```json
{
  "username": "alice",
  "email": "alice@qq.com",
  "isAdmin": false,
  "createdAt": 1789873848395,
  "todos": [ /* 结构与 GET /api/todos 相同 */ ],
  "completions": [ /* 结构与 GET /api/completions 相同，按时间升序 */ ]
}
```

**错误响应**

| 状态码 | error |
|---|---|
| `400` | `用户名不合法` |
| `403` | `需要管理员权限` |
| `404` | `该用户不存在` |
| `503` | 存储故障 |

---

## 六、修改密码

```
POST /api/password
Authorization: Bearer <token>
```

**请求体**

```json
{ "oldPassword": "旧密码", "newPassword": "新密码" }
```

**校验规则**：`newPassword` 长度 6–128

**响应 `200`**

```json
{ "ok": true }
```

**错误响应**

| 状态码 | error |
|---|---|
| `400` | `请求格式有误` / `新密码至少 6 位` |
| `401` | `当前密码不正确` |
| `503` | 存储故障 |

> 修改后**旧密码立即失效**，但**已签发的会话 token 仍然有效**（不会强制下线）。

---

## 七、运维接口

### 7.1 提醒任务运行状态（公开）

```
GET /api/notify-status
```

**无需认证**，仅返回时间与计数，不含任何隐私数据。

**响应 `200`**

```json
{
  "configured": true,
  "schedule": "*/15 * * * *",
  "lastRun": {
    "at": "2026-09-28T05:19:03.000Z",
    "agoMinutes": 7,
    "trigger": "schedule",
    "sent": 0,
    "failed": 0,
    "error": null
  }
}
```

| 字段 | 说明 |
|---|---|
| `configured` | 邮件服务是否已配置（`QQ_USER` 与 `QQ_AUTH_CODE` 是否都存在） |
| `schedule` | 定时任务的 cron 表达式 |
| `lastRun.trigger` | `schedule`（定时器自动触发）或 `manual`（手动触发） |
| `lastRun` | 从未运行过时为 `null` |

**这个接口是排查「邮件不发了」的第一站**：如果 `agoMinutes` 远大于 15，说明定时器没在跑。

---

### 7.2 手动触发提醒检查（需密钥）

```
POST /api/run-notify?secret=<NOTIFY_SECRET>
```

也支持用请求头 `x-notify-secret: <NOTIFY_SECRET>` 传递密钥。

| 查询参数 | 说明 |
|---|---|
| `dry=1` | **演习模式**：只报告哪些待办需要提醒，不真正发信、不标记已提醒 |

**响应 `200`**

```json
{
  "scannedUsers": 3,
  "scannedTodos": 9,
  "due": 2,
  "sent": 2,
  "failed": 0,
  "details": [
    { "username": "alice", "todo": "提交周报", "to": "alice@qq.com", "sent": true }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `scannedUsers` | 扫描到的**已绑定邮箱**的用户数 |
| `scannedTodos` | 这些用户的待办总数 |
| `due` | 判定需要提醒的条数 |
| `sent` / `failed` | 实际发送成功 / 失败数 |
| `error` | 邮件服务未配置时会有此字段 |

**错误响应**：`403` `无权限`（密钥错误或未配置）

**示例**

```bash
# 演习（不真发信）
curl -X POST "https://yuwann-todo.netlify.app/api/run-notify?dry=1&secret=<密钥>"

# 真实触发
curl -X POST "https://yuwann-todo.netlify.app/api/run-notify?secret=<密钥>"
```

> 这个接口的存在意义：定时任务每 15 分钟才跑一次，调试时不想等。
> 同时它也可作为外部定时器的备用触发点（万一 Netlify 的调度失效）。

---

## 八、其它

### 8.1 未匹配的路径

任何未匹配到上述规则的 `/api/*` 请求返回：

```json
{ "error": "接口不存在", "path": "/api/xxx" }
```

状态码 `404`。

### 8.2 健康检查

```
GET /
```

返回前端页面（HTML），可用于确认站点存活。

### 8.3 CORS 预检

所有接口都正确处理 `OPTIONS` 请求，返回 `204` 并带完整 CORS 头：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
```

---

## 九、测试

项目自带一套接口测试脚本，会对**指定后端**跑 23 项断言：

```bash
cd todo-deno
./test.sh https://yuwann-todo.netlify.app     # 测试线上
./test.sh http://127.0.0.1:8123               # 测试本地
```

覆盖内容：

| 分组 | 断言 |
|---|---|
| 注册 | 返回 token、重复注册 409、弱密码 400、非法用户名 400 |
| 登录 | 密码错误 401、用户不存在 401、正确密码 200、`me` 返回正确用户名 |
| 待办增删查 | 新增返回 id、列表 1 条、空文本 400、无效时间 400、删除 200、删除后 0 条、删除不存在 404 |
| 鉴权安全 | 无 token 401、伪造 token 401、登出后旧 token 失效 401 |
| 多用户隔离 | A 的数据 B 看不到 |
| 跨设备同步 | 两个会话 token 不同、设备 B 能看到设备 A 的改动与删除 |

---

## 十、相关文档

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — 架构、数据模型、设计决策
- [`OPERATIONS.md`](OPERATIONS.md) — 部署、环境变量、故障排查
- [`../CHANGELOG.md`](../CHANGELOG.md) — 版本更新日志
