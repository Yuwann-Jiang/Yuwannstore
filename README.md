# 待办事项（Todo）

一个带**账号系统、多设备同步、到期邮件提醒和完成热力图**的待办清单应用。

从单文件网页起步，演进为「Netlify 云端服务 + PWA + 安卓安装包」的完整产品。

---

## 线上地址

| 用途 | 地址 |
|---|---|
| **主站（Web / PWA）** | https://yuwann-todo.netlify.app/ |
| 后端 API | https://yuwann-todo.netlify.app/api/ |
| 提醒任务状态（公开） | https://yuwann-todo.netlify.app/api/notify-status |
| 安卓安装包 | `todo-app-native/unpackage/release/apk/`（本地） |
| 遗留静态站（旧版，无账号） | https://yuwann-jiang.github.io/Yuwannstore/ |

---

## 功能一览

| 功能 | 说明 |
|---|---|
| **账号系统** | 用户名 + 密码，PBKDF2-SHA256 加盐哈希，会话 30 天 |
| **多设备同步** | 同一账号在任何设备登录看到同一份数据 |
| **待办管理** | 添加（含截止时间）、标记完成（即删除）、列表排序 |
| **到期着色** | 🔴 ≤24 小时　🟡 >24 小时且 ≤4 天　🟢 >4 天 |
| **邮件提醒** | 剩余不足 1 天自动发邮件，每条只提醒一次，每 15 分钟检查 |
| **完成热力图** | GitHub 贡献图风格，点击方格看当天完成了哪些任务 |
| **PWA** | 可「添加到主屏幕」，断网也能打开 |
| **安卓 App** | HBuilderX 打包的 5+App，后端复用同一套 API |

---

## 30 秒快速上手

```bash
# 1) 本地跑起来（零依赖，只用 Node 内置模块）
cd todo-server && node server.js
#    访问 http://127.0.0.1:8123/

# 2) 跑测试（对线上环境做全链路验证）
./todo-deno/test.sh https://yuwann-todo.netlify.app     # 23 项接口测试
cd todo-netlify
node test-heatmap.mjs    # 24 项热力图逻辑
node test-notify.mjs     # 26 项提醒逻辑
node test-smtp.mjs       # 18 项 SMTP 协议

# 3) 部署到线上（详见 docs/OPERATIONS.md）
cd todo-netlify && ./netlify.sh deploy --prod --dir=public \
  --functions=netlify/functions --site=yuwann-todo
```

> ⚠️ 部署命令里的 `--site=yuwann-todo` **必须用站点名，不能用站点 ID**，
> 否则这个版本的 CLI 会报误导性的 `Site not found`。详见 `docs/OPERATIONS.md`。

---

## 目录结构

```
Yuwannstore/                     ← GitHub 仓库根目录
├── README.md                    ← 你在这里
├── CHANGELOG.md                 版本更新日志（所有改动都必须记在这里）
├── LICENSE                     Apache License 2.0
├── index.html                  ★ 遗留静态版（GitHub Pages 用，见下方说明）
├── docs/                       项目文档
│   ├── ARCHITECTURE.md         架构与工作逻辑
│   ├── API.md                  HTTP 接口文档
│   ├── OPERATIONS.md           部署运维与故障排查
│   └── legacy-static-version.md 旧版静态应用的功能说明（你原先写在 README 的内容）
│
├── todo-netlify/               ★ 生产环境（当前线上版本）
│   ├── netlify/functions/
│   │   ├── api.js              主 API（账号 / 待办 / 编辑 / 完成历史 / 管理员）
│   │   └── notify.js           定时任务（每 15 分钟发提醒邮件）
│   ├── lib/notify.js           提醒核心逻辑 + 自实现的 SMTP 客户端
│   ├── public/                 前端（单文件 index.html + PWA 资源）
│   │   ├── index.html          完整应用（含热力图、离线缓存、管理后台）
│   │   ├── sw.js               Service Worker
│   │   ├── manifest.webmanifest PWA 清单
│   │   └── icons/              应用图标
│   ├── netlify.toml            站点配置（路由、响应头）
│   ├── netlify.sh              CLI 包装脚本（受限环境下规避权限问题）
│   ├── test-*.mjs              测试脚本（接口 / 提醒 / SMTP / 热力图）
│   ├── make-icons.py           PWA 图标生成（纯 Python 手写 PNG，零依赖）
│   └── make-native-assets.py   安卓图标与启动图生成
│
├── todo-app-native/            ★ 安卓 App 打包工程（HBuilderX 5+App）
│   ├── manifest.json           应用配置（AppID H5E0B88F1）
│   ├── index.html              自动生成，勿手改（由 build-native-html.py 产出）
│   ├── unpackage/res/          图标与启动图
│   └── README.md               打包操作说明
│
├── todo-server/                本地版（局域网同步，用于开发调试）
│   ├── server.js               Node 后端（零依赖，JSON 文件存储）
│   ├── public/index.html       前端
│   └── README.md               使用说明
│
├── todo-worker/                备用：Cloudflare Worker 后端（接口契约一致）
│   └── wrangler.sh             CLI 包装脚本
└── todo-deno/                  备用：Deno Deploy 后端（接口契约一致）
    └── test.sh                 ★ 23 项接口测试脚本（对任意后端可用）
```

★ = 当前实际使用中

### 关于根目录的 `index.html`

它是最早的**纯前端 localStorage 版本**（v0.3.0），保留在仓库根目录是为了让
已有的 GitHub Pages 链接继续可用：

- GitHub Pages（旧版，无账号系统）：
  **https://yuwann-jiang.github.io/Yuwannstore/**
- 新版（生产环境）：
  **https://yuwann-todo.netlify.app/**

### 关于 `.gitignore`

本仓库的 `.gitignore` 采用**白名单**策略：本机工作区里还有其它无关项目与大量
缓存目录，因此先忽略一切、再逐项放行本项目文件。

> ⚠️ **新增文件时，记得在 `.gitignore` 的「第二步：放行项目文件」里加一行**，
> 否则不会被提交。

已被排除的敏感内容：`.admin-password`、`.admin-secret`、`.notify-secret`、
`todo-server/data.json`、`node_modules/`、各类工具缓存与打包产物。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | 按版本号整理的完整更新日志，含每个版本的踩坑记录 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 系统架构、数据模型、请求流程、关键设计决策与原因 |
| [`docs/API.md`](docs/API.md) | 全部 HTTP 接口的请求/响应格式与错误码 |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | 部署流程、环境变量、日常运维、故障排查手册 |

**建议阅读顺序**：本文件 → `ARCHITECTURE.md` → `API.md` → `OPERATIONS.md`

---

## ⚠️ 开发约定

> **所有改动都必须写进 [`CHANGELOG.md`](CHANGELOG.md)。**

- 功能变更 / Bug 修复 / 配置调整 → 都要新增日志条目
- 记录内容至少含：日期、版本号、改了什么、**为什么这么改**
- **踩过的坑务必写下**——这是日志最有价值的部分
- 接口 / 架构 / 部署方式变化时，同步更新 `docs/` 下对应文档

详细规则见 [`CHANGELOG.md`](CHANGELOG.md) 开头的「维护约定」。

---

## 技术栈

| 层 | 技术 | 备注 |
|---|---|---|
| 前端 | 原生 HTML/CSS/JS 单文件 | 无框架、无构建步骤 |
| 后端 | Netlify Functions（Node） | 无第三方运行时依赖（除 `@netlify/blobs`） |
| 存储 | Netlify Blobs | 键值存储，强一致读 |
| 邮件 | QQ 邮箱 SMTP | 基于 `node:tls` 自实现客户端 |
| 定时 | Netlify Scheduled Functions | cron `*/15 * * * *` |
| App | HBuilderX 5+App | WebView 套壳，云端打包 |

---

## 当前状态

**可用。** 线上服务正常运行，已通过：
- 23 项接口测试（注册/登录/增删/鉴权隔离/跨设备同步）
- 24 项热力图逻辑测试
- 26 项提醒逻辑测试
- 18 项 SMTP 协议测试

### 已知限制

1. **`netlify.app` 的 IPv4 在中国大陆被阻断**（IPv6 正常）
   - 影响：QQ/微信内置浏览器等**只走 IPv4** 的应用打不开；系统浏览器（走 IPv6）正常
   - 详见 `docs/OPERATIONS.md` 的「网络可达性」
2. **热力图只能从 2026-09-28 起累积**，历史完成记录不存在
3. **忘记密码无法找回**（无邮箱验证/重置流程）
4. **截止时间无范围校验**，可存入不合理的时间值
5. 安卓包与产品版本号不同步

### 待办事项（建议后续优先处理）

- [ ] 解决中国大陆访问问题（买域名绑 Cloudflare Worker，或换国内可达托管）
- [ ] 加数据导出/备份功能（目前数据仅存于 Netlify Blobs 单点）
- [ ] 加「编辑待办」功能（现在只能加和删）
- [ ] 加截止时间范围校验
- [ ] 加登录频率限制（防暴力破解）
- [ ] 加「忘记密码」流程（邮件通道已具备）
- [ ] 统一安卓包与产品版本号

---

## 联系与归属

- GitHub：https://github.com/Yuwann-Jiang
- 安卓应用包名：`com.yuwann.todo`
- DCloud AppID：`H5E0B88F1`
