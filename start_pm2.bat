@echo off
cd /d D:\polymarket-bot
pm2 resurrect
if errorlevel 1 (
  pm2 start index.js --name "polymarket-bot" --restart-delay=5000 --max-restarts=50
  pm2 save
)
