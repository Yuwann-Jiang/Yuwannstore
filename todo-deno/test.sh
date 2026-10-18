#!/bin/bash
# Deno 后端接口测试
# 注意：JSON 请求体先存入变量再传入，避免嵌套引号破坏 JSON。
B=${1:-http://127.0.0.1:8000}
pass=0; fail=0

chk() {
  local n="$1"
  local a="$2"
  local e="$3"
  if [ "$a" = "$e" ]; then
    echo "  PASS  $n   (实际=$a 期望=$e)"
    pass=$((pass+1))
  else
    echo "  FAIL  $n   (实际=$a 期望=$e)"
    fail=$((fail+1))
  fi
}

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }
body() { curl -s --max-time 15 "$@"; }
jq_get() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }

U="deno$(date +%s)"
U2="denob$(date +%s)"
DL=$(python3 -c 'import time;print(int((time.time()+3600)*1000))')

BODY_NEW="{\"username\":\"$U\",\"password\":\"secret123\"}"
BODY_DUP="{\"username\":\"$U\",\"password\":\"secret123\"}"
BODY_WEAK='{"username":"weakuser9","password":"12"}'
BODY_BADNAME='{"username":"a b","password":"secret123"}'
BODY_BADPW="{\"username\":\"$U\",\"password\":\"wrongpw\"}"
BODY_NOUSER='{"username":"nobody_xyz","password":"secret123"}'
BODY_LOGIN="{\"username\":\"$U\",\"password\":\"secret123\"}"
BODY_U2="{\"username\":\"$U2\",\"password\":\"secret456\"}"
TODO_A="{\"text\":\"Deno测试任务\",\"deadline\":$DL}"
TODO_EMPTY="{\"text\":\"  \",\"deadline\":$DL}"
TODO_BADTIME='{"text":"x","deadline":"abc"}'
TODO_PRIVATE="{\"text\":\"用户A的私事\",\"deadline\":$DL}"
TODO_DEVICE="{\"text\":\"设备A添加\",\"deadline\":$DL}"
JSON='Content-Type: application/json'

echo "=== 1. 注册 ==="
T=$(body -X POST $B/api/register -H "$JSON" -d "$BODY_NEW" | jq_get "['token']")
chk "注册返回 token" "$([ -n "$T" ] && echo yes || echo no)" "yes"
chk "重复注册 409" "$(code -X POST $B/api/register -H "$JSON" -d "$BODY_DUP")" "409"
chk "弱密码 400" "$(code -X POST $B/api/register -H "$JSON" -d "$BODY_WEAK")" "400"
chk "非法用户名 400" "$(code -X POST $B/api/register -H "$JSON" -d "$BODY_BADNAME")" "400"

echo "=== 2. 登录 ==="
chk "错误密码 401" "$(code -X POST $B/api/login -H "$JSON" -d "$BODY_BADPW")" "401"
chk "不存在用户 401" "$(code -X POST $B/api/login -H "$JSON" -d "$BODY_NOUSER")" "401"
T2=$(body -X POST $B/api/login -H "$JSON" -d "$BODY_LOGIN" | jq_get "['token']")
chk "正确密码登录成功" "$([ -n "$T2" ] && echo yes || echo no)" "yes"
chk "me 接口返回用户名" "$(body $B/api/me -H "Authorization: Bearer $T" | jq_get "['username']")" "$U"

echo "=== 3. 待办增删查 ==="
ID=$(body -X POST $B/api/todos -H "Authorization: Bearer $T" -H "$JSON" -d "$TODO_A" | jq_get "['todo']['id']")
chk "新增返回 id" "$([ -n "$ID" ] && echo yes || echo no)" "yes"
chk "列表 1 条" "$(body $B/api/todos -H "Authorization: Bearer $T" | jq_get "['todos'].__len__()")" "1"
chk "空文本被拒 400" "$(code -X POST $B/api/todos -H "Authorization: Bearer $T" -H "$JSON" -d "$TODO_EMPTY")" "400"
chk "无效时间被拒 400" "$(code -X POST $B/api/todos -H "Authorization: Bearer $T" -H "$JSON" -d "$TODO_BADTIME")" "400"
chk "完成删除 200" "$(code -X DELETE $B/api/todos/$ID -H "Authorization: Bearer $T")" "200"
chk "删除后 0 条" "$(body $B/api/todos -H "Authorization: Bearer $T" | jq_get "['todos'].__len__()")" "0"
chk "删除不存在 404" "$(code -X DELETE $B/api/todos/deadbeef -H "Authorization: Bearer $T")" "404"

echo "=== 4. 鉴权安全 ==="
chk "无 token 401" "$(code $B/api/todos)" "401"
chk "伪造 token 401" "$(code $B/api/todos -H 'Authorization: Bearer faketoken999')" "401"
curl -s --max-time 15 -o /dev/null -X POST $B/api/logout -H "Authorization: Bearer $T2"
chk "登出后旧 token 失效" "$(code $B/api/todos -H "Authorization: Bearer $T2")" "401"

echo "=== 5. 多用户隔离 ==="
TB=$(body -X POST $B/api/register -H "$JSON" -d "$BODY_U2" | jq_get "['token']")
curl -s --max-time 15 -o /dev/null -X POST $B/api/todos -H "Authorization: Bearer $T" -H "$JSON" -d "$TODO_PRIVATE"
chk "用户A 看到 1 条" "$(body $B/api/todos -H "Authorization: Bearer $T" | jq_get "['todos'].__len__()")" "1"
chk "用户B 看到 0 条(隔离)" "$(body $B/api/todos -H "Authorization: Bearer $TB" | jq_get "['todos'].__len__()")" "0"

echo "=== 6. 同账号跨设备同步 ==="
DA=$(body -X POST $B/api/login -H "$JSON" -d "$BODY_LOGIN" | jq_get "['token']")
DB=$(body -X POST $B/api/login -H "$JSON" -d "$BODY_LOGIN" | jq_get "['token']")
chk "两个会话 token 不同" "$([ "$DA" != "$DB" ] && echo yes || echo no)" "yes"
curl -s --max-time 15 -o /dev/null -X POST $B/api/todos -H "Authorization: Bearer $DA" -H "$JSON" -d "$TODO_DEVICE"
chk "设备B 看到设备A的改动" "$(body $B/api/todos -H "Authorization: Bearer $DB" | jq_get "['todos'].__len__()")" "2"
IDX=$(body $B/api/todos -H "Authorization: Bearer $DB" | jq_get "['todos'][0]['id']")
curl -s --max-time 15 -o /dev/null -X DELETE $B/api/todos/$IDX -H "Authorization: Bearer $DB"
chk "设备A 看到设备B的删除" "$(body $B/api/todos -H "Authorization: Bearer $DA" | jq_get "['todos'].__len__()")" "1"

echo ""
echo "===== 结果: 通过 $pass 项, 失败 $fail 项 ====="
if [ "$fail" -eq 0 ]; then echo "全部通过"; else echo "存在失败项"; fi
