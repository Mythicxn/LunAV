/* ============================================================
   Điều khiển bot Discord: đăng nhập, tự vào kênh voice mà người dùng đang ở,
   và rời voice khi được yêu cầu. Được main.js gọi từ handler 'chat' mỗi khi
   Gemini chọn action "vao_voice" / "roi_voice", hoặc gọi trực tiếp qua IPC
   'discord-join' / 'discord-leave' / 'discord-status'.

   Cần điền đủ 3 mục trong cai-dat.json > "discord": botToken, guildId, userId
   thì mới hoạt động (xem chú thích trong file đó). Bot chỉ vào được server
   ĐÃ được mời vào từ trước - không tự ý join server lạ được.

   Đây là TÀI KHOẢN BOT riêng (đăng ký ở discord.com/developers/applications),
   khác hoàn toàn với tài khoản Discord cá nhân của bạn.
   ============================================================ */

let discordLib = null;
let voiceLib = null;
let libsLoaded = false; // chỉ true SAU LẦN ĐẦU thật sự cần dùng tới (vào/ra/kiểm tra voice)

// Nạp 2 thư viện discord.js/@discordjs/voice TRỄ, đúng lúc cần dùng, thay vì nạp ngay lúc mở app.
// 2 thư viện này khá nặng (kéo theo nhiều file con) nên nạp sẵn lúc khởi động sẽ làm app mở chậm hẳn
// dù người dùng chưa chắc đã dùng tới voice trong phiên đó.
function loadLibs() {
  if (libsLoaded) return;
  libsLoaded = true;
  try {
    discordLib = require('discord.js');
    voiceLib = require('@discordjs/voice');
    // Nhiều mạng/router ở VN ưu tiên IPv6 nhưng route IPv6 lại không thông suốt tới máy chủ voice của
    // Discord, làm bước "khám phá UDP" bị treo rồi timeout (lỗi "The operation was aborted"). Ép Node
    // ưu tiên IPv4 khi phân giải tên miền để tránh việc này. Cần Node 18+ (Electron 33 đã có sẵn).
    try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}
  } catch {
    // Chưa "npm install" lại sau khi thêm thư viện discord.js/@discordjs/voice vào package.json
    // -> để null, các hàm bên dưới sẽ báo lỗi thân thiện thay vì làm app bị crash.
  }
}

let client = null;
let loginPromise = null;
let loggedInToken = null; // token đang dùng để đăng nhập; đổi token trong cai-dat.json thì tự đăng nhập lại
let lastGuildId = null;
let activeConnection = null; // VoiceConnection hiện tại (nếu đang ở trong voice) - dùng để nghe + nói
let audioPlayer = null; // AudioPlayer dùng để phát giọng đọc (Edge TTS) vào kênh voice
let listeningUserId = null; // chỉ nghe đúng người dùng này (userId trong cai-dat.json), bỏ qua người khác trong kênh
let currentlyListening = false; // đang xử lý 1 lượt nói -> bỏ qua các lượt speaking khác chồng lên
let listenerAttached = false; // đã gắn bộ lắng nghe 'speaking' cho activeConnection hiện tại chưa - tránh gắn chồng nhiều lần
let botSpeaking = false; // true trong lúc Hiyori đang phát giọng vào kênh - lúc này BỎ QUA mọi tiếng "nói" phát hiện được,
                          // vì rất có thể chỉ là mic của bạn thu lại chính giọng cô ấy qua loa (vòng lặp phản hồi/feedback)

/* ---------- Thông báo cho giao diện ----------
   main.js gọi setNotifier(fn) một lần; sau đó mọi sự kiện quan trọng về voice được đẩy qua fn(ev):
     { type: 'joining' }                              đang bắt đầu vào voice
     { type: 'joined', channelName }                  vào thành công
     { type: 'failed', code, message }                KHÔNG vào được voice (message đã viết sẵn cho người dùng đọc)
     { type: 'lost', code, message }                  đang ở trong voice thì bị mất kết nối
     { type: 'warn', code, message }                  vào được nhưng có vấn đề (vd. bot thiếu quyền Nói)
     { type: 'left' } / { type: 'info', message }     rời voice / thông tin nhẹ                                      */
let notifier = null;
function setNotifier(fn) { notifier = typeof fn === 'function' ? fn : null; }
function notify(ev) { try { if (notifier) notifier(ev); } catch {} }
function fail(code, message) {
  notify({ type: 'failed', code, message });
  return { ok: false, code, error: message };
}

const NET_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
function looksLikeNetwork(e) {
  const msg = String((e && e.message) || '');
  const code = e && (e.code || (e.cause && e.cause.code));
  return NET_CODES.has(code) || /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|getaddrinfo|socket hang up/i.test(msg);
}
const NET_MSG = 'Không kết nối được tới Discord (lỗi mạng). Kiểm tra Wi-Fi rồi thử lại; nếu đang bật VPN thì thử tắt/bật lại.';

function withTimeout(promise, ms, code) {
  let t;
  const timer = new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code })), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

function describeLoginError(e) {
  const msg = String((e && e.message) || '');
  const code = e && e.code;
  if (code === 'LOGIN_TIMEOUT') return ['login-timeout', 'Đăng nhập bot Discord quá lâu (hơn 25 giây) nên đã dừng. Thường do mạng hoặc VPN đang chặn Discord - kiểm tra mạng/VPN rồi thử lại.'];
  if (code === 'TokenInvalid' || /invalid token|incorrect login/i.test(msg)) {
    return ['token-invalid', 'Token bot Discord không đúng hoặc đã bị đổi. Vào Discord Developer Portal > Bot > Reset Token, rồi dán token mới vào discord.botToken trong cai-dat.json (sửa xong bấm Thử lại, không cần mở lại app).'];
  }
  if (looksLikeNetwork(e)) return ['network', NET_MSG];
  return ['login', 'Không đăng nhập được bot Discord: ' + msg];
}

function ensureClient(token) {
  if (client && loggedInToken === token) return loginPromise;
  if (client) { try { client.destroy(); } catch {} client = null; }
  loggedInToken = token;
  const { Client, GatewayIntentBits } = discordLib;
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  let settled = false;
  loginPromise = new Promise((resolve, reject) => {
    client.once('ready', () => { settled = true; resolve(); });
    // Dùng .on (không phải .once): lỗi có thể xảy ra bất cứ lúc nào trong suốt vòng đời client,
    // không chỉ lúc đăng nhập lần đầu.
    client.on('error', (e) => {
      if (!settled) {
        // Lỗi TRƯỚC KHI đăng nhập xong -> coi như đăng nhập thất bại, dọn sạch để lần sau thử lại từ đầu.
        settled = true;
        try { client.destroy(); } catch {}
        client = null;
        loggedInToken = null;
        reject(e);
      } else {
        // Lỗi SAU KHI đã đăng nhập thành công (vd. mạng chập chờn giữa chừng) - discord.js tự động thử
        // kết nối lại ở tầng gateway, KHÔNG cần huỷ client. Trước đây chỗ này lỡ set client=null mỗi khi
        // có lỗi bất kỳ, khiến lần vào voice tiếp theo phải đăng nhập lại từ đầu (chậm hơn hẳn) dù client
        // cũ thật ra vẫn tự hồi phục được - đã sửa để không còn ép đăng nhập lại không cần thiết.
        console.log('[DISCORD] lỗi client sau khi đã đăng nhập (đang tự thử kết nối lại):', e && e.message);
      }
    });
    client.login(token).catch((e) => { settled = true; client = null; loggedInToken = null; reject(e); });
  });
  return loginPromise;
}

const intentionalEnd = new WeakSet(); // các kết nối do CHÍNH MÌNH chủ động ngắt (leaveVoice) -> không báo là "mất kết nối"
let joining = false;                  // đang trong lúc vào voice -> chặn bấm/nhờ thêm lần nữa chồng lên

async function joinUserVoice({ botToken, guildId, userId }) {
  loadLibs();
  if (!discordLib || !voiceLib) {
    return fail('no-lib', 'Chưa cài xong thư viện Discord - chạy lại CAI-DAT.bat rồi mở app lại nhé.');
  }
  botToken = String(botToken || '').trim();
  guildId = String(guildId || '').trim();
  userId = String(userId || '').trim();
  if (!botToken || !guildId || !userId) {
    return fail('no-config', 'Chưa điền đủ discord.botToken / guildId / userId trong cai-dat.json.');
  }
  if (joining) return { ok: false, code: 'busy', error: 'Đang trong quá trình vào voice rồi, đợi thêm chút nhé.' };
  joining = true;
  notify({ type: 'joining' });
  try {
    return await doJoin(botToken, guildId, userId);
  } catch (e) {
    return fail('unknown', 'Lỗi không xác định khi vào voice: ' + (e && e.message));
  } finally {
    joining = false;
  }
}

async function doJoin(botToken, guildId, userId) {
  // 1) Đăng nhập bot (có giới hạn thời gian để không treo mãi khi mạng/VPN chặn Discord)
  try {
    await withTimeout(ensureClient(botToken), 25000, 'LOGIN_TIMEOUT');
  } catch (e) {
    if (e && e.code === 'LOGIN_TIMEOUT') { try { if (client) client.destroy(); } catch {} client = null; loggedInToken = null; }
    const [code, msg] = describeLoginError(e);
    return fail(code, msg);
  }

  // 2) Tìm server
  let guild;
  try {
    guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId));
  } catch (e) {
    if (looksLikeNetwork(e)) return fail('network', NET_MSG);
    const c = e && e.code;
    if (c === 10004 || c === 50001 || (e && (e.status === 404 || e.status === 403))) {
      return fail('guild-not-found', 'Không tìm thấy server đó - kiểm tra lại guildId, và nhớ mời bot vào server trước.');
    }
    return fail('guild-error', 'Không lấy được thông tin server Discord: ' + (e && e.message));
  }

  // 3) Tìm bạn trong server
  let member;
  try {
    member = await guild.members.fetch(userId);
  } catch (e) {
    if (looksLikeNetwork(e)) return fail('network', NET_MSG);
    const c = e && e.code;
    if (c === 10007 || c === 10013 || (e && e.status === 404)) {
      return fail('user-not-in-server', 'Không tìm thấy bạn trong server đó - kiểm tra lại userId, và bạn phải đang là thành viên của server.');
    }
    return fail('member-error', 'Không lấy được thông tin của bạn trong server: ' + (e && e.message));
  }

  // 4) Bạn có đang ở trong kênh voice không?
  const channel = member.voice && member.voice.channel;
  if (!channel) {
    return fail('user-not-in-voice', 'Bạn chưa ở trong kênh voice nào cả - vào một kênh voice trước, rồi nhờ mình hoặc bấm Thử lại nhé.');
  }

  // 5) Kiểm tra quyền của bot với kênh đó (thiếu quyền là nguyên nhân hay gặp nhất khiến vào voice bị treo)
  try {
    const me = guild.members.me || (await guild.members.fetchMe());
    const perms = channel.permissionsFor(me);
    if (perms && !perms.has(['ViewChannel', 'Connect'])) {
      return fail('no-permission', `Bot không có quyền vào kênh "${channel.name}". Vào Cài đặt kênh > Quyền, cấp cho bot các quyền Xem kênh, Kết nối và Nói.`);
    }
    if (perms && channel.userLimit > 0 && channel.members && channel.members.size >= channel.userLimit && !perms.has('MoveMembers')) {
      return fail('channel-full', `Kênh "${channel.name}" đã đầy nên bot không vào được. Nới giới hạn người của kênh hoặc cấp quyền Di chuyển thành viên cho bot.`);
    }
    if (perms && !perms.has('Speak')) {
      notify({ type: 'warn', code: 'no-speak', message: `Bot chưa có quyền Nói trong kênh "${channel.name}" nên sẽ vào được nhưng bạn sẽ không nghe thấy giọng mình. Hãy cấp quyền Nói cho bot.` });
    }
  } catch {} // không kiểm tra được quyền thì cứ thử vào, đừng chặn

  // 6) Vào kênh voice
  try {
    const { joinVoiceChannel, entersState, VoiceConnectionStatus } = voiceLib;

    // Lỗi "operation was aborted" trước đây là do bản @discordjs/voice cũ (0.17.x) không hỗ trợ giao
    // thức mã hoá DAVE mà Discord bắt buộc - đã fix bằng cách nâng lên 0.19.2, nên giờ lần đầu gần như
    // luôn thành công. Vẫn giữ 1 lần thử lại nhẹ để an toàn trước mạng chập chờn nhất thời.
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const timeoutMs = attempt === 1 ? 15000 : 10000;
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false, // phải nghe được (selfDeaf=false) mới nhận được audio người dùng gửi lên
        selfMute: false,
      });
      connection.on('stateChange', (o, n) => console.log(`[DISCORD] voice: ${o.status} -> ${n.status}`));
      connection.on('error', (e) => console.log(`[DISCORD-ERR] ${e && e.message}`));
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
        lastGuildId = guild.id;
        activeConnection = connection;
        audioPlayer = null; // tạo lại player mới cho kết nối mới này (xem speakInVoice)
        listenerAttached = false; // kết nối mới -> cho phép gắn lại bộ lắng nghe 1 lần nữa
        botSpeaking = false;

        // Đang ở trong voice mà bị ngắt (mạng rớt, bị đá khỏi kênh, kênh bị xoá...) -> báo cho người dùng biết.
        let lostReason = null;
        connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
          if (connection !== activeConnection) return;
          lostReason = { reason: newState && newState.reason, closeCode: newState && newState.closeCode };
          try {
            // Nếu chỉ là bị chuyển sang kênh khác thì sẽ tự kết nối lại trong vài giây - lúc đó bỏ qua.
            await Promise.race([
              entersState(connection, VoiceConnectionStatus.Signalling, 5000),
              entersState(connection, VoiceConnectionStatus.Connecting, 5000),
            ]);
          } catch {
            try { if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy(); } catch {}
          }
        });
        connection.on('stateChange', (o, n) => {
          if (n.status === VoiceConnectionStatus.Destroyed && activeConnection === connection) {
            activeConnection = null; audioPlayer = null; listeningUserId = null; listenerAttached = false; botSpeaking = false;
            if (!intentionalEnd.has(connection)) {
              const kicked = lostReason && lostReason.closeCode === 4014;
              notify({
                type: 'lost',
                code: kicked ? 'kicked' : 'connection-lost',
                message: kicked
                  ? 'Bot vừa bị đưa ra khỏi kênh voice (bị đá, kênh bị xoá hoặc bị chuyển đi). Bạn vào lại kênh voice rồi bấm Thử lại nhé.'
                  : 'Kết nối voice Discord bị ngắt (thường do mạng chập chờn hoặc VPN vừa đổi). Bấm Thử lại để nối lại nhé.',
              });
            }
          }
        });
        notify({ type: 'joined', channelName: channel.name });
        return { ok: true, channelName: channel.name };
      } catch (e) {
        lastErr = e;
        try { connection.destroy(); } catch {}
      }
    }
    throw lastErr;
  } catch (e) {
    try { const c = voiceLib.getVoiceConnection(guild.id); if (c) c.destroy(); } catch {} // dọn kết nối treo nửa chừng
    const aborted = e && (e.name === 'AbortError' || /aborted|timed? ?out/i.test(e.message || ''));
    if (looksLikeNetwork(e)) return fail('network', NET_MSG);
    if (aborted) {
      return fail('voice-timeout',
        'Không kết nối được tới máy chủ voice của Discord (hết thời gian chờ). Thường do mạng, tường lửa hoặc antivirus chặn kết nối UDP, hoặc do VPN. ' +
        'Thử: tắt/bật lại VPN, tạm tắt tường lửa/antivirus, hoặc đổi mạng khác. Nếu vẫn lỗi, chạy lại CAI-DAT.bat để cập nhật thư viện voice.');
    }
    return fail('voice-error', 'Vào voice không thành công: ' + (e && e.message));
  }
}

// Ghi 1 header WAV 44 byte trước dữ liệu PCM thô, để Gemini nhận diện đúng định dạng âm thanh.
function wavHeader(pcmLength, sampleRate, channels, bitDepth) {
  const buf = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcmLength, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28); buf.writeUInt16LE(blockAlign, 32); buf.writeUInt16LE(bitDepth, 34);
  buf.write('data', 36); buf.writeUInt32LE(pcmLength, 40);
  return buf;
}

// Bắt đầu "lắng nghe" đúng 1 người dùng trong kênh voice hiện tại. Mỗi khi người đó nói xong 1 câu
// (im lặng liên tục 700ms = coi như dứt câu), đoạn âm thanh nghe được (đóng gói thành file WAV, base64)
// được đưa cho onSpeech(wavBase64) xử lý - main.js truyền vào đây hàm handleVoiceTurn (gọi Gemini, rồi
// tự nói lại bằng speakInVoice bên dưới). Gọi lại hàm này nhiều lần chỉ đổi listeningUserId, không tốn thêm gì.
function startListening(userId, onSpeech) {
  loadLibs();
  listeningUserId = String(userId || '').trim();
  if (!activeConnection || !listeningUserId) return;
  const connection = activeConnection;
  if (listenerAttached) return; // đã gắn rồi (vd. Gemini lỡ chọn "vao_voice" thêm lần nữa dù đã ở trong voice) - không gắn chồng
  listenerAttached = true;
  const { EndBehaviorType } = voiceLib;
  connection.receiver.speaking.on('start', (speakingId) => {
    if (connection !== activeConnection) return; // kết nối này đã bị thay/huỷ, bỏ qua sự kiện cũ
    if (speakingId !== listeningUserId || currentlyListening) return;
    // Đang lúc Hiyori tự phát giọng vào kênh -> gần như chắc chắn đây là mic của bạn thu lại chính
    // giọng cô ấy qua loa (vòng lặp phản hồi), không phải bạn thật sự đang nói - bỏ qua để tránh
    // tình trạng trả lời liên tục không ngừng.
    if (botSpeaking) return;
    currentlyListening = true;
    let prism;
    try { prism = require('prism-media'); } catch {
      console.log('[DISCORD-VOICE] Thiếu thư viện prism-media - chạy lại CAI-DAT.bat.');
      currentlyListening = false;
      return;
    }
    const opusStream = connection.receiver.subscribe(speakingId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 700 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks = [];
    opusStream.pipe(decoder);
    decoder.on('data', (c) => chunks.push(c));
    decoder.on('end', async () => {
      currentlyListening = false;
      const pcm = Buffer.concat(chunks);
      // Bỏ qua đoạn quá ngắn (<0.3s) - thường là tiếng ồn/lách cách micro, không phải câu nói thật.
      if (pcm.length < 48000 * 2 * 2 * 0.3) return;
      const wav = Buffer.concat([wavHeader(pcm.length, 48000, 2, 16), pcm]);
      try { await onSpeech(wav.toString('base64')); } catch (e) { console.log('[VOICE-LOOP] loi:', e && e.message); }
    });
    decoder.on('error', (e) => { currentlyListening = false; console.log('[DISCORD-VOICE] loi giai ma:', e && e.message); });
  });
}

// Phát 1 đoạn âm thanh (Buffer mp3, ví dụ từ edgeSpeak trong main.js) thẳng vào kênh voice hiện tại.
function speakInVoice(mp3Buffer) {
  loadLibs();
  if (!activeConnection || !voiceLib) return false;
  try {
    const { createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior, AudioPlayerStatus } = voiceLib;
    if (!audioPlayer) {
      audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      activeConnection.subscribe(audioPlayer);
      // Gắn ĐÚNG 1 LẦN lúc tạo player (không phải mỗi lần phát) - nếu không sẽ chồng thêm 1 listener
      // Idle mỗi lần gọi speakInVoice, dẫn tới botSpeaking bị bật/tắt sai nhịp về sau.
      audioPlayer.on(AudioPlayerStatus.Idle, () => {
        setTimeout(() => { botSpeaking = false; }, 400); // đệm thêm 400ms phòng độ trễ loa -> mic
      });
    }
    const { Readable } = require('stream');
    const resource = createAudioResource(Readable.from(mp3Buffer), { inputType: StreamType.Arbitrary });
    botSpeaking = true;
    audioPlayer.play(resource);
    return true;
  } catch (e) {
    console.log('[DISCORD-VOICE] loi phat am thanh:', e && e.message);
    return false;
  }
}

function leaveVoice(guildId) {
  loadLibs();
  if (!voiceLib) return { ok: false, error: 'Chưa cài xong thư viện Discord.' };
  const gid = String(guildId || lastGuildId || '').trim();
  const connection = gid && voiceLib.getVoiceConnection(gid);
  if (!connection) {
    const msg = 'Hiện không ở trong voice nào cả.';
    notify({ type: 'info', message: msg });
    return { ok: false, error: msg };
  }
  intentionalEnd.add(connection); // để không bị báo nhầm là "mất kết nối"
  connection.destroy();
  activeConnection = null; audioPlayer = null; listeningUserId = null; listenerAttached = false; botSpeaking = false;
  notify({ type: 'left' });
  return { ok: true };
}

function status(guildId) {
  loadLibs();
  if (!voiceLib) return { connected: false };
  const gid = String(guildId || lastGuildId || '').trim();
  const connection = gid && voiceLib.getVoiceConnection(gid);
  return { connected: !!connection, guildId: gid || null };
}

module.exports = { joinUserVoice, leaveVoice, status, startListening, speakInVoice, setNotifier, notify };
