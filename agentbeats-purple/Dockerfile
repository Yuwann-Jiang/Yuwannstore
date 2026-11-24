# Purple agent image for AgentBeats Werewolf Arena.
# Build context is the repository root: docker build -f tools/lab/agentbeats/Dockerfile .
FROM python:3.13-slim
WORKDIR /app
COPY lab/ /app/lab/
RUN pip install --no-cache-dir "a2a-sdk[http-server]>=0.3.22" "uvicorn>=0.38"
EXPOSE 9999
CMD ["python", "-m", "lab.serve_agentbeats", "--port", "9999"]
