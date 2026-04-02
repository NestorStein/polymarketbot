#!/bin/bash
# Monitor 5-min window moves across all 6 assets
while true; do
  node -e "
const https = require('https');
const symbols = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT'];
const now = Math.floor(Date.now()/1000);
const win = Math.floor(now/300)*300;
const winStart = win * 1000;
const utcHour = new Date().getUTCHours();
const gate = (utcHour >= 12 && utcHour < 22) ? 'OPEN' : 'CLOSED';

let done = 0, results = [];
symbols.forEach(sym => {
  const url = 'https://api.binance.com/api/v3/klines?symbol=' + sym + '&interval=1m&limit=6';
  https.get(url, res => {
    let d=''; res.on('data',c=>d+=c); res.on('end',()=>{
      try {
        const candles = JSON.parse(d);
        const winCandles = candles.filter(c => c[0] >= winStart);
        if (winCandles.length === 0) { results.push({sym, pct:0, vel:0}); }
        else {
          const open = parseFloat(winCandles[0][1]);
          const last = candles[candles.length-1];
          const close = parseFloat(last[4]);
          const pct = ((close - open) / open) * 100;
          const vel = ((parseFloat(last[4]) - parseFloat(last[1])) / parseFloat(last[1])) * 100;
          results.push({sym: sym.replace('USDT',''), pct, vel});
        }
      } catch(e) { results.push({sym, pct:0, vel:0}); }
      if (++done === symbols.length) {
        results.sort((a,b) => Math.abs(b.pct)-Math.abs(a.pct));
        const ts = new Date().toISOString().replace('T',' ').slice(0,19);
        let best = results[0];
        let line = '['+ts+'] Gate:'+gate;
        results.forEach(r => {
          const flag = Math.abs(r.pct) >= 0.5 ? ' ***' : '';
          line += ' | ' + r.sym + (r.pct>=0?'+':'')+r.pct.toFixed(2)+'%'+flag;
        });
        console.log(line);
      }
    });
  }).on('error', e => { results.push({sym, pct:0, vel:0}); if(++done===symbols.length) process.exit(0); });
});
" 2>/dev/null >> /d/polymarket-bot/monitor.log
  sleep 20
done
