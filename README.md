# 비명 악보 (SCREAM SCORE)

마이크에 대고 소리지르면 음정·음량을 분석해 오선지 위에 음표로 채보해주는 사이트.

- 음정(pitch) → 음 높이 (높이 지르면 높은 음)
- 음량 → 음표 크기 (크게 지르면 큰 음표)
- 모든 처리는 브라우저 안에서 (Web Audio API). **녹음 없음, 서버 없음.**

## 로컬 실행
```bash
npm install
npm run dev
```

## 배포 (Vercel)
- Framework Preset: Vite
- Build Command: `npm run build`
- Output Directory: `dist`
> 마이크는 https에서만 작동. Vercel 기본 https라 문제없음.
