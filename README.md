# 악!보 (aakbo)

마이크에 대고 지르면, 그 "악!" 소리가 진짜 같은 (근데 어딘가 이상한) 악보가 되는 사이트.

- 길게 지를수록 → 음표가 길게 이어짐 (이음줄)
- 크게 지를수록 → f / ff / fff / ffff 셈여림이 붙음
- 음표 아래 가사 = "아아아아악" / "aaaak" (길이·세기에 따라 자동 생성)
- 음정이 흔들리면 → gliss. 자동 표기
- 피아노 / 전자음 / 아~ 보컬로 내 비명을 재생
- 오선지 이미지로 저장

모든 처리는 브라우저 안에서 (Web Audio API). **녹음 없음, 서버 없음.**

## 로컬 실행
```bash
npm install
npm run dev
```

## 배포 (Vercel)
- Framework Preset: Vite / Build: `npm run build` / Output: `dist`
> 마이크는 https에서만 작동. Vercel 기본 https라 OK.
