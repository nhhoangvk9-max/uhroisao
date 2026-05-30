/**
 * ============================================================
 *  HitClub MD5 - Dự đoán Tài/Xỉu thông minh
 *  Thuật toán: Phân tích cầu đa tầng + Bayes + Streak detection
 * ============================================================
 */

const API_URL = "https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=g8&gid={gid}";

// ──────────────────────────────────────────────
//  CẤU HÌNH
// ──────────────────────────────────────────────
const CONFIG = {
  HISTORY_SIZE: 30,        // Số phiên lịch sử giữ lại
  POLL_INTERVAL_MS: 5000,  // Khoảng cách gọi API (ms)
  MAX_WRONG_STREAK: 3,     // Ngưỡng sai liên tiếp → tự điều chỉnh
  WEIGHTS: {
    streak:   0.35,        // Trọng số cầu liên tiếp
    pattern:  0.25,        // Trọng số nhận dạng pattern
    bayes:    0.25,        // Trọng số Bayes tần suất
    api:      0.15,        // Trọng số gợi ý từ API nguồn
  },
};

// ──────────────────────────────────────────────
//  TRẠNG THÁI TOÀN CỤC
// ──────────────────────────────────────────────
const state = {
  history: [],          // [{ phien, ket_qua, xuc_xac, tong }]
  predictions: [],      // [{ phien, du_doan, ket_qua, dung }]
  wrongStreak: 0,
  totalPredictions: 0,
  totalCorrect: 0,
  lastPhien: null,
};

// ──────────────────────────────────────────────
//  TIỆN ÍCH
// ──────────────────────────────────────────────
function tong(xucXac) {
  return xucXac.reduce((a, b) => a + b, 0);
}

function label(t) {
  return t >= 11 ? "Tài" : "Xỉu";
}

function now() {
  return new Date().toLocaleTimeString("vi-VN");
}

function colorize(text, color) {
  const codes = { green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", reset: "\x1b[0m" };
  return `${codes[color] || ""}${text}${codes.reset}`;
}

// ──────────────────────────────────────────────
//  GỌI API
// ──────────────────────────────────────────────
async function fetchLatest() {
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ──────────────────────────────────────────────
//  THUẬT TOÁN 1: STREAK DETECTION
//  Phát hiện cầu đang chạy (bệt Tài / bệt Xỉu / cầu bàn)
// ──────────────────────────────────────────────
function analyzeStreak(hist) {
  if (hist.length < 2) return { vote: null, confidence: 0 };

  const results = hist.map(h => h.ket_qua);
  const last = results[results.length - 1];

  // Đếm streak cuối
  let streak = 1;
  for (let i = results.length - 2; i >= 0; i--) {
    if (results[i] === last) streak++;
    else break;
  }

  // Cầu bàn (xen kẽ T-X-T-X...)
  let isAlternating = true;
  for (let i = results.length - 1; i >= Math.max(0, results.length - 6); i--) {
    if (i > 0 && results[i] === results[i - 1]) { isAlternating = false; break; }
  }

  if (isAlternating && results.length >= 4) {
    // Cầu bàn → tiếp theo ngược lại
    const next = last === "Tài" ? "Xỉu" : "Tài";
    return { vote: next, confidence: 0.72 };
  }

  if (streak >= 5) {
    // Cầu dài → có thể sắp gãy
    const next = last === "Tài" ? "Xỉu" : "Tài";
    return { vote: next, confidence: 0.60 };
  }

  if (streak >= 2 && streak <= 4) {
    // Cầu đang chạy → theo cầu
    return { vote: last, confidence: 0.55 + streak * 0.03 };
  }

  return { vote: last, confidence: 0.50 };
}

// ──────────────────────────────────────────────
//  THUẬT TOÁN 2: NHẬN DẠNG PATTERN (chuỗi lặp)
//  Tìm pattern độ dài 2-5 phiên lặp lại
// ──────────────────────────────────────────────
function analyzePattern(hist) {
  if (hist.length < 6) return { vote: null, confidence: 0 };

  const results = hist.map(h => h.ket_qua);
  const n = results.length;

  for (let len = 2; len <= 5; len++) {
    const pattern = results.slice(n - len * 2, n - len);
    const recent  = results.slice(n - len, n);

    if (pattern.join(",") === recent.join(",")) {
      // Pattern lặp lại hoàn toàn → dự đoán phần tử tiếp theo của pattern
      const nextIdx = 0; // Phần tử kế tiếp trong pattern gốc (sau khi lặp)
      // Lấy pattern một chu kỳ nữa từ vị trí tương ứng
      const cyclePos = 0;
      const vote = pattern[cyclePos];
      return { vote, confidence: 0.70 + len * 0.02 };
    }

    // Kiểm tra match một phần (>= 80%)
    let matchCount = 0;
    for (let i = 0; i < len; i++) {
      if (pattern[i] === recent[i]) matchCount++;
    }
    if (matchCount / len >= 0.8) {
      return { vote: pattern[0], confidence: 0.62 };
    }
  }

  return { vote: null, confidence: 0 };
}

// ──────────────────────────────────────────────
//  THUẬT TOÁN 3: BAYES XÁC SUẤT TẦN SUẤT
//  Dựa trên tổng xúc xắc phân phối lịch sử
// ──────────────────────────────────────────────
function analyzeBayes(hist) {
  if (hist.length < 5) return { vote: null, confidence: 0 };

  const recent = hist.slice(-15);
  let tai = 0, xiu = 0;
  let sumTai = 0, sumXiu = 0;

  recent.forEach(h => {
    if (h.ket_qua === "Tài") { tai++; sumTai += h.tong; }
    else { xiu++; sumXiu += h.tong; }
  });

  const total = tai + xiu;
  const pTai = tai / total;
  const pXiu = xiu / total;

  // Xu hướng tổng điểm gần đây
  const lastTong = hist[hist.length - 1].tong;
  const avgTong = recent.reduce((a, h) => a + h.tong, 0) / recent.length;

  // Nếu tổng gần đây thấp → xu hướng Xỉu, cao → Tài
  let vote, confidence;
  if (pTai > 0.65) {
    vote = "Xỉu"; confidence = Math.min(0.75, pTai * 0.9);
  } else if (pXiu > 0.65) {
    vote = "Tài"; confidence = Math.min(0.75, pXiu * 0.9);
  } else {
    // Dùng độ lệch tổng gần nhất
    vote = lastTong > avgTong ? "Xỉu" : "Tài";
    confidence = 0.52 + Math.abs(lastTong - avgTong) / 36;
  }

  return { vote, confidence: Math.min(confidence, 0.78) };
}

// ──────────────────────────────────────────────
//  THUẬT TOÁN 4: TỰ ĐIỀU CHỈNH KHI SAI LIÊN TIẾP
//  Nếu sai >= 3 lần → đảo ngược kết quả dự đoán
// ──────────────────────────────────────────────
function applyCorrection(vote) {
  if (state.wrongStreak >= CONFIG.MAX_WRONG_STREAK) {
    console.log(colorize(`  ⚠️  Sai ${state.wrongStreak} lần liên tiếp → Đảo chiều dự đoán!`, "yellow"));
    return vote === "Tài" ? "Xỉu" : "Tài";
  }
  return vote;
}

// ──────────────────────────────────────────────
//  TỔNG HỢP DỰ ĐOÁN (Ensemble Voting)
// ──────────────────────────────────────────────
function makePrediction(hist, apiSuggestion) {
  const streak  = analyzeStreak(hist);
  const pattern = analyzePattern(hist);
  const bayes   = analyzeBayes(hist);

  const votes = { "Tài": 0, "Xỉu": 0 };

  // Cộng điểm có trọng số
  function addVote(result, weight) {
    if (result.vote && result.confidence > 0) {
      votes[result.vote] += result.confidence * weight;
    }
  }

  addVote(streak,  CONFIG.WEIGHTS.streak);
  addVote(pattern, CONFIG.WEIGHTS.pattern);
  addVote(bayes,   CONFIG.WEIGHTS.bayes);

  // API gợi ý
  if (apiSuggestion) {
    votes[apiSuggestion] += CONFIG.WEIGHTS.api;
  }

  const finalVote = votes["Tài"] >= votes["Xỉu"] ? "Tài" : "Xỉu";
  const totalScore = votes["Tài"] + votes["Xỉu"];
  const confidence = totalScore > 0
    ? Math.round((votes[finalVote] / totalScore) * 100)
    : 50;

  const corrected = applyCorrection(finalVote);

  return {
    du_doan: corrected,
    do_tin_cay: `${confidence}%`,
    detail: {
      streak:  `${streak.vote || "?"} (${Math.round(streak.confidence * 100)}%)`,
      pattern: `${pattern.vote || "?"} (${Math.round(pattern.confidence * 100)}%)`,
      bayes:   `${bayes.vote || "?"} (${Math.round(bayes.confidence * 100)}%)`,
      api:     `${apiSuggestion || "?"} (API)`,
    },
  };
}

// ──────────────────────────────────────────────
//  CẬP NHẬT KẾT QUẢ & THỐNG KÊ
// ──────────────────────────────────────────────
function updateResult(phien, ket_qua) {
  const pred = state.predictions.find(p => p.phien === phien);
  if (!pred || pred.ket_qua !== undefined) return;

  pred.ket_qua = ket_qua;
  pred.dung = pred.du_doan === ket_qua;

  state.totalPredictions++;
  if (pred.dung) {
    state.totalCorrect++;
    state.wrongStreak = 0;
    console.log(colorize(`  ✅ Phiên ${phien}: DỰ ĐOÁN ĐÚNG! (${pred.du_doan})`, "green"));
  } else {
    state.wrongStreak++;
    console.log(colorize(`  ❌ Phiên ${phien}: Sai (dự: ${pred.du_doan} | thực: ${ket_qua}) | Sai liên tiếp: ${state.wrongStreak}`, "red"));
  }

  const acc = state.totalPredictions > 0
    ? ((state.totalCorrect / state.totalPredictions) * 100).toFixed(1)
    : "0.0";
  console.log(colorize(`  📊 Tổng độ chính xác: ${acc}% (${state.totalCorrect}/${state.totalPredictions})`, "cyan"));
}

// ──────────────────────────────────────────────
//  VÒNG LẶP CHÍNH
// ──────────────────────────────────────────────
async function loop() {
  try {
    const data = await fetchLatest();

    const phienHienTai = data.phien;
    const phienDuDoan  = data.phien_du_doan;

    // Cập nhật kết quả phiên trước nếu có
    if (state.lastPhien && phienHienTai !== state.lastPhien) {
      updateResult(phienHienTai, data.ket_qua);
    }

    // Thêm phiên hiện tại vào lịch sử
    const t = tong(data.xuc_xac);
    const entry = {
      phien: phienHienTai,
      ket_qua: data.ket_qua,
      xuc_xac: data.xuc_xac,
      tong: t,
    };

    // Tránh trùng lặp
    if (!state.history.find(h => h.phien === phienHienTai)) {
      state.history.push(entry);
      if (state.history.length > CONFIG.HISTORY_SIZE) {
        state.history.shift();
      }
    }

    // Tạo dự đoán cho phiên tiếp theo
    if (!state.predictions.find(p => p.phien === phienDuDoan)) {
      const pred = makePrediction(state.history, data.du_doan);

      state.predictions.push({ phien: phienDuDoan, ...pred });
      if (state.predictions.length > 50) state.predictions.shift();

      console.log("\n" + "═".repeat(55));
      console.log(colorize(`  [${now()}] Phiên ${phienHienTai}: ${data.ket_qua} | 🎲 ${data.xuc_xac.join("-")} (tổng: ${t})`, "cyan"));
      console.log(`  🔮 Dự đoán phiên ${phienDuDoan}: ` + colorize(pred.du_doan, pred.du_doan === "Tài" ? "yellow" : "green") + ` | Tin cậy: ${pred.do_tin_cay}`);
      console.log(`     ├ Streak:  ${pred.detail.streak}`);
      console.log(`     ├ Pattern: ${pred.detail.pattern}`);
      console.log(`     ├ Bayes:   ${pred.detail.bayes}`);
      console.log(`     └ API:     ${pred.detail.api}`);
    }

    state.lastPhien = phienHienTai;

  } catch (err) {
    console.error(colorize(`  [${now()}] Lỗi: ${err.message}`, "red"));
  }
}

// ──────────────────────────────────────────────
//  KHỞI ĐỘNG
// ──────────────────────────────────────────────
console.log(colorize("╔══════════════════════════════════════════════════════╗", "cyan"));
console.log(colorize("║   HitClub MD5 - Dự đoán thông minh đa thuật toán    ║", "cyan"));
console.log(colorize("╚══════════════════════════════════════════════════════╝", "cyan"));
console.log(`  API: ${API_URL}`);
console.log(`  Poll: ${CONFIG.POLL_INTERVAL_MS / 1000}s | History: ${CONFIG.HISTORY_SIZE} phiên | Max sai: ${CONFIG.MAX_WRONG_STREAK}\n`);

loop(); // Chạy ngay lập tức
setInterval(loop, CONFIG.POLL_INTERVAL_MS);
