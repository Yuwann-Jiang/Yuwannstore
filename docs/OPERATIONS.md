# 部署、运维与故障排查

本手册面向**实际操作**：怎么部署、怎么改配置、出问题怎么查。

---

## 一、环境变量

全部配置在 **Netlify 站点环境变量**里，不写死在代码中。

| 变量名 | 用途 | 必需 |
|---|---|---|
| `QQ_USER` | 发件邮箱地址（如 `1366413810@qq.com`） | 邮件提醒必需 |
| `QQ_AUTH_CODE` | QQ 邮箱**授权码**（16 位，**不是**登录密码） | 邮件提醒必需 |
| `ADMIN_SECRET` | 保护管理员初始化接口的密钥 | 管理员功能必需 |
| `APP_URL` | 邮件里「打开待办清单」按钮的跳转地址 | 可选，默认站点首页 |
| `NOTIFY_SECRET` | 手动触发 `/api/run-notify` 的密钥 | 可选 |

作用域均为 `builds, functions, post_processing, runtime`。

### 查看与修改

**方式一：网页控制台**（推荐给非技术同学）

> Site configuration → Environment variables

**方式二：Netlify CLI**

```bash
cd todo-netlify
export NETLIFY_AUTH_TOKEN='<你的 token>'
export NETLIFY_SITE_ID='<站点 ID>'        # 注意：env 命令用 ID，不是名字

./netlify.sh env:list
./netlify.sh env:set QQ_USER "someone@qq.com"
./netlify.sh env:unset QQ_USER
```

**方式三：直接调 API**

```bash
curl -H "Authorization: Bearer <token>" \
  "https://api.netlify.com/api/v1/accounts/<account_id>/env?site_id=<site_id>"
```

> 改了环境变量后，**需要重新部署**函数才会读到新值。

### 如何获取 QQ 邮箱授权码

1. 登录 https://mail.qq.com
2. 设置 → 账号 → 找到「POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV服务」
3. 开启 **IMAP/SMTP 服务**（需手机发短信验证）
4. 复制生成的 **16 位授权码**

> 不想再发邮件时，在同一页面删除该授权码即可立即作废，网站其他功能不受影响。

### 管理员账户管理

管理员身份由数据库里的 `isAdmin` 标志决定（**不是**用户名）。查看与创建方式：

**创建管理员**（需要 `ADMIN_SECRET`）

```bash
SECRET=$(cat todo-netlify/.admin-secret)      # 或从 Netlify 控制台复制
curl -X POST https://yuwann-todo.netlify.app/api/admin/bootstrap \
  -H 'Content-Type: application/json' \
  -d "{\"secret\":\"$SECRET\",\"username\":\"admin\",\"password\":\"你的密码\"}"
```

**把已有账号提升为管理员**（会保留原有待办数据，不重置密码）

```bash
curl -X POST https://yuwann-todo.netlify.app/api/admin/bootstrap \
  -H 'Content-Type: application/json' \
  -d "{\"secret\":\"$SECRET\",\"username\":\"Yuwann\",\"password\":\"随便填不影响\"}"
```

**同时重置密码**：加 `"resetPassword": true`

**查看当前管理员**：用管理员账号访问 `/api/admin/overview`，
响应里的 `stats.adminCount` 即为管理员数量。

> ⚠️ **安全提醒**
> - 管理员能看到**所有用户**的待办、完成记录、绑定邮箱
> - 因此管理员账号的密码必须足够强，且不要与日常账号共用
> - 管理员**看不到**任何用户的密码（数据库里只有不可逆的哈希）
> - `ADMIN_SECRET` 泄露等同于任何人可提权，务必妥善保管、不要提交到仓库

**本项目的管理员凭据**保存在：

| 文件 | 内容 |
|---|---|
| `todo-netlify/.admin-password` | 管理员账号密码（权限 600） |
| `todo-netlify/.admin-secret` | 管理员初始化密钥（权限 600） |

两个文件都已在 `.gitignore` 中忽略。

---

## 二、部署 Web 版

### 2.1 命令行部署（当前使用的方式）

```bash
cd todo-netlify
export NETLIFY_AUTH_TOKEN='<token>'

./netlify.sh deploy --prod \
  --dir=public \
  --functions=netlify/functions \
  --site=yuwann-todo
```

> ### ⚠️ 必须用站点名，不能用站点 ID
>
> 本项目使用的 netlify-cli 17.38.1 是旧版，**按站点名称解析站点**。
> 传站点 ID 会报 `Error: Site not found. Please rerun "netlify link"` —— 这个提示极具误导性，
> 实际原因只是它拿 ID 当名字去查了。
>
> | 命令 | 站点标识用 |
> |---|---|
> | `deploy` | **站点名** `yuwann-todo` |
> | `env:*`、`blobs:*` | **站点 ID**（通过 `NETLIFY_SITE_ID` 环境变量） |

### 2.2 为什么用 `./netlify.sh` 而不是直接 `netlify`

`netlify-cli` 默认把配置写到 `~/Library/Preferences/netlify`，
该目录在受限环境下没有写权限，会报 `EPERM`。

`netlify.sh` 把 `HOME` 重定向到项目内的临时目录（实际文件基于脚本自身位置计算路径）：

```bash
#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
export HOME="$HERE/.fake-home"                   # 不污染系统目录，已被 .gitignore 忽略
mkdir -p "$HOME"
exec "$HERE/node_modules/.bin/netlify" "$@"
```

> 这个脚本是**环境适配**，不是项目逻辑。在权限正常的机器上可以直接用
> `npx netlify deploy ...`，不需要它。

### 2.3 部署产物说明

| 内容 | 来源 | 说明 |
|---|---|---|
| 静态文件 | `public/` | 前端页面、PWA 资源、图标 |
| 函数 `api` | `netlify/functions/api.js` | 主 API，路由 `/api/*` |
| 函数 `notify` | `netlify/functions/notify.js` | 定时任务，cron `*/15 * * * *` |
| 配置 | `netlify.toml` | 路由规则、响应头 |

### 2.4 部署后必做的验证

```bash
B=https://yuwann-todo.netlify.app

# 1) 站点存活
curl -s -o /dev/null -w "%{http_code}\n" $B/

# 2) 接口全链路（23 项断言）
cd todo-deno && ./test.sh $B

# 3) 定时任务是否在跑
curl -s $B/api/notify-status

# 4) PWA 资源是否正常
curl -s -o /dev/null -w "%{http_code}\n" $B/manifest.webmanifest
curl -s -o /dev/null -w "%{http_code}\n" $B/sw.js
```

---

## 二·补、⚠️ Netlify 免费版积分制（部署前必读）

2025-09-04 之后注册的 Netlify 账号采用**积分制**，不再有独立的"带宽额度 / 构建分钟"。
**每月 300 积分，硬上限，用完即停止相关操作，不能超额。**

### 各项操作的积分消耗

| 操作 | 消耗 | 只花在这一项时的上限 |
|---|---|---|
| **正式部署（production deploy）** | **15 积分 / 次** | **约 20 次 / 月** |
| 带宽 | 20 积分 / GB | 约 15 GB |
| Web 请求 | 2 积分 / 万次 | 约 150 万次 |
| 函数计算 | 10 积分 / GB·小时 | 约 30 GB·小时 |
| **部署预览 / 分支部署** | **免费** | 不限 |
| **失败的部署** | **免费** | — |

### 本项目踩过的坑（2026-09-30）

开发过程中累计执行了 **26 次正式部署 × 15 = 390 积分**，超出 300 额度，于是：

```
Error: JSONHTTPError: 403
{ "error": "Account credit usage exceeded - new deploys are blocked until credits are added" }
```

**注意此时的现象**：

- ✅ **线上站点完全不受影响**——首页、API、定时任务全部正常运行
- ❌ 只是**无法再部署新代码**

> 📌 换句话说：**积分耗尽 ≠ 网站挂了**，只是不能更新。别误判成故障。
> （本项目此前两次"网站打不开"都是网络问题或浏览器缓存，与额度无关。）

### 应对方式

| 方案 | 说明 |
|---|---|
| **等下一个计费周期** | 本项目计费周期为每月 20 日重置 |
| **购买积分包** | Netlify 控制台可购买 |
| **用部署预览代替正式部署** | 开发调试阶段用，**完全免费** |
| **迁移到其它平台** | 见下方「备选方案」 |

### 开发阶段务必用部署预览（免费）

```bash
cd todo-netlify

# ❌ 不要这样（15 积分/次）
./netlify.sh deploy --prod --dir=public --functions=netlify/functions --site=yuwann-todo

# ✅ 调试阶段用这个（免费），会得到一个临时 URL
./netlify.sh deploy --dir=public --functions=netlify/functions --site=yuwann-todo
# → Website draft URL: https://<deploy-id>--yuwann-todo.netlify.app
```

部署预览**拥有独立的前端与函数实例**，可以完整验证功能（含后端改动），
确认无误后再执行一次 `--prod` 正式发布。

> 💡 这是本项目最重要的成本控制手段：**把正式部署次数压到最低**。
> 改多处代码时攒在一起部署一次，不要每改一点就发一次。

### 备选方案（若不想受积分限制）

仓库里已准备好两套**可直接启用**的后端实现：

| 目录 | 平台 | 状态 |
|---|---|---|
| `todo-worker/` | Cloudflare Workers | 代码已完成并部署成功过，但 `workers.dev` 域名在中国大陆被墙，需绑自定义域名 |
| `todo-deno/` | Deno Deploy | 代码已完成，但该平台当时不接受新用户注册 |

两者的接口与 Netlify 版**完全一致**（同一套 API 契约），前端只需改 `API_BASE` 即可切换。

---

## 三、本地开发

### 3.1 零依赖本地版（最快）

```bash
cd todo-server && node server.js
# http://127.0.0.1:8123/
```

- 只用 Node 内置模块，**无需 npm install**
- 数据存在 `todo-server/data.json`（**首次注册时自动创建**，不是必需预先存在）
- 端口可通过 `PORT=9000 node server.js` 修改
- 支持局域网访问（`http://<本机IP>:8123/`），可用于手机联调

删除 `data.json` 即可清空所有账号与待办。

> ⚠️ **这个本地版是简化实现，只覆盖最早的注册/登录/增删待办。**
> 编辑待办、撤销、统计、日历导出、管理员、邮箱绑定、邮件提醒**都只有
> Netlify 生产版才有**（`todo-netlify/`）。要完整联调请改用
> `node test-api-local.mjs`（在临时目录里跑真实 `api.js`，内存存储、无需部署）。

### 3.2 前端调试

前端是单文件 `public/index.html`，改完直接部署或本地打开即可，**没有构建步骤**。

注意后端地址自动判定逻辑：

```js
const API_BASE = window.__API_BASE__ || (SAME_ORIGIN ? "" : NETLIFY_API_BASE);
```

| 页面来源 | API 指向 |
|---|---|
| Netlify 站点 | 同源（空字符串） |
| 本地 Node 服务 | 同源（空字符串） |
| GitHub Pages | `https://yuwann-todo.netlify.app` |
| 安卓 App | 由 `__API_BASE__` 注入 |

### 3.3 运行测试

**本地测试（不需要部署、不需要网络）**

```bash
cd todo-netlify
node test-stats.mjs        # 21 项：统计计算（时区切天、准时率、连续天数、分布）
node test-ics.mjs          # 15 项：日历生成（结构、转义、75 字节折行、UTC 时间）
node test-notify.mjs       # 72 项：多级提醒（三档、逐档升级、跳档、旧数据兼容、重试）
node test-api-local.mjs    # 27 项：真实 api.js 全部路由（内存版 Blobs）
node test-ui-logic.mjs     # 22 项：前端内联脚本（统计渲染、撤销提示、颜色分档）
node test-heatmap.mjs      # 24 项：热力图日期归组、颜色分级、连续天数
node test-smtp.mjs         # 18 项：SMTP 协议、邮件报文构造（本地假服务器，无需真实凭据）
```

几个测试的特别之处：

| 脚本 | 做法 |
|---|---|
| `test-api-local.mjs` | 把 `api.js` 与 `lib/` 复制到临时目录，放一个**内存版 `@netlify/blobs`** 替身（Node 逐级向上找 `node_modules`），于是能在本机打真实路由 |
| `test-ui-logic.mjs` / `test-heatmap.mjs` | 用最小 DOM 替身 / 从 `index.html` 提取真实函数来测，不是测副本 |
| `test-notify.mjs` | 用模拟存储 + 模拟邮件器，**不会真的发信** |

**对已部署后端做接口验收**

```bash
cd todo-netlify
./test-features.sh https://<预览地址>--yuwann-todo.netlify.app   # 撤销/统计/日历/编辑，56 项
cd ../todo-deno
./test.sh https://yuwann-todo.netlify.app                       # 注册/登录/增删/隔离/同步，23 项
```

两个脚本都会注册临时账号（`feat<时间戳>` / `deno<时间戳>`），只操作自己的数据，
不影响真实用户；跑完可在管理员后台手动清理。

---

## 四、部署安卓 App

App 是 HBuilderX 5+App 工程，位于 `todo-app-native/`。

### 4.1 更新 App 内容

网页版改动后，需重新生成 App 内页面：

```bash
cd todo-netlify && python3 build-native-html.py
```

这会读取 `public/index.html`，注入配置后写到 `todo-app-native/index.html`。
两边共用同一份源码，**不要手改 `todo-app-native/index.html`**。

### 4.2 打包（必须在 HBuilderX 界面操作）

> **云端打包无法用命令行完成。** 我实测过 HBuilderX 的 CLI，
> 它只有 `launch` / `logcat` / `devices` / `installPlugin` 等命令，**没有云打包接口**。

步骤：

1. 打开 HBuilderX，**文件 → 打开目录** → 选择 `todo-app-native`
2. 右上角登录 DCloud 账号（云打包必需）
3. 双击 `manifest.json`，确认：
   - 基础配置里的 **AppID** 为 `H5E0B88F1`（已注册）
   - 版本号按需递增（**改动后务必递增**，否则升级安装会有问题）
4. 菜单 **发行 → 原生App-云打包**
   - ☑ Android(apk包)
   - 包名 `com.yuwann.todo`
   - 证书：**使用DCloud老版证书**（免费）
   - 打包类型：**正式版**
5. 点打包，等待几分钟，APK 输出到 `unpackage/release/apk/`

iOS 打包需要苹果开发者账号（$99/年）与证书，没有的话只能出安卓包。

### 4.3 重新生成图标与启动图

图标由脚本生成（纯 Python 手写 PNG 编码器，零依赖）：

```bash
cd todo-netlify
python3 make-icons.py           # PWA 图标 → public/icons/
python3 make-native-assets.py   # App 图标与启动图 → todo-app-native/unpackage/res/
```

改配色只需修改脚本顶部的颜色常量后重跑。

---

## 五、日常运维

| 任务 | 频率 | 操作 |
|---|---|---|
| 查看提醒任务是否正常 | 偶尔 | 访问 `/api/notify-status`，看 `agoMinutes` 是否 < 15 |
| 清理测试账号 | 按需 | 见下方「数据管理」 |
| 检查带宽用量 | 每月 | 见下方「用量查询」 |
| 数据备份 | **建议定期** | 见下方「数据备份」 |
| 更新 App | 功能变更时 | 重新生成页面 + HBuilderX 打包 |

### 数据管理（Netlify Blobs）

```bash
cd todo-netlify
export NETLIFY_AUTH_TOKEN='<token>'
export NETLIFY_SITE_ID='<站点 ID>'

# 列出所有键
./netlify.sh blobs:list todo-app

# 读取某个键
./netlify.sh blobs:get todo-app "todos:Yuwann"
./netlify.sh blobs:get todo-app "user:Yuwann"

# 写入（覆盖）
./netlify.sh blobs:set todo-app "some:key" '{"a":1}'

# 删除
./netlify.sh blobs:delete todo-app "debug:probe"
```

数据键的结构见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 的「数据模型」。

> ⚠️ `blobs:*` 命令不支持 `--site` 参数，必须通过 `NETLIFY_SITE_ID` 环境变量指定站点。

### 清理测试账号

接口测试脚本（`test-features.sh` / `todo-deno/test.sh`）每跑一次就会注册一个
`feat<时间戳>` 或 `deno<时间戳>` 的临时账号，久了会让管理员后台的用户列表变脏。

```bash
cd todo-netlify
node cleanup-test-users.mjs            # 只预览会被删的账号
node cleanup-test-users.mjs --apply    # 真正删除
```

- 只匹配「前缀 + 10 位时间戳」这种自动生成的名字，**真实账号（含中文名）一律保留**
- 用的是 `@netlify/blobs` SDK（`siteID` + `token`），不要改回 `netlify blobs:delete`
  CLI：每个 key 启一次进程，删上百个 key 会超时并留下删一半的状态
- 会话 key（`session:*`）无法从用户名反查，靠 30 天自动过期清理

### 数据备份

目前**没有自动备份**，数据只在 Netlify Blobs 单点。建议定期手工导出：

```bash
cd todo-netlify
export NETLIFY_AUTH_TOKEN='...' NETLIFY_SITE_ID='...'
mkdir -p backup/$(date +%F)
for k in $(./netlify.sh blobs:list todo-app 2>/dev/null | grep -o -E '\| [a-z]+:[^ ]+' | sed 's/^| //;s/ *$//'); do
  ./netlify.sh blobs:get todo-app "$k" > "backup/$(date +%F)/$(echo $k | tr ':' '_').json" 2>/dev/null
done
echo "备份完成：backup/$(date +%F)/"
```

恢复时用 `blobs:set` 逐条写回即可。

### 用量查询

```bash
# 带宽用量
curl -s -H "Authorization: Bearer <token>" \
  "https://api.netlify.com/api/v1/accounts/<account_id>/bandwidth"

# 部署历史
curl -s -H "Authorization: Bearer <token>" \
  "https://api.netlify.com/api/v1/sites/<site_id>/deploys?per_page=20"
```

免费额度：带宽 **100 GB/月**，函数调用 125,000 次/月。
本项目实测用量极低（带宽约 4 MB），**远不会触顶**。

> 上述额度为 2026-09 时点的公开信息，准确数值请以
> https://www.netlify.com/pricing/ 为准。

---

## 六、故障排查手册

按**症状**索引。每条都附了实际发生过的案例。

### 6.1 网站打不开

| 先查 | 命令 |
|---|---|
| 站点是否存活 | `curl -s -o /dev/null -w "%{http_code}" https://yuwann-todo.netlify.app/` |
| Netlify 服务状态 | https://www.netlifystatus.com/ |
| 带宽是否超限 | 见「用量查询」 |

**如果 curl 正常但你打不开 → 见 6.2**

### 6.2 特定设备/浏览器打不开（中国大陆网络问题）

**这是本项目最常遇到的问题。**

**症状**：电脑能开、手机 QQ/微信内置浏览器打不开；或「昨天还能开，今天不行了」。

**根因**：`netlify.app` 的 **IPv4 在中国大陆被阻断**，IPv6 正常。

```bash
# 验证方法
curl -4 -s -o /dev/null -w "IPv4: %{http_code}\n" https://yuwann-todo.netlify.app/   # 超时/000
curl -6 -s -o /dev/null -w "IPv6: %{http_code}\n" https://yuwann-todo.netlify.app/   # 200
```

**为什么表现不一致**：系统浏览器（Safari/Chrome）会优先走 IPv6，所以能开；
而 QQ/微信内置浏览器只走 IPv4，所以打不开。

**临时办法**：在 QQ/微信里点 `···` → 「在浏览器打开」。

**根治办法**（见 `README.md` 的待办清单）：
1. 买域名 + 绑到已部署好的 Cloudflare Worker（Cloudflare 的 IPv4 国内可达）
2. 或迁移到国内可达的托管平台

### 6.3 接口返回「服务器内部错误」

**症状**：注册/登录报 `服务器内部错误，请稍后重试`（500）

**排查步骤**：

1. 先看是不是存储故障——访问 `/api/notify-status`：
   - 若返回 `503 存储服务暂时不可用` → 存储故障
   - 若返回的 `lastRun` 是 `null` 但数据库里明明有值 → 读取异常
2. **重新部署一次**（历史上多次故障都是这样恢复的）：
   ```bash
   cd todo-netlify && ./netlify.sh deploy --prod --dir=public --functions=netlify/functions --site=yuwann-todo
   ```
3. 若仍失败，临时给 `api.js` 的异常处理加上错误详情，部署后看响应：
   ```js
   catch (err) {
     return json({ error: "服务器内部错误", message: String(err.message) }, 500);
   }
   ```

**历史案例**：
- `ReferenceError: crypto is not defined` —— 运行时未暴露全局 `crypto`，
  已通过 `import { webcrypto as crypto } from "node:crypto"` 修复
- Netlify Blobs 偶发故障 —— 重新部署即恢复，数据无损

### 6.4 注册后无法立即登录 / 待办删了又出现

**根因**：Netlify Blobs 默认**最终一致性**，写入后需十几秒才可读。

**已修复**：所有读操作都加了 `consistency: "strong"`。
如果这个症状重现，检查是否有新加的读取代码漏掉了这个参数：

```bash
grep -n 'store.get\|\.get(key' todo-netlify/netlify/functions/api.js   # 都应带 consistency: "strong"
```

### 6.5 定时任务不执行 / 邮件不发

**排查顺序**：

1. **查运行状态**
   ```bash
   curl -s https://yuwann-todo.netlify.app/api/notify-status
   ```
   - `agoMinutes` > 20 → 定时器没在跑
   - `configured: false` → 邮件环境变量缺失
   - `lastRun.error` 有值 → 看具体错误

2. **确认定时任务已注册**
   ```bash
   curl -s -H "Authorization: Bearer <token>" \
     "https://api.netlify.com/api/v1/sites/<site_id>/functions" | \
     python3 -c "import sys,json; [print(f['n'], f.get('schedule')) for f in json.load(sys.stdin)['functions']]"
   ```
   应看到 `notify */15 * * * *`。

3. **手动触发看细节**
   ```bash
   curl -s -X POST "https://yuwann-todo.netlify.app/api/run-notify?dry=1&secret=<NOTIFY_SECRET>"
   ```
   `dry=1` 是演习模式，不真发信、不标记，可以放心反复试。

4. **常见原因**

   | 现象 | 原因 |
   |---|---|
   | `scannedUsers: 0` | 没有用户绑定邮箱（去网页「绑定邮箱」） |
   | `due: 0` | 没有剩余不足 1 天的待办，或都已提醒过 |
   | `failed` 有值 | SMTP 认证失败 → 授权码过期或被删除，重新生成 |
   | `error` 含「未配置」 | `QQ_USER` / `QQ_AUTH_CODE` 缺失，去环境变量补齐后**重新部署** |

5. **兜底方案**：`/api/run-notify` 可被外部定时器调用
   （如 cron-job.org），万一 Netlify 调度失效也能顶上。

### 6.6 部署报 `Site not found`

见「2.1 必须用站点名，不能用站点 ID」。

### 6.7 函数打包卡死 / 部署退出码 13

**症状**：`netlify deploy` 输出 `Warning: Detected unsettled top-level await`，
进程异常退出，退出码 13，**没有任何有效错误信息**。

**根因**：函数依赖里引入了 esbuild 打包不了的大包。
本项目在引入 **nodemailer** 时精确复现过这个问题。

**解决办法**：不要引入 nodemailer。邮件发送已用 `lib/notify.js` 里
基于 `node:tls` 手写的 SMTP 客户端实现，**零依赖**。

如果将来必须引入某个大包，可尝试在 `netlify.toml` 里标记为外部依赖：

```toml
[functions]
  node_bundler = "esbuild"
  external_node_modules = ["包名"]
```

（本项目实测对 nodemailer **无效**，最终选择了自己实现。）

### 6.8 网站显示 Netlify 的 404 页面

**排查**：

1. 确认访问的是 `https://yuwann-todo.netlify.app/`（注意 `https://` 和结尾斜杠）
2. 带参数访问以绕过浏览器缓存：`https://yuwann-todo.netlify.app/?v=2`
3. 检查静态文件是否部署成功：
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://yuwann-todo.netlify.app/index.html
   ```
4. 强制刷新（Mac：`⌘+Shift+R`）或清浏览器缓存

> `netlify.toml` 里有兜底规则 `/* → /index.html`，正常情况下任何路径都会回退到首页，
> 所以如果还看到 404，通常说明本次部署的静态文件有问题。

### 6.9 提示「存储服务暂时不可用」（503）

这是**设计如此**，表示 Netlify Blobs 读取或写入失败。

**关键：不要把它当成登录失效。** 前端已做了区分，503 不会清除登录态。

处理方式：稍等重试；若持续出现，参考 6.3 重新部署。

---

## 七、凭据与安全

### 当前使用的凭据

| 凭据 | 存放位置 | 备注 |
|---|---|---|
| **GitHub 访问令牌** | 本地 `.github-token`（权限 600，已被 `.gitignore` 忽略） | 用于 `git push`。**不要提交到仓库** |
| **Netlify 个人访问令牌** | 本地 `todo-netlify/.netlify-token`（权限 600，已被 `.gitignore` 忽略）；`netlify.sh` 会自动读取并导出为 `NETLIFY_AUTH_TOKEN` | 用于部署与数据管理 |
| QQ 邮箱授权码 | Netlify 环境变量 | 仅用于发信，可随时在 QQ 邮箱作废 |
| `ADMIN_SECRET` | Netlify 环境变量 + 本地 `.admin-secret` | 保护管理员初始化接口 |
| `NOTIFY_SECRET` | Netlify 环境变量 + 本地 `.notify-secret` | 保护手动触发接口 |
| DCloud 账号 | HBuilderX 本地 | 云打包必需 |

> 本机把 GitHub 令牌保存在 `.github-token`，推送时这样用（不会写进 git 配置）：
>
> ```bash
> cd /Users/zhuyanshen/Documents/DSH
> AUTH=$(printf 'x-access-token:%s' "$(cat .github-token)" | base64)
> git -c http.extraHeader="Authorization: Basic $AUTH" push origin main
> ```

### Netlify 令牌的保存与恢复（2026-10-18 踩过的坑）

**现象**：`./netlify.sh deploy` 报

```
Error: Unauthorized: could not retrieve site
```

`.fake-home/` 里只有 `cliId`，没有用户令牌 —— 因为此前几次部署都是在命令行里临时
带 `NETLIFY_AUTH_TOKEN=xxx` 完成的，**shell 一关令牌就没了**。

**现在的做法**（已写进 `netlify.sh`，无需手动 export）：

```bash
# 1) 令牌存文件，权限 600，已在 .gitignore 第三步排除
cd todo-netlify
printf '%s\n' '你的 Netlify 个人访问令牌' > .netlify-token
chmod 600 .netlify-token

# 2) 之后直接用包装脚本，它会自动读取
./netlify.sh status     # 验证身份
./netlify.sh deploy --dir=public --functions=netlify/functions --site=yuwann-todo
```

`netlify.sh` 还会从 `.netlify/state.json` 提取 `NETLIFY_SITE_ID` 并导出 ——
因为 `env:*` / `blobs:*` 子命令**只认这个变量，不认 `--site` 参数**。

> 📌 **教训：凡靠"临时环境变量"的凭据，一定会丢。** 要么放进文件由脚本读取，
> 要么放进系统钥匙串。令牌申请/作废入口：
> https://app.netlify.com/user/applications#personal-access-tokens

### 安全建议

1. **GitHub 令牌按最小权限原则申请**
   本仓库只需要 **`repo`** 一项权限。若生成时勾选了 `admin:org`、
   `delete_repo`、`workflow` 等，建议换成更窄的令牌——权限越大，泄露后果越严重。
   管理入口：https://github.com/settings/tokens

2. **Netlify 令牌用完即删**
   删除入口：https://app.netlify.com/user/applications#personal-access-tokens

3. **令牌不要写进代码或提交到仓库**
   本项目所有脚本都通过环境变量或本机凭据文件读取，不要改成硬编码。

4. **工作区根目录已配好 `.gitignore`**
   已忽略 `.notify-secret`、`data.json`（本地版明文数据库）、`.fake-home/`、
   `.npm-cache/`、`.netlify-home/`、`unpackage/cache|release/`、`node_modules/` 等。

   > ⚠️ 但这些文件**依然存在于磁盘上**。若要提交或分享整个工作区，
   > 请先用 `git status` 确认敏感文件没有被误加，并注意工作区里
   > 还有其它无关项目（`dsh-files/`、`课程表.xlsx` 等）。

4. **不要公开 `/api/run-notify` 的密钥**
   该接口会真实发信，泄露后可能被滥用。

5. **本地版 `todo-server/data.json` 存的是明文 JSON**
   虽然密码是哈希的，但待办内容、邮箱是明文。不要公开分享该文件。

---

## 八、相关文档

- [`../README.md`](../README.md) — 项目入口与快速上手
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — 架构、数据模型、设计决策
- [`API.md`](API.md) — 接口文档
- [`../CHANGELOG.md`](../CHANGELOG.md) — 版本更新日志（含各版本的踩坑记录）
