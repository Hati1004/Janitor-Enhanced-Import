// 위치: SillyTavern/plugins/janitor.js

const info = {
    id: 'janitor',
    name: 'JanitorAI Proxy Plugin',
    description: 'JanitorAI 우회 추출 백엔드'
};

function init(express, app, router) {
    console.log("================================================");
    console.log("[Janitor 플러그인] 🟢 백엔드 서버 완벽 로드 완료!");
    console.log("================================================");

    router.post('/fetch', async (req, res) => {
        try {
            const { url } = req.body;
            if (!url) return res.status(400).json({ success: false, error: 'URL이 없습니다.' });

            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/json'
                }
            });

            if (!response.ok) throw new Error(`HTTP 에러: ${response.status} (Cloudflare 차단 등)`);
            
            const html = await response.text();
            const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
            
            if (!match) throw new Error('페이지에서 데이터를 찾을 수 없습니다.');

            const pageData = JSON.parse(match[1]);
            let characterData = null;
            const queries = pageData.props?.pageProps?.trpcState?.json?.queries || [];
            
            for (const q of queries) {
                if (q.queryKey[0] === 'characters' && q.state?.data) {
                    characterData = q.state.data;
                    break;
                }
            }

            if (!characterData) throw new Error('캐릭터 정보를 추출할 수 없습니다.');

            res.json({ success: true, character: characterData });

        } catch (error) {
            console.error('[Janitor 플러그인] ❌ 백엔드 에러:', error.message);
            res.status(500).json({ success: false, error: error.message });
        }
    });
}

module.exports = { init, info };