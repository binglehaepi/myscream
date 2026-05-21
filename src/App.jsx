import React, { useState, useRef, useEffect, useCallback } from "react";

// ─────────────────────────────────────────────
// MYSCREAM — 비명으로 직접 채우는 그래픽 악보
// 미리 깔린 긴 오선지 위에, 지르든 안 지르든 계속 기록된다.
// 음정 → 선의 높이, 음량 → 잉크의 굵기/뭉침.
// 정적은 가는 선과 쉼표로, 비명은 휘갈긴 잉크 덩어리로.
// 음악 기호(다이내믹/페르마타 등)가 흩뿌려진다.
// 모든 처리는 브라우저 안에서 (녹음 X, 서버 X)
// ─────────────────────────────────────────────

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

const SYMBOLS = ["𝆑", "𝆏", "fff", "ppp", "𝄐", "ƒ", "𝆪", "𝆫", "≈", "~", "𝄢", "sƒz", "pp", "ff", "𝆒𝆓"];

// ── 재생 엔진 ──
class ScorePlayer {
  constructor() { this.ctx = null; this.master = null; this.timers = []; this.playing = false; }
  ensureCtx() {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }
  stop() { this.timers.forEach((t) => clearTimeout(t)); this.timers = []; this.playing = false; }
  playNote(freq, start, dur, norm, voice) {
    const ctx = this.ctx;
    const t = start;
    const vol = 0.1 + norm * 0.28;
    if (voice === "piano") {
      const partials = [1, 2, 3]; const gains = [1, 0.4, 0.18];
      const g = ctx.createGain(); g.connect(this.master);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.6);
      partials.forEach((p, i) => {
        const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = freq * p;
        const pg = ctx.createGain(); pg.gain.value = gains[i];
        o.connect(pg); pg.connect(g); o.start(t); o.stop(t + dur * 1.7);
      });
    } else if (voice === "synth") {
      const g = ctx.createGain(); g.connect(this.master);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.008);
      g.gain.setValueAtTime(vol, t + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      [0, 8].forEach((det) => {
        const o = ctx.createOscillator(); o.type = "square"; o.frequency.value = freq; o.detune.value = det;
        o.connect(g); o.start(t); o.stop(t + dur + 0.02);
      });
    } else {
      const src = ctx.createOscillator(); src.type = "sawtooth"; src.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.04);
      g.gain.setValueAtTime(vol, t + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const f1 = ctx.createBiquadFilter(); f1.type = "bandpass"; f1.frequency.value = 800; f1.Q.value = 8;
      const f2 = ctx.createBiquadFilter(); f2.type = "bandpass"; f2.frequency.value = 1200; f2.Q.value = 10;
      const mix = ctx.createGain();
      src.connect(f1); src.connect(f2); f1.connect(mix); f2.connect(mix);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.5;
      const lfoG = ctx.createGain(); lfoG.gain.value = freq * 0.01;
      lfo.connect(lfoG); lfoG.connect(src.frequency);
      mix.connect(g); g.connect(this.master);
      src.start(t); src.stop(t + dur + 0.05); lfo.start(t); lfo.stop(t + dur + 0.05);
    }
  }
  play(notes, voice, onStep, onEnd) {
    this.ensureCtx(); this.stop(); this.playing = true;
    const ctx = this.ctx;
    const step = 0.12;   // 더 빠른 재생
    const noteDur = 0.2;
    let scheduled = 0;
    notes.forEach((n, i) => {
      const at = ctx.currentTime + 0.05 + i * step;
      if (n.midi != null) this.playNote(midiToFreq(n.midi), at, noteDur, n.norm, voice);
      const ms = (0.05 + i * step) * 1000;
      this.timers.push(setTimeout(() => { if (this.playing) onStep && onStep(i); }, ms));
      scheduled = ms;
    });
    this.timers.push(setTimeout(() => {
      this.playing = false; onStep && onStep(-1); onEnd && onEnd();
    }, scheduled + step * 1000 + 150));
  }
}

function detectPitch(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.008) return -1;
  let r1 = 0, r2 = SIZE - 1; const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++) if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  const b = buf.slice(r1, r2); const n = b.length;
  const c = new Array(n).fill(0);
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

const LOW_MIDI = 52, HIGH_MIDI = 84;

// 음높이(midi)를 0~1로 (1=높음). 무음이면 null
function pitchRatio(midi) {
  if (midi == null) return null;
  const c = Math.max(LOW_MIDI - 4, Math.min(HIGH_MIDI + 4, midi));
  return (c - LOW_MIDI) / (HIGH_MIDI - LOW_MIDI);
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

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const timeBufRef = useRef(null);
  const playerRef = useRef(null);

  const peakRef = useRef(0);
  const startRef = useRef(0);
  const lastNoteRef = useRef(0);
  const notesRef = useRef([]);
  const lastMidiRef = useRef(null);

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
    const analyser = analyserRef.current;
    if (!analyser) return;
    const ctx = audioCtxRef.current;
    analyser.getFloatTimeDomainData(timeBufRef.current);

    let sum = 0;
    for (let i = 0; i < timeBufRef.current.length; i++) sum += timeBufRef.current[i] * timeBufRef.current[i];
    const rms = Math.sqrt(sum / timeBufRef.current.length);
    const norm = Math.min(1, rms * 3.5);
    setLevel(norm);
    peakRef.current = Math.max(peakRef.current, norm);

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

    // 100ms마다 무조건 기록. 지르지 않아도 점(무음)이 찍힌다.
    if (now - lastNoteRef.current > 100) {
      lastNoteRef.current = now;
      // 음악 기호 랜덤 흩뿌리기: 큰 소리거나 가끔
      let sym = null;
      if (norm > 0.45 && Math.random() < 0.25) sym = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
      else if (Math.random() < 0.04) sym = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
      notesRef.current = [...notesRef.current, { midi, norm, sym, t: (now - startRef.current) / 1000 }];
      setNotes(notesRef.current);
    }
    rafRef.current = requestAnimationFrame(tick);
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
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;
      timeBufRef.current = new Float32Array(analyser.fftSize);
      peakRef.current = 0; startRef.current = performance.now();
      lastNoteRef.current = 0; lastMidiRef.current = null;
      notesRef.current = []; setNotes([]); setElapsed(0);
      setPhase("recording");
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      setDiag({ errName: e && e.name ? e.name : "UnknownError" });
      setPhase("denied");
    }
  }, [tick, hasMic]);

  const stop = useCallback(() => {
    const dur = (performance.now() - startRef.current) / 1000;
    const pitched = notesRef.current.filter((n) => n.midi != null);
    const midis = pitched.map((n) => n.midi);
    const highest = midis.length ? Math.max(...midis) : null;
    const lowest = midis.length ? Math.min(...midis) : null;
    setResult({
      dur, count: notesRef.current.length, pitchedCount: pitched.length,
      highest, lowest,
      ts: new Date(), no: Math.floor(Math.random() * 9000) + 1000,
    });
    setPhase("done");
    cleanup();
  }, [cleanup]);

  const reset = useCallback(() => {
    if (playerRef.current) playerRef.current.stop();
    setPlaying(false); setPlayIdx(-1);
    notesRef.current = []; setNotes([]); setLevel(0); setElapsed(0); setResult(null); setPhase("idle");
  }, []);

  const saveImage = useCallback(() => {
    if (!result) return;
    setSaving(true);
    try {
      drawStaffOnly({ notes: notesRef.current, onBlob: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const d = result.ts;
        a.href = url;
        a.download = `myscream-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}.png`;
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
    if (playerRef.current) playerRef.current.stop();
    setPlaying(false); setPlayIdx(-1); setVoice(v);
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

// ── 그래픽 스코어 SVG 생성 (라이브 + 결과 공용) ──
// 미리 깔린 오선지 위에, 음표들을 "선으로 잇고" 잉크 덩어리로 표현
function ScoreSvg({ notes, W, lineH, padX, playIdx = -1, follow = false }) {
  const staffH = 56;           // 한 단 오선지 높이
  const gap = lineH / 4;       // 오선 간격
  const noteSpacing = 7;
  const topPad = 18;
  const blockH = staffH + 34;
  const perLine = Math.max(8, Math.floor((W - padX * 2 - 14) / noteSpacing));
  // 최소 단 수: 미리 오선지가 깔려있는 느낌 위해 항상 여러 단 확보
  const usedLines = Math.ceil(Math.max(notes.length, 1) / perLine);
  const minLines = follow ? Math.max(usedLines, 4) : Math.max(usedLines, 3);
  const totalLines = minLines;
  const H = topPad + totalLines * blockH + 10;

  // 음표를 단별로 분할, 각 단에서 선 path 생성
  const lineEls = [];
  for (let li = 0; li < totalLines; li++) {
    const top = topPad + li * blockH + 8;
    // 오선 5줄 (미리 깔린 빈 보표)
    const staffLines = [0,1,2,3,4].map((i) => (
      <line key={`s${li}-${i}`} x1={padX} y1={top + i*gap} x2={W - padX} y2={top + i*gap} stroke="#1a1a1a" strokeWidth="0.7" />
    ));
    // 음자리표 자리 세로선
    const clef = <text key={`c${li}`} x={padX - 2} y={top + staffH*0.62} fontSize={gap*2.6} fill="#1a1a1a" style={{fontFamily:"serif"}}>𝄞</text>;

    const slice = notes.slice(li * perLine, (li + 1) * perLine);
    // 선 잇기: 음정 있는 구간을 path로
    let pathD = "";
    const blobs = [];
    const syms = [];
    slice.forEach((n, i) => {
      const x = padX + 16 + i * noteSpacing;
      const r = pitchRatio(n.midi);
      const globalIdx = li * perLine + i;
      const isPlay = globalIdx === playIdx;
      if (r == null) {
        // 무음: 중앙 근처에서 살짝 흔들리는 가는 선
        const y = top + staffH/2 + Math.sin(i*0.9) * 3;
        pathD += (pathD ? " L" : "M") + ` ${x} ${y}`;
      } else {
        const y = top + staffH - r * staffH;
        pathD += (pathD ? " L" : "M") + ` ${x} ${y}`;
        // 음량 크면 잉크 덩어리(휘갈김)
        if (n.norm > 0.3) {
          const sz = 1.5 + n.norm * 7;
          blobs.push(
            <ellipse key={`b${li}-${i}`} cx={x} cy={y} rx={sz*1.3} ry={sz}
              fill={isPlay ? "#e0245e" : "#111"} transform={`rotate(${-30 + Math.sin(i)*40} ${x} ${y})`}
              opacity={0.9} />
          );
          // 위로 뻗는 거친 stem
          if (n.norm > 0.5) {
            blobs.push(<line key={`st${li}-${i}`} x1={x} y1={y} x2={x + (Math.random()*4-2)} y2={y - 14 - n.norm*16} stroke={isPlay ? "#e0245e" : "#111"} strokeWidth={0.8 + n.norm} />);
          }
        } else {
          // 작은 소리: 작은 점
          blobs.push(<circle key={`d${li}-${i}`} cx={x} cy={y} r={1 + n.norm*2.5} fill={isPlay ? "#e0245e" : "#222"} />);
        }
      }
      // 음악 기호 흩뿌리기
      if (n.sym) {
        const sy = top - 2 + Math.random() * (staffH + 10);
        syms.push(<text key={`y${li}-${i}`} x={x} y={sy} fontSize={9 + (n.norm)*7} fill="#111" style={{fontFamily:"serif", fontStyle:"italic"}} opacity={0.85}>{n.sym}</text>);
      }
    });

    lineEls.push(
      <g key={`g${li}`}>
        {staffLines}
        {clef}
        {pathD && <path d={pathD} fill="none" stroke="#111" strokeWidth="1.1" strokeLinejoin="round" opacity={0.85} />}
        {blobs}
        {syms}
      </g>
    );
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      <rect x="0" y="0" width={W} height={H} fill="#fffdf7" />
      {lineEls}
    </svg>
  );
}

// 저장용 캔버스 — 오선지 + 그래픽 음표만 (정보 없이)
function drawStaffOnly({ notes, onBlob }) {
  const W = 820, padX = 44, dpr = 2;
  const staffH = 70, gap = staffH / 4, noteSpacing = 9, topPad = 30, blockH = staffH + 44;
  const perLine = Math.max(8, Math.floor((W - padX * 2 - 16) / noteSpacing));
  const usedLines = Math.ceil(Math.max(notes.length, 1) / perLine);
  const totalLines = Math.max(usedLines, 4);
  const H = topPad + totalLines * blockH + 20;

  const canvas = document.createElement("canvas");
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fffdf7"; ctx.fillRect(0, 0, W, H);

  for (let li = 0; li < totalLines; li++) {
    const top = topPad + li * blockH + 10;
    ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 0.8;
    for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.moveTo(padX, top + i*gap); ctx.lineTo(W - padX, top + i*gap); ctx.stroke(); }
    ctx.fillStyle = "#1a1a1a"; ctx.font = `${gap*2.6}px serif`; ctx.textAlign = "left";
    ctx.fillText("\u{1D11E}", padX - 4, top + staffH*0.66);

    const slice = notes.slice(li * perLine, (li + 1) * perLine);
    // 선 잇기
    ctx.beginPath(); let started = false;
    slice.forEach((n, i) => {
      const x = padX + 18 + i * noteSpacing;
      const r = pitchRatio(n.midi);
      const y = r == null ? top + staffH/2 + Math.sin(i*0.9)*4 : top + staffH - r * staffH;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "rgba(17,17,17,0.85)"; ctx.lineWidth = 1.2; ctx.stroke();

    // 잉크 덩어리 + 기호
    slice.forEach((n, i) => {
      const x = padX + 18 + i * noteSpacing;
      const r = pitchRatio(n.midi);
      if (r != null) {
        const y = top + staffH - r * staffH;
        if (n.norm > 0.3) {
          const sz = 2 + n.norm * 8;
          ctx.fillStyle = "#111"; ctx.save(); ctx.translate(x, y);
          ctx.rotate((-30 + Math.sin(i)*40) * Math.PI/180);
          ctx.beginPath(); ctx.ellipse(0, 0, sz*1.3, sz, 0, 0, Math.PI*2); ctx.fill(); ctx.restore();
          if (n.norm > 0.5) {
            ctx.strokeStyle = "#111"; ctx.lineWidth = 0.8 + n.norm;
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (Math.random()*4-2), y - 16 - n.norm*18); ctx.stroke();
          }
        } else {
          ctx.fillStyle = "#222"; ctx.beginPath(); ctx.arc(x, y, 1.2 + n.norm*3, 0, Math.PI*2); ctx.fill();
        }
      }
      if (n.sym) {
        const sy = top - 2 + Math.random() * (staffH + 12);
        ctx.fillStyle = "#111"; ctx.font = `italic ${10 + n.norm*8}px serif`; ctx.textAlign = "center";
        ctx.fillText(n.sym, x, sy);
      }
    });
  }
  canvas.toBlob((blob) => onBlob(blob), "image/png");
}

function IdleView({ onStart, inIframe }) {
  return (
    <div style={S.card}>
      <p style={S.brand}>GRAPHIC SCORE</p>
      <h1 style={S.title}>MYSCREAM</h1>
      <p style={S.desc}>빈 악보가 너를 기다린다.<br />지르든, 침묵하든 — 전부 기록된다.<br />너의 비명으로 악보를 채워라.</p>
      {inIframe && (
        <div style={S.iframeNote}>⚠️ 미리보기(iframe)에선 마이크가 막혀요.<br /><b>새 창(↗) 또는 배포 주소</b>에서 열어주세요.</div>
      )}
      <button style={S.btnMain} onClick={onStart}>🎤 채보 시작</button>
    </div>
  );
}

function RecordView({ notes, level, elapsed, onStop }) {
  return (
    <div style={S.card}>
      <p style={S.recLabel}>● 기록 중  {elapsed.toFixed(1)}s</p>
      <div style={S.staffWrapLive}>
        <ScoreSvg notes={notes} W={330} lineH={56} padX={14} follow />
      </div>
      <div style={S.meterMini}><div style={{ ...S.meterFill, width: `${level * 100}%` }} /></div>
      <button style={S.btnStop} onClick={onStop}>■ 채보 끝내기</button>
    </div>
  );
}

function DoneView({ notes, r, onReset, onSave, onCopy, saving, voice, onVoice, playing, playIdx, onTogglePlay }) {
  return (
    <>
      <div style={S.card} className="pop">
        <p style={S.brand}>GRAPHIC SCORE — No.{r.no}</p>
        <p style={S.doneTitle}>MYSCREAM</p>
        <div style={{ ...S.staffWrap, maxHeight: 420, overflowY: "auto" }}>
          <ScoreSvg notes={notes} W={330} lineH={56} padX={14} playIdx={playIdx} />
        </div>

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
  if (inIframe || name === "NoMediaDevices" || !hasMic) {
    headline = "여기선 마이크가 막혀요";
    steps = ["미리보기(iframe) 안이라 마이크를 못 씁니다.", "배포 주소(https) 또는 새 창(↗)에서 열어주세요."];
  } else if (name === "NotAllowedError" || name === "SecurityError") {
    headline = "마이크 권한이 차단됐어요";
    steps = ["주소창 자물쇠/마이크 아이콘 → 허용 → 새로고침."];
  } else if (name === "NotFoundError") { headline = "마이크 장치를 못 찾았어요"; steps = ["마이크 연결을 확인해주세요."]; }
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
  title: { textAlign: "center", fontSize: 40, fontWeight: 800, letterSpacing: 3, color: "#1a1a1a", margin: "0 0 18px", fontStyle: "italic" },
  desc: { textAlign: "center", fontSize: 12.5, lineHeight: 1.9, color: "#555", marginBottom: 26 },
  iframeNote: { border: "1.5px dashed #111", padding: "12px 14px", fontSize: 11.5, lineHeight: 1.7, color: "#333", marginBottom: 20, textAlign: "left" },

  recLabel: { textAlign: "center", fontSize: 12, letterSpacing: 1, color: "#d11", fontWeight: 700, marginBottom: 12 },
  staffWrapLive: { background: "#fffdf7", border: "1px solid #eee5cf", marginBottom: 14, maxHeight: 340, overflowY: "auto" },
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
