# werewolf-purple

AgentBeats Werewolf Arena 的 purple agent（参赛方）。收到 green agent 的纯文本 prompt，
回一个严格 JSON（vote / debate / bid / night 四种形态）。

## 构建镜像（GitHub Actions，无需本地 Docker）

1. 在 GitHub 新建仓库，把本目录 push 上去（`main` 分支）；
2. Actions 会自动跑 `.github/workflows/build.yml`，产出
   `ghcr.io/<你的用户名>/werewolf-purple:latest`；
3. **到仓库 Settings → Packages 把该 package 设为 Public**（否则评测方拉不到镜像）；
4. 打开 https://agentbeats.dev/register-agent 选 purple，填镜像地址和仓库地址。

## 本地验证（有 Docker 的机器）

```bash
docker build -t werewolf-purple .
docker run -p 9999:9999 werewolf-purple
curl -s localhost:9999/.well-known/agent-card.json | head -c 200
```

## 逻辑自测（不需要 Docker / 网络）

```bash
python -m pytest tests -q      # 5 条：阶段识别、候选人、投票、竞价、发言
```

## 本地已验证（2026-11-24）

仓库自带的环境（macOS，Python 3.12.16 由 uv 装到 `~/Documents/DSH/.python`）：

```bash
cd ~/Documents/DSH && .venv-a2a/bin/python -m lab.serve_agentbeats --port 9999
curl -s localhost:9999/.well-known/agent-card.json        # → protocolVersion 0.3.0
```

实测一次真实 A2A 往返（`message/send`）返回：

```json
{"player_id": "c3d4", "reason": "c3d4场上存在感最强，先清掉带节奏的人"}
```

传输层与决策逻辑均已跑通。
