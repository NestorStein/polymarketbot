#!/bin/bash
# watchdog.sh — keeps the bot and price monitor alive 24/7.
# Start once with: nohup bash watchdog.sh >> /d/polymarket-bot/watchdog.log 2>&1 &

BOT_DIR="/d/polymarket-bot"
MONITOR_PID_FILE="$BOT_DIR/auto_monitor.pid"

ts() { date -u '+%Y-%m-%d %H:%M:%S'; }

# Check if a PID is alive by looking at /proc (works without pgrep)
pid_alive() {
  local pid=$1
  [[ -n "$pid" ]] && [[ -f "/proc/$pid/cmdline" ]] && grep -q "auto_monitor" "/proc/$pid/cmdline" 2>/dev/null
}

# Kill any stale auto_monitor instances at startup
for f in /proc/*/cmdline; do
  pid=$(echo "$f" | grep -o '[0-9]*')
  if grep -q "auto_monitor" "$f" 2>/dev/null; then
    kill "$pid" 2>/dev/null
  fi
done
sleep 2

echo "[$(ts)] watchdog started (PID=$$)"
MONITOR_PID=""

start_monitor() {
  cd "$BOT_DIR"
  nohup node auto_monitor.js >> /dev/null 2>&1 &
  MONITOR_PID=$!
  echo $MONITOR_PID > "$MONITOR_PID_FILE"
  echo "[$(ts)] auto_monitor started PID=$MONITOR_PID"
}

start_monitor

while true; do
  sleep 30

  # ── Monitor ──────────────────────────────────────────────────────────────
  if ! pid_alive "$MONITOR_PID"; then
    echo "[$(ts)] auto_monitor (PID=$MONITOR_PID) died — restarting..."
    start_monitor
  fi

  # ── Bot (detect by HTTP response on dashboard port 3002) ─────────────────
  if ! curl -s --max-time 3 http://localhost:3002/api/positions > /dev/null 2>&1; then
    echo "[$(ts)] bot not responding on port 3002 — restarting..."
    cd "$BOT_DIR"
    nohup node index.js >> "$BOT_DIR/bot_stdout.log" 2>&1 &
    echo "[$(ts)] bot started PID=$!"
  fi
done
