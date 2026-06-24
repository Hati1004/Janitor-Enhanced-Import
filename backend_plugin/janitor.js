// 위치: SillyTavern/plugins/janitor.js
const info = { id: 'janitor', name: 'JanitorAI Proxy', description: 'JannyAI 우회 추출 백엔드' };

function init(router) {
    console.log("================================================");
    console.log("[Janitor 플러그인] 🟢 JannyAI 연동 백엔드 로드 완료!");
    console.log("================================================");

    router.post('/fetch', async (req, res) => {
        try {
            const { url } = req.body;
            
            const uuidMatch = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (!uuidMatch) return res.status(400).json({ success: false, error: 'URL에서 고유번호(UUID)를 찾을 수 없습니다.' });
            
            // ✅ 브라우저처럼 보이는 헤더 추가
            const jannyRes = await fetch('https://api.jannyai.com/api/v1/download', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Origin': 'https://janitorai.com',
                    'Referer': 'https://janitorai.com/',
                    'sec-ch-ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"Windows"',
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-site',
                },
                body: JSON.stringify({ characterId: uuidMatch[0] })
            });

            if (!jannyRes.ok) throw new Error(`API 서버 접근 실패 (HTTP ${jannyRes.status})`);
            
            const jannyData = await jannyRes.json();
            
            if (jannyData.status !== 'ok' || !jannyData.downloadUrl) {
                throw new Error('JannyAI가 이 캐릭터를 아직 수집하지 못했거나 비공개 캐릭터입니다.');
            }

            res.json({ success: true, downloadUrl: jannyData.downloadUrl });

        } catch (error) {
            console.error('[Janitor 플러그인 에러]', error.message);
            res.status(500).json({ success: false, error: error.message });
        }
    });
}

module.exports = { init, info };
