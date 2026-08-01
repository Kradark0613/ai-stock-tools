#!/usr/bin/env node
/**
 * AI Stock Assistant
 * Zero dependency. One command: node app.js
 * Then open http://localhost:3456 in browser.
 *
 * Everything works: quotes, AI analysis, manual review, AND real-time news.
 */
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3456;
const HOST = '0.0.0.0'; // Allow LAN access from phones

function getLanIP() {
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// ============================
// News Proxy Logic
// ============================
function clsSign(params) {
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const sha1 = crypto.createHash('sha1').update(sorted).digest('hex');
  return crypto.createHash('md5').update(sha1).digest('hex');
}

function fetchClsTelegraph() {
  return new Promise((resolve, reject) => {
    const params = { app: 'CailianpressWeb', os: 'web', sv: '8.4.6', refresh_type: '2', rn: '20' };
    params.sign = clsSign(params);
    const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    https.get(`https://www.cls.cn/v1/roll/get_roll_list?${qs}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.errno === 0 && json.data && json.data.roll_data) {
            resolve(json.data.roll_data.map(item => ({
              title: item.title || '', content: item.content || item.brief || '',
              time: item.ctime ? new Date(item.ctime * 1000).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' }) : '',
              source: '财联社', category: detectCategory(item.title || '', item.content || ''), url: item.shareurl || '',
            })));
          } else { resolve([]); }
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fetchEastMoneyGlobalNews() {
  return new Promise((resolve, reject) => {
    https.get('https://emappdata.eastmoney.com/ThatTracker/GetGlobalNews?pageSize=20&pageIndex=1', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.eastmoney.com/' }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.errcode === 0 && json.data && json.data.list) {
            resolve(json.data.list.map(item => ({
              title: item.title || '', content: item.summary || item.title || '',
              time: item.showTime || '', source: '东方财富',
              category: detectCategory(item.title || '', item.summary || ''), url: item.url || '',
            })));
          } else { resolve([]); }
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function detectCategory(title, content) {
  const text = (title + content).toLowerCase();
  if (/财报|营收|净利润|业绩|季报|年报|中报/.test(text)) return '财报速读';
  if (/政策|国务院|工信部|证监会|央行|发改委/.test(text)) return '政策解读';
  if (/涨停|跌停|异动|拉升|跳水/.test(text)) return '题材热点';
  if (/减持|增持|回购|分红|重组|并购/.test(text)) return '公司动态';
  if (/北向|主力|资金|龙虎榜/.test(text)) return '资金动向';
  if (/人民币|美元|加息|降息|美联储|汇率/.test(text)) return '宏观政策';
  return '行业动态';
}

async function getAllNews(stockCode) {
  const results = [];
  try { const cls = await fetchClsTelegraph(); results.push(...cls); } catch (e) { console.error('CLS:', e.message); }
  try { const em = await fetchEastMoneyGlobalNews(); results.push(...em); } catch (e) { console.error('EM:', e.message); }
  if (stockCode) {
    try { const st = await fetchEastMoneyStockNews(stockCode); results.push(...st); } catch (e) { console.error('Stock:', e.message); }
  }
  const seen = new Set();
  return results.filter(r => { if (seen.has(r.title)) return false; seen.add(r.title); return true; }).slice(0, 30);
}

// ============================
// Load HTML
// ============================
const HTML_PATH = path.join(__dirname, 'ai-stock-tools.html');
let cachedHtml = null;
let htmlMtime = 0;

function getHtml() {
  try {
    const stat = fs.statSync(HTML_PATH);
    if (!cachedHtml || stat.mtimeMs > htmlMtime) {
      cachedHtml = fs.readFileSync(HTML_PATH, 'utf-8');
      htmlMtime = stat.mtimeMs;
    }
    return cachedHtml;
  } catch (e) {
    return null;
  }
}

// ============================
// HTTP Server
// ============================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/news') {
    try {
      const stockCode = url.searchParams.get('stock') || '';
      const news = await getAllNews(stockCode);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, count: news.length, data: news, time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // Serve HTML
  const html = getHtml();
  if (!html) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Error</h1><p>ai-stock-tools.html not found. Make sure it is in the same folder as app.js.</p>');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(PORT, HOST, () => {
  const lanIP = getLanIP();
  const html = getHtml();
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║     AI 智能股票助手  v2.0              ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  PC:    http://localhost:${PORT}          ║`);
  console.log(`  ║  手机:  http://${lanIP}:${PORT}`.padEnd(45) + '║');
  console.log('  ║                                        ║');
  console.log('  ║  手机和电脑连同一个 WiFi 即可访问     ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  if (!html) console.log('  Warning: ai-stock-tools.html not found!');
  console.log('  Press Ctrl+C to stop.\n');
});
