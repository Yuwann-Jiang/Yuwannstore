#!/bin/bash
# 新功能接口测试：撤销完成 / 多级提醒标记 / 统计 / 日历导出
#
# 用法：
#   ./test-features.sh                                  # 默认测线上正式环境
#   ./test-features.sh https://xxx--yuwann-todo.netlify.app   # 测某个预览地址
#
# 说明：脚本会注册一个临时测试账号（feat<时间戳>），只操作自己的数据，
# 不会影响任何真实用户。跑完可以用管理员后台手动清掉。
B=${1:-https://yuwann-todo.netlify.app}
pass=0; fail=0

chk() {
  local n="$1"; local a="$2"; local e="$3"
  if [ "$a" = "$e" ]; then
    echo "  PASS  $n   (实际=$a)"
    pass=$((pass+1))
  else
    echo "  FAIL  $n   (实际=$a 期望=$e)"
    fail=$((fail+1))
  fi
}
chk_nz() { # 非空即通过
  local n="$1"; local a="$2"
  if [ -n "$a" ] && [ "$a" != "None" ] && [ "$a" != "null" ]; then
    echo "  PASS  $n   (实际=$a)"
    pass=$((pass+1))
  else
    echo "  FAIL  $n   (得到空值)"
    fail=$((fail+1))
  fi
}

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$@"; }
body() { curl -s --max-time 25 "$@"; }
# jp '<python 表达式>'：stdin 是 JSON，d 是解析结果
jp() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
ctype() { curl -s -o /dev/null -w '%{content_type}' --max-time 25 "$@"; }

JSON='Content-Type: application/json'
U="feat$(date +%s)"
PW="secret123"
DL=$(python3 -c 'import time;print(int((time.time()+7200)*1000))')   # 2 小时后
DL2=$(python3 -c 'import time;print(int((time.time()+86400*5)*1000))') # 5 天后

echo "=== 0. 准备账号 ==="
T=$(body -X POST $B/api/register -H "$JSON" -d "{\"username\":\"$U\",\"password\":\"$PW\"}" | jp "d['token']")
chk_nz "注册并拿到 token" "$T"
AUTH="Authorization: Bearer $T"

echo "=== 1. 统计：空账号的初始值 ==="
S=$(body "$B/api/stats" -H "$AUTH")
chk "进行中 0 条" "$(echo "$S" | jp "d['active']['total']")" "0"
chk "累计完成 0 条" "$(echo "$S" | jp "d['done']['total']")" "0"
chk "准时率为 null" "$(echo "$S" | jp "d['done']['onTimeRate']")" "None"
chk "默认窗口 90 天" "$(echo "$S" | jp "d['days']")" "90"
chk "daily 长度 = 窗口天数" "$(echo "$S" | jp "len(d['daily'])")" "90"
chk "weekday 长度 7" "$(echo "$S" | jp "len(d['weekday'])")" "7"
chk "hourly 长度 24" "$(echo "$S" | jp "len(d['hourly'])")" "24"
chk "连续天数为 0" "$(echo "$S" | jp "d['streak']['current']")" "0"
chk "days=30 生效" "$(body "$B/api/stats?days=30" -H "$AUTH" | jp "len(d['daily'])")" "30"
chk "days=365 生效" "$(body "$B/api/stats?days=365" -H "$AUTH" | jp "d['days']")" "365"
chk "未登录 401" "$(code "$B/api/stats")" "401"

echo "=== 2. 日历导出 ==="
ICS=$(body "$B/api/calendar.ics" -H "$AUTH")
chk "空账号也是合法日历" "$(echo "$ICS" | grep -c 'BEGIN:VCALENDAR')" "1"
chk "空账号没有事件" "$(echo "$ICS" | grep -c 'BEGIN:VEVENT')" "0"
chk "Content-Type 正确" "$(ctype "$B/api/calendar.ics" -H "$AUTH")" "text/calendar; charset=utf-8"
chk "未登录 401" "$(code "$B/api/calendar.ics")" "401"

echo "=== 3. 新增待办后统计与日历跟着变 ==="
TODO_ID=$(body -X POST $B/api/todos -H "$AUTH" -H "$JSON" \
  -d "{\"text\":\"导出测试任务\",\"deadline\":$DL}" | jp "d['todo']['id']")
chk_nz "新增待办拿到 id" "$TODO_ID"
chk "进行中 1 条" "$(body "$B/api/stats" -H "$AUTH" | jp "d['active']['total']")" "1"
chk "落在 24 小时内档" "$(body "$B/api/stats" -H "$AUTH" | jp "d['active']['within1d']")" "1"

ICS=$(body "$B/api/calendar.ics" -H "$AUTH")
chk "日历里有 1 个事件" "$(echo "$ICS" | grep -c 'BEGIN:VEVENT')" "1"
chk "事件标题正确" "$(echo "$ICS" | grep -c 'SUMMARY:导出测试任务')" "1"
chk "带提前 1 天提醒" "$(echo "$ICS" | grep -c 'TRIGGER:-P1D')" "1"
chk "UID 唯一后缀" "$(echo "$ICS" | grep -c "@yuwann-todo")" "1"
chk "行分隔符全是 CRLF" "$(python3 -c "
import sys
s=sys.stdin.buffer.read().decode('utf-8').rstrip('\r\n')
print('yes' if s.replace('\r\n','').count('\n')==0 else 'no')" <<< "$ICS")" "yes"
chk "alarms=0 去掉提醒" "$(body "$B/api/calendar.ics?alarms=0" -H "$AUTH" | grep -c 'VALARM')" "0"
chk "超过 75 字节的行已折行" "$(python3 -c "
import sys
s=sys.stdin.buffer.read().rstrip(b'\r\n')
bad=sum(1 for line in s.split(b'\r\n') if len(line) > 75)
print(bad)" <<< "$ICS")" "0"

echo "=== 4. 完成待办：返回可撤销所需的信息 ==="
DEL=$(body -X DELETE "$B/api/todos/$TODO_ID" -H "$AUTH")
chk "完成返回 200 语义（ok=true）" "$(echo "$DEL" | jp "d['ok']")" "True"
chk "回传被删待办的文本" "$(echo "$DEL" | jp "d['completedTodo']['text']")" "导出测试任务"
chk "回传完成记录 id" "$([ -n "$(echo "$DEL" | jp "d['completionId']")" ] && echo yes || echo no)" "yes"
CMP_ID=$(echo "$DEL" | jp "d['completionId']")
chk "列表已空" "$(echo "$DEL" | jp "len(d['todos'])")" "0"
chk "完成记录 +1" "$(body "$B/api/completions" -H "$AUTH" | jp "len(d['completions'])")" "1"

echo "=== 5. 统计反映这次完成 ==="
S=$(body "$B/api/stats" -H "$AUTH")
chk "累计完成 1 条" "$(echo "$S" | jp "d['done']['total']")" "1"
chk "窗口内完成 1 条" "$(echo "$S" | jp "d['done']['inRange']")" "1"
chk "准时完成 1 条" "$(echo "$S" | jp "d['done']['onTime']")" "1"
chk "准时率 100%" "$(echo "$S" | jp "float(d['done']['onTimeRate'])==1.0")" "True"
chk "连续天数 1" "$(echo "$S" | jp "d['streak']['current']")" "1"
chk "今天那根柱子为 1" "$(echo "$S" | jp "d['daily'][-1]['count']")" "1"

echo "=== 6. 撤销完成：待办回来，完成记录回滚 ==="
RESTORE="{\"todo\":{\"id\":\"$TODO_ID\",\"text\":\"导出测试任务\",\"deadline\":$DL},\"completionId\":\"$CMP_ID\"}"
R=$(body -X POST "$B/api/todos/restore" -H "$AUTH" -H "$JSON" -d "$RESTORE")
chk "撤销成功" "$(echo "$R" | jp "d['ok']")" "True"
chk "待办回到列表" "$(echo "$R" | jp "len(d['todos'])")" "1"
chk "完成记录被回滚" "$(echo "$R" | jp "d['completionRolledBack']")" "True"
chk "服务端完成记录已清空" "$(body "$B/api/completions" -H "$AUTH" | jp "len(d['completions'])")" "0"
chk "统计里的完成数回到 0" "$(body "$B/api/stats" -H "$AUTH" | jp "d['done']['total']")" "0"
chk "待办又算作进行中" "$(body "$B/api/stats" -H "$AUTH" | jp "d['active']['total']")" "1"

echo "=== 7. 撤销的边界情况 ==="
chk "重复撤销 409" "$(code -X POST "$B/api/todos/restore" -H "$AUTH" -H "$JSON" -d "$RESTORE")" "409"
chk "缺待办数据 400" "$(code -X POST "$B/api/todos/restore" -H "$AUTH" -H "$JSON" -d '{}')" "400"
chk "空文本 400" "$(code -X POST "$B/api/todos/restore" -H "$AUTH" -H "$JSON" \
  -d "{\"todo\":{\"id\":\"abc123\",\"text\":\"  \",\"deadline\":$DL}}")" "400"
chk "非法截止时间 400" "$(code -X POST "$B/api/todos/restore" -H "$AUTH" -H "$JSON" \
  -d '{"todo":{"id":"abc123","text":"x","deadline":"abc"}}')" "400"
chk "非法 id 400" "$(code -X POST "$B/api/todos/restore" -H "$AUTH" -H "$JSON" \
  -d "{\"todo\":{\"id\":\"a b;drop\",\"text\":\"x\",\"deadline\":$DL}}")" "400"
chk "未登录 401" "$(code -X POST "$B/api/todos/restore" -H "$JSON" -d "$RESTORE")" "401"

echo "=== 8. 不带 completionId 也能撤销（只放回待办）==="
ID2=$(body -X POST $B/api/todos -H "$AUTH" -H "$JSON" \
  -d "{\"text\":\"无记录撤销\",\"deadline\":$DL2}" | jp "d['todo']['id']")
body -X DELETE "$B/api/todos/$ID2" -H "$AUTH" > /dev/null
R2=$(body -X POST "$B/api/todos/restore" -H "$AUTH" -H "$JSON" \
  -d "{\"todo\":{\"id\":\"$ID2\",\"text\":\"无记录撤销\",\"deadline\":$DL2}}")
chk "撤销成功" "$(echo "$R2" | jp "d['ok']")" "True"
chk "没有回滚动作" "$(echo "$R2" | jp "d['completionRolledBack']")" "False"
chk "列表回到 2 条" "$(echo "$R2" | jp "len(d['todos'])")" "2"

echo "=== 9. 编辑待办（改名称 / 改时间）==="
P=$(body -X PATCH "$B/api/todos/$ID2" -H "$AUTH" -H "$JSON" -d "{\"text\":\"改名成功\",\"deadline\":$DL}")
chk "改名生效" "$(echo "$P" | jp "d['todo']['text']")" "改名成功"
chk "改时间生效" "$(echo "$P" | jp "d['todo']['deadline']")" "$DL"
chk "标记了 updatedAt" "$(echo "$P" | jp "'updatedAt' in d['todo']")" "True"
chk "改名后统计里 1 条在 24 小时内" "$(body "$B/api/stats" -H "$AUTH" | jp "d['active']['within1d']")" "2"

echo "=== 10. 纪念：增删改查 ==="
chk "初始为空" "$(body "$B/api/memorials" -H "$AUTH" | jp "len(d['memorials'])")" "0"
MEM=$(body -X POST "$B/api/memorials" -H "$AUTH" -H "$JSON" \
  -d '{"title":"在一起","date":"2023-05-20"}')
MEM_ID=$(echo "$MEM" | jp "d['memorial']['id']")
chk_nz "新增拿到 id" "$MEM_ID"
chk "默认每年重复" "$(echo "$MEM" | jp "d['memorial']['repeat']")" "year"
chk "日期原样保存" "$(echo "$MEM" | jp "d['memorial']['date']")" "2023-05-20"
chk "列表 1 条" "$(body "$B/api/memorials" -H "$AUTH" | jp "len(d['memorials'])")" "1"
chk "不存在的日期 400" "$(code -X POST "$B/api/memorials" -H "$AUTH" -H "$JSON" \
  -d '{"title":"x","date":"2023-02-30"}')" "400"
chk "空名称 400" "$(code -X POST "$B/api/memorials" -H "$AUTH" -H "$JSON" \
  -d '{"title":"  ","date":"2023-05-20"}')" "400"
chk "缺日期 400" "$(code -X POST "$B/api/memorials" -H "$AUTH" -H "$JSON" -d '{"title":"x"}')" "400"
chk "非法重复方式 400" "$(code -X POST "$B/api/memorials" -H "$AUTH" -H "$JSON" \
  -d '{"title":"x","date":"2023-05-20","repeat":"weekly"}')" "400"

PATCHED=$(body -X PATCH "$B/api/memorials/$MEM_ID" -H "$AUTH" -H "$JSON" -d '{"title":"在一起的第 1 天"}')
chk "改名生效" "$(echo "$PATCHED" | jp "d['memorial']['title']")" "在一起的第 1 天"
chk "没传的字段不变" "$(echo "$PATCHED" | jp "d['memorial']['date']")" "2023-05-20"
chk "标记了 updatedAt" "$(echo "$PATCHED" | jp "'updatedAt' in d['memorial']")" "True"
chk "改不存在 404" "$(code -X PATCH "$B/api/memorials/deadbeef" -H "$AUTH" -H "$JSON" -d '{"title":"x"}')" "404"

chk "删除成功" "$(code -X DELETE "$B/api/memorials/$MEM_ID" -H "$AUTH")" "200"
chk "删除后 0 条" "$(body "$B/api/memorials" -H "$AUTH" | jp "len(d['memorials'])")" "0"
chk "重复删除 404" "$(code -X DELETE "$B/api/memorials/$MEM_ID" -H "$AUTH")" "404"
chk "未登录 401" "$(code "$B/api/memorials")" "401"

echo "=== 11. 纪念：农历 ==="
LM=$(body -X POST "$B/api/memorials" -H "$AUTH" -H "$JSON" \
  -d '{"title":"外婆生日","calendar":"lunar","date":"1940-08-15"}')
LM_ID=$(echo "$LM" | jp "d['memorial']['id']")
chk_nz "新增农历纪念日" "$LM_ID"
chk "农历文本" "$(echo "$LM" | jp "d['memorial']['lunarText']")" "八月十五"
chk "换算出的公历日期" "$(echo "$LM" | jp "d['memorial']['originalSolar']")" "1940-09-16"
chk "返回未来几次的换算结果" "$(echo "$LM" | jp "len(d['memorial']['occurrences']) >= 3")" "True"
chk "该年没有的闰月 400" "$(code -X POST "$B/api/memorials" -H "$AUTH" -H "$JSON" \
  -d '{"title":"x","calendar":"lunar","date":"2024-02-12","isLeap":true}')" "400"
chk "小月没有三十 400" "$(code -X POST "$B/api/memorials" -H "$AUTH" -H "$JSON" \
  -d '{"title":"x","calendar":"lunar","date":"2023-01-30"}')" "400"
chk "农历月份越界 400" "$(code -X POST "$B/api/memorials" -H "$AUTH" -H "$JSON" \
  -d '{"title":"x","calendar":"lunar","date":"2023-13-01"}')" "400"

echo "=== 12. 纪念：导出日历 ==="
# 先补一条「公历 + 每年重复」，才能验证 RRULE（前面那条公历的已被删掉）
body -X POST "$B/api/memorials" -H "$AUTH" -H "$JSON" \
  -d '{"title":"在一起","calendar":"solar","date":"2020-05-20"}' > /dev/null
MIC=$(body "$B/api/memorials.ics" -H "$AUTH")
chk "是合法日历" "$(echo "$MIC" | grep -c 'BEGIN:VCALENDAR')" "1"
chk "Content-Type 正确" "$(ctype "$B/api/memorials.ics" -H "$AUTH")" "text/calendar; charset=utf-8"
chk "全天事件用 VALUE=DATE" "$(echo "$MIC" | grep -c 'DTSTART;VALUE=DATE:')" "$(echo "$MIC" | grep -c 'BEGIN:VEVENT')"
chk "公历每年重复用 RRULE" "$(echo "$MIC" | grep -c 'RRULE:FREQ=YEARLY')" "1"
chk "带提前一天提醒" "$(echo "$MIC" | grep -c 'TRIGGER:-PT15H')" "$(echo "$MIC" | grep -c 'BEGIN:VEVENT')"
chk "农历事件逐次展开（出现在多个月份里）" "$([ "$(echo "$MIC" | grep -c '外婆生日')" -ge 2 ] && echo yes || echo no)" "yes"
chk "行都不超过 75 字节" "$(python3 -c "
import sys
s=sys.stdin.buffer.read().rstrip(b'\r\n')
print(sum(1 for line in s.split(b'\r\n') if len(line) > 75))" <<< "$MIC")" "0"
chk "alarms=0 去掉提醒" "$(body "$B/api/memorials.ics?alarms=0" -H "$AUTH" | grep -c 'VALARM')" "0"
chk "未登录 401" "$(code "$B/api/memorials.ics")" "401"

echo ""
echo "===== 结果: 通过 $pass 项, 失败 $fail 项 ====="
if [ "$fail" -eq 0 ]; then echo "全部通过"; else echo "存在失败项"; fi
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
