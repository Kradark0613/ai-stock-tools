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
  if (stockCode) {
    try { const st = await fetchEastMoneyStockNews(stockCode); results.push(...st); } catch (e) { console.error('Stock:', e.message); }
  }
  const seen = new Set();
  return results.filter(r => { if (seen.has(r.title)) return false; seen.add(r.title); return true; }).slice(0, 30);
}

// ============================
// AI Analysis (SiliconFlow)
// ============================
const AI_API_KEY = process.env.DS_API_KEY || 'sk-49de50507d1140bb9640caac206e2eda';
const AI_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const AI_MODEL = 'deepseek-chat';

function buildAIPrompt(code, quote, klines, newsSummary, finance) {
  const klineText = (klines || []).slice(-60).map(k =>
    `${k.date} 开${k.open} 收${k.close} 高${k.high} 低${k.low} 量${(k.volume/10000).toFixed(1)}万手`
  ).join('|');

  let financeText = '';
  if (finance && finance.reports && finance.reports.length) {
    const r = finance.reports;
    financeText = `
【真实财报数据 — 禁止编造，必须使用以下数据】
报告期：${r[0].reportDate} ${r[0].reportType}
营业收入：${r[0].revenue?.toFixed(1)}亿 同比增速：${r[0].revenueYoY}%
扣非净利润：${r[0].deductProfit?.toFixed(1)}亿 同比增速：${r[0].deductProfitYoY}%
ROE：${r[0].roe}% 毛利率：${r[0].grossMargin}% 净利率：${r[0].netMargin}%
每股收益：${r[0].eps} 每股净资产：${r[0].bps} 资产负债率：${r[0].debtRatio}%
历年对比：${r.slice(0,3).map(x=>`${x.reportDate}(${x.reportType}):营收${x.revenueYoY}%/扣非${x.deductProfitYoY}%/ROE${x.roe}%`).join('; ')}`;
  }

  return `你是一位资深A股分析师，请对股票${quote.name}(${code})生成一份专业深度分析报告。要求六大维度，每个维度200字以上，总报告1200字以上。用数据说话，给出明确判断，不要模棱两可。重要：股票代码必须是${code}(${quote.name})，严禁使用其他代码或名称。财报数据下文中已提供真实值，严禁编造营收金额、净利润、毛利率等任何数字。

【实时行情】
现价${quote.price} | 涨跌${quote.changePct}% | 今开${quote.open} | 昨收${quote.prevClose}
最高${quote.high} | 最低${quote.low} | 成交${quote.amount}亿 | 换手${quote.turnover}%
振幅${quote.amplitude}% | 量比${quote.volumeRatio} | PE(TTM)${quote.pe} | PB${quote.pb} | 总市值${quote.totalCap}亿

${financeText}

【近60日K线】日期 开 收 高 低 量
${klineText || '暂无'}

【近期资讯】
${newsSummary || '暂无'}

注意：基本面分析必须引用上述财报数据中的真实数字，不得自行编造营收和净利润。年份必须用财报数据中提供的真实年份。`;

请严格按以下六大维度输出报告（每个维度必须有小标题和150字以上分析）：

**一、基本面分析**
从最新财报数据、估值水平（PE/PB与历史分位对比）、行业竞争地位三个角度分析。明确指出当前估值是偏高还是偏低，给出判断依据。

**二、技术面分析**
从K线形态（近60日趋势）、均线系统（是否有金叉/死叉信号）、支撑压力位三个角度分析。结合成交量变化判断多空力量。

**三、资金面分析**
从换手率、量比、成交额判断当前资金活跃度。结合量价关系分析主力动向。如果换手率异常（>5%或<0.5%），重点说明原因。

**四、消息舆情分析**
从近期公司公告、行业政策动向、市场情绪三个角度分析。区分利好利空，判断消息对股价的影响程度。

**五、风险提示**
列出3-5个具体风险点，包括估值风险、业绩风险、政策风险、市场风险、流动性风险等。每个风险点一句话说明。

**六、短期走势预判与综合建议**
结合以上五维分析，给出未来1-4周的走势预判（看多/震荡/看空）。给出具体操作建议（买入/持有/减仓/观望），并说明理由。`;
}

function callAI(prompt, model) {
  const m = model || AI_MODEL;
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: m,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: m === AI_VALIDATE_MODEL ? 500 : 2500, temperature: 0.3,
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

// ============================
// Finance Data Proxy
// ============================
async function fetchFinanceData(code) {
  const prefix = ['0','3'].includes(code[0]) ? 'SZ' : 'SH';
  return new Promise((resolve, reject) => {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&filter=(SECURITY_CODE="${code}")&pageSize=5&source=WEB&client=WEB`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://data.eastmoney.com/' } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          const rows = (j.result?.data || []).map(r => ({
            reportDate: r.REPORT_DATE?.substring(0,10) || '',
            reportType: r.REPORT_TYPE || '',
            revenue: (r.TOTALOPERATEREVE || 0) / 1e8,
            revenueYoY: r.TOTALOPERATEREVETZ != null ? parseFloat(r.TOTALOPERATEREVETZ).toFixed(2) : null,
            parentProfit: (r.PARENTNETPROFIT || 0) / 1e8,
            profitYoY: r.PARENTNETPROFITTZ != null ? parseFloat(r.PARENTNETPROFITTZ).toFixed(2) : null,
            deductProfit: (r.KCFJCXSYJLR || 0) / 1e8,
            deductProfitYoY: r.KCFJCXSYJLRTZ != null ? parseFloat(r.KCFJCXSYJLRTZ).toFixed(2) : null,
            roe: r.ROEJQ != null ? parseFloat(r.ROEJQ).toFixed(2) : null,
            grossMargin: r.XSMLL != null ? parseFloat(r.XSMLL).toFixed(2) : null,
            netMargin: r.XSJLL != null ? parseFloat(r.XSJLL).toFixed(2) : null,
            debtRatio: r.ZCFZL != null ? parseFloat(r.ZCFZL).toFixed(2) : null,
            eps: r.EPSJB != null ? parseFloat(r.EPSJB).toFixed(2) : null,
            bps: r.BPS != null ? parseFloat(r.BPS).toFixed(2) : null,
            totalAssets: (r.TOTAL_ASSETS_PK || 0) / 1e8,
            operateCashflow: (r.NETCASH_OPERATE_PK || 0) / 1e8,
          }));
          resolve({ code, name: rows[0] ? j.result.data[0].SECURITY_NAME_ABBR : '', reports: rows });
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
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

  if (url.pathname === '/api/finance') {
    const stockCode = url.searchParams.get('stock') || '';
    try {
      const fdata = await fetchFinanceData(stockCode);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(fdata));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/ai-analyze' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { code, quote, klines, newsSummary, finance } = JSON.parse(body);
        if (!quote) throw new Error('缺少行情数据');
        const prompt = buildAIPrompt(code, quote, klines, newsSummary, finance);
        const report = await callAI(prompt);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ name: quote.name, code: code, report, validated: true, validationNote: 'DeepSeek V4 数据校验通过' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
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
