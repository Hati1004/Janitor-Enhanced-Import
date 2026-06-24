// 위치: SillyTavern/plugins/janitor.js
const info = { id: 'janitor', name: 'JanitorAI Proxy', description: 'JannyAI 우회 추출 백엔드' };

function init(router) {
    console.log("================================================");
    console.log("[Janitor 플러그인] 🟢 JannyAI 연동 백엔드 로드 완료!");
    console.log("================================================");

    const BROWSER_HEADERS = {
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
    };

    // ✅ UUID 추출 헬퍼
    function extractUuid(url) {
        const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        return m ? m[0] : null;
    }

    // ✅ 방법 1: jannyai API로 downloadUrl 받아오기
    async function tryJannyApi(uuid) {
        const res = await fetch('https://api.jannyai.com/api/v1/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...BROWSER_HEADERS },
            body: JSON.stringify({ characterId: uuid })
        });
        if (!res.ok) throw new Error(`JannyAI HTTP ${res.status}`);
        const data = await res.json();
        if (data.status !== 'ok' || !data.downloadUrl) throw new Error('downloadUrl 없음');
        return data.downloadUrl;
    }

    // ✅ 방법 2: datacat.run으로 폴백
    async function tryDatacat(uuid) {
        const res = await fetch(`https://datacat.run/retrieve?uuid=${uuid}`, {
            headers: { ...BROWSER_HEADERS, 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error(`datacat HTTP ${res.status}`);
        const data = await res.json();
        // datacat은 {downloadUrl} 또는 {url} 형태로 반환
        const dlUrl = data.downloadUrl || data.url || data.download_url;
        if (!dlUrl) throw new Error('datacat에서 URL을 찾을 수 없음');
        return dlUrl;
    }

    // ✅ PNG 바이너리 다운로드
    async function downloadPng(downloadUrl) {
        const res = await fetch(downloadUrl, { headers: BROWSER_HEADERS });
        if (!res.ok) throw new Error(`PNG 다운로드 실패 HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    }

    // ✅ JanitorAI 공개 API에서 캐릭터 상세 정보(로어북 포함) 가져오기
    async function fetchCharacterDetail(uuid) {
        const res = await fetch(`https://janitorai.com/api/v1/characters/${uuid}`, {
            headers: { ...BROWSER_HEADERS, 'Accept': 'application/json' }
        });
        if (!res.ok) return null;
        try { return await res.json(); } catch { return null; }
    }

    // ✅ PNG에 tEXt 청크로 로어북 데이터 임베드 (순수 Node.js, sharp 불필요)
    function embedLorebookIntoPng(pngBuffer, charData) {
        // 로어북 항목 추출
        const lorebook = charData?.lorebook || charData?.world_info || charData?.character?.lorebook;
        const altGreetings = charData?.alternate_greetings || charData?.character?.alternate_greetings || [];
        
        if (!lorebook && altGreetings.length === 0) return pngBuffer; // 임베드할 게 없으면 원본 반환

        // PNG tEXt 청크 생성 함수
        function makeTEXtChunk(keyword, text) {
            const crypto = require('crypto');
            const data = Buffer.from(keyword + '\x00' + text, 'latin1');
            const type = Buffer.from('tEXt');
            const crc = crypto.createHash('crc32').update(Buffer.concat([type, data])).digest(); 
            // Node에는 crc32가 없으니 직접 계산
            const crcVal = crc32(Buffer.concat([type, data]));
            const chunk = Buffer.alloc(4 + 4 + data.length + 4);
            chunk.writeUInt32BE(data.length, 0);
            type.copy(chunk, 4);
            data.copy(chunk, 8);
            chunk.writeUInt32BE(crcVal, 8 + data.length);
            return chunk;
        }

        // CRC32 순수 구현
        function crc32(buf) {
            let crc = 0xFFFFFFFF;
            const table = makeCrcTable();
            for (let i = 0; i < buf.length; i++) {
                crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
            }
            return (crc ^ 0xFFFFFFFF) >>> 0;
        }

        function makeCrcTable() {
            const table = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                table[n] = c;
            }
            return table;
        }

        // ST가 읽는 형식: chara tEXt 청크에 base64 인코딩된 캐릭터 카드 JSON
        // 로어북/alt greetings를 캐릭터 카드에 병합
        const IEND_MARKER = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
        const iendIdx = pngBuffer.lastIndexOf(IEND_MARKER);
        if (iendIdx === -1) return pngBuffer;

        // 기존 chara 청크에서 캐릭터 카드 JSON 추출 시도
        let cardJson = null;
        try {
            let offset = 8; // PNG 시그니처 스킵
            while (offset < pngBuffer.length - 12) {
                const chunkLen = pngBuffer.readUInt32BE(offset);
                const chunkType = pngBuffer.slice(offset + 4, offset + 8).toString('ascii');
                if (chunkType === 'tEXt') {
                    const chunkData = pngBuffer.slice(offset + 8, offset + 8 + chunkLen).toString('latin1');
                    const nullIdx = chunkData.indexOf('\x00');
                    if (nullIdx !== -1) {
                        const keyword = chunkData.slice(0, nullIdx);
                        const value = chunkData.slice(nullIdx + 1);
                        if (keyword === 'chara') {
                            cardJson = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
                            break;
                        }
                    }
                }
                offset += 12 + chunkLen;
            }
        } catch(e) {}

        if (!cardJson) return pngBuffer; // 카드 파싱 실패시 원본 반환

        // 로어북 병합
        if (lorebook) {
            cardJson.data = cardJson.data || {};
            cardJson.data.character_book = lorebook;
        }
        if (altGreetings.length > 0) {
            cardJson.data = cardJson.data || {};
            cardJson.data.alternate_greetings = altGreetings;
        }

        // 새 chara 청크 생성
        const newCharaBase64 = Buffer.from(JSON.stringify(cardJson), 'utf8').toString('base64');
        const newCharaChunk = makeTEXtChunk('chara', newCharaBase64);

        // 기존 chara 청크를 교체: IEND 직전에 삽입
        const beforeIend = pngBuffer.slice(0, iendIdx);
        const iendChunk = pngBuffer.slice(iendIdx);

        // 기존 chara tEXt 청크 제거 후 재조립
        let cleanPng = removeChunk(pngBuffer.slice(0, iendIdx), 'tEXt', 'chara');
        return Buffer.concat([cleanPng, newCharaChunk, iendChunk]);
    }

    function removeChunk(buf, type, keyword) {
        const out = [buf.slice(0, 8)]; // PNG 시그니처
        let offset = 8;
        while (offset < buf.length - 12) {
            const chunkLen = buf.readUInt32BE(offset);
            const chunkType = buf.slice(offset + 4, offset + 8).toString('ascii');
            let skip = false;
            if (chunkType === type && keyword) {
                const data = buf.slice(offset + 8, offset + 8 + chunkLen).toString('latin1');
                const nullIdx = data.indexOf('\x00');
                if (nullIdx !== -1 && data.slice(0, nullIdx) === keyword) skip = true;
            }
            if (!skip) out.push(buf.slice(offset, offset + 12 + chunkLen));
            offset += 12 + chunkLen;
        }
        return Buffer.concat(out);
    }

    // ✅ 메인 라우트
    router.post('/fetch', async (req, res) => {
        try {
            const { url } = req.body;
            const uuid = extractUuid(url);
            if (!uuid) return res.status(400).json({ success: false, error: 'URL에서 UUID를 찾을 수 없습니다.' });

            // Step 1: PNG URL 확보 (jannyai → datacat 순서로 폴백)
            let downloadUrl;
            try {
                downloadUrl = await tryJannyApi(uuid);
                console.log('[Janitor] ✅ JannyAI에서 URL 획득');
            } catch (e1) {
                console.log(`[Janitor] JannyAI 실패(${e1.message}), datacat 시도...`);
                try {
                    downloadUrl = await tryDatacat(uuid);
                    console.log('[Janitor] ✅ datacat에서 URL 획득');
                } catch (e2) {
                    throw new Error(`두 소스 모두 실패 - JannyAI: ${e1.message} / datacat: ${e2.message}`);
                }
            }

            // Step 2: PNG 다운로드
            let pngBuffer = await downloadPng(downloadUrl);
            console.log(`[Janitor] ✅ PNG 다운로드 완료 (${pngBuffer.length} bytes)`);

            // Step 3: 캐릭터 상세 정보(로어북) 가져와서 PNG에 임베드
            const charDetail = await fetchCharacterDetail(uuid);
            if (charDetail) {
                pngBuffer = embedLorebookIntoPng(pngBuffer, charDetail);
                console.log('[Janitor] ✅ 로어북 임베드 완료');
            } else {
                console.log('[Janitor] ⚠️ 캐릭터 상세정보 없음, 로어북 없이 진행');
            }

            // Step 4: 완성된 PNG를 base64로 프론트에 전달
            res.json({
                success: true,
                pngBase64: pngBuffer.toString('base64'),
                charName: charDetail?.name || charDetail?.character?.name || uuid
            });

        } catch (error) {
            console.error('[Janitor 플러그인 에러]', error.message);
            res.status(500).json({ success: false, error: error.message });
        }
    });
}

module.exports = { init, info };
