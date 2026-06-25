# 🎭 JanitorAI Enhanced Importer for SillyTavern

JanitorAI의 캐릭터 URL만 입력하면 서버 백엔드를 통해 캐릭터를 추출해 ST에 자동으로 임포트해 주는 확장 프로그램입니다.

**⚠️ 주의:** 이 확장 프로그램은 데이터 우회를 위해 실리태번의 **서버 플러그인(Backend)** 기능을 사용합니다. 설치 방법을 반드시 순서대로 따라 해 주세요!

---

## ✨ 기능

* **PNG 다운로드**: 캐릭터 URL을 입력하면 캐릭터 카드 PNG를 브라우저로 바로 받습니다.
* **ST 즉시 임포트**: 위 추출 + ST의 캐릭터 폴더에 직접 저장까지 한 번에 처리합니다. ST 내장 임포트 기능의 `Unsupported format` 오류를 우회합니다.
* **대체 인사말(Alternate Greetings) 보존**: PNG에 `chara`/`ccv3` 두 청크가 모두 있을 경우, 대체 인사말이 더 많이 들어있는 쪽을 자동으로 선택해 보존합니다.

## 🚫 지원하지 않는 기능 (알려진 한계)

* **로어북(Scripts) 자동 추출은 지원하지 않습니다.** JanitorAI의 로어북 데이터는 로그인 세션과 Cloudflare 인증이 필요한 비공개 API로만 제공되며, 이는 서버 단독으로는 우회할 수 없는 것으로 확인되었습니다. 로어북이 필요한 캐릭터는 [datacat.run](https://datacat.run) 등에서 별도로 받아 ST의 World Info(로어북) 탭에서 직접 추가해 주세요.
* **대체 인사말도 대부분 캐릭터에서는 누락될 수 있습니다.** 이 확장은 PNG를 제공하는 소스(JannyAI, datacat 익명 다운로드)에 캐싱된 데이터를 그대로 가져오는데, 소스 쪽 캐시 자체에 대체 인사말이 빠져 있는 경우가 있습니다. 

---

## ⚙️ 설치 방법 (필독)

### 💻 Windows / PC 기준

#### Step 1.
1. 설치 후 GitHub/SillyTavern/public/scripts/extensions/third-party/Janitor-Enhanced-Import 폴더에 모든 파일과 backend_plugin 폴더가 다운로드됩니다.
2. backend_plugin 폴더 안에 있는 janitor.js 파일을 복사해서, SillyTavern 상위 폴더(Start.bat이 있는 곳)에 있는 plugins 폴더에 janitor.js를 직접 붙여넣기 합니다.
3. `config.yaml` 파일을 텍스트 편집기(메모장 등)로 엽니다. `enableServerPlugins: false` 부분을 찾아 `true`로 변경하고 저장합니다.

#### Step 2.
1. 현재 켜져 있는 SillyTavern 검은색 콘솔 창(서버)을 **완전히 끄고 다시 실행**합니다.
2. 콘솔 창 로딩 중 **`[Janitor 플러그인] 🟢 백엔드 서버 완벽 로드 완료!`** 라는 문구가 뜨는지 확인합니다.
3. 브라우저에서 새로고침(F5)을 한 뒤, 확장 탭 상단에 추가된 추출기를 사용합니다!

---

### 📱 Android (Termux) 기준

코드 자체는 Windows와 완전히 동일하며, 수정할 부분은 없습니다. **폴더 경로 표기만 다릅니다** — Termux는 `C:\Users\...` 같은 드라이브 경로 대신 `~/`(홈 디렉터리) 기준 경로를 씁니다.

#### Step 1.
1. 확장을 평소처럼 SillyTavern 내장 확장 설치 기능(또는 GitHub 링크 붙여넣기)으로 설치하면, 자동으로 `~/SillyTavern/public/scripts/extensions/third-party/Janitor-Enhanced-Import` 폴더에 파일들이 들어갑니다.
2. Termux 앱에서 다음 명령으로 `janitor.js`를 plugins 폴더로 복사합니다:
   ```bash
   cp ~/SillyTavern/public/scripts/extensions/third-party/Janitor-Enhanced-Import/backend_plugin/janitor.js ~/SillyTavern/plugins/janitor.js
   ```
   (만약 `plugins` 폴더가 없다면 먼저 `mkdir ~/SillyTavern/plugins`로 만들어 주세요.)
3. `config.yaml`을 Termux 내장 편집기인 nano로 엽니다:
   ```bash
   nano ~/SillyTavern/config.yaml
   ```
   `enableServerPlugins: false`를 찾아 `true`로 바꾼 뒤 `Ctrl+X` → `Y` → `Enter`로 저장합니다.

#### Step 2.
1. Termux에서 SillyTavern을 실행 중인 터미널을 완전히 종료(`Ctrl+C`)한 뒤 다시 시작합니다:
   ```bash
   cd ~/SillyTavern && bash start.sh
   ```
2. 콘솔에 **`[Janitor 플러그인] 🟢 백엔드 서버 완벽 로드 완료!`** 문구가 뜨는지 확인합니다.
3. 브라우저(폰 자체 브라우저 또는 PC에서 같은 와이파이로 접속한 경우 모두)를 새로고침한 뒤 확장을 사용합니다.

> 💡 PC의 SillyTavern 서버에 폰 브라우저로 접속해서 쓰는 경우(서버는 PC, 화면만 폰)라면 **Windows 설치 방법을 그대로 따르면 됩니다** — 이 경우 폰은 화면만 보여줄 뿐, 실제 파일 저장은 PC 쪽에서 일어납니다. 위 Termux 안내는 SillyTavern 자체를 폰에서 직접 구동하는 경우에만 해당합니다.

---

## 🔒 개인정보 / 데이터 처리

* 이 확장은 입력한 캐릭터 URL을 **본인의 ST 서버**가 직접 JanitorAI/JannyAI/datacat에 요청해서 처리합니다. 개발자나 제3의 서버로 데이터가 전송되거나 수집되는 경로는 없습니다.
* 추출된 캐릭터 파일은 SillyTavern이 설치된 기기(PC 또는 폰)의 `characters` 폴더에만 저장됩니다.

---

## ⚠️ 문제 해결 (Troubleshooting)

### 올바른 위치들
* **PC**: `~public/scripts/extensions/third-party/Janitor-Enhanced-Import` 폴더 안에 `index.js`, `manifest.json`, `style.css`. / `~GitHub/SillyTavern/plugins` 폴더 안에 `janitor.js`
* **Termux**: `~/SillyTavern/public/scripts/extensions/third-party/Janitor-Enhanced-Import` 폴더 안에 `index.js`, `manifest.json`, `style.css`. / `~/SillyTavern/plugins` 폴더 안에 `janitor.js`

* **Q. 404 Not Found 에러가 뜹니다.**
  * A. `janitor.js`가 `plugins` 폴더에 제대로 들어가지 않았거나, `config.yaml`에서 플러그인 설정이 켜지지 않은 것입니다. 서버 창을 껐다 켜보세요.
* **Q. 403 / 401 에러가 뜹니다.**
  * A. JanitorAI 또는 datacat의 봇 방어/로그인 인증으로 막힌 것입니다. 두 소스 중 하나가 막혀도 다른 쪽으로 자동 폴백을 시도하니, 콘솔 로그에서 최종적으로 PNG를 받아왔는지 확인해 보세요.
* **Q. 대체 인사말이 1개만 보입니다.**
  * A. 위 "알려진 한계" 항목을 참고하세요. 소스 캐시 자체에 데이터가 없는 경우입니다.
