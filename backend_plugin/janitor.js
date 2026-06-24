// 위치: SillyTavern/plugins/janitor.js
const info = { id: 'janitor', name: 'JanitorAI Proxy', description: 'JannyAI 우회 추출 백엔드' };

// ── CRC32 순수 구현 ──────────────────────────────────────────────
function makeCrcTable() {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
}
const CRC_TABLE = makeCrcTable();
function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG tEXt 청크 생성 ───────────────────────────────────────────
function makeTEXtChunk(keyword, text) {
    const keyBuf  = Buffer.from(keyword, 'latin1');
    const sep     = Buffer.from([0x00]);
    const valBuf  = Buffer.from(text, 'latin1');
    const typeTag = Buffer.from('tEXt');
    const data    = Buffer.concat([keyBuf, sep, valBuf]);
    const crcVal  = crc32(Buffer.concat([typeTag, data]));
    const lenBuf  = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf  = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal, 0);
    return Buffer.concat([lenBuf, typeTag, data, crcBuf]);
}

// ── PNG에서 tEXt 청크 읽기 ───────────────────────────────────────
function readTEXtChunks(pngBuf) {
    const chunks = {};
    let offset = 8;
    while (offset + 12 <= pngBuf.length) {
        const len       = pngBuf.readUInt32BE(offset);
        const type      = pngBuf.slice(offset + 4, offset + 8).toString('ascii');
        const dataSlice = pngBuf.slice(offset + 8, offset + 8 + len);
        if (type === 'tEXt') {
            const nullIdx = dataSlice.indexOf(0x00);
            if (nullIdx !== -1) {
                const kw  = dataSlice.slice(0, nullIdx).toString('latin1');
                const val = dataSlice.slice(nullIdx + 1).toString('latin1');
                chunks[kw] = val;
            }
        }
        if (type === 'IEND') break;
        offset += 12 + len;
    }
    return chunks;
}

// ── PNG 재조립: 지정 키워드 청크 교체 후 IEND 직전 삽입 ─────────
function rebuildPng(pngBuf, extraChunks) {
    let iendOffset = -1;
    let offset = 8;
    while (offset + 12 <= pngBuf.length) {
        const len  = pngBuf.readUInt32BE(offset);
        const type = pngBuf.slice(offset + 4, offset + 8).toString('ascii');
        if (type === 'IEND') { iendOffset = offset; break; }
        offset += 12 + len;
    }
    if (iendOffset === -1) return pngBuf;

    const keywords = new Set(Object.keys(extraChunks));
    const parts = [pngBuf.slice(0, 8)];
    offset = 8;
    while (offset + 12 <= iendOffset) {
        const len       = pngBuf.readUInt32BE(offset);
        const type      = pngBuf.slice(offset + 4, offset + 8).toString('ascii');
        const dataSlice = pngBuf.slice(offset + 8, offset + 8 + len);
        let skip = false;
        if (type === 'tEXt') {
            const nullIdx = dataSlice.indexOf(0x00);
            if (nullIdx !== -1 && keywords.has(dataSlice.slice(0, nullIdx).toString('latin1'))) skip = true;
        }
        if (!skip) parts.push(pngBuf.slice(offset, offset + 12 + len));
        offset += 12 + len;
    }
    for (const [kw, val] of Object.entries(extraChunks)) {
        parts.push(makeTEXtChunk(kw, val));
    }
    parts.push(pngBuf.slice(iendOffset));
    return Buffer.concat(parts);
}

// ── 로어북 → V2 character_book 포맷 변환 ────────────────────────
function convertLorebook(raw) {
    if (!raw) return null;
    if (raw.entries && Array.isArray(raw.entries)) return raw;
    if (Array.isArray(raw)) {
        return {
            name: '', description: '', scan_depth: 2, token_budget: 2048,
            recursive_scanning: false, extensions: {},
            entries: raw.map((e, i) => ({
                keys:            Array.isArray(e.keys) ? e.keys : (e.key ? [e.key] : []),
                secondary_keys:  [],
                comment:         e.comment || e.name || '',
                content:         e.content || e.value || '',
                constant:        e.constant || false,
                selective:       e.selective || false,
                insertion_order: e.insertion_order ?? i,
                enabled:         e.enabled !== false,
                position:        e.position || 'after_char',
                extensions:      {}
            }))
        };
    }
    return raw;
}

// ── 공통 브라우저 헤더 ───────────────────────────────────────────
const BROWSER_HEADERS = {
    'User-Agent':         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept':             'application/json, text/plain, */*',
    'Accept-Language':    'en-US,en;q=0.9',
    'Origin':             'https://janitorai.com',
    'Referer':            'https://janitorai.com/',
    'sec-ch-ua':          '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile':   '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest':     'empty',
    'Sec-Fetch-Mode':     'cors',
    'Sec-Fetch-Site':     'same-site',
};

function init(router) {
    console.log("================================================");
    console.log("[Janitor 플러그인] 🟢 백엔드 서버 완벽 로드 완료!");
    console.log("================================================");

    // A. JannyAI API → PNG downloadUrl
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

    // B. datacat 폴백
    async function tryDatacat(uuid) {
        const res = await fetch(`https://datacat.run/retrieve?uuid=${uuid}`, {
            headers: { ...BROWSER_HEADERS, 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error(`datacat HTTP ${res.status}`);
        const data = await res.json();
        const dlUrl = data.downloadUrl || data.url || data.download_url;
        if (!dlUrl) throw new Error('datacat에서 URL 없음');
        return dlUrl;
    }

    // C. 캐릭터 상세정보 (여러 엔드포인트 순차 시도)
    async function fetchCharDetail(uuid) {
        const endpoints = [
            // JanitorAI가 실제로 사용하는 내부 API (hampter = 내부 코드명)
            `https://janitorai.com/hampter/characters/${uuid}`,
            `https://janitorai.com/api/v1/characters/${uuid}`,
            `https://janitorai.com/api/characters/${uuid}`,
        ];
        for (const url of endpoints) {
            try {
                const res = await fetch(url, { headers: { ...BROWSER_HEADERS } });
                if (!res.ok) { console.log(`[Janitor] ${url} → HTTP ${res.status}`); continue; }
                const json = await res.json();
                if (json && (json.id || json.uuid || json.name || json.character)) {
                    console.log(`[Janitor] ✅ 캐릭터 상세정보 획득: ${url}`);
                    // 응답 구조 로깅 (디버그용)
                    const topKeys = Object.keys(json).join(', ');
                    console.log(`[Janitor] 응답 키: ${topKeys}`);
                    return json;
                }
            } catch (e) {
                console.log(`[Janitor] ${url} 오류: ${e.message}`);
            }
        }
        return null;
    }

    // D. PNG에 로어북/대체인사말 임베드
    function embedIntoCard(pngBuf, charDetail) {
        if (!charDetail) return pngBuf;

        const existing = readTEXtChunks(pngBuf);
        let cardJson = null;
        if (existing.chara) {
            try {
                cardJson = JSON.parse(Buffer.from(existing.chara, 'base64').toString('utf8'));
            } catch (e) {
                console.log('[Janitor] ⚠️ 기존 chara 파싱 실패:', e.message);
            }
        }
        if (!cardJson) {
            cardJson = { spec: 'chara_card_v2', spec_version: '2.0', data: {} };
        }
        cardJson.data = cardJson.data || {};

        // JanitorAI 응답 구조는 { character: {...}, lorebook: [...] } 또는 평탄한 구조
        const c   = charDetail.character || charDetail;
        const raw = c.lorebook || c.world_info || c.lore_items
                 || charDetail.lorebook || charDetail.world_info || charDetail.lore_items;

        if (raw) {
            const book = convertLorebook(raw);
            if (book) {
                cardJson.data.character_book = book;
                console.log(`[Janitor] ✅ 로어북 임베드 완료 (항목 ${book.entries?.length ?? 0}개)`);
            }
        } else {
            console.log('[Janitor] ℹ️ 공개 로어북 없음');
        }

        const alt = c.alternate_greetings || charDetail.alternate_greetings || [];
        if (alt.length > 0) {
            cardJson.data.alternate_greetings = alt;
            console.log(`[Janitor] ✅ 대체 인사말 ${alt.length}개 임베드`);
        }

        if (!cardJson.data.name) cardJson.data.name = c.name || charDetail.name || '';

        const newB64 = Buffer.from(JSON.stringify(cardJson), 'utf8').toString('base64');
        return rebuildPng(pngBuf, { chara: newB64 });
    }

    // ── 메인 라우트 ───────────────────────────────────────────────
    router.post('/fetch', async (req, res) => {
        try {
            const { url } = req.body;
            const m = url && url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (!m) return res.status(400).json({ success: false, error: 'URL에서 UUID를 찾을 수 없습니다.' });
            const uuid = m[0];

            // 1. PNG URL 획득
            let downloadUrl, source = 'janny';
            try {
                downloadUrl = await tryJannyApi(uuid);
                console.log('[Janitor] ✅ JannyAI에서 URL 획득');
            } catch (e1) {
                console.log(`[Janitor] JannyAI 실패(${e1.message}), datacat 시도...`);
                try {
                    downloadUrl = await tryDatacat(uuid);
                    source = 'datacat';
                    console.log('[Janitor] ✅ datacat에서 URL 획득');
                } catch (e2) {
                    throw new Error(`두 소스 모두 실패 — JannyAI: ${e1.message} / datacat: ${e2.message}`);
                }
            }

            // 2. PNG 다운로드
            const pngRes = await fetch(downloadUrl, { headers: BROWSER_HEADERS });
            if (!pngRes.ok) throw new Error(`PNG 다운로드 실패 HTTP ${pngRes.status}`);
            let pngBuf = Buffer.from(await pngRes.arrayBuffer());
            console.log(`[Janitor] ✅ PNG 다운로드 완료 (${pngBuf.length} bytes, 소스: ${source})`);

            // 3. 캐릭터 상세정보 조회 + 로어북 임베드
            const charDetail = await fetchCharDetail(uuid);
            pngBuf = embedIntoCard(pngBuf, charDetail);

            // 4. 결과 반환
            res.json({
                success:   true,
                pngBase64: pngBuf.toString('base64'),
                charName:  charDetail?.character?.name || charDetail?.name || uuid
            });

        } catch (err) {
            console.error('[Janitor 플러그인 에러]', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });
}

module.exports = { init, info };
