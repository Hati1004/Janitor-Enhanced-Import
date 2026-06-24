// 위치: SillyTavern/plugins/janitor.js

const info = {
    id: 'janitor',
    name: 'JanitorAI Proxy Plugin',
    description: 'JanitorAI API 우회 추출 백엔드'
};

function init(router) {
    console.log("================================================");
    console.log("[Janitor 플러그인] 🟢 API 전용 백엔드 서버 로드 완료!");
    console.log("================================================");

    router.post('/fetch', async (req, res) => {
        try {
            const { url } = req.body;
            if (!url) return res.status(400).json({ success: false, error: 'URL이 없습니다.' });

            // 1. URL에서 캐릭터 고유번호(UUID)만 쏙 빼내기
            const uuidMatch = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (!uuidMatch) throw new Error('URL에서 캐릭터 고유번호(UUID)를 찾을 수 없습니다.');
            const uuid = uuidMatch[0];

            // 2. HTML 화면이 아닌, JanitorAI 내부 비밀 통로(tRPC API)로 직접 요청! (403 에러 원천 차단)
            const inputQuery = encodeURIComponent(`{"0":{"json":{"id":"${uuid}"}}}`);
            const apiUrl = `https://janitorai.com/api/trpc/characters.getCharacter?batch=1&input=${inputQuery}`;

            const response = await fetch(apiUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    'Referer': url // 내가 홈페이지에서 온 것처럼 속임
                }
            });

            if (!response.ok) throw new Error(`API 서버 접근 실패 (HTTP ${response.status})`);
            
            const data = await response.json();
            
            // 3. 복잡한 HTML 파싱 없이, API가 주는 깔끔한 캐릭터 데이터만 바로 꺼내기
            const characterData = data[0]?.result?.data?.json;
            if (!characterData) throw new Error('API 응답에서 캐릭터 정보를 찾을 수 없습니다. (비공개 캐릭터일 수 있음)');

            // 추출 성공! 프론트엔드로 전달
            res.json({ success: true, character: characterData });

        } catch (error) {
            console.error('[Janitor 플러그인] ❌ 백엔드 에러:', error.message);
            res.status(500).json({ success: false, error: error.message });
        }
    });
}

module.exports = { init, info };