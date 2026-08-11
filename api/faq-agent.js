// ============================================================================
//  KECSKEMÉT KLÍMA — Árajánló asszisztens (air-conditioning quoting agent)
//  - AI provider: OpenAI or Gemini (AI_PROVIDER in .env) — drives the Hungarian
//    conversation only.
//  - Pricing is computed DETERMINISTICALLY in this backend from the PRICES table
//    below. The AI never does arithmetic, so the total can never be miscalculated.
//  - The AI maintains a hidden running-state block (<!--DATA:{...}-->). We parse
//    it, price it, e-mail the owner, log the lead, and return the itemised
//    estimate to show the customer.
// ============================================================================

// ---------------------------------------------------------------------------
//  PRICE TABLE (HUF) — single source of truth. Edit numbers here only.
//  Source: the company's own price list (client-supplied).
// ---------------------------------------------------------------------------
const PRICES = {
    // Klímaberendezés ára a fűtendő/hűtendő helyiség mérete szerint.
    room_size: {
        s_0_15:    { huf: 200000, label: "Klímaberendezés — 0–15 m² helyiséghez" },
        s_15_30:   { huf: 250000, label: "Klímaberendezés — 15–30 m² helyiséghez" },
        s_30_plus: { huf: 380000, label: "Klímaberendezés — 30 m² feletti helyiséghez" },
        // Ha nem tudja a méretet, a KÖZÉPSŐ sávval számolunk. Szándékosan nem a
        // legolcsóbbal: egy alálőtt becslés a felmérésnél kellemetlen meglepetés.
        nem_tudom: { huf: 250000, label: "Klímaberendezés — 15–30 m² (alap becslés, a felmérésnél pontosítjuk)" },
    },
    // Mindig felszámolt, egységes tétel.
    standard: {
        installation: { huf: 100000, label: "Klíma telepítés (egységes díj)" },
    },
};

// A feltüntetett árak BRUTTÓK (ÁFA-val) és tartalmazzák a készüléket is.
// Ha a kliens később nettóra váltana, csak ezt a kettőt kell átírni.
const VAT_INCLUDED = true;
const PRICE_NOTE = VAT_INCLUDED ? "(bruttó, ÁFÁ-val)" : "(nettó ár, ÁFA nélkül)";

// Offer to e-mail the quote to the CUSTOMER. Requires a real Resend key + a
// VERIFIED sending domain — until that exists, sending fails and the customer
// would see an error, so keep this OFF. The owner still gets notified
// internally. Flip on with EMAIL_OFFER=on in .env once the domain is live.
const EMAIL_OFFER_ENABLED =
    (process.env.EMAIL_OFFER || "").toLowerCase() === "on";

const PHONE = "+36 30 260 57 56";
const COMPANY_EMAIL = "info@kecskemetklima.hu";
const BRAND = "Kecskemét Klíma";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
function formatHuf(n) {
    // 200000 -> "200 000 Ft"
    return n.toLocaleString("hu-HU").replace(/ /g, " ") + " Ft";
}

// Build the itemised quote deterministically from the AI's structured answers.
// Két tétel, mindig: a készülék (helyiségméret szerint) + az egységes telepítés.
function buildQuote(sel) {
    const items = [];
    const add = (entry) => { if (entry) items.push({ label: entry.label, huf: entry.huf }); };

    add(PRICES.room_size[sel.room_size] || PRICES.room_size.nem_tudom);
    add(PRICES.standard.installation);

    const total = items.reduce((s, i) => s + i.huf, 0);
    return { items, total };
}

// Backend decides when the quote is complete — independent of the AI model.
function isQuoteReady(s) {
    if (!s || typeof s !== "object") return false;
    const filled = (k) => s[k] != null && String(s[k]).trim() !== "";
    return REQUIRED_FIELDS.every(filled);
}

// Quick-reply buttons for each choice question — decided by the BACKEND from the
// current state, so the right buttons always appear (not reliant on the model).
const CHIP_MAP = {
    room_size: ["0–15 m²", "15–30 m²", "30 m² felett", "Nem tudom pontosan"],
};

// Order the questions are asked in: the single project question first, then the
// contact details. (A kliens kérésére nincs több projektkérdés.)
const FIELD_ORDER = ["room_size", "name", "email", "phone", "postal_code"];
const REQUIRED_FIELDS = FIELD_ORDER;

// Progress bar: with a single project question the bar would jump 0% -> 100%
// instantly, so the contact steps count toward it too and it fills gradually.
const PROGRESS_FIELDS = FIELD_ORDER;

// Maps a clicked chip label -> its canonical value, per field. Lets the BACKEND
// record an answer the instant it arrives, without waiting for the model's
// (one-step-behind) state block. Keys are the exact CHIP_MAP labels, lowercased.
const CHIP_VALUES = {
    room_size: {
        "0–15 m²": "s_0_15",
        "15–30 m²": "s_15_30",
        "30 m² felett": "s_30_plus",
        "nem tudom pontosan": "nem_tudom",
    },
};

// The first still-unanswered field given the current state (= the question the
// customer is being asked right now). Returns null when everything is filled.
function pendingField(sel) {
    const filled = (k) => sel && sel[k] != null && String(sel[k]).trim() !== "";
    for (const f of FIELD_ORDER) {
        if (!filled(f)) return f;
    }
    return null;
}

// Parse a free-typed Hungarian room size into m². Handles e.g. "20 nm",
// "20 m2", "20 négyzetméter", "kb 25", "4x5", "4,5 x 6 méter". Returns null if
// no plausible area is found. Doing this in the BACKEND (not in the model) keeps
// the band selection deterministic.
function parseAreaM2(text) {
    if (typeof text !== "string") return null;
    const t = text.toLowerCase().replace(/\s+/g, " ").trim();

    // "4x5", "4,5 x 6" — a room given by its dimensions.
    const dim = t.match(/(\d+(?:[.,]\d+)?)\s*(?:x|\*|szer)\s*(\d+(?:[.,]\d+)?)/);
    if (dim) {
        const a = parseFloat(dim[1].replace(",", "."));
        const b = parseFloat(dim[2].replace(",", "."));
        if (!isNaN(a) && !isNaN(b)) {
            const area = a * b;
            if (area > 1 && area < 500) return area;
        }
    }

    // "20 nm", "20 m2", "20 m²", "20 négyzetméter" — or just a bare number.
    const m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:nm|m2|m²|n[ée]gyzetm[ée]ter)?/);
    if (m && m[1]) {
        const n = parseFloat(m[1].replace(",", "."));
        // A plausible room is between 2 and 500 m². Anything else is noise.
        if (!isNaN(n) && n >= 2 && n < 500) return n;
    }
    return null;
}

// Put an m² value into the right price band.
function bucketArea(area) {
    if (area == null) return null;
    if (area <= 15) return "s_0_15";
    if (area <= 30) return "s_15_30";
    return "s_30_plus";
}

// Given the field the customer is answering + their message, return the canonical
// value. Choice fields match the clicked chip label (case-insensitive); contact
// fields take the text as-is. Room size also accepts a typed area or dimensions.
// Returns null if it can't be mapped so we fall back to the model's value.
function mapAnswer(field, answer) {
    if (typeof answer !== "string" || !answer.trim()) return null;
    const a = answer.trim();
    if (field === "room_size") {
        // Exact chip label first, otherwise parse a typed size into a band.
        return CHIP_VALUES.room_size[a.toLowerCase()] || bucketArea(parseAreaM2(a));
    }
    if (CHIP_VALUES[field]) {
        return CHIP_VALUES[field][a.toLowerCase()] || null;
    }
    // free-text contact fields
    if (["name", "email", "phone", "postal_code"].includes(field)) return a;
    return null;
}

// Parse the hidden running-state block out of any assistant message.
function extractData(text) {
    if (typeof text !== "string") return null;
    const m = text.match(/<!--DATA:(.*?)-->/s);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
}

// Merge several state objects, keeping the last NON-EMPTY value per field.
// This makes the state immune to the model blanking a field in a single turn:
// once a value is set, a later empty value can't erase it (a real change to a
// new non-empty value still overrides).
function mergeState(...states) {
    const out = {};
    for (const s of states) {
        if (!s || typeof s !== "object") continue;
        for (const k of Object.keys(s)) {
            const v = s[k];
            if (v != null && String(v).trim() !== "") out[k] = v;
        }
    }
    return out;
}

function nextChips(sel) {
    const f = pendingField(sel);
    return f ? (CHIP_MAP[f] || []) : [];
}

// Human-readable Hungarian labels for the recap of what the customer chose.
const LABELS = {
    room_size: {
        s_0_15: "0–15 m²",
        s_15_30: "15–30 m²",
        s_30_plus: "30 m² felett",
        nem_tudom: "Nem tudja pontosan (alap: 15–30 m²)",
    },
};
const lbl = (group, key) => (LABELS[group] && LABELS[group][key]) || key || "—";

// Drop any choice-field value the model invents that isn't a known canonical
// value. Free-text fields are untouched.
function sanitizeChoices(s) {
    if (!s || typeof s !== "object") return s;
    for (const field of Object.keys(LABELS)) {
        const v = s[field];
        if (v != null && String(v).trim() !== "" && !(String(v) in LABELS[field])) {
            delete s[field];
        }
    }
    return s;
}

// Customer-facing estimate. Returns sections split by [[SPLIT]] so the widget
// renders them as separate, easy-to-read chat bubbles. Numbers come from buildQuote.
function renderCustomerQuote(quote, sel) {
    const items = quote.items.map(i => `• ${i.label} — **${formatHuf(i.huf)}**`).join("\n");

    // Bubble 1 — the price
    const priceBubble = [
        `Köszönöm, ${sel.name || ""}! Íme az előzetes árajánlata. 🙏`,
        ``,
        `**Tételek:**`,
        items,
        ``,
        `**Becsült végösszeg: ${formatHuf(quote.total)}** ${PRICE_NOTE}`,
    ].join("\n");

    // Bubble 2 — "just an estimate" note
    const noteBubble = [
        `ℹ️ Ez csak egy **előzetes, tájékoztató becslés** — a végleges ár az **ingyenes, kötelezettségmentes helyszíni felmérés** után pontosul.`,
        `Az ár tartalmazza a klímaberendezést és a telepítést; a pontos márka/típus a felmérésnél dől el. Minden munkára számlát és jótállást adunk.`,
    ].join("\n");

    // Bubble 3 — recap of everything the customer said
    const recapLines = [`**Az Ön válaszai:**`];
    recapLines.push(`• Helyiség mérete: ${lbl("room_size", sel.room_size)}`);
    recapLines.push(`• Név: ${sel.name || "—"}`);
    recapLines.push(`• E-mail: ${sel.email || "—"}`);
    recapLines.push(`• Telefon: ${sel.phone || "—"}`);
    recapLines.push(`• Irányítószám: ${sel.postal_code || "—"}`);
    recapLines.push(``);
    recapLines.push(`Az adatait továbbítottuk a Kecskemét Klímához — hamarosan keressük! 📞 ${PHONE}`);
    if (EMAIL_OFFER_ENABLED) {
        recapLines.push(``);
        recapLines.push(`Szeretné, hogy e-mailben is elküldjük az ajánlatot?`);
    }

    return [priceBubble, noteBubble, recapLines.join("\n")].join("\n[[SPLIT]]\n");
}

// ---------------------------------------------------------------------------
//  System prompt (Hungarian) — conversation + structured output contract
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `SZEMÉLYISÉG
Te a "Kecskemét Klíma" digitális árajánló asszisztense vagy. Klímaszereléssel, karbantartással és javítással foglalkozó szakember nevében beszélsz. Kizárólag MAGYARUL válaszolj.

HANGNEM
- Udvarias, közvetlen, szakértő és tömör. Lehetőleg 40 szó alatt válaszolj.
- Egyszerre EGY kérdést tegyél fel. Sose kérdezz több dolgot egyszerre.
- Sose találgass árat és sose számolj — az árat a rendszer számolja ki a végén.

TUDÁSBÁZIS — A CÉGRŐL (csak akkor használd, ha az ügyfél KÖZBEN kérdez valamit — utána MINDIG térj vissza a soron következő kérdéshez, ugyanabban a válaszban)
- Cég/szakember: Polyák Zoltán klímaszerelő mester, 15+ év fűtés- és klímatechnikai tapasztalattal. A szakmát fűtés- és gázkészülékek szerelésével kezdte, onnan bővült a klímatechnika felé. Nem alvállalkozókkal dolgozik: ugyanaz a szakember mér fel, telepít és üzemel be, akivel az ügyfél az elején beszél.
- Elérhetőségek: telefon ${PHONE}, e-mail ${COMPANY_EMAIL}, cím 6000 Kecskemét, Számadó u. 25.
- Nyitvatartás: hétfő–péntek 08:00–17:00, hétvégén zárva.
- Szolgáltatási terület: Kecskemét és kb. 30 km-es körzete — pl. Lajosmizse, Kerekegyháza, Helvécia, Ballószög, Nyárlőrinc, Kiskunfélegyháza, Városföld, Kadafalva, Nagykőrös. Ha bizonytalan a cím, mondd: telefonon gyorsan tisztázzák.
- Számokban: 200+ telepített klíma, 15+ év tapasztalat, 4.8-as Google-értékelés, prémium készülékeknél akár 10 év garancia.
- Képesítés: F-gázos jogosultság (a hűtőközeggel végzett munkát jogszabály szerint csak ilyen jogosultsággal lehet végezni), szakképzett klímaszerelő mester.
- Szolgáltatások: (1) klíma telepítés — split és multi-split rendszerek lakásba, házba, irodába, esztétikus, rejtett vezetékezéssel, máshol vásárolt klíma felszerelése és meglévő áthelyezése is; (2) karbantartás és tisztítás — fertőtlenítés, szűrőellenőrzés és -csere, hűtőközeg-szint ellenőrzés, penész- és baktériummentesítés; (3) javítás és hibakeresés — hibakód-diagnosztika, hűtőközeg-utántöltés, szivárgáskeresés, alkatrészcsere garanciával; (4) beüzemelés és szivárgáskezelés — vákuumozás, pontos gáztöltés, szivárgásvizsgálat és -kezelés.
- Márkák (márkafüggetlen): Daikin, Mitsubishi Electric, Toshiba, Panasonic, LG, Samsung, Gree, Fujitsu, Midea, AUX, Polar.
- Árazás elve: a munka megkezdése előtt pontos, tételes és átlátható árajánlat, rejtett költség nincs; minden munkára számla és írásos jótállás jár. A helyszíni felmérés INGYENES és kötelezettségmentes.
- Folyamat: 1) kapcsolatfelvétel, 2) felmérés és árajánlat, 3) kivitelezés a megbeszélt időpontban, 4) átadás — a működés bemutatása, számla és jótállás.

GYAKORI KÉRDÉSEK (ha rákérdeznek, ezekből válaszolj röviden, majd térj vissza a következő kérdésre)
- Ingyenes a felmérés? Igen, teljesen ingyenes és kötelezettségmentes; utána adunk pontos, tételes árajánlatot.
- Mennyi ideig tart a telepítés? Egy átlagos split klíma szakszerű telepítése jellemzően néhány óra; multi-split rendszernél több. A pontos idő a helyszíni adottságoktól és a csővezeték hosszától függ.
- Milyen gyakran kell karbantartani? Ajánlott évente legalább egyszer, a szezon előtt — higiénikus levegő, alacsonyabb áramfogyasztás, hosszabb élettartam.
- Miért nem hűt eléggé a klíma? Leggyakrabban elszivárgott a hűtőközeg egy része, vagy eltömődött, koszos szűrő és párologtató akadályozza a légáramlást. Helyszíni bevizsgálás és nyomásmérés mutatja meg pontosan.
- Miből tudom, hogy kevés a gáz? Egyre gyengébb hűtés, dér vagy jég a beltéri egység csövein, sziszegő hang, hibakód. Biztosat csak nyomásméréssel lehet mondani. A gáz nem fogy el magától — ha kevés, az szinte mindig szivárgás, ezért utántöltés előtt MINDIG szivárgásvizsgálat kell.
- Meg tudom javítani házilag? A szűrők kimosása és a beltéri egység letörlése nyugodtan elvégezhető otthon. A hűtőközeggel járó munka (szivárgáskeresés, gáztöltés, vákuumozás) F-gáz képesítést és műszereket igényel — jogszabály szerint is csak szakember végezheti.
- Csöpög a klíma, mit tegyek? Legtöbbször eldugult kondenzvíz-elvezetés. Kapcsolja ki a klímát, hogy ne folyjon tovább a víz, és hívjon minket — karbantartás keretében átmossuk az elvezetőt és a csepptálcát, ellenőrizzük a lejtést.
- Felszerelik a máshol vásárolt klímát? Igen. Áthelyezést is vállalunk: leszerelés, új helyen felszerelés, vákuumozás, feltöltés, szivárgásvizsgálat.
- Végeznek szivárgásvizsgálatot? Igen — elektronikus szivárgáskereséssel és nyomáspróbával. Előbb megszüntetjük a szivárgás okát, és csak tömör rendszert töltünk fel.
- Garancia és számla? Minden elvégzett munkára jótállást és számlát adunk. Prémium klímákra a gyártói feltételek teljesülése esetén akár 10 év garancia is igényelhető.
- Mennyi idő alatt tudnak kijönni? Kecskeméten és 30 km-es körzetében rövid határidővel vállaljuk a kiszállást — a pontos időpontért érdemes telefonálni.

CÉL
Az ügyfélnek ÚJ KLÍMA TELEPÍTÉSÉRE adsz előzetes árajánlatot. Ehhez mindössze EGY dolgot kell megtudnod a projektről (a helyiség méretét), majd elkéred az elérhetőségeit. FONTOS: a rendszer már köszöntötte az ügyfelet — NE köszönj újra, rögtön az 1. kérdéssel kezdj.

MÁS SZOLGÁLTATÁSOK (karbantartás, tisztítás, javítás, beüzemelés)
Ezekre NINCS előre kalkulált ár — ilyet SOSE mondj. Ha az ügyfél ilyet kér:
- Válaszolj röviden a fenti tudásbázisból (mit tartalmaz, mire számítson).
- Mondd el, hogy ezekre a pontos árat a szakember a helyszínen / telefonon adja meg, és a felmérés ingyenes.
- Ezután kérdezd meg, szeretné-e, hogy visszahívjuk — és kérd el az elérhetőségeit (név, e-mail, telefon, irányítószám) egyesével, ugyanúgy, mint lent. A telepítési kérdést (helyiség mérete) ilyenkor is tedd fel, hogy teljes képünk legyen — ha az ügyfél nem érintett benne, fogadd el a "Nem tudom pontosan" választ és lépj tovább.

KÖZÉRTHETŐSÉG (nagyon fontos!)
Az ügyfél laikus, nem szakember. Egyszerűen, hétköznapi nyelven kérdezz, és a szakszavakat MINDIG magyarázd el egy rövid, zárójeles mondattal. Ha az ügyfél nem ért valamit, magyarázd el türelmesen, hétköznapi példával.

KÉRDÉSEK SORRENDJE (egyesével, mindig csak EGY kérdés!)
1. room_size — "Mekkora helyiségbe szeretné a klímát?" Ha az ügyfél nem tudja a négyzetmétert, segíts: kérdezd meg, nagyjából hány méter hosszú és hány méter széles a helyiség, vagy hasonlítsd hétköznapi példához (egy átlagos hálószoba kb. 12–15 m², egy tágas nappali 30 m² felett is lehet). Értékek: "s_0_15" (0–15 m²), "s_15_30" (15–30 m²), "s_30_plus" (30 m² felett), "nem_tudom". Ha konkrét méretet vagy szobaméretet mond (pl. "20 nm", "4x5 méter"), a rendszer besorolja — te csak fogadd el és lépj tovább.

ELÉRHETŐSÉGEK — CSAK az 1. kérdés UTÁN kérd el ezeket, az árajánlat elküldéséhez és a visszahíváshoz. A 2. kérdés ELŐTT írj egy rövid átvezető mondatot, pl.: "Köszönöm! Hogy elküldhessük a személyre szabott árajánlatot és felvehessük Önnel a kapcsolatot, kérek még pár adatot." Utána KÜLÖN-KÜLÖN, egyesével kérdezd (ezeknél NINCS gomb, szabad szöveg), és minden kérdésnél mondd meg RÖVIDEN, miért kéred:
2. name — "Kérem a nevét — kinek címezzük az árajánlatot?"
3. email — "Mi az e-mail címe? Erre küldjük el az árajánlatot."
4. phone — "Mi a telefonszáma? Ezen a számon hívjuk vissza a részletekkel."
5. postal_code — "Mi az irányítószáma? Ez alapján tudjuk az ingyenes felmérést egyeztetni."

MEGJEGYZÉS: A telepítés díját NE kérdezd meg és ne is részletezd — egységes díj, a rendszer automatikusan hozzáadja az ajánlathoz.

SZABÁLYOK
- Az ügyfél írhat szabad szöveggel is — értelmezd a válaszát és rendeld hozzá a megfelelő értéket.
- Ha egy válasz nem egyértelmű, EGYSZER kérdezz vissza, utána lépj tovább.
- Ne ígérj fix időpontot. Árat ne mondj a folyamat közben.
- Ha olyat kérdeznek, ami nincs a tudásbázisban (pl. pontos ár egy konkrét javításra, aznapi időpont), ne találgass: irányítsd telefonra (${PHONE}), vagy mondd, hogy a felmérésnél pontosítjuk.

REJTETT ÁLLAPOT (KÖTELEZŐ MINDEN VÁLASZBAN)
MINDEN egyes válaszod legvégére tedd ki az eddig ismert adatokat ebben a rejtett blokkban (az ügyfél NEM látja). A még meg nem kérdezett mezők értéke üres string (""). SOSE találgass — csak azt töltsd ki, amit az ügyfél ténylegesen megválaszolt:
<!--DATA:{"room_size":"","name":"","email":"","phone":"","postal_code":""}-->
A blokkban MINDEN kulcs mindig szerepeljen, csak az értékeket töltsd. Engedélyezett értékek: room_size: s_0_15|s_15_30|s_30_plus|nem_tudom. A többi (name, email, phone, postal_code) szabad szöveg.
Amikor minden szükséges mező megvan, írj egy RÖVID lezáró mondatot (pl. "Köszönöm, összeállítom az árajánlatot!") — és továbbra is tedd ki a teljes, kitöltött DATA blokkot. Az árat NE te írd ki; a rendszer számolja és mutatja.
A választógombokat a rendszer automatikusan megjeleníti — neked nem kell gombokat kiírnod.`;

// ---------------------------------------------------------------------------
//  AI providers — each takes normalized messages and returns { ok, text, error }
// ---------------------------------------------------------------------------
async function callOpenAI(messages) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { ok: false, error: "Missing OPENAI_API_KEY" };
    try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
                messages,
                temperature: 0.4,
                max_tokens: 500,
            }),
        });
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        if (text) return { ok: true, text };
        return { ok: false, error: data.error?.message || JSON.stringify(data) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function callGemini(messages) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { ok: false, error: "Missing GEMINI_API_KEY" };
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const systemMsg = messages.find(m => m.role === "system");
    const contents = messages
        .filter(m => m.role !== "system")
        .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    system_instruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
                    contents,
                    generationConfig: {
                        temperature: 0.4,
                        maxOutputTokens: 1000,
                        // gemini-2.5-flash is a "thinking" model: its internal
                        // reasoning tokens count against maxOutputTokens and were
                        // starving the visible answer (messages cut off mid-word).
                        // This bot follows a fixed script — no reasoning needed —
                        // so disable thinking. Faster, cheaper, and no truncation.
                        thinkingConfig: { thinkingBudget: 0 },
                    },
                }),
            }
        );
        const data = await res.json();
        const cand = data.candidates?.[0];
        // Join every text part (defensive — normally there is just one).
        const text = (cand?.content?.parts || [])
            .map(p => p?.text || "")
            .join("");
        if (cand?.finishReason === "MAX_TOKENS") {
            console.warn("Gemini hit MAX_TOKENS — answer may be truncated.");
        }
        if (text) return { ok: true, text };
        return { ok: false, error: data.error?.message || JSON.stringify(data) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ---------------------------------------------------------------------------
//  Handler
// ---------------------------------------------------------------------------
export default async function handler(request, response) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

    if (request.method === "OPTIONS") {
        return response.status(200).end();
    }

    try {
        const { question, history, action, lead, state } = request.body || {};

        // --- ACTION: customer asked us to e-mail them the quote ---
        if (action === "email_customer" && lead?.sel && lead?.quote) {
            const ok = await sendQuoteEmail(lead.sel, lead.quote, {
                to: lead.sel.email,
                toCustomer: true,
            });
            return response.status(200).json({
                answer: ok
                    ? `Elküldtük az árajánlatot a megadott e-mail címre (${lead.sel.email}). 📧 Ha nem találja, nézze meg a Spam mappát is.`
                    : `Sajnos most nem sikerült e-mailt küldeni, de kollégánk hamarosan keresi Önt. 📞 ${PHONE}`,
                chips: [],
            });
        }

        // Normalized message list: [{ role: "system"|"user"|"assistant", content }]
        // The widget sends history as [{ role: "user"|"assistant", content }].
        const messages = [{ role: "system", content: SYSTEM_PROMPT }];
        if (Array.isArray(history) && history.length > 0) {
            for (const m of history) {
                if (m && m.role && typeof m.content === "string") {
                    messages.push({ role: m.role === "model" ? "assistant" : m.role, content: m.content });
                }
            }
        } else if (question) {
            messages.push({ role: "user", content: question });
        }

        // Provider is switchable via .env (AI_PROVIDER=openai | gemini).
        const provider = (process.env.AI_PROVIDER || "openai").toLowerCase();
        const result = provider === "gemini"
            ? await callGemini(messages)
            : await callOpenAI(messages);

        if (!result.ok) {
            console.error(`[${provider}] API Error:`, result.error);
            return response.status(200).json({ answer: "Elnézést, most nem érem el az asszisztenst. Kérem, próbálja újra." });
        }

        let aiAnswer = result.text;
        if (!aiAnswer) {
            return response.status(200).json({ answer: "Értem, de ezt nem sikerült feldolgoznom. Megfogalmazná másképp?" });
        }

        // --- STATE: extract the running DATA block from THIS message ... ---
        let currentSel = null;
        const dataMatch = aiAnswer.match(/<!--DATA:(.*?)-->/s);
        if (dataMatch) {
            try { currentSel = sanitizeChoices(JSON.parse(dataMatch[1])); }
            catch (e) { console.error("DATA parse fail:", e.message); }
            aiAnswer = aiAnswer.replace(/<!--DATA:.*?-->/s, "").trim();
        }

        // ... then merge it onto the accumulated state. The widget carries this
        // state back to us each turn (`state`), because the chat history it stores
        // has the DATA block stripped out — so a single turn that drops a field
        // can never wipe an answer the customer already gave. Chips + completion
        // are decided from this stable, accumulated state, not one model turn.
        // (history DATA blocks are also merged as a harmless fallback.)
        const priorSel = Array.isArray(history)
            ? history
                .filter((m) => m && (m.role === "assistant" || m.role === "model"))
                .map((m) => extractData(m.content))
            : [];

        // Accumulated state BEFORE this turn's answer is applied.
        const baseSel = mergeState(state, ...priorSel);

        // Deterministically record the answer the customer just gave into the
        // field they were being asked — so the chips advance immediately and
        // don't lag a step behind the model's (one-turn-late) state block.
        const determined = {};
        const pending = pendingField(baseSel);
        if (pending) {
            const v = mapAnswer(pending, question);
            if (v) determined[pending] = v;
        }

        // Final state, by ascending trust: the model's own block (currentSel)
        // is LEAST trusted — it can hallucinate or drop fields — so it only
        // fills genuine gaps. The accumulated state (baseSel) overrides it, and
        // this turn's deterministically-mapped answer (determined) wins outright.
        const sel = mergeState(currentSel, baseSel, determined);

        // Progress for the widget's progress bar.
        const progressTotal = PROGRESS_FIELDS.length;
        const progress = PROGRESS_FIELDS.filter(
            (f) => sel[f] != null && String(sel[f]).trim() !== ""
        ).length;

        // --- COMPLETION CHECK (backend-decided, model-independent) ---
        if (isQuoteReady(sel)) {
            const quote = buildQuote(sel);

            console.log("\n========================================");
            console.log("🎯 ÚJ ÁRAJÁNLAT / LEAD");
            console.log(`Ügyfél: ${sel.name} | ${sel.phone} | ${sel.email}`);
            console.log(`Irsz.: ${sel.postal_code} | Helyiség: ${lbl("room_size", sel.room_size)}`);
            console.log(`Becsült végösszeg: ${formatHuf(quote.total)}`);
            console.log("========================================\n");

            // Always notify the owner + log the lead into the Google Sheet.
            // Run both in parallel; neither blocks the other or the response.
            await Promise.all([
                sendQuoteEmail(sel, quote, { to: process.env.LEAD_EMAIL_TO || "pirint.milan@gmail.com", toCustomer: false }),
                sendLeadToSheet(sel, quote),
            ]);

            // Show the itemised quote in chat + offer to e-mail it to the customer.
            return response.status(200).json({
                answer: renderCustomerQuote(quote, sel),
                chips: [],
                emailOffer: EMAIL_OFFER_ENABLED,
                lead: { sel, quote },
                state: sel,
                progress: progressTotal,
                progressTotal,
            });
        }

        // Strip any chips marker the model may still emit (we compute chips ourselves).
        aiAnswer = aiAnswer.replace(/<!--CHIPS:.*?-->/s, "").trim();

        // --- QUICK-REPLY CHIPS (backend-decided, reliable) ---
        const chips = nextChips(sel);

        return response.status(200).json({ answer: aiAnswer, chips, state: sel, progress, progressTotal });

    } catch (error) {
        console.error("Function Crash:", error.message);
        return response.status(500).json({ answer: "Elnézést, a szerver épp akadozik. Kérem, próbálja újra kicsit később." });
    }
}

// ---------------------------------------------------------------------------
//  E-mail (Resend). opts = { to, toCustomer }. Returns true on success.
//  - owner mail: full client details + quote
//  - customer mail: friendly "your quote" version
// ---------------------------------------------------------------------------
async function sendQuoteEmail(sel, quote, opts = {}) {
    const resendKey = process.env.RESEND_API_KEY;
    const toEmail = opts.to || process.env.LEAD_EMAIL_TO || "pirint.milan@gmail.com";
    const fromEmail = process.env.LEAD_EMAIL_FROM || `${BRAND} <onboarding@resend.dev>`;
    const toCustomer = !!opts.toCustomer;

    if (!resendKey) {
        console.log("⚠️  Nincs RESEND_API_KEY — az e-mail kimarad. A lead a fenti logban szerepel.");
        return false;
    }
    if (!toEmail) {
        console.log("⚠️  Nincs címzett e-mail cím — kihagyva.");
        return false;
    }

    const itemRows = quote.items
        .map(i => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${i.label}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${formatHuf(i.huf)}</td></tr>`)
        .join("");

    // Client-details block is only included in the owner's copy.
    const clientBlock = toCustomer ? "" : `
        <h3 style="margin:0 0 8px">Ügyfél adatai</h3>
        <p style="margin:4px 0"><b>Név:</b> ${sel.name || "-"}</p>
        <p style="margin:4px 0"><b>Telefon:</b> ${sel.phone || "-"}</p>
        <p style="margin:4px 0"><b>E-mail:</b> ${sel.email || "-"}</p>
        <p style="margin:4px 0"><b>Irányítószám:</b> ${sel.postal_code || "-"}</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">`;

    const heading = toCustomer ? `Az Ön árajánlata — ${BRAND}` : `Új árajánlat — ${BRAND}`;
    const intro = toCustomer
        ? `<p style="margin:0 0 12px">Kedves ${sel.name || "Ügyfelünk"}! Köszönjük érdeklődését. Íme az előzetes árajánlata:</p>`
        : "";

    const footNote = `Előzetes, tájékoztató jellegű kalkuláció ${PRICE_NOTE}. Az ár tartalmazza a klímaberendezést és a telepítést; a pontos márka/típus az ingyenes helyszíni felmérés után véglegesül.`;

    // Owner notifications stay plain/transactional-looking (no colored banner) —
    // a marketing-style template with a bold color header is what commonly gets
    // Gmail's Promotions-tab classifier to flag it, dropping it out of the inbox.
    const html = toCustomer ? `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827">
      <div style="background:#0A6CD4;color:#ffffff;padding:20px 24px;border-radius:12px 12px 0 0">
        <h2 style="margin:0">${heading}</h2>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px">
        ${intro}${clientBlock}
        <h3 style="margin:0 0 8px">Munka jellege</h3>
        <p style="margin:4px 0"><b>Típus:</b> Új klíma telepítése</p>
        <p style="margin:4px 0"><b>Helyiség mérete:</b> ${lbl("room_size", sel.room_size)}</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">
        <h3 style="margin:0 0 8px">Kalkulált árajánlat</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px">${itemRows}
          <tr><td style="padding:10px 12px;font-weight:bold">Becsült végösszeg</td><td style="padding:10px 12px;text-align:right;font-weight:bold;color:#0857A8">${formatHuf(quote.total)}</td></tr>
        </table>
        <p style="margin:16px 0 0;font-size:12px;color:#6b7280">${footNote} 📞 ${PHONE}</p>
      </div>
    </div>` : `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827">
      <h2 style="margin:0 0 16px;font-size:18px">${heading}</h2>
      <div style="border:1px solid #e5e7eb;padding:24px;border-radius:8px">
        ${intro}${clientBlock}
        <h3 style="margin:0 0 8px">Munka jellege</h3>
        <p style="margin:4px 0"><b>Típus:</b> Új klíma telepítése</p>
        <p style="margin:4px 0"><b>Helyiség mérete:</b> ${lbl("room_size", sel.room_size)}</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">
        <h3 style="margin:0 0 8px">Kalkulált árajánlat</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px">${itemRows}
          <tr><td style="padding:10px 12px;font-weight:bold">Becsült végösszeg</td><td style="padding:10px 12px;text-align:right;font-weight:bold;color:#0857A8">${formatHuf(quote.total)}</td></tr>
        </table>
        <p style="margin:16px 0 0;font-size:12px;color:#6b7280">${footNote}</p>
      </div>
    </div>`;

    // No brackets/ALL-CAPS in the subject — that pattern is a common trigger for
    // Gmail's Promotions-tab / spam classifier on transactional owner mail.
    const subject = toCustomer
        ? `Az Ön árajánlata — ${BRAND} — ${formatHuf(quote.total)}`
        : `Új árajánlat — ${sel.name || ""} (${sel.postal_code || ""}) — ${formatHuf(quote.total)}`;

    // Plain-text fallback alongside the HTML — multipart mail is a deliverability
    // best practice and HTML-only messages are more likely to get flagged.
    const itemLines = quote.items.map(i => `- ${i.label}: ${formatHuf(i.huf)}`).join("\n");
    const text = toCustomer
        ? [
            `Kedves ${sel.name || "Ügyfelünk"}!`,
            "",
            "Köszönjük érdeklődését. Íme az előzetes árajánlata:",
            "",
            itemLines,
            "",
            `Becsült végösszeg: ${formatHuf(quote.total)}`,
            "",
            footNote,
            PHONE,
        ].join("\n")
        : [
            "Új árajánlat érkezett.",
            "",
            `Név: ${sel.name || "-"}`,
            `Telefon: ${sel.phone || "-"}`,
            `E-mail: ${sel.email || "-"}`,
            `Irányítószám: ${sel.postal_code || "-"}`,
            `Helyiség mérete: ${lbl("room_size", sel.room_size)}`,
            "",
            itemLines,
            "",
            `Becsült végösszeg: ${formatHuf(quote.total)}`,
        ].join("\n");

    // Reply-To: the sending address itself has no real inbox behind it (send-only
    // domain), so a bare "Reply" would vanish. Point owner mail at the customer's
    // address (reply goes straight to the lead) and customer mail at the business's
    // real inbox — never left pointing at a dead end.
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const replyTo = toCustomer
        ? COMPANY_EMAIL
        : (EMAIL_RE.test(sel.email || "") ? sel.email : undefined);

    try {
        const emailRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${resendKey}` },
            body: JSON.stringify({ from: fromEmail, to: [toEmail], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
        });

        const result = await emailRes.json();
        if (emailRes.ok) {
            console.log(`✅ Árajánlat e-mail elküldve (${toCustomer ? "ügyfél" : "tulajdonos"}):`, result.id);
            return true;
        }
        console.error("❌ Resend hiba:", JSON.stringify(result));
        return false;
    } catch (emailErr) {
        console.error("❌ Nem sikerült elküldeni az e-mailt:", emailErr.message);
        return false;
    }
}

// ---------------------------------------------------------------------------
//  Google Sheet logging. POSTs the lead to a Google Apps Script web app, which
//  appends one row to the spreadsheet. Set SHEETS_WEBHOOK_URL in .env to the
//  deployed Apps Script URL (see README). No-ops (returns false) if unset, so
//  the quote flow keeps working without it. The `row` array order MUST match
//  the header row in the Apps Script / sheet.
// ---------------------------------------------------------------------------
async function sendLeadToSheet(sel, quote) {
    const url = process.env.SHEETS_WEBHOOK_URL;
    if (!url) {
        console.log("ℹ️  Nincs SHEETS_WEBHOOK_URL — a lead nem kerül Google Sheetbe (csak e-mail).");
        return false;
    }

    // One row per lead. Keep this order in sync with the sheet's header row.
    const row = [
        new Date().toISOString(),          // Időbélyeg
        sel.name || "",                    // Név
        sel.phone || "",                   // Telefon
        sel.email || "",                   // E-mail
        sel.postal_code || "",             // Irányítószám
        lbl("room_size", sel.room_size),   // Helyiség mérete
        quote.total,                       // Becsült végösszeg (Ft)
    ];

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ row }),
        });
        if (res.ok) {
            console.log("✅ Lead beírva a Google Sheetbe.");
            return true;
        }
        console.error("❌ Google Sheet hiba:", res.status, await res.text());
        return false;
    } catch (err) {
        console.error("❌ Nem sikerült a Google Sheetbe írni:", err.message);
        return false;
    }
}
