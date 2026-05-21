import React, { useState, useRef, useEffect, useCallback } from "react";

// ─────────────────────────────────────────────
// MYSCREAM — 비명을 진짜처럼 생긴 (어딘가 이상한) 악보로
// 이어지는 고함 = 길이를 가진 음표 하나 (길수록 길게 이어짐)
// 소리 크기 = 셈여림 f / ff / fff / ffff
// 음표 아래 가사 "AAAAAAH" / "끄아악" 등
// gliss., 이음줄 같은 연주 기호
// 모든 처리는 브라우저 안에서 (녹음 X, 서버 X)
// ─────────────────────────────────────────────

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

// 가사 후보 (비명체)
const LYRICS = ["AAAAAAH", "으아아악", "끄아아~", "아아아아", "으악", "끄앙", "아~", "으아~", "꺄아악", "흐어어", "오아아"];
function lyricFor(durSec, norm) {
  // 길이 → '아' 개수, 음량 → 받침(ㄱ/k) 강도
  // 예: 아아아아아아악 / aaaaaaaa k aaakaaaak
  const useRoman = Math.random() < 0.4; // 가끔 알파벳으로
  const aCount = Math.max(2, Math.round(durSec * 7) + Math.round(norm * 4));
  const a = useRoman ? "a" : "아";
  const kChar = useRoman ? "k" : "ㄱ";

  // 큰 소리일수록 받침이 더 자주/세게
  const kStrength = norm > 0.75 ? 3 : norm > 0.55 ? 2 : norm > 0.3 ? 1 : 0;

  let s;
  if (kStrength === 0) {
    // 약하면 그냥 아아아 (받침 없이, 가끔 ~)
    s = a.repeat(aCount);
    if (durSec > 0.8) s += useRoman ? "~" : "~";
  } else if (kStrength === 1) {
    // 끝에 받침
    s = a.repeat(aCount) + (useRoman ? "k" : "악");
  } else {
    // 세면: 중간중간 받침이 끼어들고 끝에도
    const parts = [];
    let remain = aCount;
    while (remain > 0) {
      const chunk = Math.min(remain, 2 + Math.floor(Math.random() * 4));
      parts.push(a.repeat(chunk));
      remain -= chunk;
      if (remain > 0 && Math.random() < 0.5) parts.push(kChar);
    }
    s = parts.join(useRoman ? " " : "");
    s += useRoman ? "k" : "악";
  }
  // 중간에 끊김(-) 가끔
  if (durSec > 1.0 && Math.random() < 0.5) {
    const mid = Math.floor(s.length / 2);
    s = s.slice(0, mid) + " - " + s.slice(mid);
  }
  return s;
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

// 음 길이(초) → 음표 종류(글리프, 박자수)
function noteGlyph(durSec) {
  if (durSec < 0.18) return { head: "♬", beats: 0.25 };
  if (durSec < 0.35) return { head: "♫", beats: 0.5 };
  if (durSec < 0.7) return { head: "♩", beats: 1 };
  if (durSec < 1.3) return { head: "♩", beats: 2, tie: true };
  return { head: "𝅗𝅥", beats: 4, tie: true };
}

// ── 재생 엔진 ──
class ScorePlayer {
  constructor() { this.ctx = null; this.master = null; this.timers = []; this.playing = false; }
  ensureCtx() {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain(); this.master.gain.value = 0.9; this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }
  stop() { this.timers.forEach((t) => clearTimeout(t)); this.timers = []; this.playing = false; }
  playNote(freq, start, dur, norm, voice, glide) {
    const ctx = this.ctx; const t = start; const vol = 0.1 + norm * 0.3;
    if (voice === "piano") {
      const partials = [1, 2, 3]; const gains = [1, 0.4, 0.18];
      const g = ctx.createGain(); g.connect(this.master);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.5);
      partials.forEach((p, i) => {
        const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = freq * p;
        const pg = ctx.createGain(); pg.gain.value = gains[i]; o.connect(pg); pg.connect(g);
        o.start(t); o.stop(t + dur * 1.6);
      });
    } else if (voice === "synth") {
      const g = ctx.createGain(); g.connect(this.master);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.008);
      g.gain.setValueAtTime(vol, t + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      [0, 8].forEach((det) => {
        const o = ctx.createOscillator(); o.type = "square"; o.frequency.value = freq; o.detune.value = det;
        o.connect(g); o.start(t); o.stop(t + dur + 0.02);
      });
    } else {
      const src = ctx.createOscillator(); src.type = "sawtooth"; src.frequency.value = freq;
      if (glide) src.frequency.linearRampToValueAtTime(freq * glide, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.04);
      g.gain.setValueAtTime(vol, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const f1 = ctx.createBiquadFilter(); f1.type = "bandpass"; f1.frequency.value = 800; f1.Q.value = 8;
      const f2 = ctx.createBiquadFilter(); f2.type = "bandpass"; f2.frequency.value = 1200; f2.Q.value = 10;
      const mix = ctx.createGain(); src.connect(f1); src.connect(f2); f1.connect(mix); f2.connect(mix);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.5;
      const lfoG = ctx.createGain(); lfoG.gain.value = freq * 0.012; lfo.connect(lfoG); lfoG.connect(src.frequency);
      mix.connect(g); g.connect(this.master);
      src.start(t); src.stop(t + dur + 0.05); lfo.start(t); lfo.stop(t + dur + 0.05);
    }
  }
  play(notes, voice, onStep, onEnd) {
    this.ensureCtx(); this.stop(); this.playing = true;
    const ctx = this.ctx;
    const baseStep = 0.16; // 음표 사이 기본 간격
    let cursor = ctx.currentTime + 0.05;
    let elapsedMs = 50;
    notes.forEach((n, i) => {
      const noteDur = Math.max(0.12, Math.min(0.9, n.dur));
      if (n.midi != null) {
        const glide = n.gliss ? (n.glissTo ? midiToFreq(n.glissTo) / midiToFreq(n.midi) : 1.5) : null;
        this.playNote(midiToFreq(n.midi), cursor, noteDur, n.norm, voice, glide);
      }
      const ms = elapsedMs;
      this.timers.push(setTimeout(() => { if (this.playing) onStep && onStep(i); }, ms));
      const advance = (n.midi != null ? noteDur : 0.12) + baseStep * 0.3;
      cursor += advance; elapsedMs += advance * 1000;
    });
    this.timers.push(setTimeout(() => { this.playing = false; onStep && onStep(-1); onEnd && onEnd(); }, elapsedMs + 150));
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

const LOW_MIDI = 55, HIGH_MIDI = 81; // 표시 범위

// midi → 오선 위 y (staff 좌표). 높을수록 위.
function staffY(midi, top, staffH) {
  const c = Math.max(LOW_MIDI - 5, Math.min(HIGH_MIDI + 5, midi));
  const r = (c - LOW_MIDI) / (HIGH_MIDI - LOW_MIDI);
  return top + staffH - r * staffH;
}

export default function App() {
  const [phase, setPhase] = useState("idle");
  const [notes, setNotes] = useState([]);   // 묶인 음표들
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState(null);
  const [diag, setDiag] = useState(null);
  const [saving, setSaving] = useState(false);
  const [voice, setVoice] = useState("piano");
  const [playing, setPlaying] = useState(false);
  const [playIdx, setPlayIdx] = useState(-1);

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const timeBufRef = useRef(null);
  const playerRef = useRef(null);

  const startRef = useRef(0);
  const notesRef = useRef([]);
  const curNoteRef = useRef(null);   // 현재 진행 중인(이어지는) 음표
  const lastMidiRef = useRef(null);
  const lastVoiceTimeRef = useRef(0); // 마지막으로 소리난 시각

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
    if (freq > 0 && norm > 0.09) {
      midi = freqToMidi(freq);
      const prev = lastMidiRef.current;
      if (prev != null) { while (midi - prev > 8) midi -= 12; while (prev - midi > 8) midi += 12; }
      lastMidiRef.current = midi;
    }

    const now = performance.now();
    setElapsed((now - startRef.current) / 1000);
    const VOICING = norm > 0.1 && midi != null;

    if (VOICING) {
      lastVoiceTimeRef.current = now;
      const cur = curNoteRef.current;
      if (cur && Math.abs((cur.lastMidi ?? midi) - midi) <= 2) {
        // 같은 음 계속 → 길이 늘리고, 음정 살짝 변하면 gliss 표시
        cur.dur = (now - cur.startMs) / 1000;
        cur.norm = Math.max(cur.norm, norm);
        cur.peakMidi = norm > cur.peakNorm ? midi : cur.peakMidi;
        if (norm > cur.peakNorm) cur.peakNorm = norm;
        if (Math.abs(midi - cur.midi) >= 2) { cur.gliss = true; cur.glissTo = midi; }
        cur.lastMidi = midi;
        commitCurrent(false);
      } else {
        // 새 음표 시작 (이전 건 확정)
        finalizeCurrent();
        curNoteRef.current = {
          midi, lastMidi: midi, peakMidi: midi, norm, peakNorm: norm,
          startMs: now, dur: 0.12, gliss: false, glissTo: null, lyric: null,
        };
        commitCurrent(true);
      }
    } else {
      // 무음: 일정 시간 지나면 현재 음표 확정 (쉼표 구간)
      if (now - lastVoiceTimeRef.current > 160) finalizeCurrent();
    }
    rafRef.current = requestAnimationFrame(tick);

    function commitCurrent(isNew) {
      // 진행 중 음표를 화면에 반영 (마지막 항목 교체/추가)
      const arr = notesRef.current;
      const draft = { ...curNoteRef.current, live: true };
      if (isNew || arr.length === 0 || !arr[arr.length - 1].live) {
        notesRef.current = [...arr, draft];
      } else {
        notesRef.current = [...arr.slice(0, -1), draft];
      }
      setNotes(notesRef.current);
    }
    function finalizeCurrent() {
      const cur = curNoteRef.current; if (!cur) return;
      const dur = Math.max(0.12, cur.dur);
      const fin = {
        midi: cur.peakMidi ?? cur.midi, norm: cur.peakNorm, dur,
        gliss: cur.gliss, glissTo: cur.glissTo,
        dyn: dynamicFor(cur.peakNorm),
        lyric: lyricFor(dur, cur.peakNorm),
        live: false,
      };
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
    // 진행 중 음표 마무리
    const cur = curNoteRef.current;
    if (cur) {
      const dur = Math.max(0.12, cur.dur);
      const fin = { midi: cur.peakMidi ?? cur.midi, norm: cur.peakNorm, dur, gliss: cur.gliss, glissTo: cur.glissTo, dyn: dynamicFor(cur.peakNorm), lyric: lyricFor(dur, cur.peakNorm), live: false };
      const arr = notesRef.current;
      if (arr.length && arr[arr.length - 1].live) notesRef.current = [...arr.slice(0, -1), fin];
      else notesRef.current = [...arr, fin];
      curNoteRef.current = null;
    } else {
      notesRef.current = notesRef.current.map((n) => ({ ...n, live: false }));
    }
    setNotes(notesRef.current);
    const dur = (performance.now() - startRef.current) / 1000;
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
      drawStaffOnly({ notes: notesRef.current, onBlob: (blob) => {
        const url = URL.createObjectURL(blob); const a = document.createElement("a");
        const d = result.ts; a.href = url;
        a.download = `aakbo-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}.png`;
        a.click(); URL.revokeObjectURL(url); setSaving(false);
      }});
    } catch (e) { setSaving(false); alert("이미지 저장에 실패했어요."); }
  }, [result]);

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
        {phase === "done" && result && <DoneView notes={notes} r={result} onReset={reset} onSave={saveImage} onCopy={copyLink} saving={saving} voice={voice} onVoice={changeVoice} playing={playing} playIdx={playIdx} onTogglePlay={togglePlay} />}
      </div>
      <p style={S.privacy}>🔒 소리는 녹음되지 않아요. 음정·음량만 분석하고 바로 사라집니다.</p>
    </div>
  );
}

const pad = (n) => String(n).padStart(2, "0");

// ── 악보 SVG: 진짜 같은데 이상한 ──
// 음표 = 머리(음높이 위치) + 기둥 + 가사 + 셈여림 + gliss
function ScoreSvg({ notes, W, playIdx = -1 }) {
  const padX = 16, topPad = 14;
  const staffH = 48, gap = staffH / 4;
  const blockH = staffH + 56; // 위 셈여림 + 아래 가사 공간
  // 음표 폭: 길이에 비례
  const layout = [];
  let x = padX + 20, line = 0;
  const lineMaxX = W - padX - 10;
  notes.forEach((n, i) => {
    const w = 14 + Math.min(70, n.dur * 46); // 길수록 넓게
    if (x + w > lineMaxX) { line++; x = padX + 20; }
    layout.push({ n, i, x, w, line });
    x += w + 5;
  });
  const totalLines = Math.max(3, (layout.length ? layout[layout.length - 1].line + 1 : 1));
  const H = topPad + totalLines * blockH + 8;

  const staffGroups = [];
  for (let li = 0; li < totalLines; li++) {
    const top = topPad + li * blockH + 26;
    staffGroups.push(
      <g key={`st${li}`}>
        {[0,1,2,3,4].map((k) => <line key={k} x1={padX} y1={top + k*gap} x2={W - padX} y2={top + k*gap} stroke="#1a1a1a" strokeWidth="0.7" />)}
        <text x={padX - 2} y={top + staffH*0.66} fontSize={gap*2.7} fill="#1a1a1a" style={{fontFamily:"serif"}}>𝄞</text>
      </g>
    );
  }

  const noteEls = layout.map(({ n, i, x, w, line }) => {
    const top = topPad + line * blockH + 26;
    const isPlay = i === playIdx;
    const col = isPlay ? "#e0245e" : "#111";
    const y = staffY(n.midi, top, staffH);
    const isLong = n.dur >= 0.7;
    const headRx = 5.2, headRy = 3.8;
    const els = [];

    // 음표 머리 (긴 음은 빈 머리). 클래식 악보처럼 살짝만 기울임
    els.push(
      <ellipse key={`h${i}`} cx={x} cy={y} rx={headRx} ry={headRy} transform={`rotate(-12 ${x} ${y})`}
        fill={isLong ? "#fffdf7" : col} stroke={col} strokeWidth={isLong ? 1.5 : 0} />
    );
    // 기둥
    els.push(<line key={`stem${i}`} x1={x + headRx - 0.5} y1={y} x2={x + headRx - 0.5} y2={y - 25} stroke={col} strokeWidth="1.2" />);
    // 길면 음표를 길게 끄는 타이(이음줄)
    if (isLong) {
      els.push(<path key={`tiec${i}`} d={`M ${x+3} ${y+5} Q ${x + w/2} ${y+13} ${x + w - 4} ${y+5}`} fill="none" stroke={col} strokeWidth="1" opacity="0.6" />);
    }
    // 짧으면 깃발 (단정하게)
    if (n.dur < 0.18) els.push(<path key={`fl${i}`} d={`M ${x+headRx-0.5} ${y-25} q 6 3 5 11`} fill="none" stroke={col} strokeWidth="1.2" />);
    // gliss 사선 + 글자
    if (n.gliss && n.glissTo != null) {
      const y2 = staffY(n.glissTo, top, staffH);
      els.push(<line key={`gl${i}`} x1={x + 4} y1={y} x2={x + w} y2={y2} stroke={col} strokeWidth="0.9" strokeDasharray="2 2" />);
      els.push(<text key={`glt${i}`} x={x + w/2} y={(y + y2)/2 - 4} fontSize="7" fill={col} fontStyle="italic" textAnchor="middle">gliss.</text>);
    }
    // 셈여림 (오선 아래쪽, 음표 밑)
    els.push(<text key={`dyn${i}`} x={x} y={top + staffH + 13} fontSize="11" fill={col} fontStyle="italic" fontWeight="700" textAnchor="middle" style={{fontFamily:"serif"}}>{n.dyn}</text>);
    // 가사 (그 아래) — 길어질 수 있으니 작게
    els.push(<text key={`ly${i}`} x={x} y={top + staffH + 27} fontSize="7.5" fill="#222" textAnchor="middle">{n.lyric}</text>);

    return <g key={`n${i}`}>{els}</g>;
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      <rect x="0" y="0" width={W} height={H} fill="#fffdf7" />
      {staffGroups}
      {noteEls}
    </svg>
  );
}

// 저장용 캔버스 (동일 레이아웃)
function drawStaffOnly({ notes, onBlob }) {
  const W = 860, dpr = 2, padX = 40, topPad = 24;
  const staffH = 60, gap = staffH / 4, blockH = staffH + 64;
  const layout = []; let x = padX + 26, line = 0; const lineMaxX = W - padX - 16;
  notes.forEach((n, i) => {
    const w = 18 + Math.min(90, n.dur * 58);
    if (x + w > lineMaxX) { line++; x = padX + 26; }
    layout.push({ n, i, x, w, line }); x += w + 7;
  });
  const totalLines = Math.max(3, (layout.length ? layout[layout.length - 1].line + 1 : 1));
  const H = topPad + totalLines * blockH + 16;

  const canvas = document.createElement("canvas");
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fffdf7"; ctx.fillRect(0, 0, W, H);

  for (let li = 0; li < totalLines; li++) {
    const top = topPad + li * blockH + 30;
    ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 0.8;
    for (let k = 0; k < 5; k++) { ctx.beginPath(); ctx.moveTo(padX, top + k*gap); ctx.lineTo(W - padX, top + k*gap); ctx.stroke(); }
    ctx.fillStyle = "#1a1a1a"; ctx.font = `${gap*2.7}px serif`; ctx.textAlign = "left";
    ctx.fillText("\u{1D11E}", padX - 4, top + staffH*0.7);
  }

  layout.forEach(({ n, x, w, line }) => {
    const top = topPad + line * blockH + 30;
    const y = staffYC(n.midi, top, staffH);
    const isLong = n.dur >= 0.7;
    const headRx = 6.5, headRy = 4.8;
    ctx.save(); ctx.translate(x, y); ctx.rotate(-12 * Math.PI/180);
    ctx.beginPath(); ctx.ellipse(0, 0, headRx, headRy, 0, 0, Math.PI*2);
    if (isLong) { ctx.fillStyle = "#fffdf7"; ctx.fill(); ctx.strokeStyle = "#111"; ctx.lineWidth = 1.8; ctx.stroke(); }
    else { ctx.fillStyle = "#111"; ctx.fill(); }
    ctx.restore();
    ctx.strokeStyle = "#111"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(x + headRx, y); ctx.lineTo(x + headRx, y - 30); ctx.stroke();
    if (isLong) {
      ctx.strokeStyle = "rgba(17,17,17,0.5)"; ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(x + 2, y + 8); ctx.quadraticCurveTo(x + w/2, y + 18, x + w - 4, y + 8); ctx.stroke();
    }
    if (n.dur < 0.18) { ctx.strokeStyle = "#111"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x+headRx, y-30); ctx.quadraticCurveTo(x+headRx+8, y-26, x+headRx+5, y-16); ctx.stroke(); }
    if (n.gliss && n.glissTo != null) {
      const y2 = staffYC(n.glissTo, top, staffH);
      ctx.strokeStyle = "#111"; ctx.lineWidth = 0.9; ctx.setLineDash([2,2]);
      ctx.beginPath(); ctx.moveTo(x + 5, y); ctx.lineTo(x + w, y2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#111"; ctx.font = "italic 9px serif"; ctx.textAlign = "center";
      ctx.fillText("gliss.", x + w/2, (y + y2)/2 - 5);
    }
    ctx.fillStyle = "#111"; ctx.font = "italic 700 13px serif"; ctx.textAlign = "center";
    ctx.fillText(n.dyn, x, top + staffH + 16);
    ctx.fillStyle = "#222"; ctx.font = "10px 'Courier New', monospace";
    ctx.fillText(n.lyric, x, top + staffH + 32);
  });
  canvas.toBlob((blob) => onBlob(blob), "image/png");
}
function staffYC(midi, top, staffH) {
  const c = Math.max(LOW_MIDI - 5, Math.min(HIGH_MIDI + 5, midi));
  const r = (c - LOW_MIDI) / (HIGH_MIDI - LOW_MIDI);
  return top + staffH - r * staffH;
}

function IdleView({ onStart, inIframe }) {
  return (
    <div style={S.card}>
      <p style={S.brand}>SCREAM SCORE · aakbo</p>
      <h1 style={S.title}>악!보</h1>
      <p style={S.subname}>aakbo</p>
      <p style={S.desc}>빈 악보가 너를 기다린다.<br />길게 지를수록 음표가 길어지고,<br />크게 지를수록 f, ff, fff…가 붙는다.</p>
      {inIframe && (<div style={S.iframeNote}>⚠️ 미리보기(iframe)에선 마이크가 막혀요.<br /><b>새 창(↗) 또는 배포 주소</b>에서 열어주세요.</div>)}
      <button style={S.btnMain} onClick={onStart}>🎤 채보 시작</button>
    </div>
  );
}

function RecordView({ notes, level, elapsed, onStop }) {
  return (
    <div style={S.card}>
      <p style={S.recLabel}>● 기록 중  {elapsed.toFixed(1)}s</p>
      <div style={S.staffWrapLive}><ScoreSvg notes={notes} W={340} /></div>
      <div style={S.meterMini}><div style={{ ...S.meterFill, width: `${level * 100}%` }} /></div>
      <button style={S.btnStop} onClick={onStop}>■ 채보 끝내기</button>
    </div>
  );
}

function DoneView({ notes, r, onReset, onSave, onCopy, saving, voice, onVoice, playing, playIdx, onTogglePlay }) {
  return (
    <>
      <div style={S.card} className="pop">
        <p style={S.brand}>악!보 — No.{r.no}</p>
        <p style={S.doneTitle}>악!보 <span style={{fontSize:14,fontStyle:"normal",letterSpacing:1,color:"#9a9484"}}>aakbo</span></p>
        <div style={{ ...S.staffWrap, maxHeight: 420, overflowY: "auto" }}><ScoreSvg notes={notes} W={340} playIdx={playIdx} /></div>
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
        <button style={S.btnMain} onClick={onSave} disabled={saving}>{saving ? "저장 중…" : "🎼 오선지 이미지 저장"}</button>
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
  page: { minHeight: "100vh", background: "#e8e3d6", backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.015) 0 1px, transparent 1px 26px)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 16px", fontFamily: MONO },
  frame: { width: "100%", maxWidth: 360 },
  card: { background: "#fffdf7", padding: "28px 22px", boxShadow: "0 12px 40px rgba(0,0,0,0.22)", border: "1px solid #ddd6c4" },
  center: { background: "#fffdf7", padding: "48px 24px", textAlign: "center", boxShadow: "0 12px 40px rgba(0,0,0,0.22)" },
  armText: { fontSize: 16, color: "#111", letterSpacing: 1, textAlign: "center" },
  brand: { textAlign: "center", fontSize: 10, letterSpacing: 4, color: "#9a9484", marginBottom: 14 },
  title: { textAlign: "center", fontSize: 44, fontWeight: 800, letterSpacing: 2, color: "#1a1a1a", margin: "0 0 2px" },
  subname: { textAlign: "center", fontSize: 13, letterSpacing: 4, color: "#9a9484", marginBottom: 18, textTransform: "uppercase" },
  desc: { textAlign: "center", fontSize: 12.5, lineHeight: 1.9, color: "#555", marginBottom: 26 },
  iframeNote: { border: "1.5px dashed #111", padding: "12px 14px", fontSize: 11.5, lineHeight: 1.7, color: "#333", marginBottom: 20, textAlign: "left" },
  recLabel: { textAlign: "center", fontSize: 12, letterSpacing: 1, color: "#d11", fontWeight: 700, marginBottom: 12 },
  staffWrapLive: { background: "#fffdf7", border: "1px solid #eee5cf", marginBottom: 14, maxHeight: 360, overflowY: "auto" },
  staffWrap: { background: "#fffdf7", border: "1px solid #eee5cf", marginBottom: 4 },
  meterMini: { height: 6, background: "#e5e0d2", borderRadius: 3, overflow: "hidden", marginBottom: 14 },
  meterFill: { height: "100%", background: "#111", transition: "width 60ms linear" },
  doneTitle: { textAlign: "center", fontSize: 30, fontWeight: 800, fontStyle: "italic", color: "#111", letterSpacing: 2, marginBottom: 16 },
  playerBox: { marginTop: 14 },
  voiceRow: { display: "flex", gap: 6, marginBottom: 10 },
  voiceOn: { flex: 1, padding: "10px 4px", background: "#111", color: "#fff", border: "1.5px solid #111", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: MONO },
  voiceOff: { flex: 1, padding: "10px 4px", background: "#fffdf7", color: "#111", border: "1.5px solid #ccc", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: MONO },
  btnPlay: { width: "100%", padding: "14px", background: "#e0245e", color: "#fff", border: "none", fontSize: 15, fontWeight: 700, letterSpacing: 1, cursor: "pointer", fontFamily: MONO },
  actions: { marginTop: 18 },
  actionRow: { display: "flex", gap: 10, marginTop: 10 },
  btnMain: { width: "100%", padding: "16px", background: "#111", color: "#fff", border: "none", fontSize: 15, fontWeight: 700, letterSpacing: 1, cursor: "pointer", fontFamily: MONO },
  btnHalf: { flex: 1, padding: "14px", background: "#fffdf7", color: "#111", border: "1.5px solid #111", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: MONO },
  btnStop: { width: "100%", padding: "16px", background: "#111", color: "#fff", border: "none", fontSize: 15, fontWeight: 700, letterSpacing: 2, cursor: "pointer", fontFamily: MONO },
  deniedHead: { fontSize: 18, fontWeight: 800, color: "#111", letterSpacing: 1, marginBottom: 18, textAlign: "center" },
  steps: { textAlign: "left", margin: "0 0 24px", paddingLeft: 18 },
  stepItem: { fontSize: 12.5, color: "#444", lineHeight: 1.7, marginBottom: 8 },
  diagBox: { marginTop: 22, padding: "12px 14px", background: "#f0ece0", textAlign: "left" },
  diagTitle: { fontSize: 10, letterSpacing: 2, color: "#999", marginBottom: 8 },
  diagLine: { fontSize: 11, color: "#666", lineHeight: 1.6 },
  privacy: { marginTop: 24, fontSize: 11, color: "#857f6f", textAlign: "center", letterSpacing: 0.5 },
};
const CSS = `
  * { box-sizing: border-box; margin: 0; }
  button:active { transform: translateY(1px); }
  button:disabled { opacity: 0.5; cursor: default; }
  .pop { animation: pop 0.4s cubic-bezier(0.16,1,0.3,1); }
  @keyframes pop { 0% { opacity: 0; transform: translateY(-12px) scale(0.97); } 100% { opacity: 1; transform: translateY(0) scale(1); } }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-thumb { background: #ccc; }
`;
