const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 默认初始数据
function createDefaultState() {
  return {
    settings: {
      title: '十佳歌手大赛 · 实时投票',
      currentRound: 1,
      maxVotesPerTicket: 1,
      judgeWeight: 20, // 1张导师票 = 20张观众票
      votingStatus: 'paused', // 'open' | 'paused' | 'ended'
      startTime: '', // ISO string or empty
      endTime: '',   // ISO string or empty
      adminPassword: 'admin',
      judgeCodes: ['J1', 'J2', 'J3']
    },
    contestants: Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      number: String(i + 1).padStart(2, '0'),
      name: `选手 ${i + 1} 号`,
      song: `参赛曲目 ${i + 1}`
    })),
    // tickets: { [code]: { createdAt, votedRounds: { [round]: [contestantIds] } } }
    tickets: {},
    // judgeVotes: { [round]: { [judgeCode]: [contestantIds] } }
    judgeVotes: {}
  };
}

let state = createDefaultState();
if (fs.existsSync(STATE_FILE)) {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('读取状态文件失败，使用默认配置:', e);
  }
}

let saveTimer = null;
function saveState() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8').catch(err => {
      console.error('保存状态失败:', err);
    });
  }, 50);
}

// 计算当前轮次的排行榜数据
function getPublicState() {
  const round = String(state.settings.currentRound);
  const audienceCounts = {};
  const judgeCounts = {};

  state.contestants.forEach(c => {
    audienceCounts[c.id] = 0;
    judgeCounts[c.id] = 0;
  });

  let totalAudienceVotes = 0;
  Object.values(state.tickets).forEach(ticket => {
    const voted = ticket.votedRounds?.[round];
    if (Array.isArray(voted)) {
      totalAudienceVotes++;
      voted.forEach(id => {
        if (audienceCounts[id] !== undefined) audienceCounts[id]++;
      });
    }
  });

  const roundJudgeVotes = state.judgeVotes[round] || {};
  let totalJudgeVotes = 0;
  Object.values(roundJudgeVotes).forEach(voted => {
    if (Array.isArray(voted)) {
      totalJudgeVotes++;
      voted.forEach(id => {
        if (judgeCounts[id] !== undefined) judgeCounts[id]++;
      });
    }
  });

  const weight = Number(state.settings.judgeWeight) || 1;
  const leaderboard = state.contestants.map(c => {
    const aVotes = audienceCounts[c.id] || 0;
    const jVotes = judgeCounts[c.id] || 0;
    const totalScore = aVotes + jVotes * weight;
    return {
      ...c,
      audienceVotes: aVotes,
      judgeVotes: jVotes,
      totalScore
    };
  });

  return {
    settings: {
      title: state.settings.title,
      currentRound: state.settings.currentRound,
      maxVotesPerTicket: state.settings.maxVotesPerTicket,
      judgeWeight: state.settings.judgeWeight,
      votingStatus: state.settings.votingStatus,
      startTime: state.settings.startTime,
      endTime: state.settings.endTime
    },
    leaderboard,
    stats: {
      totalTickets: Object.keys(state.tickets).length,
      totalAudienceVotes,
      totalJudgeVotes,
      totalJudges: state.settings.judgeCodes.length
    }
  };
}

function broadcastState() {
  const payload = JSON.stringify({ type: 'STATE_UPDATE', data: getPublicState() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// 定时检查自动开启/结束投票
setInterval(() => {
  const now = Date.now();
  let changed = false;
  const { startTime, endTime, votingStatus } = state.settings;

  if (startTime && votingStatus === 'paused') {
    const startMs = new Date(startTime).getTime();
    if (!isNaN(startMs) && now >= startMs && (!endTime || now < new Date(endTime).getTime())) {
      state.settings.votingStatus = 'open';
      changed = true;
    }
  }
  if (endTime && votingStatus === 'open') {
    const endMs = new Date(endTime).getTime();
    if (!isNaN(endMs) && now >= endMs) {
      state.settings.votingStatus = 'ended';
      changed = true;
    }
  }
  if (changed) {
    saveState();
    broadcastState();
  }
}, 1000);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 简单的管理员鉴权中间件
const adminTokens = new Set();
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  next();
}

// 管理员登录
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === state.settings.adminPassword) {
    const token = crypto.randomBytes(16).toString('hex');
    adminTokens.add(token);
    return res.json({ token });
  }
  res.status(401).json({ error: '密码错误' });
});

// 获取公开状态
app.get('/api/state', (req, res) => {
  res.json(getPublicState());
});

// 获取完整后台配置（含导师口令）
app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({
    settings: state.settings,
    publicState: getPublicState()
  });
});

// 更新设置
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const allowed = ['title', 'currentRound', 'maxVotesPerTicket', 'judgeWeight', 'votingStatus', 'startTime', 'endTime', 'adminPassword', 'judgeCodes'];
  allowed.forEach(key => {
    if (req.body[key] !== undefined) {
      state.settings[key] = req.body[key];
    }
  });
  saveState();
  broadcastState();
  res.json({ ok: true, state: getPublicState() });
});

// 选手管理
app.post('/api/admin/contestants', requireAdmin, (req, res) => {
  const { contestants } = req.body;
  if (!Array.isArray(contestants)) {
    return res.status(400).json({ error: '选手数据格式错误' });
  }
  state.contestants = contestants.map((c, idx) => ({
    id: c.id || Date.now() + idx,
    number: String(c.number || idx + 1).padStart(2, '0'),
    name: String(c.name || `选手 ${idx + 1}`),
    song: String(c.song || '')
  }));
  saveState();
  broadcastState();
  res.json({ ok: true, contestants: state.contestants });
});

// 批量生成门票码
app.post('/api/admin/tickets/generate', requireAdmin, (req, res) => {
  const count = Math.min(Math.max(Number(req.body.count) || 100, 1), 2000);
  const newCodes = [];
  for (let i = 0; i < count; i++) {
    let code;
    do {
      code = crypto.randomBytes(4).toString('hex').toUpperCase();
    } while (state.tickets[code]);
    state.tickets[code] = { createdAt: new Date().toISOString(), votedRounds: {} };
    newCodes.push(code);
  }
  saveState();
  broadcastState();
  res.json({ ok: true, generated: newCodes.length, total: Object.keys(state.tickets).length });
});

// 导出门票二维码（含 DataURL）
app.get('/api/admin/tickets/export', requireAdmin, async (req, res) => {
  const baseUrl = req.query.baseUrl || `${req.protocol}://${req.get('host')}`;
  const codes = Object.keys(state.tickets);
  const result = await Promise.all(
    codes.map(async (code, index) => {
      const url = `${baseUrl}/?code=${code}`;
      const qrDataUrl = await QRCode.toDataURL(url, { width: 220, margin: 1 });
      return { index: index + 1, code, url, qrDataUrl };
    })
  );
  res.json({ tickets: result });
});

// 导出导师专属二维码
app.get('/api/admin/judges/qr', requireAdmin, async (req, res) => {
  const baseUrl = req.query.baseUrl || `${req.protocol}://${req.get('host')}`;
  const codes = state.settings.judgeCodes || [];
  const judges = await Promise.all(
    codes.map(async (code, index) => {
      const url = `${baseUrl}/judge.html?code=${encodeURIComponent(code)}`;
      const qrDataUrl = await QRCode.toDataURL(url, { width: 220, margin: 1 });
      return { index: index + 1, code, url, qrDataUrl };
    })
  );
  res.json({ judges });
});

// 重置当前轮次投票或清空所有门票
app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const { type } = req.body; // 'round' | 'tickets'
  const round = String(state.settings.currentRound);
  if (type === 'round') {
    Object.values(state.tickets).forEach(t => {
      if (t.votedRounds) delete t.votedRounds[round];
    });
    delete state.judgeVotes[round];
  } else if (type === 'tickets') {
    state.tickets = {};
  }
  saveState();
  broadcastState();
  res.json({ ok: true });
});

// 检查门票状态（观众端进入时调用，不销毁二维码）
app.get('/api/ticket/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const ticket = state.tickets[code];
  if (!ticket) {
    return res.status(404).json({ error: '无效的门票二维码' });
  }
  const round = String(state.settings.currentRound);
  const votedIds = ticket.votedRounds?.[round] || null;
  res.json({
    valid: true,
    code,
    currentRound: state.settings.currentRound,
    hasVoted: Array.isArray(votedIds),
    votedIds
  });
});

// 观众提交投票
app.post('/api/vote', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const contestantIds = req.body.contestantIds;

  if (state.settings.votingStatus !== 'open') {
    return res.status(400).json({ error: '当前未开放投票' });
  }
  const ticket = state.tickets[code];
  if (!ticket) {
    return res.status(404).json({ error: '无效的门票二维码' });
  }
  const round = String(state.settings.currentRound);
  if (ticket.votedRounds?.[round]) {
    return res.status(400).json({ error: '您在本轮已投过票，无法重复提交' });
  }
  if (!Array.isArray(contestantIds) || contestantIds.length === 0) {
    return res.status(400).json({ error: '请至少选择一位选手' });
  }
  const uniqueIds = [...new Set(contestantIds.map(Number))];
  if (uniqueIds.length > Number(state.settings.maxVotesPerTicket)) {
    return res.status(400).json({ error: `每轮最多只能投 ${state.settings.maxVotesPerTicket} 票` });
  }
  const validIds = new Set(state.contestants.map(c => c.id));
  if (uniqueIds.some(id => !validIds.has(id))) {
    return res.status(400).json({ error: '包含无效的选手编号' });
  }

  if (!ticket.votedRounds) ticket.votedRounds = {};
  ticket.votedRounds[round] = uniqueIds;
  saveState();
  broadcastState();
  res.json({ ok: true, votedIds: uniqueIds });
});

// 导师提交投票
app.post('/api/judge/vote', (req, res) => {
  const judgeCode = String(req.body.judgeCode || '').trim().toUpperCase();
  const contestantIds = req.body.contestantIds;

  if (!state.settings.judgeCodes.map(c => c.toUpperCase()).includes(judgeCode)) {
    return res.status(403).json({ error: '导师口令无效' });
  }
  if (state.settings.votingStatus !== 'open') {
    return res.status(400).json({ error: '当前未开放投票' });
  }
  const round = String(state.settings.currentRound);
  if (!state.judgeVotes[round]) state.judgeVotes[round] = {};
  if (state.judgeVotes[round][judgeCode]) {
    return res.status(400).json({ error: '您在本轮已完成导师投票' });
  }
  if (!Array.isArray(contestantIds) || contestantIds.length === 0) {
    return res.status(400).json({ error: '请至少选择一位选手' });
  }
  const uniqueIds = [...new Set(contestantIds.map(Number))];
  state.judgeVotes[round][judgeCode] = uniqueIds;
  saveState();
  broadcastState();
  res.json({ ok: true, votedIds: uniqueIds });
});

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'STATE_UPDATE', data: getPublicState() }));
});

server.listen(PORT, () => {
  console.log(`🎤 十佳歌手投票系统已启动！`);
  console.log(`📺 大屏幕榜单: http://localhost:${PORT}/screen.html`);
  console.log(`⚙️  图形化后台: http://localhost:${PORT}/admin.html  (默认密码: admin)`);
  console.log(`🎓 导师投票页: http://localhost:${PORT}/judge.html  (默认口令: J1, J2, J3)`);
});
