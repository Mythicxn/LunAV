/* ============================================================
   Biểu cảm cho nhân vật Live2D.
   Hiyori không có sẵn file biểu cảm (.exp3.json), nên ta tự điều khiển các tham số khuôn mặt
   (lông mày, má hồng, mắt cười, miệng...). Mọi số liệu nằm trong bieu-cam.json để bạn tự chỉnh.

   Cách hoạt động mỗi khung hình (ngay trước khi model được vẽ):
     1. "trungTinh"  : các tham số khuôn mặt luôn bị ghi đè về mặt bình thường, để các chuyển động chờ
                       của model không tự làm mặt cười/giận/buồn ngẫu nhiên.
     2. "set"        : nét mặt đích của cảm xúc đang có (chuyển mượt từ mặt bình thường).
     3. "mul", "add" : nhân/cộng thêm (mở mắt, nghiêng đầu, liếc mắt...), nên chớp mắt và nhìn theo chuột vẫn chạy.
   ============================================================ */
(function () {
  const D = {
    defs: {}, neutral: {}, modelProfiles: {}, modelId: null, enabled: true, holdSec: 25, halfLifeMin: 40, moodRest: 0,
    rig: null, active: null, mood: null,
    curSet: {}, curAdd: {}, curMul: {}, last: 0,
  };
  let nowFn = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const LEVEL_W = { 1: 0.6, 2: 1.0, 3: 1.35 };
  const weightOf = (level) => LEVEL_W[level] || 1.0;
  const isObj = (o) => o && typeof o === 'object';

  function setDefs(defs, neutral) {
    D.defs = isObj(defs) ? defs : {};
    D.modelProfiles = isObj(defs && defs._modelProfiles) ? defs._modelProfiles : {};
    D._baseNeutral = isObj(neutral) ? neutral : {};
    D.neutral = D._baseNeutral;
    D.modelId = null;
    D.curSet = {};
    D.curAdd = {};
    D.curMul = {};
  }

  function profile() {
    return D.modelId && isObj(D.modelProfiles[D.modelId]) ? D.modelProfiles[D.modelId] : null;
  }

  function setModel(modelId) {
    D.modelId = String(modelId || '');
    const p = profile();
    if (p && isObj(p.neutral)) D.neutral = { ...(isObj(neutralBase()) ? neutralBase() : {}), ...p.neutral };
    else D.neutral = neutralBase();
    D.curSet = {}; D.curAdd = {}; D.curMul = {};
  }

  function neutralBase() {
    return isObj(D._baseNeutral) ? D._baseNeutral : {};
  }
  function names() { return Object.keys(D.defs).filter((k) => !k.startsWith('_')); }
  function enable(on) { D.enabled = !!on; if (!on) D.active = null; }
  function config(o) {
    if (o && Number.isFinite(o.holdSec) && o.holdSec > 0) D.holdSec = o.holdSec;
    if (o && Number.isFinite(o.halfLifeMin) && o.halfLifeMin > 0) D.halfLifeMin = o.halfLifeMin;
    if (o && Number.isFinite(o.moodRest)) D.moodRest = Math.max(-1, Math.min(1, o.moodRest));
  }

  function resolvedDef(name) {
    const base = isObj(D.defs[name]) ? D.defs[name] : {};
    const p = profile();
    const native = p && isObj(p.emotions) && isObj(p.emotions[name]) ? p.emotions[name] : {};
    return {
      ...base,
      ...native,
      set: { ...(base.set || {}), ...(native.set || {}) },
      add: { ...(base.add || {}), ...(native.add || {}) },
      mul: { ...(base.mul || {}), ...(native.mul || {}) },
      cuChi: native.cuChi || base.cuChi,
      giong: native.giong || base.giong,
    };
  }

  function usedParams() {
    const s = new Set(Object.keys(D.neutral));
    for (const n of names()) {
      const d = resolvedDef(n);
      for (const op of ['set', 'add', 'mul']) Object.keys(d[op] || {}).forEach((k) => s.add(k));
    }
    return [...s];
  }
  function missingParams() {
    if (!D.rig) return [];
    return usedParams().filter((k) => !(k in D.rig.idx));
  }

  function attachRaw(raw, model) {
    const P = raw && raw.parameters;
    if (!P || !P.ids) { D.rig = null; return { ok: false, count: 0, ids: [], missing: [] }; }
    const ids = Array.from(P.ids);
    const idx = {};
    ids.forEach((id, i) => { idx[id] = i; });
    D.rig = { P, idx, model };
    D.last = nowFn();
    D.curSet = {};
    return { ok: true, count: ids.length, ids, missing: missingParams() };
  }
  function attach(model) {
    let raw = null;
    try {
      const cm = model.internalModel.coreModel;
      raw = (typeof cm.getModel === 'function' && cm.getModel()) || cm._model || null;
    } catch {}
    return attachRaw(raw, model);
  }

  // Ghi thẳng một tham số (dùng cho miệng nhép). Trả về false nếu model không có tham số đó.
  function setParam(id, v) {
    const r = D.rig;
    if (!r || !(id in r.idx)) return false;
    r.P.values[r.idx[id]] = v;
    return true;
  }

  function playGesture(cu, lv, force) {
    if (!cu || !cu.nhom || !D.rig || !D.rig.model || typeof D.rig.model.motion !== 'function') return;
    if (!force) {
      if ((cu.mucToiThieu || 1) > lv) return;
      if (Math.random() >= (cu.xacSuat === undefined ? 0.5 : cu.xacSuat)) return;
    }
    try {
      const p = D.rig.model.motion(cu.nhom, undefined, 3); // 3 = FORCE: chen ngang chuyển động đang chạy
      if (p && p.catch) p.catch(() => {});
    } catch {}
  }

  function set(name, level, holdMs, forceGesture) {
    if (!D.enabled) return;
    if (!D.defs[name]) name = D.defs.binh_thuong ? 'binh_thuong' : null;
    if (!name) { D.active = null; return; }
    const lv = level || 2;
    const ms = holdMs !== undefined ? holdMs : D.holdSec * 1000 * (0.6 + 0.2 * lv);
    D.active = { name, w: weightOf(lv), until: nowFn() + ms };
    playGesture(resolvedDef(name).cuChi, lv, forceGesture);
  }
  function clear() { D.active = null; }

  function setMood(m) {
    if (!m || typeof m.v !== 'number') return;
    D.mood = { v: m.v, neg: m.neg || null, at: Date.now() };
  }

  // Tâm trạng nền: gương mặt lúc rảnh mang sẵn sắc thái của tâm trạng hiện tại
  // (mặc định tâm trạng "nghỉ" hơi vui nên cô ấy lúc nào cũng thoáng nét cười nhẹ).
  function baseline() {
    const m = D.mood || (D.moodRest !== 0 ? { v: D.moodRest, neg: null, at: Date.now() } : null);
    if (!m) return null;
    const decay = Math.pow(0.5, (Date.now() - m.at) / (D.halfLifeMin * 60000));
    const v = D.moodRest + (m.v - D.moodRest) * decay;
    if (v <= -0.3) {
      const nm = m.neg && D.defs[m.neg] ? m.neg : 'buon';
      return { name: nm, w: Math.min(0.55, -v * 0.7) };
    }
    if (v >= 0.2) return { name: 'vui', w: Math.min(0.5, v * 0.9) };
    return null;
  }

  // Độ cao/tốc độ giọng đọc theo cảm xúc (cộng thêm vào cài đặt giọng hiện tại)
  function prosody(name, level) {
    if (!D.enabled) return null;
    const g = resolvedDef(name).giong;
    if (!g) return null;
    const w = weightOf(level || 2);
    return { pitchHz: (g.pitchHz || 0) * w, ratePct: (g.ratePct || 0) * w };
  }

  const clampTo = (P, i, v) => {
    const lo = P.minimumValues ? P.minimumValues[i] : -Infinity;
    const hi = P.maximumValues ? P.maximumValues[i] : Infinity;
    return Math.min(hi, Math.max(lo, v));
  };

  // Gọi mỗi khung hình, NGAY TRƯỚC khi model được vẽ.
  function apply(isSpeaking) {
    const r = D.rig;
    if (!r || !D.enabled) return;
    const P = r.P;
    const now = nowFn();
    const dt = Math.min(0.1, Math.max(0, (now - D.last) / 1000));
    D.last = now;

    if (D.active && now > D.active.until && !isSpeaking) D.active = null;
    const t = D.active || baseline();
    const def = t ? resolvedDef(t.name) : null;
    const w = t ? t.w : 0;
    const a = 1 - Math.exp(-dt / 0.22); // hệ số làm mượt: ~0.5 giây để đổi nét mặt

    // 1) "set": ghi đè hẳn nét mặt (mặt bình thường -> nét mặt đích)
    const setKeys = new Set([...Object.keys(D.neutral), ...Object.keys((def && def.set) || {})]);
    for (const k of setKeys) {
      const i = r.idx[k];
      if (i === undefined) continue;
      const nv = D.neutral[k] !== undefined ? D.neutral[k] : (P.defaultValues ? P.defaultValues[i] : 0);
      const dv = def && def.set && def.set[k] !== undefined ? def.set[k] : nv;
      const target = nv + (dv - nv) * w;
      const cur = D.curSet[k] === undefined ? nv : D.curSet[k];
      const next = cur + (target - cur) * a;
      D.curSet[k] = next;
      P.values[i] = clampTo(P, i, next);
    }

    // 2) "mul" và "add": chồng thêm lên giá trị hiện có (chớp mắt, nhìn theo chuột vẫn hoạt động)
    const tAdd = {}, tMul = {};
    if (def) {
      for (const [k, v] of Object.entries(def.add || {})) tAdd[k] = v * w;
      for (const [k, v] of Object.entries(def.mul || {})) tMul[k] = Math.max(0, 1 + (v - 1) * w);
    }
    const keys = new Set([...Object.keys(D.curAdd), ...Object.keys(D.curMul), ...Object.keys(tAdd), ...Object.keys(tMul)]);
    for (const k of keys) {
      const ca = D.curAdd[k] === undefined ? 0 : D.curAdd[k];
      const cm = D.curMul[k] === undefined ? 1 : D.curMul[k];
      const na = ca + ((tAdd[k] === undefined ? 0 : tAdd[k]) - ca) * a;
      const nm = cm + ((tMul[k] === undefined ? 1 : tMul[k]) - cm) * a;
      if (tAdd[k] === undefined && tMul[k] === undefined && Math.abs(na) < 0.002 && Math.abs(nm - 1) < 0.002) {
        delete D.curAdd[k]; delete D.curMul[k];
        continue;
      }
      D.curAdd[k] = na; D.curMul[k] = nm;
      const i = r.idx[k];
      if (i === undefined) continue;
      P.values[i] = clampTo(P, i, P.values[i] * nm + na);
    }

    // Akuro không có idle motion mặc định trong model3.json. Cho model này một
    // chuyển động nền rất nhẹ (thở), chạy LIÊN TỤC mọi lúc (kể cả đang nói hoặc đang
    // có biểu cảm khác) vì ParamBreath là tham số riêng, không trùng với bất kỳ
    // biểu cảm nào trong bieu-cam.json nên không tranh chấp giá trị với set/add/mul.
    const idle = profile() && profile().idle;
    if (idle) {
      const tIdle = now / 1000;
      if (idle.breathId && r.idx[idle.breathId] !== undefined) {
        const bi = r.idx[idle.breathId];
        const amp = Number(idle.breathAmplitude || 0.12);
        const spd = Number(idle.breathSpeed || 1.0);
        const bv = Math.sin(tIdle * spd * Math.PI * 2) * amp;
        P.values[bi] = clampTo(P, bi, bv);
      }
    }
  }

  const api = {
    setDefs, setModel, names, enable, config, attach, attachRaw, setParam, set, clear, setMood,
    prosody, apply, missingParams,
    _state: D, _setClock: (fn) => { nowFn = fn; },
  };
  const g = typeof window !== 'undefined' ? window : globalThis;
  g.Emo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
