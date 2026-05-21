import React, { useState, useRef, useEffect, useCallback } from "react";

// ─────────────────────────────────────────────
// 비명 악보 — SCREAM SCORE
// 마이크 pitch(음정) → 오선지 위 음 높이
// 마이크 음량(RMS) → 음표 크기
// 지르는 동안 음표가 왼→오로 찍히며 악보가 길어진다.
// 멈추면 완성된 악보 + png 저장.
// 모든 처리는 브라우저 안에서 (녹음 X, 서버 X)
// ─────────────────────────────────────────────

// 음표 하나가 담는 정보: { midi, norm(음량), t }
// midi: 음 높이(MIDI note number). null이면 무음(쉼표 취급)

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function midiToName(m) {
  if (m == null) return "—";
  const oct = Math.floor(m / 12) - 1;
  return NOTE_NAMES[m % 12] + oct;
}

// autocorrelation 기반 pitch 검출. 실패 시 -1
function detectPitch(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1; // 너무 조용하면 패스

  let r1 = 0, r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++) if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }

  const b = buf.slice(r1, r2);
  const n = b.length;
  const c = new Array(n).fill(0);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n - i; j++) c[i] += b[j] * b[j + i];

  let d = 0;
  while (c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < n; i++) {
    if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  }
  let T0 = maxpos;
  if (T0 <= 0) return -1;

  // 포물선 보간
  const x1 = c[T0 - 1] || 0, x2 = c[T0], x3 = c[T0 + 1] || 0;
  const a = (x1 + x3 - 2 * x2) / 2;
  const bb = (x3 - x1) / 2;
  if (a) T0 = T0 - bb / (2 * a);

  const freq = sampleRate / T0;
  if (freq < 70 || freq > 1200) return -1; // 사람 목소리 범위 밖이면 버림
  return freq;
}

function freqToMidi(f) {
  return Math.round(69 + 12 * Math.log2(f / 440));
}

// 오선지 표시 범위 (MIDI). 대략 G3~A5
const LOW_MIDI = 55;  // G3
const HIGH_MIDI = 81; // A5

export default function App() {
  const [phase, setPhase] = useState("idle");
  const [notes, setNotes] = useState([]);
  const [level, setLevel] = useState(0);
  const [curMidi, setCurMidi] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState(null);
  const [diag, setDiag] = useState(null);
  const [saving, setSaving] = useState(false);

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const bufRef = useRef(null);
  const timeBufRef = useRef(null);

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

    // 음량
    let sum = 0;
    for (let i = 0; i < timeBufRef.current.length; i++) sum += timeBufRef.current[i] * timeBufRef.current[i];
    const rms = Math.sqrt(sum / timeBufRef.current.length);
    const norm = Math.min(1, rms * 3.5);
    setLevel(norm);
    peakRef.current = Math.max(peakRef.current, norm);

    // pitch
    const freq = detectPitch(timeBufRef.current, ctx.sampleRate);
    let midi = null;
    if (freq > 0 && norm > 0.1) {
      midi = freqToMidi(freq);
      // 옥타브 점프 억제: 직전 음과 12반음 이상 튀면 옥타브 보정
      const prev = lastMidiRef.current;
      if (prev != null) {
        while (midi - prev > 8) midi -= 12;
        while (prev - midi > 8) midi += 12;
      }
      lastMidiRef.current = midi;
      setCurMidi(midi);
    } else {
      setCurMidi(null);
    }

    const now = performance.now();
    setElapsed((now - startRef.current) / 1000);

    // 130ms마다 음표 하나 찍기 (지르고 있을 때만)
    if (norm > 0.1 && now - lastNoteRef.current > 130) {
      lastNoteRef.current = now;
      notesRef.current = [...notesRef.current, { midi, norm, t: (now - startRef.current) / 1000 }];
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

      peakRef.current = 0;
      startRef.current = performance.now();
      lastNoteRef.current = 0;
      lastMidiRef.current = null;
      notesRef.current = [];
      setNotes([]);
      setElapsed(0);
      setPhase("recording");
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      setDiag({ errName: e && e.name ? e.name : "UnknownError" });
      setPhase("denied");
    }
  }, [tick, hasMic]);

  const stop = useCallback(() => {
    const dur = (performance.now() - startRef.current) / 1000;
    const peak = peakRef.current;
    const pitched = notesRef.current.filter((n) => n.midi != null);
    const midis = pitched.map((n) => n.midi);
    const highest = midis.length ? Math.max(...midis) : null;
    const lowest = midis.length ? Math.min(...midis) : null;
    const range = highest != null && lowest != null ? highest - lowest : 0;

    // 음역대 등급
    let grade;
    if (notesRef.current.length < 3) grade = { label: "무음", note: "악보가 비었어요" };
    else if (range >= 18) grade = { label: "오페라 가수", note: "음역대 미쳤다" };
    else if (range >= 11) grade = { label: "노래방 본선급", note: "기복이 심함" };
    else if (range >= 5) grade = { label: "흥얼흥얼", note: "안정적인 비명" };
    else grade = { label: "한 음 집착", note: "단조로운 절규" };

    setResult({
      dur, peak,
      count: notesRef.current.length,
      highest, lowest, range,
      grade,
      ts: new Date(),
      no: Math.floor(Math.random() * 9000) + 1000,
    });
    setPhase("done");
    cleanup();
  }, [cleanup]);

  const reset = useCallback(() => {
    notesRef.current = []; setNotes([]); setLevel(0); setCurMidi(null); setElapsed(0); setResult(null); setPhase("idle");
  }, []);

  // png 저장: 캔버스에 오선지+음표 다시 그림
  const saveImage = useCallback(() => {
    if (!result) return;
    setSaving(true);
    try {
      drawScore({ notes: notesRef.current, result, toBlob: true, onBlob: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const d = result.ts;
        a.href = url;
        a.download = `scream-score-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}.png`;
        a.click();
        URL.revokeObjectURL(url);
        setSaving(false);
      }});
    } catch (e) { setSaving(false); alert("이미지 저장에 실패했어요."); }
  }, [result]);

  const copyLink = useCallback(async () => {
    try { await navigator.clipboard.writeText(window.location.href); alert("링크 복사 완료! 트위터에 자랑하세요 🎼"); }
    catch (e) { alert(window.location.href); }
  }, []);

  return (
    <div style={S.page}>
      <style>{CSS}</style>
      <div style={S.frame}>
        {phase === "idle" && <IdleView onStart={start} inIframe={inIframe} />}
        {phase === "arming" && <div style={S.center}><p style={S.armText}>마이크 권한 허용해줘…</p></div>}
        {phase === "denied" && <DeniedView diag={diag} inIframe={inIframe} isSecure={isSecure} hasMic={hasMic} onReset={reset} />}
        {phase === "recording" && <RecordView notes={notes} level={level} curMidi={curMidi} elapsed={elapsed} onStop={stop} />}
        {phase === "done" && result && <DoneView notes={notes} r={result} onReset={reset} onSave={saveImage} onCopy={copyLink} saving={saving} />}
      </div>
      <p style={S.privacy}>🔒 소리는 녹음되지 않아요. 음정·음량만 분석하고 바로 사라집니다.</p>
    </div>
  );
}

const pad = (n) => String(n).padStart(2, "0");

// ── 오선지 + 음표 렌더 (라이브 SVG / 저장 캔버스 공용 좌표 계산) ──
function noteY(midi, top, staffH) {
  // midi를 LOW~HIGH 범위에 매핑. 높을수록 위.
  if (midi == null) return top + staffH / 2;
  const clamped = Math.max(LOW_MIDI - 6, Math.min(HIGH_MIDI + 6, midi));
  const r = (clamped - LOW_MIDI) / (HIGH_MIDI - LOW_MIDI);
  return top + staffH - r * staffH;
}

function LiveStaff({ notes, curMidi }) {
  // 가로로 흐르는 오선지. 최근 음표 위주로 보여줌(스크롤 효과)
  const W = 320, top = 30, staffH = 120, lineGap = staffH / 4;
  const noteSpacing = 12;
  const visibleCount = Math.floor((W - 40) / noteSpacing);
  const shown = notes.slice(-visibleCount);
  const startX = 30;

  return (
    <svg viewBox={`0 0 ${W} 200`} style={{ width: "100%", height: "auto" }}>
      {/* 오선 5줄 */}
      {[0, 1, 2, 3, 4].map((i) => (
        <line key={i} x1={10} y1={top + i * lineGap} x2={W - 10} y2={top + i * lineGap} stroke="#111" strokeWidth="1" />
      ))}
      {/* 음자리표 느낌의 세로 바 */}
      <line x1={14} y1={top} x2={14} y2={top + staffH} stroke="#111" strokeWidth="2" />
      {/* 음표들 */}
      {shown.map((n, i) => {
        const x = startX + i * noteSpacing;
        const y = noteY(n.midi, top, staffH);
        const rad = 2.5 + n.norm * 5;
        return n.midi == null ? (
          <text key={i} x={x} y={top + staffH / 2 + 4} fontSize="12" fill="#bbb" textAnchor="middle">𝄽</text>
        ) : (
          <g key={i}>
            <ellipse cx={x} cy={y} rx={rad * 1.2} ry={rad} fill="#111" transform={`rotate(-20 ${x} ${y})`} />
            <line x1={x + rad} y1={y} x2={x + rad} y2={y - 22} stroke="#111" strokeWidth="1.5" />
          </g>
        );
      })}
      {/* 현재 음 표시 */}
      {curMidi != null && (
        <text x={W - 12} y={20} fontSize="12" fill="#d11" textAnchor="end" fontWeight="700">{midiToName(curMidi)}</text>
      )}
    </svg>
  );
}

// 저장용 캔버스 그리기 — 음표 전체를 여러 단으로 접어서 그림
function drawScore({ notes, result, onBlob }) {
  const W = 800, PAD = 50;
  const dpr = 2;
  const top0 = 130;
  const staffH = 120, lineGap = staffH / 4;
  const noteSpacing = 16;
  const perLine = Math.floor((W - PAD * 2 - 20) / noteSpacing);
  const lineBlockH = staffH + 70; // 한 단 높이(여백 포함)
  const totalLines = Math.max(1, Math.ceil(notes.length / perLine));

  const footerH = 260;
  const H = top0 + totalLines * lineBlockH + footerH;

  const canvas = document.createElement("canvas");
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fffdf7"; // 살짝 크림색 종이
  ctx.fillRect(0, 0, W, H);

  const cx = W / 2;
  ctx.textAlign = "center";
  ctx.fillStyle = "#999";
  ctx.font = "12px 'Courier New', monospace";
  ctx.fillText("S C R E A M   S C O R E", cx, 50);
  ctx.fillStyle = "#111";
  ctx.font = "800 26px 'Courier New', monospace";
  ctx.fillText("나의 비명 채보", cx, 88);

  // 각 단 그리기
  for (let li = 0; li < totalLines; li++) {
    const top = top0 + li * lineBlockH;
    ctx.strokeStyle = "#111"; ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath(); ctx.moveTo(PAD, top + i * lineGap); ctx.lineTo(W - PAD, top + i * lineGap); ctx.stroke();
    }
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(PAD + 4, top); ctx.lineTo(PAD + 4, top + staffH); ctx.stroke();

    const slice = notes.slice(li * perLine, (li + 1) * perLine);
    slice.forEach((n, i) => {
      const x = PAD + 24 + i * noteSpacing;
      if (n.midi == null) {
        ctx.fillStyle = "#ccc"; ctx.font = "16px serif"; ctx.textAlign = "center";
        ctx.fillText("𝄽", x, top + staffH / 2 + 5);
        return;
      }
      const y = noteYCanvas(n.midi, top, staffH);
      const rad = 3 + n.norm * 6;
      ctx.fillStyle = "#111";
      ctx.save();
      ctx.translate(x, y); ctx.rotate(-0.35);
      ctx.beginPath(); ctx.ellipse(0, 0, rad * 1.2, rad, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = "#111"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x + rad, y); ctx.lineTo(x + rad, y - 26); ctx.stroke();
    });
  }

  // footer 정보
  let fy = top0 + totalLines * lineBlockH + 30;
  const d = result.ts;
  const dateStr = `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}`;
  ctx.strokeStyle = "#ccc"; ctx.lineWidth = 1.5; ctx.setLineDash([6,5]);
  ctx.beginPath(); ctx.moveTo(PAD, fy); ctx.lineTo(W-PAD, fy); ctx.stroke(); ctx.setLineDash([]);
  fy += 36;

  const row = (k, v) => {
    ctx.font = "700 16px 'Courier New', monospace";
    ctx.textAlign = "left"; ctx.fillStyle = "#444"; ctx.fillText(k, PAD, fy);
    ctx.textAlign = "right"; ctx.fillStyle = "#111"; ctx.fillText(v, W - PAD, fy);
    fy += 32;
  };
  row("일자", `${dateStr}  No.${result.no}`);
  row("음표 수", `${result.count} 개`);
  row("최고음 / 최저음", `${midiToName(result.highest)} / ${midiToName(result.lowest)}`);
  row("음역대", `${result.range} 반음`);
  row("지속 시간", `${result.dur.toFixed(1)} s`);
  fy += 10;

  // 등급 박스
  ctx.strokeStyle = "#111"; ctx.lineWidth = 2.5;
  ctx.strokeRect(PAD, fy, W - PAD*2, 80);
  ctx.textAlign = "center";
  ctx.fillStyle = "#111"; ctx.font = "800 28px 'Courier New', monospace";
  ctx.fillText(result.grade.label, cx, fy + 38);
  ctx.fillStyle = "#666"; ctx.font = "italic 14px 'Courier New', monospace";
  ctx.fillText(`“${result.grade.note}”`, cx, fy + 64);

  canvas.toBlob((blob) => onBlob(blob), "image/png");
}

function noteYCanvas(midi, top, staffH) {
  if (midi == null) return top + staffH / 2;
  const clamped = Math.max(LOW_MIDI - 6, Math.min(HIGH_MIDI + 6, midi));
  const r = (clamped - LOW_MIDI) / (HIGH_MIDI - LOW_MIDI);
  return top + staffH - r * staffH;
}

function IdleView({ onStart, inIframe }) {
  return (
    <div style={S.card}>
      <p style={S.brand}>SCREAM SCORE</p>
      <h1 style={S.title}>비명 악보</h1>
      <p style={S.desc}>마이크에 대고 질러봐.<br />너의 비명을 악보로 채보해드립니다.<br />높이 지르면 높은 음, 크게 지르면 큰 음표.</p>
      {inIframe && (
        <div style={S.iframeNote}>⚠️ 미리보기(iframe)에선 마이크가 막혀요.<br /><b>새 창(↗) 또는 배포 주소</b>에서 열어주세요.</div>
      )}
      <button style={S.btnMain} onClick={onStart}>🎤 지를 준비 됐어</button>
    </div>
  );
}

function RecordView({ notes, level, curMidi, elapsed, onStop }) {
  return (
    <div style={S.card}>
      <p style={S.recLabel}>● REC  {elapsed.toFixed(1)}s · {notes.length}음</p>
      <div style={S.staffWrap}>
        <LiveStaff notes={notes} curMidi={curMidi} />
      </div>
      <div style={S.meterMini}>
        <div style={{ ...S.meterFill, width: `${level * 100}%` }} />
      </div>
      <p style={S.hint}>{level > 0.5 ? "그렇지! 음 올려봐!" : level > 0.15 ? "더 크게!" : "지르면 음표가 찍혀…"}</p>
      <button style={S.btnStop} onClick={onStop}>■ 채보 끝내기</button>
    </div>
  );
}

function DoneView({ notes, r, onReset, onSave, onCopy, saving }) {
  // 화면용: 단을 접어서 SVG로 미리보기
  const W = 320, PAD = 16, top = 26, staffH = 100, lineGap = staffH / 4;
  const noteSpacing = 9;
  const perLine = Math.floor((W - PAD * 2 - 16) / noteSpacing);
  const totalLines = Math.max(1, Math.ceil(notes.length / perLine));
  const lineBlockH = staffH + 36;
  const svgH = totalLines * lineBlockH + 10;

  return (
    <>
      <div style={S.card} className="pop">
        <p style={S.brand}>SCREAM SCORE</p>
        <p style={S.doneTitle}>나의 비명 채보</p>
        <div style={{ ...S.staffWrap, maxHeight: 360, overflowY: "auto" }}>
          <svg viewBox={`0 0 ${W} ${svgH}`} style={{ width: "100%", height: "auto" }}>
            {Array.from({ length: totalLines }).map((_, li) => {
              const t = top + li * lineBlockH;
              const slice = notes.slice(li * perLine, (li + 1) * perLine);
              return (
                <g key={li}>
                  {[0,1,2,3,4].map((i) => (
                    <line key={i} x1={PAD} y1={t + i*lineGap} x2={W-PAD} y2={t + i*lineGap} stroke="#111" strokeWidth="0.8" />
                  ))}
                  <line x1={PAD+2} y1={t} x2={PAD+2} y2={t+staffH} stroke="#111" strokeWidth="1.5" />
                  {slice.map((n, i) => {
                    const x = PAD + 14 + i * noteSpacing;
                    if (n.midi == null) return <text key={i} x={x} y={t+staffH/2+3} fontSize="9" fill="#ccc" textAnchor="middle">𝄽</text>;
                    const y = noteY(n.midi, t, staffH);
                    const rad = 2 + n.norm * 4;
                    return (
                      <g key={i}>
                        <ellipse cx={x} cy={y} rx={rad*1.2} ry={rad} fill="#111" transform={`rotate(-20 ${x} ${y})`} />
                        <line x1={x+rad} y1={y} x2={x+rad} y2={y-18} stroke="#111" strokeWidth="1.2" />
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>

        <div style={S.dash} />
        <Row k="음표 수" v={`${r.count} 개`} />
        <Row k="최고음 / 최저음" v={`${midiToName(r.highest)} / ${midiToName(r.lowest)}`} />
        <Row k="음역대" v={`${r.range} 반음`} />
        <Row k="지속 시간" v={`${r.dur.toFixed(1)} s`} />
        <div style={S.dash} />
        <div style={S.gradeBox}>
          <p style={S.gradeLabel}>{r.grade.label}</p>
          <p style={S.gradeNote}>“{r.grade.note}”</p>
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

function Row({ k, v }) {
  return <div style={S.row}><span style={S.rowK}>{k}</span><span style={S.dots} /><span style={S.rowV}>{v}</span></div>;
}

const MONO = "'Courier New', ui-monospace, monospace";

const S = {
  page: { minHeight: "100vh", background: "#e8e3d6", backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.015) 0 1px, transparent 1px 26px)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 16px", fontFamily: MONO },
  frame: { width: "100%", maxWidth: 360 },
  card: { background: "#fffdf7", padding: "32px 24px", boxShadow: "0 12px 40px rgba(0,0,0,0.22)", border: "1px solid #ddd6c4" },
  center: { background: "#fffdf7", padding: "48px 24px", textAlign: "center", boxShadow: "0 12px 40px rgba(0,0,0,0.22)" },
  armText: { fontSize: 16, color: "#111", letterSpacing: 1, textAlign: "center" },

  brand: { textAlign: "center", fontSize: 11, letterSpacing: 4, color: "#9a9484", marginBottom: 16 },
  title: { textAlign: "center", fontSize: 36, fontWeight: 800, letterSpacing: 2, color: "#1a1a1a", margin: "0 0 18px" },
  desc: { textAlign: "center", fontSize: 13, lineHeight: 1.9, color: "#555", marginBottom: 28 },
  iframeNote: { border: "1.5px dashed #111", padding: "12px 14px", fontSize: 11.5, lineHeight: 1.7, color: "#333", marginBottom: 20, textAlign: "left" },

  recLabel: { textAlign: "center", fontSize: 12, letterSpacing: 1, color: "#d11", fontWeight: 700, marginBottom: 14 },
  staffWrap: { background: "#fffdf7", padding: "4px 0", marginBottom: 14 },
  meterMini: { height: 6, background: "#e5e0d2", borderRadius: 3, overflow: "hidden", marginBottom: 12 },
  meterFill: { height: "100%", background: "#111", transition: "width 60ms linear" },
  hint: { textAlign: "center", fontSize: 14, fontWeight: 700, color: "#111", marginBottom: 20, letterSpacing: 1 },

  doneTitle: { textAlign: "center", fontSize: 22, fontWeight: 800, color: "#111", letterSpacing: 1, marginBottom: 18 },
  dash: { borderTop: "2px dashed #ccc", margin: "14px 0" },
  row: { display: "flex", alignItems: "baseline", margin: "7px 0" },
  rowK: { fontSize: 13, color: "#333", whiteSpace: "nowrap" },
  dots: { flex: 1, borderBottom: "1px dotted #ccc", margin: "0 6px", transform: "translateY(-3px)" },
  rowV: { fontSize: 13, color: "#111", fontWeight: 700, whiteSpace: "nowrap" },

  gradeBox: { border: "2px solid #111", padding: "16px 12px", textAlign: "center", margin: "8px 0 0" },
  gradeLabel: { fontSize: 24, fontWeight: 800, color: "#111", letterSpacing: 2, marginBottom: 8 },
  gradeNote: { fontSize: 12, color: "#666", fontStyle: "italic" },

  actions: { marginTop: 20 },
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
