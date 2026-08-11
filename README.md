# Kecskemét Klíma — Árajánló chat widget

A Hungarian air-conditioning quoting chat widget for **Kecskemét Klíma**
(Polyák Zoltán, klímaszerelő mester). The customer answers **one** question
about the room, gives their contact details, then immediately sees an itemised
estimate. The company owner receives the same quote + the customer's details by
e-mail.

Built on the same engine as the `kecskemet quoting agent` (gas boiler) widget.

---

## How it works (architecture)

```
public/widget.js   ──POST──►  api/faq-agent.js  ──►  OpenAI / Gemini  = conversation only
   (chat UI)                       │
                                   ├──►  PRICES table  = deterministic price calc
                                   ├──►  Resend        = e-mail to owner
                                   └──►  Google Sheet  = optional lead log
```

**The AI never does arithmetic.** It only runs the Hungarian conversation and
maintains a hidden JSON block of the customer's *choices* (not prices). The
backend looks each choice up in the fixed `PRICES` table, sums it, and builds
the quote. This is why the total can never be miscalculated by the model.

---

## How the price is calculated

All prices are in **HUF**, **gross (ÁFA included)**, and include **both the
appliance and the installation**. Edit them in **one place**: the `PRICES`
object at the top of [`api/faq-agent.js`](api/faq-agent.js).

| Step | Question | Options → amount |
|---|---|---|
| 1 | **Mekkora helyiségbe szeretné a klímát?** | 0–15 m² → 200 000 · 15–30 m² → 250 000 · 30 m² felett → 380 000 · *Nem tudom* → 250 000 |
| — | **Always added (not asked)** | Klíma telepítés — 100 000 Ft |

**Total = room-size price + 100 000 Ft.** So the three possible quotes are
**300 000 / 350 000 / 480 000 Ft**.

### Decisions baked into the logic
- **One room, one unit.** The client's price sheet is per-room, and he asked for
  no extra questions — so the bot never asks how many rooms/units. A multi-split
  enquiry is handled at the free site survey. (If that ever changes, it's a
  handful of lines: a `unit_count` field in `FIELD_ORDER` + a loop in
  `buildQuote`.)
- **"Nem tudom" falls back to the MIDDLE band (250 000)**, not the cheapest.
  A deliberately different choice from the boiler widget: undershooting the
  estimate makes the site survey an unpleasant surprise.
- **Free-typed sizes are parsed in the backend**, not by the model —
  `parseAreaM2` understands `20 nm`, `20 m2`, `20 négyzetméter`, `4x5`,
  `4,5 x 6 méter`, or a bare number, and `bucketArea` puts it in a band. This
  keeps band selection deterministic even when the customer doesn't click a button.
- **Only installation is priced.** Karbantartás / javítás / beüzemelés have no
  price sheet, so the bot answers those from its knowledge base, says the survey
  is free, and still collects the contact details for a callback — the lead is
  never lost.
- **Prices are gross.** To switch to net, flip `VAT_INCLUDED` at the top of
  `api/faq-agent.js` (it drives the `PRICE_NOTE` shown in chat and e-mail) and
  restate the numbers in `PRICES`.

### Quote delivery
- The itemised estimate is **shown in the chat** as soon as all answers are in,
  split into easy-to-read bubbles (price → "just an estimate" note → a recap).
- The **owner always** receives it by e-mail (with the client's details).
- The **customer can be offered a button** to have it e-mailed to them too —
  off by default, see `EMAIL_OFFER` below.
- Completion is decided by the **backend** (`isQuoteReady`) from a running hidden
  state block the model maintains — so the quote always appears even if the model
  phrasing varies.

---

## The bot's knowledge base

`SYSTEM_PROMPT` in `api/faq-agent.js` carries everything scraped from
**kecskemet-kl-ma.vercel.app**, so the assistant can answer mid-conversation
questions without inventing anything:

- **Company:** Polyák Zoltán klímaszerelő mester, 15+ év tapasztalat, F-gázos
  képesítés, nem alvállalkozókkal dolgozik.
- **Contact:** +36 30 260 57 56 · info@kecskemetklima.hu · 6000 Kecskemét,
  Számadó u. 25. · H–P 8:00–17:00.
- **Area:** Kecskemét + 30 km (Lajosmizse, Kerekegyháza, Helvécia, Ballószög,
  Nyárlőrinc, Kiskunfélegyháza, Városföld, Kadafalva, Nagykőrös).
- **Numbers:** 200+ telepített klíma · 4.8 Google · akár 10 év garancia.
- **Services:** telepítés (split/multi-split, máshol vásárolt klíma, áthelyezés) ·
  karbantartás & tisztítás · javítás & hibakeresés · beüzemelés & szivárgáskezelés.
- **Brands:** Daikin, Mitsubishi Electric, Toshiba, Panasonic, LG, Samsung,
  Gree, Fujitsu, Midea, AUX, Polar.
- **All 15 GYIK answers** from the site: ingyenes felmérés, telepítés
  időtartama, karbantartás gyakorisága, miért nem hűt, kevés gáz jelei, mit
  szabad házilag, csöpögő klíma, szivárgásvizsgálat, garancia + számla, kiszállás.

To change what the bot says, edit `SYSTEM_PROMPT`. To change *what it asks*,
edit `FIELD_ORDER`, `CHIP_MAP` and `CHIP_VALUES` together.

---

## Setup & deploy

1. **Keys** — `.env` (git-ignored) is already copied from the boiler project:
   - `AI_PROVIDER` — `openai` or `gemini`
   - `OPENAI_API_KEY` / `OPENAI_MODEL`, or `GEMINI_API_KEY` / `GEMINI_MODEL`
   - `RESEND_API_KEY` — free at <https://resend.com>
   - `LEAD_EMAIL_TO` — where quotes are sent
   - `LEAD_EMAIL_FROM` — the `onboarding@resend.dev` test sender to start; later
     verify a domain in Resend and change it
   - `EMAIL_OFFER=on` — enables the "e-mail it to me too" button (needs a
     verified sending domain first, otherwise the customer sees an error)
   - `SHEETS_WEBHOOK_URL` — optional, see below
2. **Run locally:** `node server.js` → <http://localhost:8890>
3. **Deploy (Vercel):** push the repo; set the same env vars in the Vercel
   dashboard. `api/faq-agent.js` is the serverless endpoint, `public/` is static.
4. **Embed on the site:**
   ```html
   <script>
     window.KLIMA_CONFIG = {
       apiUrl: "https://YOUR-APP.vercel.app/api/faq-agent",
       assetsUrl: "https://YOUR-APP.vercel.app"
     };
   </script>
   <script src="https://YOUR-APP.vercel.app/widget.js"></script>
   ```

---

## Leads → Google Sheet (optional)

Every completed lead is also appended as a row to a Google Sheet. Leave
`SHEETS_WEBHOOK_URL` empty and the quote/e-mail flow still works exactly as before.

1. Create a Google Sheet with this header row (this exact order — it matches the
   `row` array in `sendLeadToSheet`):

   `Időbélyeg | Név | Telefon | E-mail | Irányítószám | Helyiség mérete | Becsült végösszeg (Ft)`

2. **Extensions → Apps Script**, replace the contents with:

   ```javascript
   function doPost(e) {
     var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
     var data = JSON.parse(e.postData.contents);
     sheet.appendRow(data.row);
     return ContentService
       .createTextOutput(JSON.stringify({ ok: true }))
       .setMimeType(ContentService.MimeType.JSON);
   }
   ```

3. **Deploy → New deployment → Web app.** *Execute as* = **Me**, *Who has
   access* = **Anyone**. Deploy, authorise, copy the **Web app URL** (`/exec`).

4. Paste it into `SHEETS_WEBHOOK_URL` in `.env` and in the Vercel dashboard.

---

## Customising

- **Prices:** the `PRICES` object in `api/faq-agent.js`.
- **Questions / wording / knowledge:** `SYSTEM_PROMPT` in `api/faq-agent.js`.
- **Colours:** `public/style.css` — brand blue `#0A6CD4` / `#0857A8`, ice
  `#7FD4FF`, orange call button `#F3701D`, matching the website's palette.
- **Logo:** `public/logo.png` is still the **boiler company's placeholder** —
  replace it with the Kecskemét Klíma logo (it's used in the chat header and as
  the bot avatar).
- **Phone number:** `PHONE` constant in both `public/widget.js` and
  `api/faq-agent.js`.
