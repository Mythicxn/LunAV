const $ = (id) => document.getElementById(id);
const msgEl = $('msg'), sendBtn = $('send'), seeBtn = $('seescreen'), bubble = $('bubble');
const logEl = $('log'), logListEl = $('loglist'), logStatusEl = $('log-status'), settingsEl = $('settings');
const modelSelectEl = $('model-select'), modelStatusEl = $('modelstatus');

let live2dModels = [];
let currentLive2DModelId = null;
let live2dLoading = false;

let hasKey = false;
let busy = false;
let emoInfo = null;    // thông tin tham số biểu cảm của model
let basePitchHz = 0;   // độ cao giọng đang lưu (Hz), để cộng thêm theo cảm xúc
let pixiApp = null;     // renderer Live2D, dùng để tự co giãn khi cửa sổ thay đổi kích thước
let logCount = 0;

/* ---------- Theo dõi màn hình nhẹ (bấm 👁 để bật/tắt) ---------- */
let watching = false;
let watchTimer = null;
let watchStopAt = 0;
let watchIntervalMs = 20000; // đè lại bằng giá trị từ cai-dat.json (theoDoiKhoangCachGiay) lúc khởi động, xem bên dưới
let watchTickStart = 0;      // lúc bắt đầu lượt chụp gần nhất - để giữ đúng nhịp "mỗi N giây 1 lần" tính từ lúc chụp
let watchMaxMs = 15 * 60 * 1000;
const STOP_WATCH_RE = /(ngừng|dừng|tắt|thôi)[^.!?]{0,12}(theo dõi|nhìn|xem màn hình)|(xong|hết)( việc| rồi){1,2}( nhé)?[.!]?$/i;

/* ---------- Chủ động hiện diện: ACTIVE -> QUIET -> WATCHING -> AWAY -> RETURNED ---------- */
let proactiveEnabled = true;
let proactiveQuietMs = 5 * 60 * 1000;
let proactiveIntervalMs = 60 * 1000;
let proactiveAwayMs = 15 * 60 * 1000;
let proactiveCooldownMinMs = 5 * 60 * 1000;
let proactiveCooldownMaxMs = 7 * 60 * 1000;
let proactiveState = 'ACTIVE';
let proactiveTimer = null;
let proactiveWatching = false;
let proactiveNextSpeakAt = 0;
let proactiveReturnTimer = null;

/* ---------- Giọng nói ---------- */
let muted = false;
let speaking = false;
let viVoice = null;
let enVoice = null;
let audioCtx = null;
let currentSrc = null;
let currentAudioEl = null; // dùng cho audio mp3 (Edge TTS)
let voiceRate = 1; // độ cao giọng (tốc độ phát): >1 cao và nhanh hơn

// Giọng dự phòng của Windows (dùng khi cả Edge TTS lẫn Gemini TTS đều lỗi/hết hạn mức)
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  viVoice = voices.find((v) => v.lang === 'vi-VN') || voices.find((v) => v.lang.startsWith('vi')) || null;
  enVoice = voices.find((v) => v.lang === 'en-US') || voices.find((v) => v.lang.startsWith('en')) || null;
}
speechSynthesis.onvoiceschanged = pickVoice;
pickVoice();

function speakWindows(text, lang) {
  speechSynthesis.cancel();
  const useEn = lang === 'en';
  const u = new SpeechSynthesisUtterance(text);
  u.lang = useEn ? 'en-US' : 'vi-VN';
  const v = useEn ? enVoice : viVoice;
  if (v) u.voice = v;
  u.pitch = 1.1;
  u.onstart = () => { speaking = true; };
  u.onend = u.onerror = () => { speaking = false; };
  speechSynthesis.speak(u);
}

let playToken = 0; // tăng lên mỗi lần dừng/nói mới để huỷ lượt cũ

function stopSpeaking() {
  playToken++;
  speechSynthesis.cancel();
  if (currentSrc) { try { currentSrc.stop(); } catch {} currentSrc = null; }
  if (currentAudioEl) { try { currentAudioEl.pause(); } catch {} currentAudioEl = null; }
  speaking = false;
}

// Tách câu đầu ra riêng để phát sớm; phần còn lại tạo song song rồi phát nối tiếp
function splitReply(text) {
  const s = text.replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.+?[.!?…]+)\s+(.+)$/);
  return m && m[1].length >= 15 ? [m[1], m[2]] : [s];
}

async function playPcm(b64, rate) {
  audioCtx = audioCtx || new AudioContext({ sampleRate: 24000 });
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  // Gemini trả về PCM 16-bit, 24kHz, mono (base64)
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  const buf = audioCtx.createBuffer(1, pcm.length, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;

  return new Promise((resolve) => {
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.min(1.5, Math.max(0.8, rate || 1));
    src.connect(audioCtx.destination);
    src.onended = () => { if (currentSrc === src) currentSrc = null; resolve(); };
    currentSrc = src;
    speaking = true;
    src.start();
  });
}

// Phát audio mp3 trả về từ Edge TTS (khác định dạng với PCM thô của Gemini TTS)
function playMp3(b64, rate) {
  return new Promise((resolve) => {
    const audio = new Audio('data:audio/mpeg;base64,' + b64);
    audio.playbackRate = Math.min(1.5, Math.max(0.8, rate || 1));
    audio.onended = () => { if (currentAudioEl === audio) currentAudioEl = null; resolve(); };
    audio.onerror = () => { if (currentAudioEl === audio) currentAudioEl = null; resolve(); };
    currentAudioEl = audio;
    speaking = true;
    audio.play().catch(() => resolve());
  });
}

async function speak(text, opts = {}) {
  // opts: voice/style = thử giọng khác; force = bỏ qua nút tắt tiếng; split = false để đọc một lần;
  //       rate = độ cao giọng thử; noFallback = lỗi thì báo false, không đọc bằng giọng Windows
  if (muted && !opts.force) return false;
  stopSpeaking();
  const token = playToken;
  const lang = opts.lang || 'en'; // âm thanh CHỈ nói tiếng Anh: 'en' mặc định (Edge TTS), chỉ dùng 'vi' khi cố ý truyền vào (không còn chỗ nào gọi vậy nữa)
  const parts = opts.split === false ? [String(text).replace(/\s+/g, ' ').trim()] : splitReply(text);
  const ttsOpt = { voice: opts.voice, style: opts.style, lang, edgeVoice: opts.edgeVoice, edgePitch: opts.edgePitch, edgeRate: opts.edgeRate };
  const jobs = parts.map((p) => window.api.tts(p, ttsOpt)); // gửi tất cả cùng lúc

  for (let i = 0; i < parts.length; i++) {
    const r = await jobs[i];
    if (token !== playToken || (muted && !opts.force)) return false;
    if (!r || !r.ok) {
      if (opts.noFallback) return false;
      speakWindows(parts.slice(i).join(' '), lang); // dự phòng giọng Windows
      return true;
    }
    if (r.kind === 'mp3') await playMp3(r.data, opts.rate !== undefined ? opts.rate : voiceRate);
    else await playPcm(r.pcm, opts.rate !== undefined ? opts.rate : voiceRate);
    if (token !== playToken) return false;
  }
  speaking = false;
  return true;
}

$('btn-mute').addEventListener('click', () => {
  muted = !muted;
  $('btn-mute').textContent = muted ? '🔇' : '🔊';
  if (muted) stopSpeaking();
});

/* ---------- Chọn giọng + nghe thử (giọng nữ tiếng Anh, Edge TTS) ---------- */
const VOICES = [
  ['en-US-AriaNeural', 'tươi sáng, biểu cảm'],
  ['en-US-JennyNeural', 'ấm áp, thân thiện'],
  ['en-US-AnaNeural', 'trẻ con, rất "anime"'],
  ['en-US-EmmaNeural', 'tự nhiên, dễ chịu'],
  ['en-US-AshleyNeural', 'vui vẻ, sôi nổi'],
  ['en-US-SaraNeural', 'trẻ trung, thoải mái'],
  ['en-GB-SoniaNeural', 'giọng Anh-Anh, thanh lịch'],
  ['en-GB-MaisieNeural', 'giọng Anh-Anh, trẻ con'],
  ['en-AU-NatashaNeural', 'giọng Úc, tự tin'],
];
(() => {
  const sel = $('voice');
  VOICES.forEach(([n, d]) => {
    const o = document.createElement('option');
    o.value = n; o.textContent = n + ' (' + d + ')';
    sel.appendChild(o);
  });
})();

function setVoiceStatus(text, isErr) {
  $('voicestatus').textContent = text;
  $('voicestatus').className = isErr ? 'err' : '';
}

function pitchStr(hz) { return (hz >= 0 ? '+' : '') + hz + 'Hz'; }

$('voicepitch').addEventListener('input', () => {
  $('voicepitchval').textContent = pitchStr(Number($('voicepitch').value));
});

// Mẫu bắt đầu cho giọng kiểu anime: chọn giọng trẻ + đẩy cao độ lên một chút. Sau đó nghe thử và tinh chỉnh.
$('voiceanime').addEventListener('click', () => {
  $('voice').value = 'en-US-AnaNeural';
  $('voicepitch').value = 30;
  $('voicepitchval').textContent = pitchStr(30);
  setVoiceStatus('Đã chọn mẫu kiểu anime (giọng trẻ + cao độ +30Hz). Bấm "Nghe thử", rồi chỉnh lại cho hợp ý.');
});

$('voicetest').addEventListener('click', async () => {
  const btn = $('voicetest');
  btn.disabled = true;
  setVoiceStatus('Đang tạo giọng, đợi vài giây...');
  const ok = await speak("Hi, I'm Hiyori. It's really nice to have you here.", {
    lang: 'en', edgeVoice: $('voice').value, edgePitch: pitchStr(Number($('voicepitch').value)),
    force: true, split: false, noFallback: true,
  });
  btn.disabled = false;
  if (ok) setVoiceStatus('Thích giọng này thì bấm "Dùng giọng này" để lưu.');
  else setVoiceStatus('Không tạo được giọng này. Thử giọng khác, hoặc xem lỗi trong cửa sổ đen.', true);
});

$('voicesave').addEventListener('click', async () => {
  const pitch = pitchStr(Number($('voicepitch').value));
  const r = await window.api.setVoice({ voice: $('voice').value, pitch });
  if (r.ok) { basePitchHz = Number($('voicepitch').value); setVoiceStatus('Đã lưu. Từ tin nhắn sau sẽ dùng giọng này.'); }
  else setVoiceStatus(r.error, true);
});

/* ---------- Bong bóng, lịch sử ---------- */
function showBubble(text, kind) {
  bubble.textContent = text;
  bubble.className = kind || '';
  bubble.hidden = false;
  bubble.scrollTop = 0;
}
bubble.addEventListener('click', () => { bubble.hidden = true; });

function logStamp() {
  return new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function sendDevLog(level, text) {
  try { window.api.devLog(level, text); } catch {}
}

function addLog(role, text) {
  // Đây là LỊCH SỬ TRÒ CHUYỆN, chỉ hiển thị những gì thật sự thuộc hội thoại.
  // Không đưa SYSTEM/SEARCH/ERROR vào đây để tránh lẫn với context hội thoại.
  if (role !== 'user' && role !== 'model') {
    sendDevLog(role, text);
    return;
  }
  const type = role === 'user' ? 'me' : 'ai';
  const labels = { user: 'USER', model: 'Virtual Assist' };
  const d = document.createElement('div');
  d.className = 'm ' + type;
  const head = document.createElement('div');
  head.className = 'log-head';
  const label = document.createElement('span');
  label.className = 'log-label';
  label.textContent = labels[role];
  const tm = document.createElement('span');
  tm.className = 'log-time';
  tm.textContent = logStamp();
  head.appendChild(label);
  head.appendChild(tm);
  const body = document.createElement('div');
  body.className = 'log-body';
  body.textContent = String(text ?? '');
  d.appendChild(head);
  d.appendChild(body);
  (logListEl || logEl).appendChild(d);
  logCount += 1;
  while (logListEl && logListEl.children.length > 300) logListEl.removeChild(logListEl.firstChild);
  if (logStatusEl) logStatusEl.textContent = `${logCount} tin nhắn • Lịch sử trò chuyện`;
  if (logListEl) logListEl.scrollTop = logListEl.scrollHeight;
}

function formatLogDetail(o) {
  if (!o || typeof o !== 'object') return String(o ?? '');
  const lines = [];
  if (o.model) lines.push(`model: ${o.model}`);
  if (Number.isFinite(o.elapsedMs)) lines.push(`model ping: ${o.elapsedMs}ms`);
  if (Number.isFinite(o.responseChars)) lines.push(`response: ${o.responseChars} ký tự`);
  if (Number.isFinite(o.historySent)) lines.push(`history sent: ${o.historySent} tin`);
  if (o.watchTick) lines.push('watchTick: true');
  if (o.withScreen) lines.push('screen: captured');
  if (o.screenUnchanged) lines.push('screen: unchanged → bỏ qua Gemini');
  if (o.jsonMode) lines.push('response mode: JSON');
  if (o.searchProvider) lines.push(`search provider: ${o.searchProvider}`);
  if (o.searchQuery) lines.push(`query: ${o.searchQuery}`);
  if (o.status) lines.push(`HTTP: ${o.status}`);
  if (o.code) lines.push(`code: ${o.code}`);
  return lines.join(' • ');
}

function logChatDebug(r) {
  const d = r && r.debug ? r.debug : {};
  if (r && r.ok) {
    sendDevLog('system', `${d.model || 'model'} • ${Number.isFinite(d.elapsedMs) ? d.elapsedMs + 'ms' : '—'} • ${Number.isFinite(d.responseChars) ? d.responseChars + ' ký tự' : 'không rõ độ dài'}${formatLogDetail(d) ? '\n' + formatLogDetail(d) : ''}`);
  } else if (r) {
    sendDevLog('error', `${r.error || 'Lỗi không xác định'}\n${formatLogDetail({ ...d, code: r.code, status: r.status })}${r.errorDetail ? '\n' + r.errorDetail : ''}`);
  }
}

function logSearchDebug(search) {
  if (!search) return;
  if (search.used) {
    const provider = search.provider || 'unknown';
    const titles = Array.isArray(search.sources) ? search.sources.slice(0, 5) : [];
    sendDevLog('search', `${provider}${search.query ? ` • ${search.query}` : ''}${titles.length ? '\n' + titles.map((x, i) => `${i + 1}. ${x}`).join('\n') : ''}`);
  } else if (search.blocked || search.note) {
    sendDevLog('search', `Không dùng được web${search.note ? '\n' + search.note : ''}`);
  }
}

function openSettings() {
  logEl.hidden = true; bubble.hidden = true; settingsEl.hidden = false;
  if (modelSelectEl) modelSelectEl.focus();
}
function toggleLog() {
  const show = logEl.hidden;
  settingsEl.hidden = true;
  logEl.hidden = !show;
  if (show) { bubble.hidden = true; if (logListEl) logListEl.scrollTop = logListEl.scrollHeight; }
}
$('log-close').addEventListener('click', () => { logEl.hidden = true; msgEl.focus(); });

/* ---------- Điều khiển kích thước cửa sổ ---------- */
const resizeFixedEl = $('resize-fixed');
const resizeEnableEl = $('resize-enable');
const resizeControlsEl = $('resize-controls');
const resizeWidthEl = $('resize-width');
const resizeHeightEl = $('resize-height');
const resizeWidthValEl = $('resize-width-val');
const resizeHeightValEl = $('resize-height-val');
let resizeSaveTimer = null;

function refreshResizeUI() {
  const enabled = !!resizeEnableEl.checked;
  resizeFixedEl.checked = !enabled;
  resizeControlsEl.classList.toggle('disabled', !enabled);
  resizeWidthEl.disabled = !enabled;
  resizeHeightEl.disabled = !enabled;
  resizeWidthValEl.textContent = `${resizeWidthEl.value} px`;
  resizeHeightValEl.textContent = `${resizeHeightEl.value} px`;
}

async function commitWindowResize() {
  const r = await window.api.setWindowSize({
    allow: resizeEnableEl.checked,
    width: Number(resizeWidthEl.value),
    height: Number(resizeHeightEl.value),
  });
  if (!r || !r.ok) {
    sendDevLog('error', 'Không lưu được kích thước cửa sổ. ' + (r && r.error ? r.error : 'unknown error'));
    return;
  }
  resizeWidthEl.value = r.width;
  resizeHeightEl.value = r.height;
  refreshResizeUI();
}

function queueWindowResize() {
  refreshResizeUI();
  clearTimeout(resizeSaveTimer);
  resizeSaveTimer = setTimeout(() => { commitWindowResize().catch((e) => sendDevLog('error', 'Resize IPC lỗi. ' + String(e && e.message || e))); }, 120);
}
function onResizeModeChange() {
  if (!resizeEnableEl.checked) resizeFixedEl.checked = true;
  else resizeFixedEl.checked = false;
  refreshResizeUI();
  commitWindowResize().catch((e) => sendDevLog('error', 'Resize IPC lỗi. ' + String(e && e.message || e)));
}
resizeEnableEl.addEventListener('change', onResizeModeChange);
resizeFixedEl.addEventListener('change', onResizeModeChange);
resizeWidthEl.addEventListener('input', queueWindowResize);
resizeHeightEl.addEventListener('input', queueWindowResize);
resizeWidthEl.addEventListener('change', () => commitWindowResize());
resizeHeightEl.addEventListener('change', () => commitWindowResize());
refreshResizeUI();

/* ---------- Nút bấm ---------- */
$('close').addEventListener('click', () => window.api.quit());
$('btn-log').addEventListener('click', toggleLog);
$('btn-settings').addEventListener('click', () => { settingsEl.hidden ? openSettings() : (settingsEl.hidden = true); });
$('btn-devconsole').addEventListener('click', () => { try { window.api.openDevConsole(); } catch {} });
$('closesettings').addEventListener('click', () => { settingsEl.hidden = true; msgEl.focus(); });

// Lưu ý: quản lý Gemini API key / Tavily API key giờ nằm trong Developer Console,
// nên toàn bộ UI + logic lưu/xoá key ở panel Cài đặt chính đã được gỡ bỏ khỏi đây.

$('clearall').addEventListener('click', async () => {
  if (!confirm('Xoá toàn bộ lịch sử trò chuyện và trí nhớ dài hạn của nhân vật?')) return;
  await window.api.clearAll();
  if (logListEl) logListEl.innerHTML = '';
  logCount = 0;
  if (logStatusEl) logStatusEl.textContent = 'Console đã xoá.';
  showBubble('Mình đã quên hết rồi. Chào bạn, mình là Hiyori!');
  settingsEl.hidden = true;
});

/* ---------- Gửi tin nhắn ---------- */
// withScreen = true: kèm ảnh chụp màn hình NGAY LÚC GỬI. overrideText: dùng câu này thay vì ô nhập
// (dùng khi bắt đầu theo dõi bằng câu có sẵn trong ô nhập, không xoá ô nhập của người dùng nhầm chỗ).
async function send(withScreen, overrideText) {
  let text = overrideText !== undefined ? overrideText : msgEl.value.trim();
  if (!text) {
    if (!withScreen) return;
    text = 'Nhìn màn hình xem mình đang làm gì đi.';
  }
  // Đang theo dõi mà người dùng gõ kiểu "xong rồi", "thôi dừng theo dõi"... -> tự tắt theo dõi trước khi gửi.
  if (watching && overrideText === undefined && STOP_WATCH_RE.test(text)) {
    stopWatching(null);
  }
  if (busy) return;
  if (!hasKey) {
    showBubble('Bạn chưa cấu hình Gemini API key. Mở Developer Console (🛠) để thêm key nhé.', 'err');
    try { window.api.openDevConsole(); } catch {}
    return;
  }
  if (!Net.online) { // đang mất mạng: hỏi nhanh xem đã có lại chưa; chưa thì báo ngay thay vì để tin nhắn chờ treo
    if (Net.checking) return;
    Net.checking = true;
    const back = await pingNow();
    Net.checking = false;
    if (back) goOnline();
    else {
      Emo.set('lo_lang', 2, 8000);
      showBubble('Mình đang mất kết nối mạng nên chưa trả lời được. Câu của bạn vẫn còn trong ô nhập, có mạng lại mình sẽ báo nhé.', 'err');
      return;
    }
  }

  busy = true; sendBtn.disabled = true; seeBtn.disabled = true;
  if (overrideText === undefined) msgEl.value = '';
  logEl.hidden = true; settingsEl.hidden = true;
  showBubble(withScreen ? 'Đang xem màn hình...' : 'Đang suy nghĩ...', 'wait');
  Emo.set('suy_nghi', 2, 90000);

  const r = await window.api.chat(text, { withScreen: !!withScreen, search: searchOn });

  busy = false; sendBtn.disabled = false; seeBtn.disabled = false;
  if (r.ok) {
    addLog('user', text + (withScreen ? ' [kèm ảnh màn hình]' : ''));
    addLog('model', r.reply || '(không có nội dung trả về)');
    logChatDebug(r);
    logSearchDebug(r.search);
    const srcs = r.search && Array.isArray(r.search.sources) ? r.search.sources.slice(0, 3) : [];
    showBubble(r.reply + (srcs.length ? '\n\n🔎 ' + srcs.join(', ') : '')); // luôn hiện bong bóng bằng tiếng Việt (kèm nguồn nếu có tìm web)
    handleSearchInfo(r.search);
    handleDiscordInfo(r.discord);
    if (!Net.online) { Net.online = true; netBadge(); stopNetWatch(); } // gửi được nghĩa là mạng đã có lại
    reactToReply(r);     // đổi nét mặt theo cảm xúc + đọc thành tiếng (giọng Anh nếu có, không thì giọng Việt)
  } else {
    if (overrideText === undefined) msgEl.value = text; // trả lại câu vừa gõ để bấm gửi lại
    Emo.clear();
    logChatDebug(r);
    showBubble(r.error, 'err');
    if (r.code === 'NETWORK') markOffline(true); // mất mạng: hiện chấm đỏ, tự báo khi có lại
  }
  msgEl.focus();
}
sendBtn.addEventListener('click', () => send(false));
msgEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) send(false); });

/* ---------- Chủ động quan sát khi người dùng còn ở máy nhưng im lặng ---------- */
function stopProactiveWatching() {
  proactiveWatching = false;
  if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
  if (proactiveReturnTimer) { clearTimeout(proactiveReturnTimer); proactiveReturnTimer = null; }
  if (proactiveState === 'WATCHING' || proactiveState === 'QUIET') proactiveState = 'ACTIVE';
}

function randomProactiveCooldown() {
  const lo = Math.min(proactiveCooldownMinMs, proactiveCooldownMaxMs);
  const hi = Math.max(proactiveCooldownMinMs, proactiveCooldownMaxMs);
  return lo + Math.random() * (hi - lo);
}

function scheduleProactiveTick() {
  if (!proactiveWatching || watching) return;
  if (proactiveTimer) clearTimeout(proactiveTimer);
  proactiveTimer = setTimeout(proactiveWatchTick, Math.max(40000, proactiveIntervalMs));
}

async function startProactiveWatching() {
  if (!proactiveEnabled || proactiveWatching || watching) return;
  proactiveWatching = true;
  proactiveState = 'WATCHING';
  // Vừa bước qua mốc 5 phút im lặng -> chụp ngay tấm đầu tiên.
  await proactiveWatchTick();
}

async function proactiveWatchTick() {
  if (!proactiveWatching || watching) return;
  if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
  if (!Net.online || busy) {
    scheduleProactiveTick();
    return;
  }

  const cooldown = Date.now() < proactiveNextSpeakAt;
  const r = await window.api.chat(
    '(tự động quan sát màn hình vì người dùng đã im lặng một lúc, chỉ lên tiếng nếu thật sự thấy vấn đề có thể giúp)',
    { withScreen: true, watchTick: true, proactiveCooldown: cooldown }
  );

  if (!proactiveWatching || watching) return;
  if (r.ok && !r.silent && r.reply) {
    // Bình thường cách nhau 5-7 phút; prompt ở main.js cho phép phá khoảng nghỉ nếu vấn đề thực sự cần can thiệp.
    proactiveNextSpeakAt = Date.now() + randomProactiveCooldown();
    addLog('model', r.reply);
    logChatDebug(r);
    showBubble(r.reply);
    reactToReply(r);
  } else if (r && r.ok && r.skipped) {
    sendDevLog('system', 'WATCH • ảnh gần như không đổi → không gọi Gemini ' + formatLogDetail(r.debug || { watchTick: true, screenUnchanged: true }));
  } else if (r && r.ok && r.silent) {
    // Không spam log nội dung AI; chỉ ghi một marker kỹ thuật để debug khi cần.
    sendDevLog('system', 'WATCH • Gemini kiểm tra xong và chọn im lặng ' + formatLogDetail(r.debug || { watchTick: true }));
  } else if (r && !r.ok) {
    logChatDebug(r);
  }
  scheduleProactiveTick();
}

function handleProactivePresence(phase) {
  if (!proactiveEnabled) return;
  // Người dùng chủ động bật chế độ 👁 thủ công thì không chạy thêm observer tự động.
  if (watching) {
    if (proactiveWatching) stopProactiveWatching();
    return;
  }

  if (phase === 'QUIET') {
    if (!proactiveWatching) {
      proactiveState = 'QUIET';
      startProactiveWatching();
    }
    return;
  }

  if (phase === 'AWAY') {
    proactiveState = 'AWAY';
    if (proactiveWatching) stopProactiveWatching();
    proactiveState = 'AWAY';
    return;
  }

  if (proactiveState === 'AWAY') {
    proactiveState = 'RETURNED';
    if (proactiveReturnTimer) clearTimeout(proactiveReturnTimer);
    proactiveReturnTimer = setTimeout(() => {
      proactiveReturnTimer = null;
      if (proactiveState === 'RETURNED') proactiveState = 'ACTIVE';
    }, 1800);
  } else {
    proactiveState = 'ACTIVE';
  }
  if (proactiveWatching) stopProactiveWatching();
}

/* ---------- Bật/tắt theo dõi màn hình nhẹ ---------- */
// Bấm 👁: bắt đầu theo dõi (chụp ngay + lặp lại mỗi theoDoiKhoangCachGiay giây, mặc định 20s, tính từ lúc chụp lần trước). Bấm lại (hoặc gõ "xong rồi", "thôi dừng
// theo dõi"...) để tắt. Trong lúc theo dõi, bot chỉ lên tiếng khi thật sự có gì đáng nói (xem main.js).
seeBtn.addEventListener('click', () => {
  if (watching) stopWatching('Mình dừng theo dõi màn hình nhé.');
  else startWatching();
});

function watchOffTitle() {
  return 'Chụp màn hình rồi hỏi - bấm để bật theo dõi nhẹ, bấm lại để tắt';
}

async function startWatching() {
  if (watching || busy) return;
  if (proactiveWatching) stopProactiveWatching();
  const text = msgEl.value.trim() || 'Theo dõi màn hình giúp mình nhé, có gì đáng chú ý thì nói cho mình biết.';
  watching = true;
  watchStopAt = Date.now() + watchMaxMs;
  seeBtn.classList.add('watching');
  seeBtn.title = 'Đang theo dõi màn hình nhẹ - bấm để tắt';
  watchTickStart = Date.now();
  await send(true, text);
  scheduleNextTick();
}

function scheduleNextTick() {
  if (!watching) return;
  if (Date.now() >= watchStopAt) {
    stopWatching('Mình dừng theo dõi màn hình vì đã khá lâu rồi, cần thì bấm 👁 lại nhé.');
    return;
  }
  // Tính từ lúc chụp lần trước: nếu lượt trước mất 8 giây để Gemini trả lời thì chỉ đợi thêm (interval - 8) giây
  const wait = Math.max(1000, watchIntervalMs - (Date.now() - watchTickStart));
  watchTimer = setTimeout(watchTick, wait);
}

async function watchTick() {
  if (!watching) return;
  watchTickStart = Date.now();
  if (busy || !Net.online) { scheduleNextTick(); return; } // đang gửi tay lượt khác hoặc đang mất mạng -> bỏ qua, thử lại lượt sau
  const r = await window.api.chat('(tự động theo dõi màn hình định kỳ, kiểm tra xem có gì cần nói không)', { withScreen: true, watchTick: true });
  if (!watching) return; // người dùng lỡ tắt trong lúc chờ
  if (!r.ok) {
    if (r.code === 'NETWORK') { markOffline(false); scheduleNextTick(); return; } // mất mạng: tạm dừng, có mạng lại thì tự tiếp tục
    stopWatching('Mình gặp lỗi khi theo dõi màn hình nên đã dừng lại: ' + r.error);
    return;
  }
  if (!r.silent) {
    addLog('model', r.reply);
    showBubble(r.reply);
    reactToReply(r);
  }
  scheduleNextTick();
}

function stopWatching(msg) {
  if (!watching) return;
  watching = false;
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
  seeBtn.classList.remove('watching');
  seeBtn.title = watchOffTitle();
  if (msg) showBubble(msg);
}

/* ---------- Biểu cảm: phản ứng theo cảm xúc của AI ---------- */
// Màn hình LUÔN hiện tiếng Việt (showBubble đã hiện r.reply trước khi gọi hàm này), nhưng ÂM THANH
// chỉ đọc tiếng Anh (r.speechEn). Nếu vì lý do gì đó model không trả về được speech_en (lỗi định dạng
// JSON hiếm gặp), thì im lặng luôn cho lượt đó thay vì rơi về đọc tiếng Việt.
function reactToReply(r) {
  if (r.mood) Emo.setMood(r.mood);
  if (r.emotion) Emo.set(r.emotion, r.intensity || 2);
  else Emo.clear();

  if (r.speechEn) {
    const o = { lang: 'en' };
    const p = r.emotion ? Emo.prosody(r.emotion, r.intensity || 2) : null;
    if (p) { // giọng cao/thấp, nhanh/chậm theo cảm xúc (cộng vào cài đặt giọng đã lưu)
      const hz = Math.max(-60, Math.min(120, Math.round(basePitchHz + p.pitchHz)));
      const rate = Math.max(-40, Math.min(40, Math.round(p.ratePct)));
      o.edgePitch = pitchStr(hz);
      o.edgeRate = (rate >= 0 ? '+' : '') + rate + '%';
    }
    speak(r.speechEn, o);
  } else {
    sendDevLog('tts', 'Không có bản dịch tiếng Anh (speech_en) cho lượt này nên bỏ qua đọc thành tiếng (chỉ hiện bong bóng).');
  }
}


/* ---------- Thông báo nhỏ tự tắt ---------- */
let toastTimer = null;
function showToast(text, ms) {
  const el = $('toast');
  clearTimeout(toastTimer);
  el.textContent = text;
  el.hidden = false;
  if (ms) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
if (window.api.onSingleInstanceNotice) {
  window.api.onSingleInstanceNotice((text) => showToast(text, 6500));
}

/* ---------- Kết nối mạng: nhận biết mất mạng / có mạng lại ---------- */
// Hiyori cần mạng để "suy nghĩ" (Gemini chạy trên máy chủ Google). Khi mất mạng: hiện chấm đỏ, cô ấy tỏ ra lo lắng,
// tin nhắn không bị gửi treo; khi có lại: tự báo và nhắc câu còn nằm trong ô nhập.
const Net = { online: true, checking: false, timer: null, streak: 0, pollMs: 4000 };
async function pingNow() {
  try { const r = await window.api.ping(); return !!(r && r.online); } catch { return false; }
}
function netBadge() { $('netstatus').hidden = Net.online; }
function stopNetWatch() { if (Net.timer) { clearInterval(Net.timer); Net.timer = null; } Net.streak = 0; }
function startNetWatch() {
  stopNetWatch();
  Net.timer = setInterval(async () => {          // cứ vài giây kiểm tra lại; 2 lần liên tiếp thông mới báo "có mạng lại"
    if (Net.online) { stopNetWatch(); return; }
    if (await pingNow()) { if (++Net.streak >= 2) goOnline(); } else Net.streak = 0;
  }, Net.pollMs);
}
function markOffline(quiet) {                    // quiet = true: giữ nguyên bong bóng hiện tại (ví dụ đang hiện lỗi mạng)
  if (!Net.online) return;
  Net.online = false; netBadge();
  Emo.set('lo_lang', 2, 9000);
  if (!quiet) showBubble('Ơ, mình mất kết nối mạng rồi. Có mạng lại mình sẽ báo bạn nhé.', 'wait');
  startNetWatch();
}
function goOnline() {
  if (Net.online) return;
  Net.online = true; netBadge(); stopNetWatch();
  Emo.set('vui', 2, 8000);
  const pending = msgEl.value.trim();
  showBubble('Có mạng lại rồi! ' + (pending ? 'Câu vừa rồi của bạn vẫn còn trong ô nhập, bấm gửi để mình trả lời nhé.' : 'Mình trò chuyện tiếp được rồi.'));
}
window.addEventListener('offline', () => markOffline(false));
window.addEventListener('online', async () => { if (!Net.online && await pingNow()) goOnline(); });

/* ---------- Tìm kiếm web (nút 🌐) ---------- */
let searchOn = true, searchAvailable = true, searchBlocked = false;
try { searchOn = localStorage.getItem('search') !== '0'; } catch {}
function refreshSearchButton() {
  const b = $('btn-search');
  b.hidden = !searchAvailable;
  b.className = searchOn && !searchBlocked ? '' : 'off';
  b.title = searchBlocked ? 'Tìm web chưa dùng được với key hiện tại'
    : searchOn ? 'Tìm kiếm web: ĐANG BẬT (bấm để tắt)' : 'Tìm kiếm web: đang tắt (bấm để bật)';
}
$('btn-search').addEventListener('click', () => {
  searchOn = !searchOn;
  try { localStorage.setItem('search', searchOn ? '1' : '0'); } catch {}
  refreshSearchButton();
  showToast(searchOn ? 'Đã bật tìm kiếm web.' : 'Đã tắt tìm kiếm web.', 2500);
});
function handleSearchInfo(s) {
  if (!s) return;
  if (typeof s.blocked === 'boolean') { searchBlocked = s.blocked; refreshSearchButton(); }
  if (s.note) showToast(s.note, 10000);
}

/* ---------- Thông báo trạng thái voice Discord ---------- */
// main.js / discord-bot.js đẩy sự kiện 'discord-event' mỗi khi có gì đó về voice:
//   joining (đang vào) -> joined (vào được) hoặc failed (KHÔNG vào được, kèm lý do và cách sửa);
//   lost (đang ở trong voice thì bị mất kết nối), warn (vào được nhưng có vấn đề), left (đã rời).
// Lỗi (failed/lost) hiện thành một khung đỏ nằm lại đến khi bấm Đóng (hoặc tự tắt sau ~45 giây), có nút "Thử lại":
// sửa xong cai-dat.json / vào lại kênh voice rồi bấm Thử lại, không cần mở lại app.
let voiceAlertTimer = null;
function hideVoiceAlert() {
  clearTimeout(voiceAlertTimer);
  $('voicealert').hidden = true;
}
function showVoiceAlert(text) {
  clearTimeout(voiceAlertTimer);
  $('toast').hidden = true;
  $('voicealerttext').textContent = text;
  $('voicealert').hidden = false;
  voiceAlertTimer = setTimeout(hideVoiceAlert, 45000);
}
$('voicealertclose').addEventListener('click', hideVoiceAlert);
$('voicealertretry').addEventListener('click', async () => {
  hideVoiceAlert();
  showToast('⏳ Đang thử vào lại voice Discord...', 40000);
  try { await window.api.discordJoin(); } catch {} // kết quả sẽ được báo lại bằng sự kiện discord-event
});

function handleDiscordEvent(ev) {
  if (!ev) return;
  switch (ev.type) {
    case 'joining':
      hideVoiceAlert();
      showToast('⏳ Đang vào kênh voice Discord...', 40000);
      break;
    case 'joined':
      hideVoiceAlert();
      showToast(`🔊 Đã vào kênh voice "${ev.channelName}"`, 6000);
      break;
    case 'failed':
      showVoiceAlert('⚠️ Không vào được voice Discord\n' + ev.message);
      try { Emo.set('lo_lang', 2, 8000); } catch {}
      break;
    case 'lost':
      showVoiceAlert('⚠️ ' + ev.message);
      try { Emo.set('lo_lang', 2, 8000); } catch {}
      break;
    case 'warn':
      showToast('⚠️ ' + ev.message, 12000);
      break;
    case 'left':
      hideVoiceAlert();
      showToast('🔈 Đã rời voice.', 5000);
      break;
    case 'info':
      showToast(ev.message, 6000);
      break;
  }
}
if (window.api.onDiscordEvent) window.api.onDiscordEvent(handleDiscordEvent);

// Kết quả vào/ra voice giờ được báo qua handleDiscordEvent (chạy nền), nên ở đây không cần làm gì thêm.
function handleDiscordInfo() {}

/* ---------- Phóng to / thu nhỏ nhân vật (không đổi kích thước cửa sổ) ---------- */
const View = {
  model: null,
  modelUpdateHandler: null, w0: 0, h0: 0, W: 0, H: 0, avail: 0,
  t: 0, pan: 0,          // đích: t = mức phóng (0 = toàn thân ... 1 = cận nhất), pan = 0 nhìn từ đầu ... 1 nhìn xuống chân
  tCur: 0, panCur: 0,    // giá trị đang hiển thị (chuyển mượt tới đích)
  targetFocusX: 0, targetFocusY: 0,
  focusX: 0, focusY: 0,
  fMin: 0.22,            // ở mức phóng cao nhất chỉ còn thấy 22% chiều cao model (từ đầu xuống)
  presets: { nuaNguoi: 0.52, canMat: 0.3 },
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const viewFull = () => Math.min(View.W / View.w0, View.avail / View.h0);       // vừa khít toàn thân
function viewScale(t) {
  const f = Math.pow(View.fMin, t);                                            // phần chiều cao model vừa khít khung nhìn
  return viewFull() * Math.max(1, (View.avail / (f * View.h0)) / viewFull());
}
const tFromFrac = (f) => clamp01(Math.log(f) / Math.log(View.fMin));
function layoutView(t, pan) {
  if (!View.model) return;
  const s = viewScale(t), Hs = View.h0 * s;
  View.model.scale.set(s);
  View.model.x = (View.W - View.w0 * s) / 2;
  View.model.y = Hs <= View.avail ? View.avail - Hs : -pan * (Hs - View.avail); // toàn thân: sát đáy; phóng to: neo theo đầu
}
function viewStep() { // gọi mỗi khung hình: trượt mượt tới mức phóng đích
  const dt = View.t - View.tCur, dp = View.pan - View.panCur;
  if (Math.abs(dt) < 0.0005 && Math.abs(dp) < 0.0005) {
    if (View.tCur !== View.t || View.panCur !== View.pan) {
      View.tCur = View.t;
      View.panCur = View.pan;
      layoutView(View.tCur, View.panCur);
    }
  } else {
    View.tCur += dt * 0.2;
    View.panCur += dp * 0.2;
    layoutView(View.tCur, View.panCur);
  }

  if (View.model && View.model.internalModel && View.model.internalModel.focusController) {
    const fc = View.model.internalModel.focusController;
    View.focusX += (View.targetFocusX - View.focusX) * 0.18;
    View.focusY += (View.targetFocusY - View.focusY) * 0.18;
    fc.focus(View.focusX, View.focusY);
  }
}
function syncViewUI() { $('zoomrange').value = Math.round(View.t * 100); $('panrange').value = Math.round(View.pan * 100); }
let viewSaveTimer = null;
function persistView() {
  syncViewUI();
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => { try { localStorage.setItem('view', JSON.stringify({ t: View.t, pan: View.pan })); } catch {} }, 300);
}
function goPreset(name) {
  View.t = name === 'full' ? 0 : tFromFrac(name === 'bust' ? View.presets.nuaNguoi : View.presets.canMat);
  View.pan = 0;
  persistView();
}
function cycleView() { // nút 🔍: Toàn thân -> Nửa người -> Cận mặt -> Toàn thân
  const tb = tFromFrac(View.presets.nuaNguoi), tc = tFromFrac(View.presets.canMat);
  if (View.t < tb - 0.08) goPreset('bust');
  else if (View.t < tc - 0.08) goPreset('close');
  else goPreset('full');
}

$('btn-zoom').addEventListener('click', cycleView);
$('view-full').addEventListener('click', () => goPreset('full'));
$('view-bust').addEventListener('click', () => goPreset('bust'));
$('view-close').addEventListener('click', () => goPreset('close'));
$('zoomrange').addEventListener('input', (e) => { View.t = clamp01(Number(e.target.value) / 100); persistView(); });
$('panrange').addEventListener('input', (e) => { View.pan = clamp01(Number(e.target.value) / 100); persistView(); });
window.addEventListener('wheel', (e) => {
  if (e.target && e.target.closest && e.target.closest('.panel, #bubble')) return; // đang cuộn nội dung bảng/bong bóng thì thôi
  e.preventDefault();
  if (e.shiftKey) View.pan = clamp01(View.pan + e.deltaY * 0.001);                 // Shift + cuộn: trượt lên/xuống thân
  else View.t = clamp01(View.t - e.deltaY * 0.0009);                              // cuộn lên: phóng to, cuộn xuống: thu nhỏ
  persistView();
}, { passive: false });

async function loadLive2DModel(modelId, modelPath) {
  if (live2dLoading) return false;
  const target = live2dModels.find((m) => m.id === modelId);
  if (!target && !modelPath) return false;
  const pathToLoad = modelPath || target.path;
  live2dLoading = true;
  if (modelStatusEl) { modelStatusEl.textContent = 'Đang tải model…'; modelStatusEl.className = ''; }

  try {
    const { Live2DModel } = PIXI.live2d;
    // Tải model mới trước; nếu tải lỗi thì model cũ vẫn còn nguyên.
    const model = await Live2DModel.from(pathToLoad);
    if (!pixiApp) throw new Error('PIXI chưa khởi tạo');

    const old = View.model;
    const oldHandler = View.modelUpdateHandler;

    // Dừng listener của model cũ trước khi destroy để không giữ closure/reference.
    if (old && oldHandler) {
      try { old.internalModel.off('beforeModelUpdate', oldHandler); } catch {}
    }

    if (old && old.parent) {
      try { old.parent.removeChild(old); } catch {}
    }

    if (old) {
      try {
        // Mỗi model có texture riêng; giải phóng texture + baseTexture khi đổi model
        // để RAM/GPU không tích lũy sau nhiều lần đổi model.
        old.destroy({ children: true, texture: true, baseTexture: true });
      } catch {
        try { old.destroy(); } catch {}
      }
    }

    pixiApp.stage.addChild(model);
    currentLive2DModelId = target ? target.id : modelId;

    emoInfo = Emo.attach(model);
    try { Emo.setModel(currentLive2DModelId); } catch {}

    const modelUpdateHandler = () => {
      const v = speaking ? (Math.sin(performance.now() / 90) * 0.5 + 0.5) * 0.8 : 0;
      if (!Emo.setParam('ParamMouthOpenY', v)) {
        try { model.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', v); } catch {}
      }
      Emo.apply(speaking);
    };
    View.modelUpdateHandler = modelUpdateHandler;
    model.internalModel.on('beforeModelUpdate', modelUpdateHandler);

    Object.assign(View, { model, w0: model.width, h0: model.height });
    layoutView(View.tCur, View.panCur);

    // Chạy GC texture sau khi model cũ đã bị hủy. Đây chỉ là cleanup lúc đổi model,
    // không chạy liên tục trong render loop.
    try {
      if (pixiApp.renderer && pixiApp.renderer.textureGC) {
        pixiApp.renderer.textureGC.run();
      }
    } catch {}

    if (modelStatusEl) {
      const missing = emoInfo && emoInfo.missing && emoInfo.missing.length
        ? ` • thiếu ${emoInfo.missing.length} tham số biểu cảm`
        : '';
      modelStatusEl.textContent = `✓ Đang dùng ${currentLive2DModelId}${missing}`;
      modelStatusEl.className = 'ok';
    }
    return true;
  } catch (e) {
    console.error('[MODEL] Không tải được model:', e);
    if (modelStatusEl) {
      modelStatusEl.textContent = 'Không tải được model: ' + (e.message || e);
      modelStatusEl.className = 'err';
    }
    return false;
  } finally {
    live2dLoading = false;
  }
}

if (modelSelectEl) {
  modelSelectEl.addEventListener('change', async () => {
    const id = modelSelectEl.value;
    const r = await window.api.setLive2DModel(id);
    if (!r.ok) {
      if (modelStatusEl) { modelStatusEl.textContent = r.error || 'Không lưu được model.'; modelStatusEl.className = 'err'; }
      return;
    }
    const m = live2dModels.find((x) => x.id === id);
    await loadLive2DModel(id, m && m.path);
  });
}

/* ---------- Vẫy tay chào lúc mở app ----------
   wave.motion3.json không được đăng ký trong akuro.model3.json (không có mục "Motions"),
   nên không gọi thẳng model.motion() được. Ở đây tự dựng lại đúng biên độ lắc tay
   (syHand1L2/2L2/3L2, ±24.487/±18.281/±30) và tư thế giơ tay (HandNormalButton/HandButton4)
   lấy từ 2 file wave.motion3.json + wave-expression.exp3.json gốc, chạy trong ~3.2 giây.
   Đã đối chiếu akuro_cdi3.json + akuro_physics3.json: syHand1L2/2L2/3L2 là nhóm tham số RIÊNG
   (ParamGroup, dùng cho vẫy tay), khác với syHand1L/2L/3L (ParamGroup32) mà physics3.json thật sự
   điều khiển theo chuyển động cơ thể -> không trùng, không "đánh nhau" như lo ngại trước đây.
*/
function playWaveOnce() {
  if (!View.model) return;
  const t0 = performance.now();
  const DUR_MS = 3200;
  const FREQ_HZ = 2.3;
  function tick(now) {
    if (!View.model) return;
    const el = now - t0;
    if (el >= DUR_MS) {
      Emo.setParam('HandNormalButton', 1);
      Emo.setParam('HandButton4', 0);
      Emo.setParam('syHand1L2', 0);
      Emo.setParam('syHand2L2', 0);
      Emo.setParam('syHand3L2', 0);
      return;
    }
    const t = el / 1000;
    const fadeIn = Math.min(1, t / 0.15);
    const fadeOut = Math.min(1, (DUR_MS / 1000 - t) / 0.3);
    const env = Math.min(fadeIn, fadeOut);
    const s = Math.sin(t * FREQ_HZ * Math.PI * 2) * env;
    // HandNormalButton/HandButton4 chuyển mượt theo cùng bao hình (env) với biên độ lắc tay,
    // để tay hạ xuống êm lúc kết thúc thay vì giữ nguyên tư thế giơ tay rồi giật về ở khung cuối.
    Emo.setParam('HandNormalButton', 1 - env);
    Emo.setParam('HandButton4', env);
    Emo.setParam('syHand1L2', s * 24.487);
    Emo.setParam('syHand2L2', s * 18.281);
    Emo.setParam('syHand3L2', s * 30);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ---------- Chạm/vuốt lên model (tóc = vui dần -> bối rối, vùng nhạy cảm = khó chịu -> giận) ----------
   Model Akuro không có HitAreas sẵn trong .model3.json, nên tự tính vùng theo tỉ lệ (0..1) trên khung
   hình thật của model (model.getBounds()), độc lập với zoom/pan hiện tại của View. Số liệu vùng lấy từ
   cai-dat.json (vungChamModel), có thể chỉnh lại không cần sửa file này. */
const canvasEl = $('canvas');
let touchZones = {
  dau: [{ x1: 0.32, y1: 0.0, x2: 0.68, y2: 0.16 }], // đỉnh đầu, ưu tiên trước vùng tóc hai bên bên dưới
  toc: [
    { x1: 0.0, y1: 0.0, x2: 1.0, y2: 0.32 },
    { x1: 0.0, y1: 0.0, x2: 0.22, y2: 0.75 },
    { x1: 0.78, y1: 0.0, x2: 1.0, y2: 0.75 },
  ],
  nhayCam: [{ x1: 0.28, y1: 0.45, x2: 0.72, y2: 0.78 }], // ngực + váy + đùi trên đầu gối
  chan: [{ x1: 0.15, y1: 0.78, x2: 0.85, y2: 1.0 }], // từ đầu gối trở xuống
  soLanVuotDeBoiRoi: 5,
  giayResetDem: 4,
};
let touchDragging = false;
let lastTouchZone = null;
let headPatCount = 0;
let hairStrokeCount = 0;
let sensitiveTouchCount = 0;
let touchZoneResetTimer = null;
let lastDebugLogAt = 0;
let coordinateDebugEnabled = true;
let smallPupilsUsedSession = false; // chỉ dùng biểu cảm small-pupils 1 LẦN DUY NHẤT cho cả phiên mở app, không reset theo giờ chạm mà chỉ reset khi mở lại app

/* ---------- Câu nói phản ứng khi chạm/vuốt (bong bóng + giọng nói, đọc từ bieu-cam.json → cauNoiCham) ---------- */
let touchLines = null; // { toc: {1:[],2:[],3:[]}, nhayCam: {1:[],2:[],3:[]}, chan: [] }, gán lúc nhận get-state
let lastTouchLineText = null;
let lastTouchLineAt = 0;
const TOUCH_LINE_COOLDOWN_MS = 2600; // tránh spam bong bóng/giọng khi kéo chuột qua lại nhanh giữa các vùng

function pickTouchLine(pool) {
  const arr = Array.isArray(pool) ? pool.filter((s) => s && typeof s.vi === 'string' && s.vi.trim()) : [];
  if (!arr.length) return null;
  if (arr.length === 1) return arr[0];
  let pick;
  do { pick = arr[Math.floor(Math.random() * arr.length)]; } while (pick.vi === lastTouchLineText);
  return pick;
}

// Hiện bong bóng (tiếng Việt) + nói câu phản ứng ngắn (LUÔN bằng tiếng Anh, giống câu trả lời chat)
// cho một mức chạm. KHÔNG ghi vào lịch sử trò chuyện (đây là phản ứng vật lý tức thời, không phải
// một lượt hội thoại). Nếu đang bận nói câu khác (trả lời AI, câu chạm trước đó...) thì chỉ hiện
// bong bóng, không tranh giọng.
function sayTouch(pool) {
  const now = Date.now();
  if (now - lastTouchLineAt < TOUCH_LINE_COOLDOWN_MS) return;
  const item = pickTouchLine(pool);
  if (!item) return;
  lastTouchLineText = item.vi;
  lastTouchLineAt = now;
  showBubble(item.vi);
  if (item.en && !speaking && !muted) {
    speak(item.en, { lang: 'en' }).catch(() => {});
  }
}

function insideAnyRect(rects, nx, ny) {
  if (!Array.isArray(rects)) return false;
  return rects.some((r) => nx >= r.x1 && nx <= r.x2 && ny >= r.y1 && ny <= r.y2);
}

function whichTouchZone(clientX, clientY) {
  if (!View.model || !canvasEl) return null;
  const rect = canvasEl.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const b = View.model.getBounds(); // khung hình thật trên màn hình, đã tính scale/pan hiện tại
  if (!b || b.width <= 0 || b.height <= 0) return null;
  if (x < b.x || x > b.x + b.width || y < b.y || y > b.y + b.height) return null;
  const nx = (x - b.x) / b.width;
  const ny = (y - b.y) / b.height;
  if (insideAnyRect(touchZones.nhayCam, nx, ny)) return 'nhayCam';
  if (insideAnyRect(touchZones.chan, nx, ny)) return 'chan';
  if (insideAnyRect(touchZones.dau, nx, ny)) return 'dau';
  if (insideAnyRect(touchZones.toc, nx, ny)) return 'toc';
  return null;
}

function scheduleTouchZoneReset() {
  clearTimeout(touchZoneResetTimer);
  const ms = Math.max(1, Number(touchZones.giayResetDem) || 4) * 1000;
  touchZoneResetTimer = setTimeout(() => {
    headPatCount = 0;
    hairStrokeCount = 0;
    sensitiveTouchCount = 0;
  }, ms);
}

function reactHeadPat() {
  headPatCount++;
  scheduleTouchZoneReset();
  const dau = touchLines && touchLines.dau;
  if (headPatCount <= 4) { Emo.set('vui', 2); sayTouch(dau && dau['1']); }
  else if (headPatCount <= 8) { Emo.set('vui', 3); sayTouch(dau && dau['2']); }
  else { Emo.set('hao_hung', 2); sayTouch(dau && dau['3']); }
  sendDevLog('touch', `TOUCH • xoa đầu lần ${headPatCount}`);
}

function reactHairStroke() {
  hairStrokeCount++;
  scheduleTouchZoneReset();
  const toc = touchLines && touchLines.toc;
  if (hairStrokeCount <= 4) { Emo.set('cham_squint', 2); sayTouch(toc && toc['1']); }
  else if (hairStrokeCount <= 8) { Emo.set('cham_shy', 2); sayTouch(toc && toc['2']); }
  else { Emo.set('cham_omouth', 2); sayTouch(toc && toc['3']); }
  sendDevLog('touch', `TOUCH • vuốt tóc lần ${hairStrokeCount}`);
}

function reactSensitiveTouch() {
  sensitiveTouchCount++;
  scheduleTouchZoneReset();
  const nc = touchLines && touchLines.nhayCam;
  if (!smallPupilsUsedSession) {
    smallPupilsUsedSession = true;
    Emo.set('cham_smallpupils', 2, undefined, true);
    sayTouch(nc && nc['1']);
    sendDevLog('touch', 'TOUCH • chạm vùng nhạy cảm lần đầu tiên (small-pupils, chỉ 1 lần/phiên)');
  } else if (sensitiveTouchCount <= 4) {
    Emo.set('buon', 2, undefined, true);
    sayTouch(nc && nc['2']);
    sendDevLog('touch', `TOUCH • chạm vùng nhạy cảm lần ${sensitiveTouchCount} (buồn)`);
  } else if (sensitiveTouchCount <= 7) {
    Emo.set('kho_chiu', 2, undefined, true);
    sayTouch(nc && nc['3']);
    sendDevLog('touch', `TOUCH • chạm vùng nhạy cảm lần ${sensitiveTouchCount} (khó chịu)`);
  } else if (sensitiveTouchCount <= 10) {
    Emo.set('gian', 3, undefined, true);
    sayTouch(nc && nc['4']);
    sendDevLog('touch', `TOUCH • chạm vùng nhạy cảm lần ${sensitiveTouchCount} (tức giận)`);
  } else {
    Emo.set('cham_dark', 3, undefined, true);
    sayTouch(nc && nc['5']);
    sendDevLog('touch', `TOUCH • chạm vùng nhạy cảm lần ${sensitiveTouchCount} (mặt tối - cảnh báo cuối)`);
  }
}

function reactLegTouch() {
  Emo.set('cham_shy', 2, undefined, true);
  sayTouch(touchLines && touchLines.chan);
  sendDevLog('touch', 'TOUCH • chạm vùng chân (shy-face)');
}

window.api.onCoordinateDebugSetting((enabled) => {
  coordinateDebugEnabled = !!enabled;
  if (!coordinateDebugEnabled) lastDebugLogAt = 0;
});
window.api.getDevConsoleSettings().then((r) => {
  coordinateDebugEnabled = !!r?.coordinateTracking;
}).catch(() => {});

// Rê chuột qua model (KHÔNG cần giữ nút) để xem toạ độ nx/ny hiện tại trong Developer Console —
// dùng để tự canh mép vùng tóc/chân/vùng nhạy cảm cho khớp model thật, không cần đoán qua ảnh chụp màn hình.
canvasEl.addEventListener('pointermove', (e) => {
  if (!coordinateDebugEnabled) return;
  if (!View.model || !canvasEl) return;
  const now = performance.now();
  if (now - lastDebugLogAt < 350) return; // bớt spam log, ~3 lần/giây là đủ đọc
  const rect = canvasEl.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const b = View.model.getBounds();
  if (!b || b.width <= 0 || b.height <= 0) return;
  if (x < b.x || x > b.x + b.width || y < b.y || y > b.y + b.height) return;
  lastDebugLogAt = now;
  const nx = (x - b.x) / b.width, ny = (y - b.y) / b.height;
  sendDevLog('touch-debug', `TOẠ ĐỘ • x=${nx.toFixed(3)}  y=${ny.toFixed(3)}`);
});

canvasEl.addEventListener('pointerdown', (e) => {
  touchDragging = true;
  lastTouchZone = null;
  const z = whichTouchZone(e.clientX, e.clientY);
  if (z === 'nhayCam') reactSensitiveTouch();
  else if (z === 'dau') reactHeadPat();
  else if (z === 'toc') reactHairStroke();
  else if (z === 'chan') reactLegTouch();
  if (z) lastTouchZone = z;
});

canvasEl.addEventListener('pointermove', (e) => {
  if (!touchDragging) return;
  const z = whichTouchZone(e.clientX, e.clientY);
  if (!z || z === lastTouchZone) return;
  lastTouchZone = z;
  if (z === 'toc') reactHairStroke();
  else if (z === 'dau') reactHeadPat();
  else if (z === 'nhayCam') reactSensitiveTouch();
  else if (z === 'chan') reactLegTouch();
});

window.addEventListener('pointerup', () => { touchDragging = false; });
window.addEventListener('pointercancel', () => { touchDragging = false; });

/* ---------- Khởi động ---------- */
(async () => {
  const state = await window.api.getState();
  hasKey = state.hasKey;
  live2dModels = Array.isArray(state.live2dModels) ? state.live2dModels : [];
  currentLive2DModelId = state.live2dModel || (live2dModels[0] && live2dModels[0].id) || null;
  if (modelSelectEl) {
    modelSelectEl.innerHTML = '';
    live2dModels.forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.label || m.id;
      modelSelectEl.appendChild(o);
    });
    if (currentLive2DModelId) modelSelectEl.value = currentLive2DModelId;
  }
  hasKey = !!state.geminiConfigured || hasKey;
  sendDevLog('system', 'Hiyori khởi động • ' + (state.windowResize ? `window: ${state.windowResize.width}x${state.windowResize.height} • resize: ${state.windowResize.enabled ? 'on' : 'off'}` : 'window: unknown'));
  searchAvailable = state.searchEnabled !== false;
  searchBlocked = !!state.searchBlocked;
  refreshSearchButton();
  if (state.framing) {
    if (Number.isFinite(state.framing.nuaNguoi)) View.presets.nuaNguoi = Math.max(0.15, Math.min(0.95, state.framing.nuaNguoi));
    if (Number.isFinite(state.framing.canMat)) View.presets.canMat = Math.max(0.1, Math.min(0.95, state.framing.canMat));
    if (Number.isFinite(state.framing.gan_nhat)) View.fMin = Math.max(0.1, Math.min(0.6, state.framing.gan_nhat));
  }
  try {
    const sv = JSON.parse(localStorage.getItem('view'));
    if (sv) { View.t = View.tCur = clamp01(Number(sv.t) || 0); View.pan = View.panCur = clamp01(Number(sv.pan) || 0); }
  } catch {}
  syncViewUI();
  if (state.touchZones && (Array.isArray(state.touchZones.toc) || Array.isArray(state.touchZones.nhayCam) || Array.isArray(state.touchZones.chan) || Array.isArray(state.touchZones.dau))) {
    touchZones = {
      dau: Array.isArray(state.touchZones.dau) ? state.touchZones.dau : touchZones.dau,
      toc: Array.isArray(state.touchZones.toc) ? state.touchZones.toc : touchZones.toc,
      nhayCam: Array.isArray(state.touchZones.nhayCam) ? state.touchZones.nhayCam : touchZones.nhayCam,
      chan: Array.isArray(state.touchZones.chan) ? state.touchZones.chan : touchZones.chan,
      soLanVuotDeBoiRoi: state.touchZones.soLanVuotDeBoiRoi ?? touchZones.soLanVuotDeBoiRoi,
      giayResetDem: state.touchZones.giayResetDem ?? touchZones.giayResetDem,
    };
  }
  if (state.touchLines && typeof state.touchLines === 'object') touchLines = state.touchLines;
  Emo.setDefs(state.emotionDefs, state.emotionNeutral);
  Emo.enable(state.emotionsEnabled !== false);
  Emo.config({ holdSec: state.emotionHoldSec, halfLifeMin: state.moodHalfLifeMin, moodRest: state.moodRest });
  if (state.mood) Emo.setMood(state.mood);
  if (Number.isFinite(state.watchIntervalSec) && state.watchIntervalSec > 0) watchIntervalMs = state.watchIntervalSec * 1000;
  if (!watching) seeBtn.title = watchOffTitle();
  if (Number.isFinite(state.watchMaxMin) && state.watchMaxMin > 0) watchMaxMs = state.watchMaxMin * 60000;
  if (state.proactive) {
    proactiveEnabled = state.proactive.enabled !== false;
    if (Number.isFinite(state.proactive.quietAfterMin) && state.proactive.quietAfterMin > 0) proactiveQuietMs = state.proactive.quietAfterMin * 60000;
    if (Number.isFinite(state.proactive.intervalSec) && state.proactive.intervalSec > 0) proactiveIntervalMs = state.proactive.intervalSec * 1000;
    if (Number.isFinite(state.proactive.awayAfterMin) && state.proactive.awayAfterMin > 0) proactiveAwayMs = state.proactive.awayAfterMin * 60000;
    if (Number.isFinite(state.proactive.cooldownMin) && state.proactive.cooldownMin > 0) proactiveCooldownMinMs = state.proactive.cooldownMin * 60000;
    if (Number.isFinite(state.proactive.cooldownMax) && state.proactive.cooldownMax > 0) proactiveCooldownMaxMs = state.proactive.cooldownMax * 60000;
    proactiveState = state.proactive.presence || 'ACTIVE';
  }
  if (state.windowResize) {
    resizeEnableEl.checked = state.windowResize.enabled === true;
    resizeWidthEl.value = Math.max(260, Math.min(1000, Number(state.windowResize.width) || 360));
    resizeHeightEl.value = Math.max(400, Math.min(1000, Number(state.windowResize.height) || 620));
    refreshResizeUI();
  }
  if (state.edgeVoice) {
    const sel = $('voice');
    if (![...sel.options].some((o) => o.value === state.edgeVoice)) {
      const o = document.createElement('option'); o.value = state.edgeVoice; o.textContent = state.edgeVoice; sel.appendChild(o);
    }
    sel.value = state.edgeVoice;
  }
  const savedPitch = parseInt(state.edgePitch, 10);
  if (Number.isFinite(savedPitch)) {
    basePitchHz = savedPitch;
    $('voicepitch').value = savedPitch;
    $('voicepitchval').textContent = pitchStr(savedPitch);
  }
  state.history.forEach((m) => addLog(m.role, m.text));

  if (!hasKey) showBubble('Bạn chưa cấu hình Gemini API key. Mở Developer Console (🛠) để thêm key nhé.', 'err');
  else if (!state.history.length) showBubble('Chào bạn! Mình là Hiyori. Nhắn gì đó cho mình nhé.');
  else showBubble('Bạn quay lại rồi! Hôm nay có gì vui không?');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) markOffline(false); // mở app khi đang mất mạng

  /* ---- Nhân vật Live2D ---- */
  try {
    const { Live2DModel } = PIXI.live2d;
    const W = window.innerWidth, H = window.innerHeight;
    const avail = H - 56; // chừa chỗ cho ô nhập ở dưới

    pixiApp = new PIXI.Application({
      view: $('canvas'), width: W, height: H, backgroundAlpha: 0, autoStart: true,
    });
    const app = pixiApp;

    // Bố trí cửa sổ trước; model được tải qua hàm dùng chung để có thể đổi model ngay trong Settings.
    Object.assign(View, { W, H, avail });
    const selected = live2dModels.find((m) => m.id === currentLive2DModelId) || live2dModels[0];
    if (!selected) throw new Error('Không tìm thấy model Live2D trong thư mục models.');
    if (!(await loadLive2DModel(selected.id, selected.path))) throw new Error('Không tải được model Live2D.');
    playWaveOnce(); // chào tay 1 lần lúc vừa mở app
    if (app.ticker) app.ticker.add(viewStep);

    // Tự căn lại canvas + Live2D mỗi khi cửa sổ đổi kích thước.
    let resizeFrame = 0;
    window.addEventListener('resize', () => {
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        const nw = window.innerWidth;
        const nh = window.innerHeight;
        if (pixiApp && pixiApp.renderer) pixiApp.renderer.resize(nw, nh);
        View.W = nw;
        View.H = nh;
        View.avail = Math.max(1, nh - 56);
        layoutView(View.tCur, View.panCur);
      });
    });

    // Theo dõi chuột nhẹ: mắt bám theo hướng chuột, đầu chỉ nghiêng/xoay nhẹ.
    // Tọa độ từ main.js đã là tọa độ tương đối với cửa sổ Electron.
    // Không giới hạn theo vùng quanh đầu để khi chuột ở ô chat model vẫn nhìn đúng hướng.
    let lastCursorX = NaN;
    let lastCursorY = NaN;

    // pixi-live2d-display mặc định có thể xoay đầu tới khoảng 30 độ.
    // Gửi trực tiếp một giá trị focus nhỏ hơn 1 để chuyển động tự nhiên hơn:
    // - ngang: tối đa ~9 độ AngleX / ~3 độ BodyAngleX
    // - dọc: tối đa ~6 độ AngleY
    // - Z chỉ nghiêng rất nhẹ khi nhìn chéo.
    const TRACK_X_GAIN = 0.30;
    const TRACK_Y_GAIN = 0.20;

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    const setSoftCursorFocus = (pos) => {
      if (!View.model || !View.model.internalModel || !View.model.internalModel.focusController) return;

      const model = View.model;
      const centerX = model.x + model.width * 0.5;
      const centerY = model.y + model.height * 0.5;

      // Chuẩn hóa vị trí chuột theo kích thước model rồi giảm biên độ.
      // Cursor xuống thấp => model chỉ nhìn xuống nhẹ, không cúi sâu.
      const dx = (pos.x - centerX) / Math.max(1, model.width * 0.5);
      const dy = (pos.y - centerY) / Math.max(1, model.height * 0.5);

      const focusX = clamp(dx * TRACK_X_GAIN, -TRACK_X_GAIN, TRACK_X_GAIN);
      // focusController dùng Y dương = nhìn lên, nên đảo chiều trục Y màn hình.
      const focusY = clamp(-dy * TRACK_Y_GAIN, -TRACK_Y_GAIN, TRACK_Y_GAIN);

      View.targetFocusX = focusX;
      View.targetFocusY = focusY;
    };

    window.api.onCursor((pos) => {
      if (!pos) return;
      if (pos.presence) handleProactivePresence(pos.presence);
      if (!View.model) return;

      lastCursorX = pos.x;
      lastCursorY = pos.y;
      setSoftCursorFocus(pos);
    });

    // Một lượt nói chuyện qua voice Discord (nghe bạn nói -> Gemini hiểu & trả lời -> đã tự nói lại
    // thẳng vào kênh voice từ phía main.js rồi) - ở đây chỉ cần hiện chữ + đổi nét mặt, KHÔNG gọi speak()
    // nữa vì gọi thêm sẽ phát trùng audio 2 nơi cùng lúc (loa máy + kênh voice).
    window.api.onVoiceTurn(({ heard, reply, emotion, intensity, mood }) => {
      addLog('user', heard);
      addLog('model', reply);
      sendDevLog('system', 'VOICE • nhận câu nói từ Discord và trả lời xong');
      showBubble(reply);
      if (mood) Emo.setMood(mood);
      if (emotion) Emo.set(emotion, intensity || 2);
      else Emo.clear();
    });
  } catch (err) {
    sendDevLog('error', 'Renderer không tải được nhân vật: ' + String(err && err.stack || err));
    showBubble('Không tải được nhân vật. Kiểm tra lại thư mục models và tên file trong renderer.js nhé.', 'err');
  }
})();
