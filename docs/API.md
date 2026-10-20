# HTTP 接口文档

**Base URL**：`https://yuwann-todo.netlify.app`

所有接口都在 `/api/` 前缀下，由 `todo-netlify/netlify/functions/api.js` 统一处理。

---

## 通用约定

| 项目 | 约定 |
|---|---|
| 请求体 | JSON，需带 `Content-Type: application/json` |
| 响应体 | JSON，`Content-Type: application/json; charset=utf-8`（**唯一例外**：`/api/calendar.ics` 返回 `text/calendar`） |
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
| `409` | 冲突（用户名已被注册 / 撤销时待办已存在） | 提示换一个用户名；撤销冲突时刷新列表即可 |
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
      "notifiedStages": ["3d", "1d"],
      "notifiedStage": "1d",
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
| `updatedAt` | number? | 最后一次编辑时间（没编辑过则无此字段） |
| `notifiedStages` | string[]? | **已发过的提醒档位**，取值 `3d` / `1d` / `overdue` |
| `notifiedStage` | string? | 最后一次发的是哪一档 |
| `notified` | boolean? | 兼容字段：任一一档发过即为 `true` |
| `notifiedAt` | number? | 最后一次提醒的发送时间 |

**多级提醒的档位**

| 档位 | 触发条件（距截止） | 邮件主题 | 每档次数 |
|---|---|---|---|
| `3d` | ≤ 3 天 | ⏳ 待办还有 3 天到期 | 1 次 |
| `1d` | ≤ 1 天 | ⏰ 待办即将到期 | 1 次 |
| `overdue` | < 0（已超时） | ⚠️ 待办已超时 | 1 次 |

- 定时任务每 15 分钟扫一遍；**跳档不补发**——待办直接从「剩 5 天」跳到
  「已超时」时只发超时这一封，同时把前两档一起写进 `notifiedStages`
- 旧数据只有 `notified: true` 时，视为 `["3d","1d"]` 已发，升级后不会补发
- 改截止时间会清空全部档位（见 3.4）

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
  "completionRecorded": true,
  "completedTodo": { "id": "a79b3c1d2e4f5a6b7c", "text": "提交周报", "deadline": 1790046600000, "created": 1789873848395 },
  "completionId": "3f8a1c2d9e40"
}
```

| 字段 | 说明 |
|---|---|
| `completionRecorded` | 完成历史是否写入成功。即使写入失败，待办本身也已删除，接口仍返回 200 |
| `completedTodo` | 被删除的那条待办的完整快照，**供「撤销」使用** |
| `completionId` | 本次写入的完成记录 id，撤销时用它精确回滚；写入失败时为 `null` |

> 前端拿到 `completedTodo` 与 `completionId` 后会在底部弹出 10 秒的撤销提示条，
> 点击「撤销」即调用 `POST /api/todos/restore`。

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

| 改动内容 | 对提醒状态的影响 | 原因 |
|---|---|---|
| **只改 `text`** | **保留** `notifiedStages` / `notifiedStage` / `notifiedAt` | 避免收到重复的提醒邮件 |
| **改了 `deadline`** | **全部清除**（含旧字段 `notified`） | 旧的提醒已失效，应按新时间重新走完三档 |

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

### 3.5 撤销「已完成」

```
POST /api/todos/restore
Authorization: Bearer <token>
```

把误标为「已完成」的待办放回列表，并**回滚对应的完成记录**。

**请求体**

```json
{
  "todo": {
    "id": "a79b3c1d2e4f5a6b7c",
    "text": "提交周报",
    "deadline": 1790046600000,
    "created": 1789873848395
  },
  "completionId": "3f8a1c2d9e40"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `todo.id` | 是 | 1–32 位字母数字（`[A-Za-z0-9]+`），沿用原 id |
| `todo.text` | 是 | 去空格后不能为空，超过 500 字符截断 |
| `todo.deadline` | 是 | 有限数字（毫秒时间戳） |
| `todo.created` | 否 | 缺失时用当前时间 |
| `completionId` | 否 | 传了才会回滚完成记录；不传只放回待办 |

**成功响应 `200`**

```json
{
  "ok": true,
  "todo": { "id": "...", "text": "提交周报", "deadline": 1790046600000, "created": 1789873848395, "updatedAt": 1790062898158 },
  "todos": [ /* 恢复后的完整列表 */ ],
  "completionRolledBack": true
}
```

`completionRolledBack` 为 `true` 表示完成记录确实被删掉了（热力图与统计会同步变化）。

**错误响应**

| 状态码 | error | 场景 |
|---|---|---|
| `400` | `请求格式有误` / `缺少待办数据` / `待办内容不能为空` / `截止时间无效` / `待办 id 不合法` | 参数不合法 |
| `401` | `未登录或登录已失效` | 未登录 |
| `409` | `该待办已存在` | 同 id 的待办已在列表里（例如另一台设备也撤销过） |
| `503` | `存储服务暂时不可用，请稍后重试` | 存储异常 |

> ⚠️ **为什么必须回滚完成记录**：热力图的格子数、统计页的完成数与准时率都读
> `completions:*`。只把待办放回列表而不删记录，会留下一条"其实没完成"的记录，
> 数据会慢慢变脏且极难发现。前端遇到 `409` 时会自动刷新列表，不会重复插入。

---

## 四、完成历史与统计

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
| `id` | string | 完成记录 id（12 位随机串），撤销时用于精确回滚 |
| `text` | string | 完成时的待办内容，最长 200 字符 |
| `at` | number | 完成时间（毫秒时间戳） |
| `deadline` | number \| null | 该待办原本的截止时间 |
| `onTime` | boolean \| null | 是否在截止时间之前完成；原待办无有效截止时间时为 `null` |

**重要说明**

- **上限 3000 条**，超出后自动丢弃最旧的记录
- 按 `at` 升序排列（即时间从早到晚）
- 前端热力图按**本地时区**把 `at` 归入 `YYYY-MM-DD`；
  统计接口（4.2）则由服务端按时区参数聚合，两者口径一致

### 4.2 完成统计

```
GET /api/stats?days=90&tz=480
Authorization: Bearer <token>
```

| 参数 | 默认值 | 说明 |
|---|---|---|
| `days` | `90` | 统计窗口天数，取值 1–365，越界会被夹住 |
| `tz` | `480` | 客户端时区：**比 UTC 快多少分钟**（北京 = 480） |

> ⚠️ `tz` 不是 JS 的 `getTimezoneOffset()` 返回值。北京时
> `getTimezoneOffset()` 返回 `-480`，前端要传 `-getTimezoneOffset()` 才是 `480`。
> 传错方向会让所有"天"整体错位，而且白天测试完全看不出来。

**响应 `200`（节选，字段齐全）**

```json
{
  "generatedAt": 1790062898158,
  "tzMinutes": 480,
  "days": 90,
  "range": { "from": "2026-07-23", "to": "2026-10-20" },
  "active": { "total": 5, "overdue": 1, "within1d": 1, "within3d": 1, "within7d": 1, "later": 1 },
  "done": { "total": 12, "onTime": 9, "late": 3, "unknown": 0, "inRange": 8,
            "onTimeRate": 0.75, "lateRate": 0.25 },
  "streak": { "current": 3, "longest": 6, "activeDays": 5,
              "bestDay": { "date": "2026-10-18", "count": 4 } },
  "daily": [ { "date": "2026-07-23", "count": 2, "onTime": 2, "late": 0 } ],
  "weekly": [ { "weekStart": "2026-10-19", "count": 3 } ],
  "weekday": [0, 1, 2, 3, 4, 5, 6],
  "hourly": [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 0],
  "average": { "perDayInRange": 0.27, "perActiveDay": 1.6,
               "busiestWeekday": 4, "busiestHour": 21 },
  "lead": { "count": 3, "averageMs": 172800000, "medianMs": 86400000 }
}
```

| 字段 | 说明 |
|---|---|
| `active.*` | 进行中待办按剩余时间分档：已超时 / ≤24h / ≤3d / ≤7d / 更远 |
| `done.total` | 累计完成记录条数（最多 3000） |
| `done.inRange` | 统计窗口内的完成数 |
| `done.onTimeRate` | 准时率 = `onTime / (onTime + late)`；无数据时为 `null` |
| `done.unknown` | 缺 `deadline` 的早期记录，不计入准时率 |
| `streak.current` | 当前连续完成天数（今天没完成时从昨天往前算，不清零） |
| `streak.longest` | 历史最长连续天数（跨出统计窗口也能算对） |
| `streak.bestDay` | 单日最高记录；没有记录时为 `null` |
| `daily` | 长度 = `days`，从早到晚；`daily[-1]` 是今天 |
| `weekly` | 按自然周（周一为首日）聚合 |
| `weekday` / `hourly` | 窗口内完成数的分布，下标 0 = 周日 / 0 点 |
| `average.busiestWeekday` / `busiestHour` | 最忙的星期与时段；无数据为 `null` |
| `lead` | 未完成待办的「创建 → 截止」时长统计（计划提前量） |

**错误响应**：`401 未登录或登录已失效` / `503 存储服务暂时不可用`

---

## 四·补、导出到日历（`.ics`）

### 4.补.1 导出待办

```
GET /api/calendar.ics?tz=480&alarms=1
Authorization: Bearer <token>
```

| 参数 | 默认值 | 说明 |
|---|---|---|
| `tz` | `480` | 只影响文件里的文字说明（时间本身用 UTC 表示） |
| `alarms` | `1` | 传 `0` 可去掉「提前 1 天」的提醒 |

**响应 `200`**

```
Content-Type: text/calendar; charset=utf-8
Content-Disposition: attachment; filename="todos.ics"; filename*=UTF-8''%E5%BE%85%E5%8A%9E.ics
```

```ics
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Yuwann Todo//Todo Due Calendar//CN
X-WR-CALNAME:我的待办
BEGIN:VEVENT
UID:a79b3c1d2e4f5a6b7c@yuwann-todo
DTSTAMP:20261020T070000Z
DTSTART:20261021T113000Z
DTEND:20261021T120000Z
SUMMARY:提交周报
DESCRIPTION:截止时间：2026-10-21 20:00
TRANSP:OPAQUE
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:待办还有不到 1 天到期：提交周报
TRIGGER:-P1D
END:VALARM
END:VEVENT
END:VCALENDAR
```

**设计要点**

| 决定 | 原因 |
|---|---|
| 用 `VEVENT` 而不是 `VTODO` | `VTODO` 是待办的标准表示，但 **Google 日历支持极差**（导入后常常什么都不显示）；`VEVENT` 在所有日历里都能正常导入 |
| 每条待办 = 30 分钟日程，**结束时间 = 截止时间** | 日历里看到的时间就是截止时间，直观 |
| 时间统一用 UTC（`...Z`） | 导入方会自动换算成当地时区，也不需要手写 `VTIMEZONE` 规则 |
| 每行折行到 ≤ 75 **字节** | RFC 5545 的硬要求；中文一个字 3 字节，30 字标题必然超限，不折行部分日历会解析失败 |
| `,` `;` `\` 换行做转义 | 否则一个逗号就能破坏整个文件结构 |
| 前端用 `fetch` + `Blob` 下载 | 直接打开 URL 会丢 `Authorization` 头（401）；把 token 放查询串又会留在浏览器历史和访问日志里 |

**错误响应**：`401 未登录或登录已失效` / `503 存储服务暂时不可用`

---

## 四·补二、纪念

纪念日是「有纪念意义的日期」（生日、在一起的纪念日、毕业那天…），
与待办**完全分开存储**：待办完成即删除，纪念日要长期保留。

> **日期一律用 `"YYYY-MM-DD"` 字符串，不用时间戳。**
> 纪念日是日历上的一天，不是某个瞬间。若存时间戳，
> 北京时间 `2023-05-20 00:00` 在 UTC 里是 `2023-05-19 16:00`，
> 再"取日期"就会变成 5 月 19 日 —— 纪念日硬生生错一天。
>
> 「还有几天」由**前端**按本机时区计算，服务端只负责存与校验。

### 4补二.1 获取纪念日列表

```
GET /api/memorials
Authorization: Bearer <token>
```

**响应 `200`**

```json
{
  "memorials": [
    {
      "id": "3910cd902673",
      "title": "在一起",
      "date": "2023-05-20",
      "repeat": "year",
      "note": "第一次见面",
      "created": 1792489508356
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 12 位随机串 |
| `title` | 纪念什么，≤ 50 字 |
| `date` | `"YYYY-MM-DD"`，必须是真实存在的日期 |
| `repeat` | `"year"` 每年重复 ｜ `"none"` 只此一次 |
| `note` | 备注，可为空字符串，≤ 200 字 |
| `created` / `updatedAt` | 创建 / 最后修改时间戳 |

列表顺序由前端决定（今天与将到的排前面，过去的排后面）。

### 4补二.2 新增纪念日

```
POST /api/memorials
Authorization: Bearer <token>
```

```json
{ "title": "在一起", "date": "2023-05-20", "repeat": "year", "note": "第一次见面" }
```

| 字段 | 必填 | 校验 |
|---|---|---|
| `title` | 是 | 去空格后不能为空，超 50 字截断 |
| `date` | 是 | 必须 `YYYY-MM-DD` 且真实存在（`2023-02-30`、平年 `2023-02-29` 拒绝、必须补零） |
| `repeat` | 否 | `year` / `none`，**默认 `year`** |
| `note` | 否 | ≤ 200 字 |

**成功响应 `201`**：`{ memorial, memorials }`（含完整列表，前端拿到即可渲染）
**错误**：`400` 参数不合法 / 超出条数上限（500 条）、`401`、`503`

### 4补二.3 修改纪念日

```
PATCH /api/memorials/<id>
Authorization: Bearer <token>
```

只改传入的字段；`updatedAt` 会被刷新。

- `404` `该纪念日不存在`
- `400` `没有要修改的内容`（空对象）或字段不合法

### 4补二.4 删除纪念日

```
DELETE /api/memorials/<id>
Authorization: Bearer <token>
```

**成功 `200`**：`{ ok: true, memorials: [...] }`；不存在时 `404`

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
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS
```

---

## 九、测试

### 9.1 无需部署的本地测试（快，覆盖核心逻辑）

```bash
cd todo-netlify
node test-stats.mjs        # 统计计算：时区切天、准时率、连续天数、分布
node test-ics.mjs          # 日历生成：结构、转义、75 字节折行、UTC 时间
node test-notify.mjs       # 多级提醒：三档判定、逐档升级、跳档不补发、旧数据兼容
node test-api-local.mjs    # 真实 api.js 全部路由（内存版 Blobs，无需 Netlify）
node test-ui-logic.mjs     # 前端内联脚本：统计页渲染、撤销提示、颜色分档
node test-memorial.mjs     # 纪念日校验（日期合法性、闰年、补零）
node test-heatmap.mjs      # 热力图逻辑
```

`test-api-local.mjs` 的做法值得一提：它把 `api.js` 与 `lib/` 复制到临时目录，
再放一个**内存版 `@netlify/blobs`** 替身（Node 会逐级向上查找 `node_modules`），
于是能在本机直接打真实路由，完全不需要部署或网络。

### 9.2 对已部署后端跑接口验收

```bash
cd todo-netlify
./test-features.sh https://<预览地址>--yuwann-todo.netlify.app   # 撤销/统计/日历/编辑
cd ../todo-deno
./test.sh https://yuwann-todo.netlify.app                       # 注册/登录/增删/隔离/同步
```

两个脚本都会注册临时账号（`feat<时间戳>` / `deno<时间戳>`），只操作自己的数据，
不会碰到真实用户。

覆盖内容：

| 分组 | 断言 |
|---|---|
| 注册 / 登录 | 返回 token、重复注册 409、弱密码 400、非法用户名 400、密码错误 401、`me` 返回正确用户名 |
| 待办增删查 | 新增返回 id、列表数量、空文本 400、无效时间 400、删除 200、删除不存在 404 |
| **撤销完成** | 返回 `completedTodo`/`completionId`、待办回到列表、完成记录回滚、重复撤销 409、非法参数 400、不带 id 也能放回 |
| **统计** | 空账号初始值、`days`/`tz` 参数生效、完成后准时率与连续天数变化、撤销后回落 |
| **日历导出** | `Content-Type`、空账号合法、事件数与标题、`VALARM` 开关、CRLF 行尾、无超过 75 字节的行 |
| 编辑待办 | 改名、改时间、`updatedAt`、空文本 400、不存在 404 |
| **纪念** | 增删改查、默认每年重复、非法日期/空名称/缺日期/非法重复方式 400、未登录 401 |
| 鉴权安全 | 无 token 401、伪造 token 401、登出后旧 token 失效 401 |
| 多用户隔离 / 跨设备同步 | A 的数据 B 看不到；两个会话 token 不同、设备间改动互相可见 |

---

## 十、相关文档

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — 架构、数据模型、设计决策
- [`OPERATIONS.md`](OPERATIONS.md) — 部署、环境变量、故障排查
- [`../CHANGELOG.md`](../CHANGELOG.md) — 版本更新日志
