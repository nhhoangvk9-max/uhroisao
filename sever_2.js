const express = require('express');
const axios = require('axios');
const Database = require('better-sqlite3');
const crypto = require('crypto');

// ================= CẤU HÌNH =================
const API_SOURCE = "https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu";
const PLATFORM_ID = "g8";
const GID_DEFAULT = "default";    // gid mẫu, có thể thay đổi qua query param
const SECRET_KEY = "my_secret_2025";
const FETCH_INTERVAL = 3000;      // 3 giây
const HISTORY_LIMIT = 200;        // số phiên lấy về để phân tích

// ================= DATABASE =================
const db = new Database('taixiu.db');
db.pragma('journal_mode = WAL'); // hiệu năng tốt hơn

// Khởi tạo bảng
db.exec(`
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE,
    result TEXT,
    timestamp TEXT
  );
  CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE,
    prediction TEXT,
    md5_hash TEXT,
    created_at TEXT,
    actual_result TEXT
  );
`);

// ================= TRUY VẤN DB =================
function saveResult(session_id, result, ts) {
  const stmt = db.prepare('INSERT OR IGNORE INTO history (session_id, result, timestamp) VALUES (?, ?, ?)');
  stmt.run(session_id, result, ts);
}

function getHistory(limit = 200) {
  // Lấy từ cũ nhất đến mới nhất để phân tích cầu
  const rows = db.prepare('SELECT session_id, result FROM history ORDER BY id ASC LIMIT ?').all(limit);
  return rows; // [{session_id, result}]
}

function getLastSessionId() {
  const row = db.prepare('SELECT session_id FROM history ORDER BY id DESC LIMIT 1').get();
  return row ? row.session_id : null;
}

function savePrediction(session_id, prediction, md5_hash) {
  const stmt = db.prepare(`INSERT OR REPLACE INTO predictions (session_id, prediction, md5_hash, created_at) 
                           VALUES (?, ?, ?, ?)`);
  stmt.run(session_id, prediction, md5_hash, new Date().toISOString());
}

function updatePredictionResult(session_id, actual) {
  const stmt = db.prepare('UPDATE predictions SET actual_result = ? WHERE session_id = ?');
  stmt.run(actual, session_id);
}

function getPredictions(limit = 100) {
  const rows = db.prepare('SELECT session_id, prediction, md5_hash, created_at, actual_result FROM predictions ORDER BY id DESC LIMIT ?').all(limit);
  return rows;
}

function getAccuracy() {
  const total = db.prepare('SELECT COUNT(*) as count FROM predictions WHERE actual_result IS NOT NULL').get().count;
  if (total === 0) return { total: 0, correct: 0, accuracy: 0 };
  const correct = db.prepare('SELECT COUNT(*) as count FROM predictions WHERE prediction = actual_result AND actual_result IS NOT NULL').get().count;
  return {
    total_verified: total,
    correct: correct,
    accuracy: parseFloat(((correct / total) * 100).toFixed(2))
  };
}

// ================= GỌI API NGUỒN =================
async function fetchResults() {
  try {
    const params = { platform_id: PLATFORM_ID, gid: GID_DEFAULT };
    const response = await axios.get(API_SOURCE, { params, timeout: 5000 });
    if (response.status !== 200) {
      console.error(`API nguồn trả về lỗi ${response.status}`);
      return [];
    }
    const data = response.data;
    // Điều chỉnh theo cấu trúc thực tế. Giả sử data.data là mảng các phiên
    if (data && Array.isArray(data.data)) {
      return data.data;
    } else if (Array.isArray(data)) {
      return data;
    } else {
      console.error('Định dạng dữ liệu không rõ:', data);
      return [];
    }
  } catch (err) {
    console.error('Lỗi fetch:', err.message);
    return [];
  }
}

async function pollNewSessions() {
  console.log('Bắt đầu fetch dữ liệu...');
  let lastId = getLastSessionId();
  while (true) {
    const sessions = await fetchResults();
    if (sessions.length > 0) {
      for (const s of sessions) {
        const sid = s.session_id || s.gid; // tùy API
        const res = s.result;
        const ts = s.time || new Date().toISOString();
        if (sid && res) {
          saveResult(sid, res, ts);
          updatePredictionResult(sid, res);
        }
      }
      // Kiểm tra xem có phiên mới nhất không
      const currentLast = getLastSessionId();
      if (currentLast !== lastId) {
        lastId = currentLast;
      }
    }
    await new Promise(resolve => setTimeout(resolve, FETCH_INTERVAL));
  }
}

// ================= THUẬT TOÁN PHÂN TÍCH CẦU =================
function analyzePattern(history) {
  if (!history || history.length < 2) return null;

  const results = history.map(item => item.result); // mảng 'tai'/'xiu'
  const MIN_MATCH = 3;

  let bestTai = 0, bestXiu = 0;
  let found = false;

  // Duyệt từ mẫu dài nhất đến ngắn nhất
  for (let len = Math.min(Math.floor(results.length / 2), 10); len >= MIN_MATCH; len--) {
    const pattern = results.slice(-len);
    let countTai = 0, countXiu = 0;
    // Đếm số lần pattern xuất hiện trong lịch sử (trừ lần cuối cùng đang xét)
    for (let i = 0; i <= results.length - len - 1; i++) {
      if (results.slice(i, i + len).every((val, idx) => val === pattern[idx])) {
        if (i + len < results.length) {
          const next = results[i + len];
          if (next === 'tai') countTai++;
          else if (next === 'xiu') countXiu++;
        }
      }
    }
    if (countTai + countXiu > 0) {
      bestTai = countTai;
      bestXiu = countXiu;
      found = true;
      break; // lấy mẫu dài nhất có dữ liệu
    }
  }

  if (found) {
    if (bestTai > bestXiu) return 'tai';
    if (bestXiu > bestTai) return 'xiu';
  }

  // Heuristic: cầu bệt, 1-1
  if (results.length >= 3) {
    const last3 = results.slice(-3);
    if (last3.every(v => v === last3[0])) {
      return results[results.length - 1]; // bệt
    }
    if (last3[0] !== last3[1] && last3[1] !== last3[2] && last3[0] === last3[2]) {
      return results[results.length - 1] === 'tai' ? 'xiu' : 'tai'; // 1-1
    }
  }

  // Mặc định tỉ lệ tổng
  const totalTai = results.filter(r => r === 'tai').length;
  const totalXiu = results.filter(r => r === 'xiu').length;
  return totalTai > totalXiu ? 'tai' : 'xiu';
}

function generateMD5(sessionId, prediction) {
  return crypto.createHash('md5').update(`${sessionId}${prediction}${SECRET_KEY}`).digest('hex');
}

function getNextSessionId(lastSid) {
  if (!lastSid) return `next_${Date.now()}`;
  const num = parseInt(lastSid, 10);
  return isNaN(num) ? `next_${Date.now()}` : String(num + 1);
}

// ================= EXPRESS APP =================
const app = express();
app.use(express.json());

// API dự đoán
app.get('/api/predict', (req, res) => {
  const gid = req.query.gid || GID_DEFAULT; // có thể dùng sau
  const history = getHistory(HISTORY_LIMIT);
  if (history.length === 0) {
    return res.status(503).json({ error: 'Chưa có dữ liệu lịch sử' });
  }

  const prediction = analyzePattern(history);
  if (!prediction) {
    return res.status(500).json({ error: 'Không thể dự đoán' });
  }

  const lastSid = history[history.length - 1].session_id;
  const nextSid = getNextSessionId(lastSid);
  const md5 = generateMD5(nextSid, prediction);

  savePrediction(nextSid, prediction, md5);

  return res.json({
    session_id: nextSid,
    prediction: prediction,
    md5: md5,
    timestamp: new Date().toISOString(),
    message: 'Dự đoán đã được khóa bằng MD5'
  });
});

// API xác minh
app.post('/api/verify', (req, res) => {
  const { session_id, actual_result } = req.body;
  if (!session_id || !actual_result) {
    return res.status(400).json({ error: 'Thiếu session_id hoặc actual_result' });
  }
  const row = db.prepare('SELECT prediction, md5_hash FROM predictions WHERE session_id = ?').get(session_id);
  if (!row) {
    return res.status(404).json({ error: 'Không tìm thấy dự đoán cho session này' });
  }
  const expectedMd5 = generateMD5(session_id, row.prediction);
  const md5Match = expectedMd5 === row.md5_hash;
  const correct = row.prediction === actual_result;
  updatePredictionResult(session_id, actual_result);
  return res.json({
    session_id,
    predicted: row.prediction,
    actual: actual_result,
    correct,
    md5_match: md5Match,
    verified: md5Match && correct
  });
});

// API lịch sử dự đoán
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const rows = getPredictions(limit);
  return res.json(rows);
});

// API độ chính xác
app.get('/api/accuracy', (req, res) => {
  return res.json(getAccuracy());
});

// ================= KHỞI ĐỘNG =================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server dự đoán Tài/Xỉu chạy trên cổng ${PORT}`);
  // Chạy tiến trình fetch nền
  pollNewSessions(); // async function, không cần await vì chạy vòng lặp vô tận
});