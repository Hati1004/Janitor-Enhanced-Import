// 위치: SillyTavern/plugins/janitor.js
const info = { id: 'janitor', name: 'JanitorAI Proxy', description: 'JannyAI 우회 추출 백엔드' };

function init(router) {
    console.log("================================================");
    console.log("[Janitor 플러그인] 🟢 JannyAI 연동 백엔드 로드 완료!");
    console.log("================================================");

    router.post('/fetch', async (req, res) => {
        try {
            const { url } = req.body;
            
            // 1. URL에서 캐릭터 고유번호(UUID)만 쏙 빼내기
            const uuidMatch = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (!uuidMatch) return res.status(400).json({ success: false, error: 'URL에서 고유번호(UUID)를 찾을 수 없습니다.' });
            
            // 2. 실리태번의 비밀 무기인 JannyAI 서버로 직접 요청 (Cloudflare 403 에러 원천 차단)
            const jannyRes = await fetch('https://api.jannyai.com/api/v1/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ characterId: uuidMatch[0] })
            });

            if (!jannyRes.ok) throw new Error(`JannyAI 서버 접근 실패 (HTTP ${jannyRes.status})`);
            
            const jannyData = await jannyRes.json();
            
            // JannyAI에 캐릭터가 없거나 에러가 났을 때
            if (jannyData.status !== 'ok' || !jannyData.downloadUrl) {
                throw new Error('JannyAI가 이 캐릭터를 아직 수집하지 못했거나 비공개 캐릭터입니다.');
            }

            // 3. JannyAI가 만들어둔 완벽한 PNG 이미지 주소를 프론트엔드로 전달
            res.json({ success: true, downloadUrl: jannyData.downloadUrl });

        } catch (error) {
            console.error('[Janitor 플러그인 에러]', error.message);
            res.status(500).json({ success: false, error: error.message });
        }
    });
}

module.exports = { init, info };