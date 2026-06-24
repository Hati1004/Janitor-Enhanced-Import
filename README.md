# 🎭 JanitorAI Enhanced Importer for SillyTavern

JanitorAI의 캐릭터 URL만 입력하면 서버 백엔드를 통해 캐릭터, 로어북, Alternate Greetings를 한 번에 추출해 ST에 자동으로 임포트해 주는 확장 프로그램입니다.

**⚠️ 주의:** 이 확장 프로그램은 데이터 우회를 위해 실리태번의 **서버 플러그인(Backend)** 기능을 사용합니다. 설치 방법을 반드시 순서대로 따라 해 주세요!

---

## ⚙️ 설치 방법 (필독)

이 확장은 **1. UI 확장 프로그램**과 **2. 서버 플러그인** 두 가지를 모두 설치해야 정상 작동합니다.

### Step 1. 서버 플러그인 설정 및 설치 (`janitor.js`)
1. SillyTavern이 설치된 가장 상위 폴더(Start.bat이 있는 곳)를 엽니다.
2. `config.yaml` 파일을 텍스트 편집기(메모장 등)로 엽니다.
3. `enableServerPlugins: false` 부분을 찾아 `true`로 변경하고 저장합니다.
4. SillyTavern 상위 폴더에 있는 `plugins` 폴더를 엽니다. (없으면 새로 만드세요)
5. 이 깃허브의 `backend_plugin` 폴더 안에 있는 **`janitor.js` 파일을 `plugins` 폴더 안으로 복사**합니다.

### Step 2. UI 확장 프로그램 설치
1. SillyTavern의 `public/scripts/extensions/third-party/` 경로로 이동합니다.
2. `Janitor-Enhanced-Import`라는 이름으로 새 폴더를 만듭니다.
3. 이 깃허브 메인에 있는 `index.js`, `manifest.json`, `style.css` 파일을 방금 만든 폴더에 넣습니다.

### Step 3. 서버 재시작
1. 현재 켜져 있는 SillyTavern 검은색 콘솔 창(서버)을 **완전히 끄고 다시 실행**합니다.
2. 콘솔 창 로딩 중 **`[Janitor 플러그인] 🟢 백엔드 서버 완벽 로드 완료!`** 라는 문구가 뜨는지 확인합니다.
3. 브라우저에서 새로고침(F5)을 한 뒤, 확장 탭 상단에 추가된 추출기를 사용합니다!

---

## ⚠️ 문제 해결 (Troubleshooting)
* **Q. 404 Not Found 에러가 뜹니다.**
  * A. `janitor.js`가 `plugins` 폴더에 제대로 들어가지 않았거나, `config.yaml`에서 플러그인 설정이 켜지지 않은 것입니다. 서버 창을 껐다 켜보세요.
* **Q. 403 Forbidden 에러가 뜹니다.**
  * A. JanitorAI의 Cloudflare 봇 방어가 매우 심해져서 발생하는 대상 서버 측 방어입니다. 나중에 다시 시도해 보세요.