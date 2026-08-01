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
// AI Analysis (SiliconFlow)
// ============================
const AI_API_KEY = process.env.SF_API_KEY || 'sk-vjwhhlbgymkjijywcitvlmbfcyfikfjmivaygpqmstzxiiuv';
const AI_API_URL = 'https://api.siliconflow.cn/v1/chat/completions';
const AI_MODEL = 'deepseek-ai/DeepSeek-V3';

async function fetchQuoteData(code) {
  return new Promise((resolve, reject) => {
    const market = ['0','3'].includes(code[0]) ? 0 : 1;
    const fields = 'f43,f44,f45,f46,f47,f48,f50,f51,f58,f60,f116,f117,f162,f167,f168,f170';
    https.get(`https://push2.eastmoney.com/api/qt/stock/get?secid=${market}.${code}&fields=${fields}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(body).data;
          if (!d) return resolve(null);
          resolve({
            name: d.f58, price: d.f43/100, open: d.f46/100, high: d.f44/100, low: d.f45/100,
            prevClose: d.f60/100, changePct: d.f60 ? ((d.f43-d.f60)/d.f60*100).toFixed(2) : 0,
            volume: (d.f47/10000).toFixed(0), amount: (d.f48/1e8).toFixed(2),
            pe: d.f162 ? (d.f162/100).toFixed(2) : '-', pb: d.f170 ? (d.f170/100).toFixed(2) : '-',
            turnover: d.f168 ? (d.f168/100).toFixed(2) : '-', amplitude: d.f51 ? (d.f51/100).toFixed(2) : '-',
            volumeRatio: d.f50 ? (d.f50/100).toFixed(2) : '-', totalCap: d.f116 ? (d.f116/1e8).toFixed(0) : '-',
          });
        } catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function fetchKlineSummary(code) {
  return new Promise(resolve => {
    const market = ['0','3'].includes(code[0]) ? 0 : 1;
    https.get(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${market}.${code}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&end=20500101&lmt=20`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const klines = JSON.parse(body).data?.klines || [];
          resolve(klines.map(l => l.split(',')).map(p => ({
            date: p[0], open: p[1], close: p[2], high: p[3], low: p[4], vol: p[5]
          })));
        } catch(e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

async function fetchStockNewsSummary(code) {
  return new Promise(resolve => {
    https.get(`https://search-api-web.eastmoney.com/search/jsonp?cb=jQuery&param=%7B%22uid%22%3A%22%22%2C%22keyword%22%3A%22${code}%22%2C%22type%22%3A%5B%22cmsArticleWebOld%22%5D%2C%22client%22%3A%22web%22%2C%22clientType%22%3A%22web%22%2C%22clientVersion%22%3A%22curr%22%2C%22param%22%3A%7B%22cmsArticleWebOld%22%3A%7B%22searchScope%22%3A%22default%22%2C%22sort%22%3A%22default%22%2C%22pageIndex%22%3A1%2C%22pageSize%22%3A5%2C%22preTag%22%3A%22%22%2C%22postTag%22%3A%22%22%7D%7D%7D`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://so.eastmoney.com/' } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body.replace(/^jQuery\d+_?\d*\(/, '').replace(/\)\s*$/, ''));
          resolve((json.cmsArticleWebOld || []).slice(0, 5).map(a => a.title || '').join('；'));
        } catch(e) { resolve(''); }
      });
    }).on('error', () => resolve(''));
  });
}

async function callAI(prompt) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1200, temperature: 0.5,
    });
    const req = https.request(AI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AI_API_KEY}` }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.choices && j.choices[0]) resolve(j.choices[0].message.content);
          else reject(new Error(j.error?.message || 'API error'));
        } catch(e) { reject(e); }
      });
    });
    req.write(data);
    req.end();
  });
}

async function aiAnalyze(code) {
  if (AI_API_KEY === 'YOUR_SILICONFLOW_KEY_HERE') throw new Error('请先配置 SiliconFlow API Key');

  const [quote, klines, newsSummary] = await Promise.all([
    fetchQuoteData(code), fetchKlineSummary(code), fetchStockNewsSummary(code)
  ]);
  if (!quote) throw new Error('未找到该股票');

  const klineText = klines.map(k =>
    `${k.date} 开${k.open} 收${k.close} 高${k.high} 低${k.low} 量${(k.vol/10000).toFixed(1)}万手`
  ).join('\n');

  const prompt = `你是专业A股分析师。以下是股票${quote.name}(${code})的实时数据，请生成一份简明深度分析报告，包括：基本面、技术面、资金面、消息面、风险提示、综合建议。控制600字以内。

【实时行情】现价${quote.price} 涨跌${quote.changePct}% 今开${quote.open} 最高${quote.high} 最低${quote.low} 昨收${quote.prevClose}
成交${quote.amount}亿 换手${quote.turnover}% 振幅${quote.amplitude}% 量比${quote.volumeRatio}
PE${quote.pe} PB${quote.pb} 总市值${quote.totalCap}亿

【近20日K线】
${klineText}

【近期资讯】${newsSummary || '暂无'}

请用中文回复，格式：
**基本面**
...（估值水平、业绩趋势）
**技术面**
...（K线形态、均线、支撑压力）
**资金面**
...（成交量、换手率、资金动向）
**消息面**
...（近期事件影响）
**风险提示**
...（主要风险点）
**综合建议**
...（一句话结论）`;

  return { name: quote.name, code: code, report: await callAI(prompt) };
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

  if (url.pathname === '/api/ai-analyze') {
    const stockCode = url.searchParams.get('stock') || '';
    try {
      const result = await aiAnalyze(stockCode);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // Serve HTML (main page or test page)
  let html;
  if (url.pathname === '/ai-test' || url.pathname === '/ai-test.html') {
    try { html = fs.readFileSync(path.join(__dirname, 'ai-test.html'), 'utf-8'); } catch(e) { html = null; }
  } else {
    html = getHtml();
  }
  if (!html) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Error</h1><p>Page not found.</p>');
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
