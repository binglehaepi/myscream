import React, { useState, useRef, useEffect, useCallback } from "react";

// ─────────────────────────────────────────────
// 악!보 (aakbo) — 비명을 격조있는 클래식 성악 악보로
// 진짜 악보처럼 정갈한데 가사가 "아아아아악!보"라 어이없음.
// 길이=음표 길이, 음량=셈여림(f~ffff), 가사=아아아악
// 나타냄말 / gliss / 페르마타 / breath / 악센트
// 모든 처리는 브라우저 안에서 (녹음 X, 서버 X)
// ─────────────────────────────────────────────

const SERIF = "Georgia, 'Times New Roman', 'Nanum Myeongjo', 'Noto Serif KR', 'Apple SD Gothic Neo', serif";

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

// 이탤릭 나타냄말 (음표 위)
const EXPRESSIONS = ["molto sostenuto", "espressivo, doloroso", "poco meno intenso", "con forza", "agitato", "con dolore", "disperato", "molto vibrato", "senza misura"];
// 셈여림 아래 영어 설명
const DYN_NOTES = { ffff: "release everything", fff: "screamed, not sung", ff: "tremendously", f: "with intent", mf: "still holding back", p: "barely audible", pp: "almost silence" };
// 빠르기말 후보
const TEMPI = ["Molto drammatico", "Disperato", "Con tutta forza", "Largo doloroso", "Agitato assai"];
const FOOTERS = ["for one scream and breath", "to be performed only once", "in a single exhalation", "as loud as the body permits"];

const UNIFIED_LYRIC = "a a a a - a";

function lyricFor() {
  return UNIFIED_LYRIC;
}

function dynamicFor(norm) {
  if (norm > 0.75) return "ffff";
  if (norm > 0.55) return "fff";
  if (norm > 0.35) return "ff";
  if (norm > 0.18) return "f";
  if (norm > 0.10) return "mf";
  if (norm > 0.05) return "p";
  return "pp";
}

// ── 재생 엔진 (녹음 시각·박자·피치 반영) ──
function playbackToneDur(n, gapToNext) {
  const span = n.span || n.dur || NOTE_BEAD_DUR;
  if (gapToNext != null) return Math.max(0.08, gapToNext * 0.98 + 0.03);
  return Math.max(0.1, span * 1.25);
}

class ScorePlayer {
  constructor() { this.ctx = null; this.master = null; this.timers = []; this.nodes = []; this.playing = false; }
  ensureCtx() {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain(); this.master.gain.value = 1; this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }
  stop() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    this.nodes.forEach(({ node, end }) => {
      try { node.stop(end); } catch (_) {}
      try { node.disconnect(); } catch (_) {}
    });
    this.nodes = [];
    this.playing = false;
  }
  track(node, end) { this.nodes.push({ node, end }); return node; }
  scheduleEnvelope(gain, t, dur, vol, legato = false) {
    const eps = 0.001;
    const peak = Math.max(eps, vol);
    if (legato) {
      const attack = 0.005;
      const release = Math.min(0.03, dur * 0.1);
      const sustainEnd = Math.max(t + attack, t + dur - release);
      gain.gain.setValueAtTime(eps, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + attack);
      gain.gain.setValueAtTime(peak * 0.94, sustainEnd);
      gain.gain.exponentialRampToValueAtTime(eps, t + dur + 0.015);
      return t + dur + 0.02;
    }
    const sustained = dur >= 0.55;
    const attack = sustained ? Math.min(0.08, dur * 0.12) : 0.015;
    const release = sustained ? Math.max(0.14, Math.min(0.5, dur * 0.15)) : Math.max(0.06, dur * 0.35);
    const sustainEnd = Math.max(t + attack + 0.01, t + dur - release);
    const end = t + dur + 0.04;
    gain.gain.setValueAtTime(eps, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + attack);
    if (sustained) {
      gain.gain.setValueAtTime(peak, sustainEnd);
      gain.gain.exponentialRampToValueAtTime(eps, end);
    } else {
      gain.gain.exponentialRampToValueAtTime(eps, t + dur * 0.75 + 0.04);
    }
    return end;
  }
  playNote(freq, start, dur, norm, voice, glide, detune = 0, legato = true) {
    const ctx = this.ctx;
    const t = start;
    const vol = Math.min(0.95, 0.2 + norm * 0.65);
    const end = t + dur + 0.08;
    const sustained = dur >= 0.4;
    const glideRatio = glide || 1;
    const glideT = legato ? Math.min(dur * 0.85, Math.max(0.06, dur * 0.5)) : Math.min(dur * 0.7, 0.12);

    if (voice === "piano") {
      const partials = [1, 2, 3, 4];
      const gains = sustained ? [1, 0.55, 0.32, 0.14] : [1, 0.45, 0.22, 0.1];
      const g = ctx.createGain();
      g.connect(this.master);
      this.scheduleEnvelope(g, t, dur, vol, legato);
      partials.forEach((p, i) => {
        const o = ctx.createOscillator();
        o.type = sustained ? "sine" : "triangle";
        o.frequency.setValueAtTime(freq * p, t);
        o.detune.setValueAtTime(detune, t);
        if (glide && p === 1) o.frequency.exponentialRampToValueAtTime(freq * p * glideRatio, t + glideT);
        const pg = ctx.createGain();
        pg.gain.value = gains[i];
        o.connect(pg);
        pg.connect(g);
        o.start(t);
        this.track(o, end);
      });
      this.track(g, end);
    } else if (voice === "synth") {
      const g = ctx.createGain();
      g.connect(this.master);
      this.scheduleEnvelope(g, t, dur, vol * 0.92, legato);
      [0, 7, -7].forEach((det) => {
        const o = ctx.createOscillator();
        o.type = "square";
        o.frequency.setValueAtTime(freq, t);
        o.detune.setValueAtTime(detune + det, t);
        if (glide) o.frequency.exponentialRampToValueAtTime(freq * glideRatio, t + glideT);
        o.connect(g);
        o.start(t);
        this.track(o, end);
      });
      this.track(g, end);
    } else {
      const src = ctx.createOscillator();
      src.type = "sawtooth";
      src.frequency.setValueAtTime(freq, t);
      src.detune.setValueAtTime(detune, t);
      if (glide) src.frequency.exponentialRampToValueAtTime(freq * glideRatio, t + glideT);
      const f1 = ctx.createBiquadFilter();
      f1.type = "bandpass";
      f1.frequency.value = 720 + norm * 380;
      f1.Q.value = sustained ? 5.5 : 8;
      const f2 = ctx.createBiquadFilter();
      f2.type = "bandpass";
      f2.frequency.value = 1080 + norm * 520;
      f2.Q.value = sustained ? 6 : 10;
      const mix = ctx.createGain();
      mix.gain.value = 1.15;
      const g = ctx.createGain();
      g.connect(this.master);
      this.scheduleEnvelope(g, t, dur, vol, legato);
      src.connect(f1);
      src.connect(f2);
      f1.connect(mix);
      f2.connect(mix);
      mix.connect(g);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = sustained ? 4.2 : 5.5;
      const lfoG = ctx.createGain();
      lfoG.gain.value = freq * (sustained ? 0.008 : 0.014);
      lfo.connect(lfoG);
      lfoG.connect(src.frequency);
      src.start(t);
      lfo.start(t);
      this.track(src, end);
      this.track(lfo, end);
      this.track(g, end);
    }
  }
  play(notes, voice, onStep, onEnd) {
    this.ensureCtx();
    this.stop();
    this.playing = true;
    const ctx = this.ctx;
    const base = ctx.currentTime + 0.06;
    const playable = [];
    notes.forEach((n, i) => {
      if (n.midi != null && !n.rest) playable.push({ n, i });
    });
    if (!playable.length) {
      this.playing = false;
      onStep && onStep(-1);
      onEnd && onEnd();
      return;
    }
    let lastMidi = null;
    let totalSec = 0;
    let tFallback = 0;
    playable.forEach(({ n, i }, pi) => {
      const t0 = n.at != null ? n.at : tFallback;
      const next = playable[pi + 1];
      const nextT = next ? (next.n.at != null ? next.n.at : t0 + (n.span || NOTE_BEAD_DUR)) : null;
      const gapToNext = nextT != null ? Math.max(0.04, nextT - t0) : null;
      tFallback = nextT ?? t0 + (n.span || NOTE_BEAD_DUR);
      const legato = gapToNext == null || gapToNext < 0.42;
      const toneDur = playbackToneDur(n, gapToNext);
      const start = base + t0;
      totalSec = Math.max(totalSec, t0 + toneDur);
      let glide = null;
      if (lastMidi != null) {
        const ratio = midiToFreq(n.midi) / midiToFreq(lastMidi);
        if (lastMidi !== n.midi || Math.abs(ratio - 1) > 0.02) glide = ratio;
      }
      const detune = n.detune ?? 0;
      this.playNote(midiToFreq(n.midi), start, toneDur, n.norm ?? 0.5, voice, glide, detune, legato);
      lastMidi = n.midi;
      this.timers.push(setTimeout(() => { if (this.playing) onStep && onStep(i); }, t0 * 1000 + 30));
    });
    this.timers.push(setTimeout(() => {
      this.playing = false;
      onStep && onStep(-1);
      onEnd && onEnd();
    }, totalSec * 1000 + 250));
  }
}

function detectPitch(buf, sampleRate) {
  const SIZE = buf.length; let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.008) return -1;
  let r1 = 0, r2 = SIZE - 1; const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++) if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  const b = buf.slice(r1, r2); const n = b.length; const c = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) c[i] += b[j] * b[j + i];
  let d = 0; while (c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < n; i++) if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  let T0 = maxpos; if (T0 <= 0) return -1;
  const x1 = c[T0 - 1] || 0, x2 = c[T0], x3 = c[T0 + 1] || 0;
  const a = (x1 + x3 - 2 * x2) / 2; const bb = (x3 - x1) / 2;
  if (a) T0 = T0 - bb / (2 * a);
  const freq = sampleRate / T0;
  if (freq < 70 || freq > 1200) return -1;
  return freq;
}
function freqToMidi(f) { return Math.round(69 + 12 * Math.log2(f / 440)); }

const LOW_MIDI = 57, HIGH_MIDI = 79;
// 음높이 제한 없음 — 오선·다른 단 침범·악보 밖 위쪽 허용
function staffY(midi, top, staffH) {
  const r = (midi - LOW_MIDI) / (HIGH_MIDI - LOW_MIDI);
  return top + staffH - r * staffH;
}

const PREPARED_STAFF_LINES = 5;
const NOTE_BEAD_DUR = 0.16;
const NOTE_LAYOUT_W = 30;

function beadInterval(norm) {
  return Math.max(0.12, 0.24 - norm * 0.1);
}

function centsBetween(freq, midi) {
  if (!freq || midi == null) return 0;
  return Math.max(-80, Math.min(80, Math.round(1200 * Math.log2(freq / midiToFreq(midi)))));
}

function buildFinalNote(cur, dur = NOTE_BEAD_DUR) {
  const midi = cur.lastMidi ?? cur.midi;
  const span = Math.max(0.05, cur.dur || dur);
  const at = (cur.beadStartMs - cur.sessionStartMs) / 1000;
  return {
    midi,
    norm: cur.peakNorm,
    dur,
    span,
    at,
    detune: centsBetween(cur.lastFreq, midi),
    dyn: dynamicFor(cur.peakNorm),
    lyric: lyricFor(),
    expr: Math.random() < 0.18 ? EXPRESSIONS[Math.floor(Math.random() * EXPRESSIONS.length)] : null,
    fermata: false,
    accent: cur.peakNorm > 0.72,
    live: false,
    bead: true,
  };
}

export default function App() {
  const [phase, setPhase] = useState("idle");
  const [notes, setNotes] = useState([]);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState(null);
  const [diag, setDiag] = useState(null);
  const [saving, setSaving] = useState(false);
  const [voice, setVoice] = useState("piano");
  const [playing, setPlaying] = useState(false);
  const [playIdx, setPlayIdx] = useState(-1);
  const [meta, setMeta] = useState({ tempo: "Molto drammatico", bpm: 72, footer: "for one scream and breath" });

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const timeBufRef = useRef(null);
  const playerRef = useRef(null);

  const startRef = useRef(0);
  const notesRef = useRef([]);
  const curNoteRef = useRef(null);
  const lastMidiRef = useRef(null);
  const lastVoiceTimeRef = useRef(0);

  const inIframe = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
  const isSecure = typeof window !== "undefined" && window.isSecureContext;
  const hasMic = typeof navigator !== "undefined" && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function";

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") audioCtxRef.current.close();
    rafRef.current = null; streamRef.current = null; audioCtxRef.current = null; analyserRef.current = null;
  }, []);
  useEffect(() => () => cleanup(), [cleanup]);

  const tick = useCallback(() => {
    const analyser = analyserRef.current; if (!analyser) return;
    const ctx = audioCtxRef.current;
    analyser.getFloatTimeDomainData(timeBufRef.current);
    let sum = 0;
    for (let i = 0; i < timeBufRef.current.length; i++) sum += timeBufRef.current[i] * timeBufRef.current[i];
    const rms = Math.sqrt(sum / timeBufRef.current.length);
    const norm = Math.min(1, rms * 3.5);
    setLevel(norm);
    const freq = detectPitch(timeBufRef.current, ctx.sampleRate);
    let midi = null;
    if (freq > 0 && norm > 0.07) {
      midi = freqToMidi(freq);
      const prev = lastMidiRef.current;
      if (prev != null) { while (midi - prev > 8) midi -= 12; while (prev - midi > 8) midi += 12; }
      lastMidiRef.current = midi;
    }
    const liveFreq = freq > 0 ? freq : null;
    const now = performance.now();
    setElapsed((now - startRef.current) / 1000);
    const VOICING = norm > 0.08 && midi != null;
    if (VOICING) {
      lastVoiceTimeRef.current = now;
      const cur = curNoteRef.current;
      if (cur && Math.abs((cur.lastMidi ?? midi) - midi) <= 3) {
        cur.dur = (now - cur.startMs) / 1000;
        if (norm > cur.peakNorm) { cur.peakNorm = norm; cur.peakMidi = midi; }
        if (liveFreq) cur.lastFreq = liveFreq;
        cur.lastMidi = midi;
        if (cur.dur >= beadInterval(cur.peakNorm)) {
          appendBead(cur);
          curNoteRef.current = {
            midi, lastMidi: midi, peakMidi: midi, norm, peakNorm: norm,
            startMs: now, beadStartMs: now, sessionStartMs: startRef.current,
            dur: 0, lastFreq: liveFreq, gliss: false, glissTo: null,
          };
          commitCurrent(true);
        } else {
          commitCurrent(false);
        }
      } else {
        finalizeCurrent();
        curNoteRef.current = {
          midi, lastMidi: midi, peakMidi: midi, norm, peakNorm: norm,
          startMs: now, beadStartMs: now, sessionStartMs: startRef.current,
          dur: 0, lastFreq: liveFreq, gliss: false, glissTo: null,
        };
        commitCurrent(true);
      }
    } else {
      if (now - lastVoiceTimeRef.current > 90) finalizeCurrent();
    }
    rafRef.current = requestAnimationFrame(tick);

    function commitCurrent(isNew) {
      const arr = notesRef.current; const draft = { ...curNoteRef.current, live: true };
      if (isNew || arr.length === 0 || !arr[arr.length - 1].live) notesRef.current = [...arr, draft];
      else notesRef.current = [...arr.slice(0, -1), draft];
      setNotes(notesRef.current);
    }
    function appendBead(cur) {
      const fin = buildFinalNote(cur);
      const arr = notesRef.current;
      if (arr.length && arr[arr.length - 1].live) notesRef.current = [...arr.slice(0, -1), fin];
      else notesRef.current = [...arr, fin];
      setNotes(notesRef.current);
    }
    function finalizeCurrent() {
      const cur = curNoteRef.current; if (!cur) return;
      if (cur.dur < 0.04) { curNoteRef.current = null; return; }
      const fin = buildFinalNote(cur);
      const arr = notesRef.current;
      if (arr.length && arr[arr.length - 1].live) notesRef.current = [...arr.slice(0, -1), fin];
      else notesRef.current = [...arr, fin];
      setNotes(notesRef.current);
      curNoteRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    if (!hasMic) { setDiag({ errName: "NoMediaDevices" }); setPhase("denied"); return; }
    setPhase("arming");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
      source.connect(analyser); analyserRef.current = analyser;
      timeBufRef.current = new Float32Array(analyser.fftSize);
      startRef.current = performance.now();
      notesRef.current = []; curNoteRef.current = null; lastMidiRef.current = null; lastVoiceTimeRef.current = 0;
      setNotes([]); setElapsed(0); setPhase("recording");
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) { setDiag({ errName: e && e.name ? e.name : "UnknownError" }); setPhase("denied"); }
  }, [tick, hasMic]);

  const stop = useCallback(() => {
    const cur = curNoteRef.current;
    if (cur) {
      const fin = buildFinalNote(cur);
      const arr = notesRef.current;
      if (arr.length && arr[arr.length - 1].live) notesRef.current = [...arr.slice(0, -1), fin];
      else notesRef.current = [...arr, fin];
      curNoteRef.current = null;
    } else notesRef.current = notesRef.current.map((n) => ({ ...n, live: false }));
    // 마지막 음표에 늘임표 강제
    if (notesRef.current.length) { const last = notesRef.current.length - 1; notesRef.current = notesRef.current.map((n, i) => i === last ? { ...n, fermata: true } : n); }
    setNotes(notesRef.current);
    const dur = (performance.now() - startRef.current) / 1000;
    setMeta({
      tempo: TEMPI[Math.floor(Math.random() * TEMPI.length)],
      bpm: 60 + Math.floor(Math.random() * 40),
      footer: FOOTERS[Math.floor(Math.random() * FOOTERS.length)],
    });
    setResult({ dur, count: notesRef.current.length, ts: new Date(), no: Math.floor(Math.random() * 9000) + 1000 });
    setPhase("done");
    cleanup();
  }, [cleanup]);

  const reset = useCallback(() => {
    if (playerRef.current) playerRef.current.stop();
    setPlaying(false); setPlayIdx(-1);
    notesRef.current = []; curNoteRef.current = null; setNotes([]); setLevel(0); setElapsed(0); setResult(null); setPhase("idle");
  }, []);

  const saveImage = useCallback(() => {
    if (!result) return; setSaving(true);
    try {
      drawScoreSheet({ notes: notesRef.current, meta, onBlob: (blob) => {
        const url = URL.createObjectURL(blob); const a = document.createElement("a");
        const d = result.ts; a.href = url;
        a.download = `aakbo-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}.png`;
        a.click(); URL.revokeObjectURL(url); setSaving(false);
      }});
    } catch (e) { setSaving(false); alert("이미지 저장에 실패했어요."); }
  }, [result, meta]);

  const togglePlay = useCallback(() => {
    if (!playerRef.current) playerRef.current = new ScorePlayer();
    const p = playerRef.current;
    if (playing) { p.stop(); setPlaying(false); setPlayIdx(-1); return; }
    setPlaying(true);
    p.play(notesRef.current, voice, (i) => setPlayIdx(i), () => { setPlaying(false); setPlayIdx(-1); });
  }, [playing, voice]);

  const changeVoice = useCallback((v) => {
    if (playerRef.current) playerRef.current.stop(); setPlaying(false); setPlayIdx(-1); setVoice(v);
  }, []);
  useEffect(() => () => { if (playerRef.current) playerRef.current.stop(); }, []);

  const copyLink = useCallback(async () => {
    try { await navigator.clipboard.writeText(window.location.href); alert("링크 복사 완료! 🎼"); }
    catch (e) { alert(window.location.href); }
  }, []);

  return (
    <div style={S.page}>
      <style>{CSS}</style>
      <div style={S.frame}>
        {phase === "idle" && <IdleView onStart={start} inIframe={inIframe} />}
        {phase === "arming" && <div style={S.center}><p style={S.armText}>마이크 권한 허용해줘…</p></div>}
        {phase === "denied" && <DeniedView diag={diag} inIframe={inIframe} isSecure={isSecure} hasMic={hasMic} onReset={reset} />}
        {phase === "recording" && <RecordView notes={notes} level={level} elapsed={elapsed} onStop={stop} />}
        {phase === "done" && result && <DoneView notes={notes} meta={meta} r={result} onReset={reset} onSave={saveImage} onCopy={copyLink} saving={saving} voice={voice} onVoice={changeVoice} playing={playing} playIdx={playIdx} onTogglePlay={togglePlay} />}
      </div>
    </div>
  );
}

const pad = (n) => String(n).padStart(2, "0");

// 가사 미리보기 한 줄 (제목 아래)
function lyricLine(notes) {
  return notes.length ? UNIFIED_LYRIC : "";
}

// ── 악보 SVG ──
function ScoreSheet({ notes, meta, W, playIdx = -1, showHeader = true, minStaffLines = 1 }) {
  const padX = 30, gap = 7.5, staffH = gap * 4;
  const noteTop = showHeader ? 56 : 20;
  const blockH = staffH + 72;
  const layout = []; let x = padX + 64, line = 0; const lineMaxX = W - padX - 14;
  notes.forEach((n, i) => {
    const w = n.rest ? 22 : NOTE_LAYOUT_W;
    if (x + w > lineMaxX) { line++; x = padX + 64; }
    layout.push({ n, i, x, w, line }); x += w + 7;
  });
  const noteLines = layout.length ? layout[layout.length - 1].line + 1 : 0;
  const totalLines = Math.max(minStaffLines, noteLines, 1);
  const headH = showHeader ? 30 : 4;
  const H = noteTop + headH + totalLines * blockH;

  let extMinY = noteTop;
  let extMaxY = H;
  layout.forEach(({ n, line }) => {
    if (n.rest || n.midi == null) return;
    const top = noteTop + headH + line * blockH + 8;
    const y = staffY(n.midi, top, staffH);
    extMinY = Math.min(extMinY, y - 30);
    extMaxY = Math.max(extMaxY, y + 14);
  });
  const vbTop = Math.min(0, extMinY - 12);
  const vbH = Math.max(H, extMaxY + 20) - vbTop;

  const els = [];

  // 빠르기말 (좌상) + 우상 지시문
  if (showHeader) {
    els.push(<text key="tempo" x={padX} y={36} fontSize="13" fontWeight="700" fill="#111" style={{fontFamily:SERIF}}>{meta.tempo}</text>);
    els.push(<text key="bpm" x={padX + meta.tempo.length * 7.6 + 18} y={37} fontSize="12" fill="#111" style={{fontFamily:SERIF}}>♩ = {meta.bpm}</text>);
    els.push(<text key="within" x={W - padX} y={36} fontSize="11" fontStyle="italic" fill="#111" textAnchor="end" style={{fontFamily:SERIF}}>scream it from within</text>);
  }

  for (let li = 0; li < totalLines; li++) {
    const top = noteTop + headH + li * blockH + 8;
    // 오선 5줄
    for (let k = 0; k < 5; k++) els.push(<line key={`s${li}-${k}`} x1={padX} y1={top + k*gap} x2={W - padX} y2={top + k*gap} stroke="#111" strokeWidth="0.8" />);
    // 끝 세로 마디줄(마지막 단만 굵게)
    els.push(<line key={`bar${li}`} x1={W - padX} y1={top} x2={W - padX} y2={top + staffH} stroke="#111" strokeWidth={li === totalLines-1 ? 2.4 : 0.8} />);
    // 높은음자리표
    els.push(<text key={`clef${li}`} x={padX - 2} y={top + staffH*0.92} fontSize={staffH*1.55} fill="#111" style={{fontFamily:SERIF}}>𝄞</text>);
    // Voice 파트명 + 박자표(첫 단만)
    if (li === 0) {
      els.push(<text key="voice" x={padX - 28} y={top + staffH/2 + 4} fontSize="11" fill="#111" textAnchor="end" style={{fontFamily:SERIF}}>Voice</text>);
      els.push(<text key="ts1" x={padX + 26} y={top + gap*1.9} fontSize={gap*2.2} fontWeight="700" fill="#111" textAnchor="middle" style={{fontFamily:SERIF}}>4</text>);
      els.push(<text key="ts2" x={padX + 26} y={top + gap*3.9} fontSize={gap*2.2} fontWeight="700" fill="#111" textAnchor="middle" style={{fontFamily:SERIF}}>4</text>);
    }
  }

  layout.forEach(({ n, i, x, w, line }) => {
    const top = noteTop + headH + line * blockH + 8;
    const isPlay = i === playIdx;
    const col = isPlay || n.live ? "#c0143c" : "#111";

    if (n.rest) {
      // 온쉼표(넷째 줄 위 막대) 또는 breath
      els.push(<rect key={`rest${i}`} x={x - 5} y={top + gap - 2} width="10" height="3.2" fill={col} />);
      if (n.breath) els.push(<text key={`br${i}`} x={x} y={top - 6} fontSize="10" fontStyle="italic" fill="#111" textAnchor="middle" style={{fontFamily:SERIF}}>(breath)</text>);
      return;
    }

    const y = staffY(n.midi, top, staffH);
    const headRx = 5.2, headRy = 3.8;

    if (n.expr) els.push(<text key={`ex${i}`} x={x} y={top - 8} fontSize="9.5" fontStyle="italic" fill="#111" textAnchor="middle" style={{fontFamily:SERIF}}>{n.expr}</text>);
    if (n.fermata) {
      els.push(<path key={`fmA${i}`} d={`M ${x-7} ${top - 16} A 7 7 0 0 1 ${x+7} ${top-16}`} fill="none" stroke={col} strokeWidth="1" />);
      els.push(<circle key={`fmD${i}`} cx={x} cy={top - 17} r="1.3" fill={col} />);
    }
    if (n.accent) els.push(<text key={`ac${i}`} x={x} y={top - 16} fontSize="13" fill={col} textAnchor="middle" style={{fontFamily:SERIF}}>&gt;</text>);

    els.push(<ellipse key={`h${i}`} cx={x} cy={y} rx={headRx} ry={headRy} transform={`rotate(-15 ${x} ${y})`} fill={col} />);
    els.push(<line key={`st${i}`} x1={x + headRx - 0.4} y1={y} x2={x + headRx - 0.4} y2={y - 22} stroke={col} strokeWidth="1.2" />);
    if (i === 0 && n.lyric) els.push(<text key={`ly${i}`} x={W / 2} y={top + staffH + 20} fontSize="10" fill="#111" textAnchor="middle" style={{fontFamily:SERIF}}>{n.lyric}</text>);
    if (!n.live && i % 4 === 0) {
      els.push(<text key={`dy${i}`} x={x} y={top + staffH + 36} fontSize="14" fontStyle="italic" fontWeight="700" fill={col} textAnchor="middle" style={{fontFamily:SERIF}}>{n.dyn}</text>);
    }
  });

  return (
    <svg viewBox={`0 ${vbTop} ${W} ${vbH}`} style={{ width: "100%", height: "auto", display: "block", overflow: "visible" }}>
      <rect x="0" y={vbTop} width={W} height={vbH} fill="#fff" />
      {els}
    </svg>
  );
}

// ── 저장용 캔버스 (전체 시트: 제목+가사줄+악보+푸터) ──
function drawScoreSheet({ notes, meta, onBlob }) {
  const W = 1000, dpr = 2, padX = 70;
  const gap = 9, staffH = gap * 4, blockH = staffH + 120;
  const layout = []; let x = padX + 70, line = 0; const lineMaxX = W - padX - 20;
  notes.forEach((n, i) => {
    const w = n.rest ? 30 : NOTE_LAYOUT_W + 8;
    if (x + w > lineMaxX) { line++; x = padX + 70; }
    layout.push({ n, i, x, w, line }); x += w + 8;
  });
  const totalLines = Math.max(1, (layout.length ? layout[layout.length - 1].line + 1 : 1));
  const titleH = 230;
  const scoreTop = titleH;
  let extMinY = scoreTop;
  let extMaxY = scoreTop + totalLines * blockH;
  layout.forEach(({ n, line }) => {
    if (n.rest || n.midi == null) return;
    const top = scoreTop + line * blockH + 10;
    const y = staffYC(n.midi, top, staffH);
    extMinY = Math.min(extMinY, y - 34);
    extMaxY = Math.max(extMaxY, y + 16);
  });
  const topPad = extMinY < scoreTop ? Math.ceil(scoreTop - extMinY + 18) : 0;
  const botPad = Math.max(0, Math.ceil(extMaxY - (scoreTop + totalLines * blockH) + 28));
  const baseH = scoreTop + totalLines * blockH + 150;
  const H = baseH + topPad + botPad;

  const canvas = document.createElement("canvas");
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
  const cx = W / 2;

  // 제목
  ctx.fillStyle = "#111"; ctx.textAlign = "center";
  ctx.font = `64px ${SERIF}`; ctx.fillText("aakbo", cx, 90);
  const ll = lyricLine(notes);
  if (ll) {
    ctx.font = `22px ${SERIF}`;
    ctx.fillText(ll, cx, 130);
  }
  // 빠르기말
  ctx.textAlign = "left"; ctx.font = `bold 17px ${SERIF}`;
  ctx.fillText(meta.tempo, padX, 195);
  ctx.font = `15px ${SERIF}`;
  ctx.fillText(`♩ = ${meta.bpm}`, padX + ctx.measureText(meta.tempo).width + 24, 196);
  ctx.textAlign = "right"; ctx.font = `italic 14px ${SERIF}`;
  ctx.fillText("scream it from within", W - padX, 195);

  ctx.save();
  ctx.translate(0, topPad);
  // 오선/음표
  for (let li = 0; li < totalLines; li++) {
    const top = scoreTop + li * blockH + 10;
    ctx.strokeStyle = "#111"; ctx.lineWidth = 1;
    for (let k = 0; k < 5; k++) { ctx.beginPath(); ctx.moveTo(padX, top + k*gap); ctx.lineTo(W - padX, top + k*gap); ctx.stroke(); }
    ctx.lineWidth = li === totalLines-1 ? 3 : 1;
    ctx.beginPath(); ctx.moveTo(W - padX, top); ctx.lineTo(W - padX, top + staffH); ctx.stroke();
    ctx.fillStyle = "#111"; ctx.font = `${staffH*1.5}px ${SERIF}`; ctx.textAlign = "left";
    ctx.fillText("\u{1D11E}", padX - 4, top + staffH*0.95);
    if (li === 0) {
      ctx.textAlign = "right"; ctx.font = `15px ${SERIF}`;
      ctx.fillText("Voice", padX - 36, top + staffH/2 + 5);
      ctx.textAlign = "center"; ctx.font = `bold ${gap*2.1}px ${SERIF}`;
      ctx.fillText("4", padX + 42, top + gap*1.9);
      ctx.fillText("4", padX + 42, top + gap*3.9);
    }
  }

  layout.forEach(({ n, i, x, w, line }) => {
    const top = scoreTop + line * blockH + 10;
    if (n.rest) {
      ctx.fillStyle = "#111"; ctx.fillRect(x - 7, top + gap - 3, 14, 4);
      if (n.breath) { ctx.font = `italic 13px ${SERIF}`; ctx.textAlign = "center"; ctx.fillText("(breath)", x, top - 8); }
      return;
    }
    const y = staffYC(n.midi, top, staffH);
    const headRx = 6.5, headRy = 4.6;
    if (n.expr) { ctx.fillStyle = "#111"; ctx.font = `italic 12px ${SERIF}`; ctx.textAlign = "center"; ctx.fillText(n.expr, x, top - 10); }
    if (n.fermata) {
      ctx.strokeStyle = "#111"; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, top - 18, 9, Math.PI, 0); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, top - 20, 1.7, 0, Math.PI*2); ctx.fillStyle = "#111"; ctx.fill();
    }
    if (n.accent) { ctx.fillStyle = "#111"; ctx.font = `16px ${SERIF}`; ctx.textAlign = "center"; ctx.fillText(">", x, top - 18); }
    ctx.save(); ctx.translate(x, y); ctx.rotate(-15 * Math.PI/180);
    ctx.beginPath(); ctx.ellipse(0, 0, headRx, headRy, 0, 0, Math.PI*2);
    ctx.fillStyle = "#111"; ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "#111"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(x + headRx, y); ctx.lineTo(x + headRx, y - 26); ctx.stroke();
    if (i === 0 && n.lyric) {
      ctx.fillStyle = "#111"; ctx.font = `11px ${SERIF}`; ctx.textAlign = "center";
      ctx.fillText(n.lyric, W / 2, top + staffH + 24);
    }
  });

  const fy = baseH - 70;
  ctx.strokeStyle = "#111"; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(padX, fy); ctx.lineTo(W*0.34, fy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W*0.66, fy); ctx.lineTo(W - padX, fy); ctx.stroke();
  ctx.fillStyle = "#111"; ctx.font = `italic 16px ${SERIF}`; ctx.textAlign = "center";
  ctx.fillText(meta.footer, cx, fy + 5);
  ctx.restore();

  canvas.toBlob((blob) => onBlob(blob), "image/png");
}
function staffYC(midi, top, staffH) {
  return staffY(midi, top, staffH);
}

function IdleView({ onStart, inIframe }) {
  return (
    <div style={S.sheet}>
      <h1 style={S.brandTitle}>aakbo</h1>
      <div style={S.scoreStage}>
        <ScoreSheet notes={[]} meta={{ tempo: "", bpm: 72 }} W={760} showHeader={false} minStaffLines={PREPARED_STAFF_LINES} />
      </div>
      {inIframe && (<div style={S.iframeNote}>⚠️ 미리보기(iframe)에선 마이크가 막혀요. <b>새 창(↗) 또는 배포 주소</b>에서 열어주세요.</div>)}
      <button style={S.btnMain} onClick={onStart}>악!보</button>
    </div>
  );
}

function RecordView({ notes, level, elapsed, onStop }) {
  return (
    <div style={S.sheet}>
      <h1 style={S.brandTitleSmall}>aakbo</h1>
      <p style={S.recLabel}>● {elapsed.toFixed(1)}s</p>
      <div style={S.liveScore}>
        <ScoreSheet notes={notes} meta={{ tempo: "", bpm: 72 }} W={760} showHeader={false} minStaffLines={PREPARED_STAFF_LINES} />
      </div>
      <div style={S.meterMini}><div style={{ ...S.meterFill, width: `${level * 100}%` }} /></div>
      <button style={S.btnStop} onClick={onStop}>■ 채보 끝내기</button>
    </div>
  );
}

function DoneView({ notes, meta, r, onReset, onSave, onCopy, saving, voice, onVoice, playing, playIdx, onTogglePlay }) {
  return (
    <>
      <div style={S.sheet} className="pop">
        <h1 style={S.brandTitle}>aakbo</h1>
        <p style={S.lyricSub}>{UNIFIED_LYRIC}</p>
        <div style={S.doneScore}>
          <ScoreSheet notes={notes} meta={meta} W={760} playIdx={playIdx} showHeader minStaffLines={PREPARED_STAFF_LINES} />
        </div>
        <p style={S.footerLine}>— {meta.footer} —</p>
        <div style={S.playerBox}>
          <div style={S.voiceRow}>
            <button style={voice === "piano" ? S.voiceOn : S.voiceOff} onClick={() => onVoice("piano")}>🎹 피아노</button>
            <button style={voice === "synth" ? S.voiceOn : S.voiceOff} onClick={() => onVoice("synth")}>👾 전자음</button>
            <button style={voice === "ahh" ? S.voiceOn : S.voiceOff} onClick={() => onVoice("ahh")}>🗣️ 아~</button>
          </div>
          <button style={S.btnPlay} onClick={onTogglePlay}>{playing ? "■ 정지" : "▶︎ 내 비명 연주하기"}</button>
        </div>
      </div>
      <div style={S.actions}>
        <button style={S.btnMain} onClick={onSave} disabled={saving}>{saving ? "저장 중…" : "🎼 악보 이미지 저장"}</button>
        <div style={S.actionRow}>
          <button style={S.btnHalf} onClick={onCopy}>🔗 링크 복사</button>
          <button style={S.btnHalf} onClick={onReset}>다시 지르기</button>
        </div>
      </div>
    </>
  );
}

function DeniedView({ diag, inIframe, isSecure, hasMic, onReset }) {
  const name = diag && diag.errName;
  let headline = "마이크를 못 켰어 😶"; let steps = [];
  if (inIframe || name === "NoMediaDevices" || !hasMic) { headline = "여기선 마이크가 막혀요"; steps = ["미리보기(iframe) 안이라 마이크를 못 씁니다.", "배포 주소(https) 또는 새 창(↗)에서 열어주세요."]; }
  else if (name === "NotAllowedError" || name === "SecurityError") { headline = "마이크 권한이 차단됐어요"; steps = ["주소창 자물쇠/마이크 아이콘 → 허용 → 새로고침."]; }
  else if (name === "NotFoundError") { headline = "마이크 장치를 못 찾았어요"; steps = ["마이크 연결을 확인해주세요."]; }
  else if (!isSecure) { headline = "보안 연결이 아니에요"; steps = ["https 페이지에서만 작동합니다."]; }
  else steps = ["잠시 후 다시 시도해주세요."];
  return (
    <div style={S.center}>
      <p style={S.deniedHead}>{headline}</p>
      <ol style={S.steps}>{steps.map((s, i) => <li key={i} style={S.stepItem}>{s}</li>)}</ol>
      <button style={S.btnMain} onClick={onReset}>다시 시도</button>
      <div style={S.diagBox}>
        <p style={S.diagTitle}>진단 정보</p>
        <p style={S.diagLine}>iframe 안: {String(inIframe)}</p>
        <p style={S.diagLine}>보안(https): {String(isSecure)}</p>
        <p style={S.diagLine}>마이크 API: {String(hasMic)}</p>
        {diag && <p style={S.diagLine}>오류: {diag.errName}</p>}
      </div>
    </div>
  );
}

const MONO = "'Courier New', ui-monospace, monospace";
const S = {
  page: { minHeight: "100vh", background: "#fff", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "20px 14px", fontFamily: SERIF },
  frame: { width: "100%", maxWidth: 480 },
  sheet: { background: "#fff", padding: "22px 18px 20px", boxShadow: "0 8px 32px rgba(0,0,0,0.1)", border: "1px solid #eee" },
  center: { background: "#fff", padding: "48px 24px", textAlign: "center", boxShadow: "0 16px 50px rgba(0,0,0,0.28)" },
  armText: { fontSize: 16, color: "#111", letterSpacing: 1, textAlign: "center", fontFamily: SERIF },

  brandTitle: { textAlign: "center", fontSize: 34, fontWeight: 400, letterSpacing: 6, color: "#111", margin: "0 0 8px", fontFamily: SERIF },
  lyricSub: { textAlign: "center", fontSize: 12, color: "#444", margin: "0 0 12px", letterSpacing: 2, fontFamily: SERIF },
  brandTitleSmall: { textAlign: "center", fontSize: 22, fontWeight: 400, letterSpacing: 4, color: "#111", margin: "0 0 8px", fontFamily: SERIF },
  scoreStage: { margin: "0 0 18px", background: "#fff" },
  liveScore: { margin: "0 0 12px", maxHeight: 420, overflowY: "auto", overflowX: "hidden", background: "#fff" },
  doneScore: { margin: "0 0 8px", maxHeight: 420, overflowY: "auto", overflowX: "hidden", background: "#fff" },
  footerLine: { textAlign: "center", fontSize: 12, fontStyle: "italic", color: "#333", margin: "14px 0 6px", fontFamily: SERIF },

  iframeNote: { border: "1.5px dashed #111", padding: "12px 14px", fontSize: 11.5, lineHeight: 1.7, color: "#333", marginBottom: 18, textAlign: "left", fontFamily: MONO },
  recLabel: { textAlign: "center", fontSize: 12, letterSpacing: 1, color: "#c0143c", fontWeight: 700, marginBottom: 10, fontFamily: SERIF },
  meterMini: { height: 6, background: "#e5e0d2", borderRadius: 3, overflow: "hidden", marginBottom: 14 },
  meterFill: { height: "100%", background: "#111", transition: "width 40ms linear" },

  playerBox: { marginTop: 16 },
  voiceRow: { display: "flex", gap: 6, marginBottom: 10 },
  voiceOn: { flex: 1, padding: "10px 4px", background: "#111", color: "#fff", border: "1.5px solid #111", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: MONO },
  voiceOff: { flex: 1, padding: "10px 4px", background: "#fff", color: "#111", border: "1.5px solid #ccc", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: MONO },
  btnPlay: { width: "100%", padding: "14px", background: "#c0143c", color: "#fff", border: "none", fontSize: 15, fontWeight: 700, letterSpacing: 1, cursor: "pointer", fontFamily: MONO },

  actions: { marginTop: 16 },
  actionRow: { display: "flex", gap: 10, marginTop: 10 },
  btnMain: { width: "100%", padding: "16px", background: "#111", color: "#fff", border: "none", fontSize: 14.5, fontWeight: 700, letterSpacing: 1, cursor: "pointer", fontFamily: MONO },
  btnHalf: { flex: 1, padding: "14px", background: "#fff", color: "#111", border: "1.5px solid #111", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: MONO },
  btnStop: { width: "100%", padding: "16px", background: "#111", color: "#fff", border: "none", fontSize: 15, fontWeight: 700, letterSpacing: 2, cursor: "pointer", fontFamily: MONO },

  deniedHead: { fontSize: 18, fontWeight: 700, color: "#111", letterSpacing: 1, marginBottom: 18, textAlign: "center", fontFamily: SERIF },
  steps: { textAlign: "left", margin: "0 0 24px", paddingLeft: 18, fontFamily: MONO },
  stepItem: { fontSize: 12.5, color: "#444", lineHeight: 1.7, marginBottom: 8 },
  diagBox: { marginTop: 22, padding: "12px 14px", background: "#f0ece0", textAlign: "left", fontFamily: MONO },
  diagTitle: { fontSize: 10, letterSpacing: 2, color: "#999", marginBottom: 8 },
  diagLine: { fontSize: 11, color: "#666", lineHeight: 1.6 },
};
const CSS = `
  * { box-sizing: border-box; margin: 0; }
  button:active { transform: translateY(1px); }
  button:disabled { opacity: 0.5; cursor: default; }
  .pop { animation: pop 0.4s cubic-bezier(0.16,1,0.3,1); }
  @keyframes pop { 0% { opacity: 0; transform: translateY(-12px) scale(0.98); } 100% { opacity: 1; transform: translateY(0) scale(1); } }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-thumb { background: #ccc; }
`;
