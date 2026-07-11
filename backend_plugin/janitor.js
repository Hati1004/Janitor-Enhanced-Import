// 위치: SillyTavern/plugins/janitor.js
const fs   = require('fs');
const path = require('path');
const info = { id: 'janitor', name: 'JanitorAI Proxy', description: 'JannyAI 우회 추출 백엔드' };

// ── CRC32 ────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG tEXt 청크 생성 ───────────────────────────────────────────
function makeTEXtChunk(keyword, text) {
    const typeTag = Buffer.from('tEXt');
    const data    = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0x00]), Buffer.from(text, 'latin1')]);
    const lenBuf  = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf  = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeTag, data])), 0);
    return Buffer.concat([lenBuf, typeTag, data, crcBuf]);
}

// ── PNG 청크 읽기 ────────────────────────────────────────────────
function readAllChunks(pngBuf) {
    const result = [];
    let offset = 8;
    while (offset + 12 <= pngBuf.length) {
        const len  = pngBuf.readUInt32BE(offset);
        const type = pngBuf.slice(offset + 4, offset + 8).toString('ascii');
        const data = pngBuf.slice(offset + 8, offset + 8 + len);
        result.push({ type, len, data, offset });
        if (type === 'IEND') break;
        offset += 12 + len;
    }
    return result;
}

// ── PNG 재조립: 기존 tEXt 청크 교체 + IEND 직전 삽입 ────────────
function rebuildPng(pngBuf, textChunks) {
    const chunks = readAllChunks(pngBuf);
    const replaceKeys = new Set(Object.keys(textChunks));
    const parts = [pngBuf.slice(0, 8)]; // PNG 시그니처

    for (const chunk of chunks) {
        if (chunk.type === 'IEND') {
            // 새 tEXt 청크들을 IEND 직전에 삽입
            for (const [kw, val] of Object.entries(textChunks)) {
                parts.push(makeTEXtChunk(kw, val));
            }
            parts.push(pngBuf.slice(chunk.offset)); // IEND 포함 나머지
            break;
        }
        // 교체 대상 tEXt 청크는 건너뜀
        if (chunk.type === 'tEXt') {
            const nullIdx = chunk.data.indexOf(0x00);
            if (nullIdx !== -1) {
                const kw = chunk.data.slice(0, nullIdx).toString('latin1');
                if (replaceKeys.has(kw)) continue;
            }
        }
        parts.push(pngBuf.slice(chunk.offset, chunk.offset + 12 + chunk.len));
    }
    return Buffer.concat(parts);
}

// ── PNG에서 chara 카드 JSON 읽기 ─────────────────────────────────
// ccv3와 chara 둘 다 읽어서, alternate_greetings가 더 많이 들어있는
// (=더 완전한) 쪽을 우선 사용한다. v3 스펙은 chara에 V2 호환용 축약본을
// 넣고 ccv3에 멀티그리팅 등 전체 데이터를 넣는 경우가 흔하다.
function readCharaCard(pngBuf) {
    const chunks = readAllChunks(pngBuf);
    let charaCard = null;
    let ccv3Card  = null;

    for (const chunk of chunks) {
        if (chunk.type !== 'tEXt') continue;
        const nullIdx = chunk.data.indexOf(0x00);
        if (nullIdx === -1) continue;
        const kw = chunk.data.slice(0, nullIdx).toString('latin1');
        if (kw !== 'chara' && kw !== 'ccv3') continue;
        try {
            const val = chunk.data.slice(nullIdx + 1).toString('latin1');
            const parsed = JSON.parse(Buffer.from(val, 'base64').toString('utf8'));
            if (kw === 'chara') charaCard = parsed;
            else ccv3Card = parsed;
        } catch(e) { /* 해당 청크 건너뜀 */ }
    }

    const agCount = (c) => {
        const ag = c?.data?.alternate_greetings || c?.alternate_greetings || [];
        return Array.isArray(ag) ? ag.length : 0;
    };

    if (ccv3Card && agCount(ccv3Card) >= agCount(charaCard)) {
        console.log(`[Janitor][DEBUG] ccv3 청크 사용 (alternate_greetings ${agCount(ccv3Card)}개, chara청크는 ${agCount(charaCard)}개)`);
        return ccv3Card;
    }
    if (charaCard) {
        console.log(`[Janitor][DEBUG] chara 청크 사용 (alternate_greetings ${agCount(charaCard)}개)`);
        return charaCard;
    }
    return null;
}

// ── V3 카드 → V2 카드 변환 (ST 1.18 호환) ───────────────────────
// ST의 /api/characters/import는 spec_version 2.0만 받음.
// JannyAI/datacat이 V3 스펙이나 camelCase 변형 필드를 줄 수 있어 항상 정규화한다.
function toV2Card(card) {
    if (!card) return null;
    // 표준 chara_card_v2이면서 snake_case data 필드가 실제로 존재할 때만 그대로 반환
    if ((card.spec === 'chara_card_v2' || card.spec_version === '2.0') && card.data && 'first_mes' in card.data) {
        return card;
    }

    const d = card.data || {};
    const pick = (...vals) => {
        for (const v of vals) if (v !== undefined && v !== null) return v;
        return undefined;
    };

    const v2 = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name:                       pick(d.name, card.name, d.characterName, card.characterName)               || '',
            description:                pick(d.description, card.description, d.rawDescription, card.rawDescription) || '',
            personality:                pick(d.personality, card.personality)                                       || '',
            scenario:                   pick(d.scenario, card.scenario)                                             || '',
            first_mes:                  pick(d.first_mes, card.first_mes, d.firstMessage, card.firstMessage)        || '',
            mes_example:                pick(d.mes_example, card.mes_example, d.exampleDialogs, card.exampleDialogs) || '',
            creator_notes:              pick(d.creator_notes, card.creatorcomment, d.creatorNotes, card.creatorNotes) || '',
            system_prompt:              pick(d.system_prompt, card.systemPrompt)                                     || '',
            post_history_instructions:  pick(d.post_history_instructions, card.postHistoryInstructions)             || '',
            tags:                       pick(d.tags, card.tags, d.customTags, card.customTags)                      || [],
            creator:                    pick(d.creator, card.creator, d.creatorName, card.creatorName)              || '',
            character_version:         pick(d.character_version, card.characterVersion)                            || '',
            alternate_greetings:        pick(d.alternate_greetings, card.alternate_greetings, d.altGreetings, card.altGreetings) || [],
            character_book:             pick(d.character_book, card.character_book)                                 || null,
            extensions:                 pick(d.extensions, card.extensions)                                         || {},
        }
    };
    // null인 character_book은 제거
    if (!v2.data.character_book) delete v2.data.character_book;
    return v2;
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

// ── HTML 태그 제거 (description/personality 등에 <p> 등이 섞여 옴) ──
function stripHtml(s) {
    return String(s || '').replace(/<[^>]*>/g, '').trim();
}

function init(router) {
    console.log("================================================");
    console.log("[Janitor 플러그인] 🟢 백엔드 서버 완벽 로드 완료!");
    console.log("================================================");

    // 0-A. 네이티브 JanitorAI 캐릭터 데이터 → V2 카드 변환
    // 주의: 이 API(hampter/characters/{uuid})는 Cloudflare 봇 감지가 걸려 있어
    // 서버(Node fetch)에서 직접 호출하면 토큰이 맞아도 403이 뜬다. 그래서 이 데이터는
    // 프론트엔드(index.js, 실제 브라우저)에서 이미 fetch해온 것을 그대로 받아 변환만 한다.
    // 대부분의 제작자가 비워두므로 기본값(빈 문자열/배열)만 채운다.
    function nativeToV2Card(apiData) {
        return {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name:                       apiData.name || apiData.chat_name || '',
                // 주의: JanitorAI 네이티브 API는 description/personality 필드의 내용물이
                // ST가 기대하는 것과 반대로 들어있다(description에 실제 성격/서사가,
                // personality에 세팅 문구가 들어있는 경우가 확인됨). 그래서 여기서 교차 매핑한다.
                description:                stripHtml(apiData.personality),
                personality:                stripHtml(apiData.description),
                scenario:                   stripHtml(apiData.scenario),
                first_mes:                  stripHtml(apiData.first_message),
                mes_example:                stripHtml(apiData.example_dialogs),
                creator_notes:              apiData.creator_name ? `JanitorAI 원작자: ${apiData.creator_name}` : '',
                system_prompt:              '',
                post_history_instructions:  '',
                tags:                       apiData.custom_tags || apiData.tags || [],
                creator:                    apiData.creator_name || '',
                character_version:          '',
                alternate_greetings:        [],
                character_book:             null,
                extensions:                 {},
            }
        };
    }

    // 아바타(webp) → PNG 변환. sharp가 없으면 명확한 설치 안내와 함께 실패시킨다.
    async function fetchAvatarAsPng(avatarFileName) {
        if (!avatarFileName) throw new Error('네이티브 API 응답에 avatar 파일명이 없습니다.');
        const avatarUrl = `https://ella.janitorai.com/bot-avatars/${avatarFileName}?width=1200`;
        const res = await fetch(avatarUrl, { headers: BROWSER_HEADERS });
        if (!res.ok) throw new Error(`아바타 다운로드 실패 HTTP ${res.status}`);
        const inputBuf = Buffer.from(await res.arrayBuffer());

        let sharp;
        try {
            sharp = require('sharp');
        } catch (e) {
            throw new Error('sharp 모듈이 설치되어 있지 않습니다. 플러그인 폴더(backend_plugin)에서 "npm install sharp" 실행 후 ST를 재시작하세요.');
        }
        return await sharp(inputBuf).png().toBuffer();
    }

    // A. JannyAI API → PNG downloadUrl
    async function tryJannyApi(uuid) {
        const res = await fetch('https://api.jannyai.com/api/v1/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...BROWSER_HEADERS },
            body: JSON.stringify({ characterId: uuid })
        });
        if (!res.ok) throw new Error(`JannyAI HTTP ${res.status}`);
        const data = await res.json();
        console.log('[Janitor][DEBUG] JannyAI 원본 응답 전체:', JSON.stringify(data));
        if (data.status !== 'ok' || !data.downloadUrl) throw new Error('downloadUrl 없음');
        return { downloadUrl: data.downloadUrl, raw: data };
    }

    // B. datacat 익명 다운로드 경로
    async function tryDatacat(uuid) {
        const res = await fetch(`https://datacat.run/retrieve?uuid=${uuid}`, {
            headers: { ...BROWSER_HEADERS, 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error(`datacat HTTP ${res.status}`);
        // 진단용: JSON 파싱 전에 원본 텍스트를 먼저 확보해서 실패 시 그대로 로그로 남긴다.
        const rawText = await res.text();
        let data;
        try {
            data = JSON.parse(rawText);
        } catch (parseErr) {
            console.log(`[Janitor][DEBUG] datacat 응답이 JSON이 아님. 앞부분 300자: ${rawText.slice(0, 300)}`);
            throw parseErr;
        }
        console.log('[Janitor][DEBUG] datacat 원본 응답 전체:', JSON.stringify(data));
        const dlUrl = data.downloadUrl || data.url || data.download_url;
        if (!dlUrl) throw new Error('datacat URL 없음');
        return { downloadUrl: dlUrl, raw: data };
    }

    // E. 메인: PNG 추출
    // 참고: JanitorAI의 로어북(Scripts)과 datacat의 'core' 추출 경로는 모두
    // 로그인 세션(Cloudflare 포함) 인증이 필요해 서버 단독으로는 접근할 수 없는 것이
    // 실측으로 확인되어, 이 기능은 PNG(대체 인사말 포함) 추출에 집중한다.
    async function buildFinalPng(uuid, characterPageUrl, nativeApiData) {
        let avatarPngBuf = null;
        let source = 'unknown';
        let nativeCard = null;

        // 0. 프론트엔드가 이미 브라우저에서 fetch해온 네이티브 캐릭터 데이터가 있으면 그걸 사용.
        // (서버에서 직접 호출하면 Cloudflare 봇 감지에 막히므로, 반드시 브라우저 쪽에서 받아와야 함)
        if (nativeApiData) {
            try {
                if (!nativeApiData.id) throw new Error('전달받은 데이터에 캐릭터 id가 없습니다.');
                nativeCard = nativeToV2Card(nativeApiData);
                avatarPngBuf = await fetchAvatarAsPng(nativeApiData.avatar);
                source = 'native';
                console.log('[Janitor] ✅ 네이티브(브라우저 fetch) 데이터로 카드+아바타 확보 완료');
            } catch (e0) {
                console.log(`[Janitor] 네이티브 데이터 처리 실패(${e0.message}), datacat/JannyAI로 폴백...`);
            }
        }

        // PNG 베이스 이미지 확보(네이티브가 실패했을 때만): datacat(익명) → JannyAI 순으로 시도.
        // 둘 다 캐시 데이터의 완전성이 캐릭터마다 달라, 실패한 쪽으로 자동 폴백한다.
        let downloadUrl = null;
        if (!avatarPngBuf) try {
            const r = await tryDatacat(uuid);
            downloadUrl = r.downloadUrl;
            source = 'datacat';
            console.log('[Janitor] ✅ datacat PNG URL 획득');
        } catch (e1) {
            console.log(`[Janitor] datacat 실패(${e1.message}), JannyAI 시도...`);
            try {
                const r = await tryJannyApi(uuid);
                downloadUrl = r.downloadUrl;
                source = 'janny';
                console.log('[Janitor] ✅ JannyAI PNG URL 획득');
            } catch (e2) {
                console.log(`[Janitor] JannyAI도 실패(${e2.message})`);
            }
        }

        if (downloadUrl) {
            const pngRes = await fetch(downloadUrl, { headers: BROWSER_HEADERS });
            if (pngRes.ok) {
                avatarPngBuf = Buffer.from(await pngRes.arrayBuffer());
                console.log(`[Janitor] ✅ 아바타 PNG ${avatarPngBuf.length} bytes (소스: ${source})`);
            } else {
                console.log(`[Janitor] 아바타 PNG 다운로드 실패 HTTP ${pngRes.status}`);
            }
        }

        if (!avatarPngBuf) {
            throw new Error('PNG 베이스 이미지를 어떤 소스에서도 가져오지 못했습니다.');
        }

        // 네이티브 API로 이미 카드를 만들었으면 그걸 그대로 쓴다.
        // (변환된 아바타 PNG엔 원래 chara/ccv3 청크가 없으므로 다시 읽을 필요가 없음)
        let card;
        if (nativeCard) {
            card = nativeCard;
        } else {
            // PNG에 임베드된 카드 읽기 (chara/ccv3 중 더 완전한 쪽 자동 선택)
            card = readCharaCard(avatarPngBuf);
            if (card) {
                const rawAg = card.data?.alternate_greetings || card.alternate_greetings || [];
                console.log(`[Janitor][DEBUG] PNG 임베드 카드의 alternate_greetings 개수: ${rawAg.length}`);
            } else {
                console.log('[Janitor][DEBUG] PNG에 chara/ccv3 텍스트 청크 자체가 없음');
            }
            card = toV2Card(card);
            if (!card) {
                card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: uuid } };
            }
        }
        console.log(`[Janitor] 카드 변환: spec=${card.spec} v=${card.spec_version} (소스: ${source})`);

        // V2 카드를 PNG에 다시 임베드 (chara + ccv3 둘 다 교체하여 충돌 방지)
        const newB64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
        const pngBuf = rebuildPng(avatarPngBuf, { chara: newB64, ccv3: newB64 });

        return {
            pngBuf,
            charName: card.data.name || uuid
        };
    }

    // ── H. JanitorAI 로어북 엔트리 → ST World Info 변환 ────────────
    // JanitorAI Scripts의 정확한 필드명이 문서화돼 있지 않아, 여러 후보
    // 필드명을 순서대로 확인하는 방어적 매핑을 사용한다.
    function janitorEntriesToWorldInfo(entries) {
        const wiEntries = {};
        entries.forEach((e, idx) => {
            const rawKeys = e.keys ?? e.key ?? e.keywords ?? e.triggers ?? e.trigger_words ?? e.primary_keys ?? [];
            const key = Array.isArray(rawKeys)
                ? rawKeys
                : String(rawKeys || '').split(',').map(s => s.trim()).filter(Boolean);

            wiEntries[String(idx)] = {
                uid: idx,
                key,
                keysecondary: [],
                comment: e.comment || e.name || e.entry_name || '',
                content: stripHtml(e.content || ''),
                constant: !!e.constant,
                selective: true,
                selectiveLogic: 0,
                addMemo: true,
                order: 100,
                position: 0,
                disable: e.enabled === false || e.disabled === true,
                excludeRecursion: false,
                preventRecursion: false,
                delayUntilRecursion: false,
                probability: 100,
                useProbability: true,
                depth: typeof e.depth === 'number' ? e.depth : 4,
                group: e.category || '',
                groupOverride: false,
                groupWeight: typeof e.groupWeight === 'number' ? e.groupWeight : 100,
                scanDepth: null,
                caseSensitive: typeof e.case_sensitive === 'boolean' ? e.case_sensitive : null,
                matchWholeWords: null,
                useGroupScoring: null,
                automationId: '',
                role: null,
                vectorized: false,
                sticky: 0,
                cooldown: 0,
                delay: 0,
                displayIndex: idx
            };
        });
        return { entries: wiEntries };
    }

    // ── F. 안전한 파일명 생성 ────────────────────────────────────
    function sanitizeFileName(name) {
        const cleaned = String(name || 'character')
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .trim()
            .slice(0, 100);
        return cleaned || 'character';
    }

    // ── G. 중복 없는 파일 경로 찾기 ──────────────────────────────
    function getUniquePath(dir, baseName) {
        let candidate = path.join(dir, `${baseName}.png`);
        let n = 1;
        while (fs.existsSync(candidate)) {
            candidate = path.join(dir, `${baseName}_${n}.png`);
            n++;
        }
        return candidate;
    }

    // ── 메인 라우트: 추출만 (다운로드 모드에서 사용) ───────────────
    router.post('/fetch', async (req, res) => {
        try {
            const { url, nativeApiData } = req.body;
            if (!url) return res.status(400).json({ success: false, error: 'URL이 필요합니다.' });

            const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (!m) return res.status(400).json({ success: false, error: 'URL에서 UUID를 찾을 수 없습니다.' });
            const uuid = m[0];

            const { pngBuf, charName } = await buildFinalPng(uuid, url, nativeApiData);

            res.json({
                success:   true,
                pngBase64: pngBuf.toString('base64'),
                charName:  charName
            });

        } catch (err) {
            console.error('[Janitor 플러그인 에러]', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ── 메인 라우트: 추출 + ST characters 폴더에 직접 저장 ─────────
    // ST의 /api/characters/import 를 거치지 않고 파일을 직접 써서
    // "Unsupported format: undefined" 문제를 원천적으로 회피한다.
    router.post('/fetch-and-save', async (req, res) => {
        try {
            const { url, nativeApiData } = req.body;
            if (!url) return res.status(400).json({ success: false, error: 'URL이 필요합니다.' });

            const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (!m) return res.status(400).json({ success: false, error: 'URL에서 UUID를 찾을 수 없습니다.' });
            const uuid = m[0];

            const { pngBuf, charName } = await buildFinalPng(uuid, url, nativeApiData);

            // ST 1.12+ 멀티유저 구조: req.user.directories.characters 가
            // 현재 로그인한 유저의 캐릭터 폴더 절대경로를 제공한다.
            // (단일 유저 모드에서도 default-user 기준으로 채워짐)
            const charactersDir = req.user?.directories?.characters;
            if (!charactersDir) {
                console.error('[Janitor] req.user.directories.characters 를 찾을 수 없음. ST 버전이 너무 오래되었거나 미들웨어 순서 문제일 수 있음.');
                return res.status(500).json({
                    success: false,
                    error: '캐릭터 폴더 경로를 찾을 수 없습니다 (req.user.directories.characters 없음). ST 버전을 확인하세요.'
                });
            }

            if (!fs.existsSync(charactersDir)) {
                fs.mkdirSync(charactersDir, { recursive: true });
            }

            const safeName  = sanitizeFileName(charName);
            const finalPath = getUniquePath(charactersDir, safeName);

            fs.writeFileSync(finalPath, pngBuf);
            console.log(`[Janitor] ✅ 캐릭터 파일 저장 완료: ${finalPath}`);

            res.json({
                success:  true,
                charName: charName,
                fileName: path.basename(finalPath)
            });

        } catch (err) {
            console.error('[Janitor 플러그인 에러]', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });
    // ── 메인 라우트: 로어북(Scripts) 엔트리 → ST World Info로 저장 ──
    router.post('/save-worldbook', async (req, res) => {
        try {
            const { bookName, entries } = req.body;
            if (!Array.isArray(entries) || entries.length === 0) {
                return res.status(400).json({ success: false, error: '엔트리 데이터가 없습니다.' });
            }

            // ST 1.12+ 멀티유저 구조: req.user.directories.worlds
            const worldsDir = req.user?.directories?.worlds;
            if (!worldsDir) {
                console.error('[Janitor] req.user.directories.worlds 를 찾을 수 없음.');
                return res.status(500).json({
                    success: false,
                    error: 'worlds 디렉토리를 찾을 수 없습니다 (req.user.directories.worlds 없음). ST 버전을 확인하세요.'
                });
            }
            if (!fs.existsSync(worldsDir)) fs.mkdirSync(worldsDir, { recursive: true });

            const safeName  = sanitizeFileName(bookName || 'JanitorLorebook');
            let candidate   = path.join(worldsDir, `${safeName}.json`);
            let n = 1;
            while (fs.existsSync(candidate)) {
                candidate = path.join(worldsDir, `${safeName}_${n}.json`);
                n++;
            }

            const wiData = janitorEntriesToWorldInfo(entries);
            fs.writeFileSync(candidate, JSON.stringify(wiData, null, 2));
            console.log(`[Janitor] ✅ 로어북 저장 완료: ${candidate} (엔트리 ${entries.length}개)`);

            res.json({
                success:  true,
                fileName: path.basename(candidate, '.json'),
                count:    entries.length
            });

        } catch (err) {
            console.error('[Janitor 플러그인 에러]', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });
}

module.exports = { init, info };
