# JanitorAI Enhanced Importer (for SillyTavern)

JanitorAI의 캐릭터 카드(PNG)와 로어북(Scripts)을 SillyTavern으로 바로 가져올 수 있게 해주는 확장입니다.

이 저장소는 두 부분으로 구성되어 있습니다.

1. **SillyTavern 확장** (`index.js`, `manifest.json`, `style.css`) — ST 화면에 패널을 추가하고, URL만 입력하면 캐릭터를 다운로드/임포트합니다.
2. **백엔드 플러그인** (`backend_plugin/janitor.js`) — 실제로 JanitorAI에서 데이터를 가져와 PNG로 만들거나, 로어북을 World Info로 저장하는 서버 쪽 코드입니다.
3. **(선택) Tampermonkey 브릿지 스크립트** (`janitor-bridge_user.js`) — janitorai.com 페이지에서 버튼 한 번으로 캐릭터/로어북을 바로 내 SillyTavern으로 전송합니다. 캐릭터/로어북 API가 막히거나 불안정할 때 가장 안정적인 방법입니다.

---

## 1. SillyTavern 확장 설치 (필수)

1. SillyTavern 실행 → 좌측 상단 **확장(Extensions)** 메뉴 → **Install Extension** 클릭
2. 이 저장소 URL을 붙여넣고 설치
   ```
   https://github.com/Hati1004/Janitor-Enhanced-Import
   ```
   (또는 저장소를 zip으로 받아서 `SillyTavern/public/scripts/extensions/third-party/` 폴더에 압축 해제해도 됩니다)
3. SillyTavern을 재시작하고, 확장 목록에서 **JanitorAI Enhanced Importer**가 활성화되어 있는지 확인합니다.
4. 왼쪽 사이드바(캐릭터 목록 근처) 상단에 **🎭 JanitorAI → ST 자동 추출기** 패널이 생기면 정상 설치된 것입니다.

## 2. 백엔드 플러그인 설치 (필수)

`index.js`만으로는 실제 다운로드가 동작하지 않습니다. 서버 쪽 플러그인도 설치해야 합니다.

1. `backend_plugin/janitor.js`를 SillyTavern 서버의 플러그인 폴더로 복사합니다.
   ```
   SillyTavern/plugins/janitor/index.js
   ```
   (폴더가 없으면 새로 만들어 주세요. 폴더명은 자유지만, 안의 파일명은 `index.js`로 맞춰주세요.)
2. SillyTavern의 `config.yaml`에서 서버 플러그인이 활성화되어 있는지 확인합니다.
   ```yaml
   enableServerPlugins: true
   ```
3. SillyTavern 서버를 **재시작**합니다. 콘솔에 플러그인 로드 로그가 뜨면 정상입니다.

## 3. (선택, 권장) Tampermonkey 브릿지 스크립트 설치

URL 입력 방식이 막히거나 캐릭터/로어북이 제대로 안 잡힐 때를 위한 보조 수단입니다. **로어북(Scripts) 내보내기는 이 방법을 쓰는 걸 추천합니다.**

1. 브라우저에 [Tampermonkey](https://www.tampermonkey.net/) 확장을 설치합니다 (Chrome, Edge, Firefox 등 지원).
2. Tampermonkey 대시보드 → **새 스크립트 만들기** → 기존 내용을 지우고 `janitor-bridge_user.js` 파일 내용을 전부 붙여넣기 → 저장 (Ctrl+S)
3. janitorai.com에 접속하면:
   - 캐릭터 페이지: 화면에 **"📤 ST로 보내기"** 버튼이 생깁니다.
   - 로어북(Scripts) 편집 페이지: 마찬가지로 전송 버튼이 뜨고, 클릭 시 저장할 이름을 확인/수정하는 창이 뜹니다.
4. 처음 사용 시 SillyTavern 서버 주소를 물어보면 기본값(`http://127.0.0.1:8000`)을 확인하거나 본인 환경에 맞게 입력하세요. (Tampermonkey 메뉴 아이콘 우클릭 → 메뉴 명령어에서 나중에 다시 바꿀 수 있습니다.)
5. JanitorAI 인증 토큰을 물어보면, 브라우저 개발자도구(F12) → Network 탭에서 janitorai API 요청의 `Authorization: Bearer ...` 값 중 `Bearer` 뒤의 문자열만 입력하면 됩니다.

---

## 사용 방법

### 캐릭터 카드 가져오기
- **ST 확장 패널**에서 캐릭터 URL을 입력하고 `⬇️ PNG 다운로드`(파일로 저장) 또는 `📥 ST 즉시 임포트`(캐릭터 목록에 바로 추가) 선택
- 또는 janitorai.com 캐릭터 페이지에서 Tampermonkey 버튼 클릭

### 로어북(Scripts) 가져오기
- janitorai.com의 Scripts 편집 화면에서 Tampermonkey **"📤 ST로 보내기"** 버튼 클릭
- 뜨는 창에서 저장할 로어북 이름을 확인하고 확인 누르면, SillyTavern의 World Info(로어북) 목록에 바로 추가됩니다.

---

## 문제 해결

- **"worlds 디렉토리를 찾을 수 없습니다" 에러**: SillyTavern 버전이 너무 낮을 수 있습니다 (1.12+ 필요).
- **CSRF 토큰 에러**: SillyTavern 서버 주소가 맞는지, 서버가 실행 중인지 확인하세요.
- **로어북 엔트리를 못 찾음**: F12 콘솔에서 `__jaiDebugLorebook()`을 실행해 디버그 정보를 확인해 보세요.

## 주의사항

이 확장은 JanitorAI의 비공식 API/페이지 구조에 의존합니다. JanitorAI 쪽 구조가 바뀌면 일부 기능이 동작하지 않을 수 있습니다.
