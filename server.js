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
      mode: 'classic', // 'classic' | 'top10'
      currentRound: 1,
      activeGroup: 0, // 0 = 全部，1-8 = 十佳模式第1轮双人舞台当前投票组
      screenView: 'live', // 'live' | 'r1-groups' | 'r1-duels'
      maxVotesPerTicket: 1,
      judgeWeight: 20, // 1张导师票 = 20张观众票
      votingStatus: 'paused', // 'open' | 'paused' | 'ended'
      startTime: '', // ISO string or empty
      endTime: '',   // ISO string or empty
      adminPassword: 'admin',
      judgeCodes: ['J1', 'J2', 'J3'],
      activeContestantIds: []
    },
    contestants: Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      number: String(i + 1).padStart(2, '0'),
      name: `选手 ${i + 1} 号`,
      song: `参赛曲目 ${i + 1}`,
      group: Math.floor(i / 2) + 1
    })),
    // tickets: { [code]: { createdAt, votedRounds: { [bucketKey]: [contestantIds] } } }
    tickets: {},
    // judgeVotes: { [bucketKey]: { [judgeCode]: [contestantIds] } }
    judgeVotes: {},
    // manualVotes: { [bucketKey]: { [contestantId]: number } }
    manualVotes: {}
  };
}

let state = createDefaultState();
if (fs.existsSync(STATE_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const def = createDefaultState();
    state = {
      ...def,
      ...loaded,
      settings: { ...def.settings, ...(loaded.settings || {}) },
      tickets: loaded.tickets || {},
      judgeVotes: loaded.judgeVotes || {},
      manualVotes: loaded.manualVotes || {}
    };
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

// 获取当前投票使用的存储桶 Key（支持十佳模式第1轮按组独立投票）
function getVoteBucketKey() {
  if (
    state.settings.mode === 'top10' &&
    Number(state.settings.currentRound) === 1 &&
    Number(state.settings.activeGroup) > 0
  ) {
    return `1-G${Number(state.settings.activeGroup)}`;
  }
  return String(state.settings.currentRound);
}

// 获取当前轮次需要汇总的所有存储桶 Key
function getRoundBucketKeys() {
  const round = String(state.settings.currentRound);
  if (state.settings.mode === 'top10' && Number(round) === 1) {
    return ['1', '1-G1', '1-G2', '1-G3', '1-G4', '1-G5', '1-G6', '1-G7', '1-G8'];
  }
  return [round];
}

// 计算当前轮次的排行榜数据
function getPublicState() {
  const bucketKeys = getRoundBucketKeys();
  const activeBucketKey = getVoteBucketKey();
  const audienceCounts = {};
  const judgeCounts = {};

  state.contestants.forEach(c => {
    audienceCounts[c.id] = 0;
    judgeCounts[c.id] = 0;
  });

  let totalAudienceVotes = 0;
  Object.values(state.tickets).forEach(ticket => {
    bucketKeys.forEach(bk => {
      const voted = ticket.votedRounds?.[bk];
      if (Array.isArray(voted)) {
        totalAudienceVotes++;
        voted.forEach(id => {
          if (audienceCounts[id] !== undefined) audienceCounts[id]++;
        });
      }
    });
  });

  // 合并平滑加票数据
  bucketKeys.forEach(bk => {
    const roundManual = state.manualVotes?.[bk] || {};
    Object.entries(roundManual).forEach(([cid, count]) => {
      const numId = Number(cid);
      const val = Number(count) || 0;
      if (audienceCounts[numId] !== undefined && val > 0) {
        audienceCounts[numId] += val;
        totalAudienceVotes += val;
      }
    });
  });

  // 当前正在投票的桶（逐组投时显示当前组的导师进度，否则汇总本轮）
  let totalJudgeVotes = 0;
  const judgeBucketsToCount = Number(state.settings.activeGroup) > 0 ? [activeBucketKey] : bucketKeys;
  judgeBucketsToCount.forEach(bk => {
    const roundJudgeVotes = state.judgeVotes[bk] || {};
    Object.values(roundJudgeVotes).forEach(voted => {
      if (Array.isArray(voted)) {
        totalJudgeVotes++;
      }
    });
  });
  bucketKeys.forEach(bk => {
    const roundJudgeVotes = state.judgeVotes[bk] || {};
    Object.values(roundJudgeVotes).forEach(voted => {
      if (Array.isArray(voted)) {
        voted.forEach(id => {
          if (judgeCounts[id] !== undefined) judgeCounts[id]++;
        });
      }
    });
  });

  const weight = Number(state.settings.judgeWeight) || 1;
  const activeGroupNum = Number(state.settings.activeGroup) || 0;
  const isTop10R1 = state.settings.mode === 'top10' && Number(state.settings.currentRound) === 1;

  const activeSet =
    state.settings.mode === 'top10' &&
    Array.isArray(state.settings.activeContestantIds) &&
    state.settings.activeContestantIds.length > 0
      ? new Set(state.settings.activeContestantIds.map(Number))
      : null;

  const allScored = state.contestants
    .filter(c => !activeSet || activeSet.has(c.id))
    .map(c => {
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

  let groupTotals = null;
  let allRound1Leaderboard = null;
  let leaderboard = allScored;

  if (isTop10R1) {
    groupTotals = {};
    allScored.forEach(c => {
      const g = c.group || 1;
      groupTotals[g] = (groupTotals[g] || 0) + c.totalScore;
    });
    allRound1Leaderboard = allScored.map(c => ({
      ...c,
      groupTotal: groupTotals[c.group || 1] || 0
    }));
    leaderboard = activeGroupNum > 0
      ? allRound1Leaderboard.filter(c => Number(c.group) === activeGroupNum)
      : allRound1Leaderboard;
  }

  return {
    settings: {
      title: state.settings.title,
      mode: state.settings.mode || 'classic',
      currentRound: state.settings.currentRound,
      activeGroup: activeGroupNum,
      screenView: state.settings.screenView || 'live',
      maxVotesPerTicket: state.settings.maxVotesPerTicket,
      judgeWeight: state.settings.judgeWeight,
      votingStatus: state.settings.votingStatus,
      startTime: state.settings.startTime,
      endTime: state.settings.endTime,
      activeContestantIds: state.settings.activeContestantIds || []
    },
    leaderboard,
    allRound1Leaderboard,
    groupTotals,
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

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 1张/秒平滑加票管理
const activeDrips = new Map(); // contestantId -> { timer, remaining, round }

function stopAllDrips() {
  activeDrips.forEach(entry => clearInterval(entry.timer));
  activeDrips.clear();
}

function getDripStatus() {
  return Array.from(activeDrips.entries()).map(([contestantId, info]) => ({
    contestantId,
    remaining: info.remaining,
    round: info.round
  }));
}

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

// 获取完整后台配置（含导师口令、全部选手及当前加票任务）
app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({
    settings: state.settings,
    allContestants: state.contestants,
    activeDrips: getDripStatus(),
    publicState: getPublicState()
  });
});

// 更新设置
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const allowed = [
    'title',
    'mode',
    'currentRound',
    'activeGroup',
    'screenView',
    'maxVotesPerTicket',
    'judgeWeight',
    'votingStatus',
    'startTime',
    'endTime',
    'adminPassword',
    'judgeCodes',
    'activeContestantIds'
  ];
  allowed.forEach(key => {
    if (req.body[key] !== undefined) {
      state.settings[key] = req.body[key];
    }
  });
  saveState();
  broadcastState();
  res.json({ ok: true, state: getPublicState() });
});

// 选手管理（支持保留空白姓名/曲目及组别）
app.post('/api/admin/contestants', requireAdmin, (req, res) => {
  const { contestants } = req.body;
  if (!Array.isArray(contestants)) {
    return res.status(400).json({ error: '选手数据格式错误' });
  }
  state.contestants = contestants.map((c, idx) => ({
    id: Number(c.id) || Date.now() + idx,
    number: String(c.number || idx + 1).padStart(2, '0'),
    name: c.name !== undefined ? String(c.name) : '',
    song: c.song !== undefined ? String(c.song) : '',
    group: Number(c.group) || Math.floor(idx / 2) + 1
  }));
  saveState();
  broadcastState();
  res.json({ ok: true, contestants: state.contestants });
});

// 十佳定制模式：初始化16位空白选手（8组两人配对）
app.post('/api/admin/top10/init-16', requireAdmin, (req, res) => {
  stopAllDrips();
  state.contestants = Array.from({ length: 16 }, (_, i) => ({
    id: i + 1,
    number: String(i + 1).padStart(2, '0'),
    name: '',
    song: '',
    group: Math.floor(i / 2) + 1
  }));
  state.settings.mode = 'top10';
  state.settings.currentRound = 1;
  state.settings.activeGroup = 0;
  state.settings.screenView = 'live';
  state.settings.activeContestantIds = [];
  state.settings.votingStatus = 'paused';
  saveState();
  broadcastState();
  res.json({ ok: true, contestants: state.contestants });
});

// 十佳定制模式：晋级下一轮
app.post('/api/admin/top10/advance', requireAdmin, (req, res) => {
  const nextRound = Number(req.body.nextRound);
  const qualifiedIds = Array.isArray(req.body.qualifiedIds) ? req.body.qualifiedIds.map(Number) : [];
  if (!nextRound || qualifiedIds.length === 0) {
    return res.status(400).json({ error: '请选择晋级选手与目标轮次' });
  }
  stopAllDrips();
  state.settings.mode = 'top10';
  state.settings.currentRound = nextRound;
  state.settings.activeGroup = 0;
  state.settings.screenView = 'live';
  state.settings.activeContestantIds = qualifiedIds;
  state.settings.votingStatus = 'paused';
  saveState();
  broadcastState();
  res.json({ ok: true, state: getPublicState() });
});

// 项目存档导出
app.get('/api/admin/archive/export', requireAdmin, (req, res) => {
  res.json({
    exportedAt: new Date().toISOString(),
    state
  });
});

// 项目存档导入恢复
app.post('/api/admin/archive/import', requireAdmin, (req, res) => {
  const incoming = req.body.state || req.body;
  if (!incoming || !incoming.settings || !Array.isArray(incoming.contestants)) {
    return res.status(400).json({ error: '无效的项目存档文件格式' });
  }
  stopAllDrips();
  const def = createDefaultState();
  state = {
    ...def,
    ...incoming,
    settings: { ...def.settings, ...incoming.settings },
    tickets: incoming.tickets || {},
    judgeVotes: incoming.judgeVotes || {},
    manualVotes: incoming.manualVotes || {}
  };
  saveState();
  broadcastState();
  res.json({ ok: true, state: getPublicState() });
});

// 人工微调（1张/秒平滑加票）
app.post('/api/admin/drip/start', requireAdmin, (req, res) => {
  const contestantId = Number(req.body.contestantId);
  const count = Math.min(Math.max(Number(req.body.count) || 0, 1), 500);
  if (!state.contestants.some(c => c.id === contestantId)) {
    return res.status(400).json({ error: '无效的选手' });
  }

  const round = getVoteBucketKey();
  const addOneVote = () => {
    if (!state.manualVotes[round]) state.manualVotes[round] = {};
    state.manualVotes[round][contestantId] = (state.manualVotes[round][contestantId] || 0) + 1;
    saveState();
    broadcastState();
  };

  if (activeDrips.has(contestantId)) {
    const existing = activeDrips.get(contestantId);
    existing.remaining += count;
    return res.json({ ok: true, activeDrips: getDripStatus() });
  }

  // 立即加第1票，其余每秒加1票
  addOneVote();
  const leftAfterFirst = count - 1;
  if (leftAfterFirst > 0) {
    const entry = { remaining: leftAfterFirst, round, timer: null };
    entry.timer = setInterval(() => {
      addOneVote();
      entry.remaining -= 1;
      if (entry.remaining <= 0) {
        clearInterval(entry.timer);
        activeDrips.delete(contestantId);
      }
    }, 1000);
    activeDrips.set(contestantId, entry);
  }

  res.json({ ok: true, activeDrips: getDripStatus() });
});

app.post('/api/admin/drip/stop', requireAdmin, (req, res) => {
  stopAllDrips();
  res.json({ ok: true, activeDrips: [] });
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
  const bucketKeys = getRoundBucketKeys();
  if (type === 'round') {
    stopAllDrips();
    Object.values(state.tickets).forEach(t => {
      if (t.votedRounds) {
        bucketKeys.forEach(bk => delete t.votedRounds[bk]);
      }
    });
    bucketKeys.forEach(bk => {
      delete state.judgeVotes[bk];
      if (state.manualVotes) delete state.manualVotes[bk];
    });
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
  const bucketKey = getVoteBucketKey();
  const votedIds = ticket.votedRounds?.[bucketKey] || null;
  res.json({
    valid: true,
    code,
    currentRound: state.settings.currentRound,
    activeGroup: Number(state.settings.activeGroup) || 0,
    voteBucket: bucketKey,
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
  const bucketKey = getVoteBucketKey();
  if (ticket.votedRounds?.[bucketKey]) {
    return res.status(400).json({ error: '您在本组/本轮已投过票，无法重复提交' });
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
  ticket.votedRounds[bucketKey] = uniqueIds;
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
  const bucketKey = getVoteBucketKey();
  if (!state.judgeVotes[bucketKey]) state.judgeVotes[bucketKey] = {};
  if (state.judgeVotes[bucketKey][judgeCode]) {
    return res.status(400).json({ error: '您在本组/本轮已完成导师投票' });
  }
  if (!Array.isArray(contestantIds) || contestantIds.length === 0) {
    return res.status(400).json({ error: '请至少选择一位选手' });
  }
  const uniqueIds = [...new Set(contestantIds.map(Number))];
  state.judgeVotes[bucketKey][judgeCode] = uniqueIds;
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
