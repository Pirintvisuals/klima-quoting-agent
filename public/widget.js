(function () {
  // Configuration with defaults for local development
  const config = window.KLIMA_CONFIG || window.KAZAN_CONFIG || {};
  const apiUrl = config.apiUrl || "/api/faq-agent";
  const assetsUrl = config.assetsUrl || ""; // e.g. "https://your-app.vercel.app"
  const PHONE = "+36 30 260 57 56";
  const BRAND = "Kecskemét Klíma";
  // How long the whole flow takes, in seconds. Drives the greeting copy, the
  // teaser bubbles and the countdown in the progress bar — change it in ONE
  // place. 15 is the honest number: one button tap plus four short typed
  // fields (név, e-mail, telefon, irányítószám).
  const QUOTE_SECONDS = 15;

  let chatOpen = false;
  let chatWindow = null;
  let messagesContainer = null;
  let inputElement = null;
  let sending = false;
  let conversationHistory = []; // [{ role: "user"|"assistant", content: "..." }]
  let convState = {}; // accumulated answer-state, carried turn-to-turn (chips/quote rely on it)
  let started = false;
  let lastLead = null; // { sel, quote } — held so the customer can request the e-mail
  let thinkingEl = null;
  let progressFillEl = null, progressLabelEl = null, progressBarEl = null;

  let container = null;

  // --- Analytics (PostHog) -------------------------------------------------
  // Same PostHog project as the NM Bau widget; every event carries a `client`
  // super-property so one dashboard splits the numbers per widget.
  // No PII leaves the page: inputs are masked in replays, the customer's own
  // bubbles are masked, and events only ever carry field NAMES / counts —
  // never what was typed.
  const POSTHOG_KEY = config.posthogKey || "phc_nroFe9H8K9hbVENBqcRRrWW9GXxoyVZhSomy3U8Zhu4P";
  const POSTHOG_HOST = config.posthogHost || "https://eu.i.posthog.com";
  const CLIENT_ID = config.client || "klima-kecskemet";
  const WIDGET_VERSION = "2026-09-17";
  const SESSION_REPLAY = config.sessionReplay !== false;

  let filledFields = [];   // field names answered so far, in the order they were answered
  let lastField = null;    // most recently answered field -> "where they stopped"
  let lastProgress = 0, lastProgressTotal = 0;
  let quoteDone = false;
  let turns = 0;           // messages the customer sent (typed or clicked)

  function track(event, props, options) {
    try {
      if (window.posthog && typeof window.posthog.capture === "function") {
        window.posthog.capture(event, props || {}, options);
      }
    } catch (e) {}
  }

  function initAnalytics() {
    if (!POSTHOG_KEY) return;
    if (window.posthog && window.posthog.__loaded) return; // host page already runs PostHog
    !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
    try {
      window.posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        capture_pageview: false, // embedded widget, not a page view
        autocapture: false,      // only our own named events
        disable_session_recording: !SESSION_REPLAY,
        session_recording: {
          maskAllInputs: true,
          maskTextSelector: ".faq-msg.user .faq-bubble, .ph-no-capture",
        },
      });
      window.posthog.register({
        client: CLIENT_ID,
        widget_version: WIDGET_VERSION,
        page: location.pathname,
      });
    } catch (e) {}
  }

  // Compare the carried answer-state before/after a turn and emit one
  // question_answered per newly filled field (names only, never values).
  function noteStateChange(prevState, data) {
    const isFilled = (s, k) => s && s[k] != null && String(s[k]).trim() !== "";
    const newly = Object.keys(convState || {}).filter(
      (k) => isFilled(convState, k) && !isFilled(prevState, k) && filledFields.indexOf(k) === -1
    );
    if (typeof data.progress === "number" && typeof data.progressTotal === "number") {
      lastProgress = data.progress;
      lastProgressTotal = data.progressTotal;
    }
    newly.forEach((field) => {
      filledFields.push(field);
      lastField = field;
      track("question_answered", {
        field,
        step: filledFields.length,
        answered: lastProgress,
        total: lastProgressTotal,
      });
    });
    // Customer sent something but no field got filled: usually an off-script
    // question (price, brands...), sometimes an answer the bot could not read.
    if (!newly.length && !data.lead) track("message_unmatched", { after_field: lastField, answered: lastProgress });
  }

  function funnelSnapshot() {
    return {
      last_field: lastField,
      fields_answered: filledFields.length,
      answered: lastProgress,
      total: lastProgressTotal,
      turns,
      completed: quoteDone,
    };
  }

  // Tab closed / navigated away: the most reliable "where did they cut off".
  let leftSent = false;
  function onLeave() {
    if (leftSent || !started) return;
    leftSent = true;
    track("widget_left", funnelSnapshot(), { transport: "sendBeacon" });
  }
  window.addEventListener("pagehide", onLeave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onLeave();
    else leftSent = false; // came back: allow a fresh snapshot next time
  });

  // --- Inline SVG icons (no emojis used as UI icons) ---
  const ICON = {
    chat: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    mail: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    write: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
    help: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><line x1="12" y1="17.5" x2="12" y2="17.5"/></svg>',
  };

  function logoSrc() {
    return assetsUrl ? `${assetsUrl}/logo.png` : "logo.png";
  }

  // Inject the widget stylesheet so it works on any site it's embedded on,
  // not just the demo page.
  function injectStyles() {
    if (document.getElementById("faq-agent-styles")) return;
    const link = document.createElement("link");
    link.id = "faq-agent-styles";
    link.rel = "stylesheet";
    link.href = assetsUrl ? `${assetsUrl}/style.css` : "style.css";
    document.head.appendChild(link);
  }

  function createContainer() {
    container = document.createElement("div");
    container.id = "faq-agent-container";
    document.body.appendChild(container);
  }

  function createLauncher() {
    if (!container) createContainer();

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "faq-chat-launcher";
    btn.setAttribute("aria-label", `Csevegés megnyitása — ${BRAND}`);
    btn.innerHTML = `<span class="faq-launcher-ring" aria-hidden="true"></span>${ICON.chat}<span class="faq-launcher-dot" aria-hidden="true"></span>`;
    btn.onclick = toggleChat;
    container.appendChild(btn);

    // Rotating teaser questions — cycled to spark engagement and show what the
    // assistant can actually do. No emojis. Hungarian, air-conditioning focused.
    const TEASERS = [
      `Klíma ára ${QUOTE_SECONDS} másodperc alatt – egy kérdés, és kész.`,
      "Kérdezzen bátran! Árakról, márkákról, garanciáról – bármiről.",
      `Mennyibe kerül egy klíma felszerelve? ${QUOTE_SECONDS} mp és megtudja.`,
      "Nem hűt eléggé a klímája? Írjon, azonnal válaszolok.",
      `Egy kérdés, ${QUOTE_SECONDS} másodperc, és látja az árat.`,
      "Kérdése van a klímáról? Írjon, azonnal válaszolok.",
      "Klímatisztítás, javítás vagy új klíma? Kérdezzen nyugodtan.",
      "Milyen márkákat szerelünk? Hány év a garancia? Kérdezze meg!",
      `Ingyenes árajánlat, kötelezettség nélkül – kb. ${QUOTE_SECONDS} mp.`,
    ];
    let teaserIdx = 0;
    let teaserTimer = null;
    let teaserDismissed = false;

    const tooltip = document.createElement("div");
    tooltip.className = "faq-chat-tooltip";
    tooltip.setAttribute("role", "button");
    tooltip.setAttribute("tabindex", "0");
    tooltip.innerHTML = `<span class="faq-tooltip-text">${TEASERS[0]}</span>`;
    const teaserText = tooltip.querySelector(".faq-tooltip-text");

    function stopTeaserRotation() {
      if (teaserTimer) { clearInterval(teaserTimer); teaserTimer = null; }
    }
    function rotateTeaser() {
      if (teaserDismissed || chatOpen) return;
      teaserIdx = (teaserIdx + 1) % TEASERS.length;
      teaserText.style.opacity = "0";
      setTimeout(() => {
        teaserText.textContent = TEASERS[teaserIdx];
        teaserText.style.opacity = "1";
      }, 280);
    }

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "faq-tooltip-close";
    closeBtn.setAttribute("aria-label", "Buborék bezárása");
    closeBtn.innerHTML = "&times;";
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      teaserDismissed = true;
      stopTeaserRotation();
      tooltip.classList.remove("show");
      setTimeout(() => tooltip.classList.add("hidden"), 300);
    };

    tooltip.appendChild(closeBtn);
    const openFromTooltip = () => {
      stopTeaserRotation();
      tooltip.classList.remove("show");
      setTimeout(() => tooltip.classList.add("hidden"), 300);
      if (!chatOpen) toggleChat();
    };
    tooltip.onclick = openFromTooltip;
    tooltip.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFromTooltip(); } };

    container.appendChild(tooltip);
    setTimeout(() => {
      if (teaserDismissed) return;
      tooltip.classList.add("show");
      teaserTimer = setInterval(rotateTeaser, 9000); // swap the question every 9s
    }, 1600);
  }

  function toggleChat() {
    const tooltip = document.querySelector(".faq-chat-tooltip");
    const launcher = document.querySelector(".faq-chat-launcher");

    if (chatOpen) {
      // Close: animate, then HIDE (keep in DOM so the conversation persists).
      const w = chatWindow;
      w.classList.add("closing");
      setTimeout(() => {
        if (w) { w.style.display = "none"; w.classList.remove("closing"); }
      }, 180);
      chatOpen = false;
      track("chat_closed", funnelSnapshot());
      if (launcher) launcher.classList.remove("active");
    } else {
      if (tooltip) {
        tooltip.classList.remove("show");
        setTimeout(() => tooltip.classList.add("hidden"), 300);
      }
      if (!chatWindow) {
        openChat(); // build once (also fires the greeting + first question)
      } else {
        // Re-show the existing window with its messages intact.
        chatWindow.style.display = "flex";
        chatWindow.style.animation = "none";
        void chatWindow.offsetWidth; // force reflow so the open animation replays
        chatWindow.style.animation = "";
        scrollToBottom();
        setTimeout(() => inputElement && inputElement.focus(), 120);
      }
      chatOpen = true;
      track("chat_opened", { turns });
      if (launcher) launcher.classList.add("active");
    }
  }

  function openChat() {
    chatWindow = document.createElement("div");
    chatWindow.className = "faq-chat-window";
    chatWindow.setAttribute("role", "dialog");
    chatWindow.setAttribute("aria-label", `${BRAND} árajánló asszisztens`);

    // ---- Header ----
    const header = document.createElement("div");
    header.className = "faq-chat-header";

    const logo = document.createElement("img");
    logo.src = logoSrc();
    logo.alt = BRAND;
    logo.className = "faq-header-logo";

    const textBlock = document.createElement("div");
    textBlock.className = "faq-header-text";
    textBlock.innerHTML =
      `<span class="faq-header-title">${BRAND}</span>` +
      `<span class="faq-header-status"><span class="faq-status-dot" aria-hidden="true"></span>Azonnal válaszol</span>`;

    const actions = document.createElement("div");
    actions.className = "faq-header-actions";

    const phone = document.createElement("a");
    phone.className = "faq-header-phone";
    phone.href = `tel:${PHONE.replace(/\s/g, "")}`;
    phone.setAttribute("aria-label", `Hívás: ${PHONE}`);
    phone.innerHTML = `${ICON.phone}<span>${PHONE}</span>`;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "faq-header-close";
    closeBtn.setAttribute("aria-label", "Csevegés bezárása");
    closeBtn.innerHTML = ICON.close;
    closeBtn.onclick = toggleChat;

    actions.appendChild(phone);
    actions.appendChild(closeBtn);

    header.appendChild(logo);
    header.appendChild(textBlock);
    header.appendChild(actions);

    // ---- Progress bar (how far through the questions) ----
    const progress = document.createElement("div");
    progress.className = "faq-progress";
    progress.innerHTML =
      `<span class="faq-progress-clock" aria-hidden="true">${ICON.clock}</span>` +
      '<div class="faq-progress-track"><div class="faq-progress-fill"></div></div>' +
      // Seeded so the time promise is on screen from the very first frame,
      // before the first backend response arrives.
      `<span class="faq-progress-label">kb. ${QUOTE_SECONDS} mp az egész</span>`;
    progressBarEl = progress;
    progressFillEl = progress.querySelector(".faq-progress-fill");
    progressLabelEl = progress.querySelector(".faq-progress-label");

    // ---- Messages ----
    messagesContainer = document.createElement("div");
    messagesContainer.className = "faq-chat-messages";
    messagesContainer.setAttribute("role", "log");
    messagesContainer.setAttribute("aria-live", "polite");

    // ---- Input ----
    const inputBar = document.createElement("form");
    inputBar.className = "faq-chat-input";
    inputBar.onsubmit = (e) => { e.preventDefault(); sendMessage(); };

    inputElement = document.createElement("input");
    inputElement.type = "text";
    inputElement.className = "faq-input-field";
    inputElement.setAttribute("aria-label", "Írja be a válaszát");
    inputElement.placeholder = "Írja be a válaszát – vagy kérdezzen bátran…";
    inputElement.autocomplete = "off";

    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.className = "faq-send-btn";
    sendBtn.setAttribute("aria-label", "Küldés");
    sendBtn.innerHTML = ICON.send;

    inputBar.appendChild(inputElement);
    inputBar.appendChild(sendBtn);

    // Hint shown ONLY when the customer has to type a free-text answer (the
    // contact details at the end). It makes it obvious there are no buttons to
    // click here — they must write something. Hidden while chips are offered.
    const inputHint = document.createElement("div");
    inputHint.className = "faq-input-hint";
    inputHint.innerHTML = `${ICON.write}<span>Most Önön a sor — kérjük, írja be a válaszát, majd nyomjon Entert.</span>`;

    // Persistent hint below messages reminding visitors they can ask freely
    const questionHint = document.createElement("div");
    questionHint.className = "faq-question-hint";
    questionHint.innerHTML =
      `${ICON.help}<span><strong>Bármikor kérdezhet</strong> – árakról, márkákról, garanciáról, karbantartásról. Csak írja be ide!</span>`;

    const inputWrap = document.createElement("div");
    inputWrap.className = "faq-input-wrap";
    inputWrap.appendChild(inputHint);
    inputWrap.appendChild(inputBar);

    chatWindow.appendChild(header);
    chatWindow.appendChild(progress);
    chatWindow.appendChild(messagesContainer);
    chatWindow.appendChild(questionHint);
    chatWindow.appendChild(inputWrap);

    container.appendChild(chatWindow);
    setTimeout(() => inputElement && inputElement.focus(), 150);

    if (!started) {
      started = true;
      track("quote_started");
      addMessage("bot", `Üdvözlöm a **${BRAND}** árajánló asszisztensénél! Egyetlen kérdés alapján elkészítem az **előzetes árajánlatát** – az egész **kb. ${QUOTE_SECONDS} másodperc**.`);

      // "You can ask me anything" block — a labelled row of clickable example
      // questions. It deliberately SURVIVES the first bot turn (clearChips
      // skips it), so the visitor sees the answer buttons and the "ask me
      // something instead" option side by side. It only disappears once they
      // actually send a message of their own.
      const askBlock = document.createElement("div");
      askBlock.className = "faq-ask-block";

      const askLabel = document.createElement("div");
      askLabel.className = "faq-ask-label";
      askLabel.innerHTML = `${ICON.help}<span><strong>Bármit kérdezhet</strong> – akár most rögtön, akár menet közben:</span>`;

      const exWrap = document.createElement("div");
      exWrap.className = "faq-chips faq-example-questions";
      // Kept SHORT on purpose: long questions wrap to two lines each and the
      // block then swallows half the chat window, pushing the actual question
      // out of view. These fit two-per-row.
      const examples = [
        "Meddig tart?",
        "Milyen márkák?",
        "Hány év garancia?",
        "Ingyenes felmérés?",
      ];
      examples.forEach((q) => {
        const chip = makeChip(q);
        chip.onclick = () => sendMessage(q);
        exWrap.appendChild(chip);
      });

      askBlock.appendChild(askLabel);
      askBlock.appendChild(exWrap);
      messagesContainer.appendChild(askBlock);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      sendMessage("Szeretnék árajánlatot klíma telepítésére.", true);
    }
  }

  function renderMarkdown(text) {
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const inline = (s) =>
      esc(s)
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    // Build clean block elements (bullets, headers, paragraphs) for readability.
    let html = "";
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "") { html += '<div class="faq-sp"></div>'; continue; }
      if (line.startsWith("•")) { html += '<div class="faq-li">' + inline(line) + "</div>"; continue; }
      if (/^\*\*.*\*\*:?$/.test(line)) { html += '<div class="faq-h">' + inline(line) + "</div>"; continue; }
      html += '<div class="faq-p">' + inline(line) + "</div>";
    }
    return html;
  }

  // Removes the answer buttons only. The example-question chips are explicitly
  // spared so the "you can ask me anything" invitation stays on screen next to
  // the first question instead of being wiped by the kickoff turn.
  function clearChips() {
    messagesContainer
      .querySelectorAll(".faq-chips:not(.faq-example-questions)")
      .forEach((c) => c.remove());
  }

  // Drop the whole "ask me anything" block — called once the visitor has sent
  // a message of their own, at which point the invitation has done its job.
  function clearAskBlock() {
    const b = messagesContainer.querySelector(".faq-ask-block");
    if (b) b.remove();
  }

  // Switch the composer between "pick a button" mode (chips shown) and
  // "type your answer" mode (no buttons — the contact-detail questions). In
  // type mode we surface a clear hint, highlight the field and auto-focus it so
  // it's obvious the customer must write something.
  function setInputMode(typeMode) {
    if (!chatWindow) return;
    chatWindow.classList.toggle("type-mode", typeMode);
    if (inputElement) {
      inputElement.placeholder = typeMode
        ? "Írja ide a válaszát…"
        : "Válasszon fent – vagy kérdezzen bátran…";
      if (typeMode) setTimeout(() => inputElement && inputElement.focus(), 80);
    }
  }

  function makeChip(label) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "faq-chip";
    chip.textContent = label;
    return chip;
  }

  function renderChips(chips) {
    clearChips();
    if (!chips || !chips.length) return;
    const wrap = document.createElement("div");
    wrap.className = "faq-chips";
    chips.forEach((label) => {
      const chip = makeChip(label);
      chip.onclick = () => { clearChips(); sendMessage(label); };
      wrap.appendChild(chip);
    });
    messagesContainer.appendChild(wrap);
    scrollToBottom();
  }

  // After the quote is shown, offer to e-mail it to the customer.
  function renderEmailOffer() {
    clearChips();
    const wrap = document.createElement("div");
    wrap.className = "faq-chips";

    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "faq-chip faq-chip-primary";
    yes.innerHTML = `${ICON.mail}<span>Kérem e-mailben is</span>`;
    yes.onclick = () => { clearChips(); track("email_requested"); requestEmail(); };

    const no = makeChip("Köszönöm, nem");
    no.onclick = () => {
      clearChips();
      track("email_declined");
      addMessage("bot", "Rendben, köszönjük a megkeresést! Hamarosan keressük. Ha sürgős, hívjon: " + PHONE);
    };

    wrap.appendChild(yes);
    wrap.appendChild(no);
    messagesContainer.appendChild(wrap);
    scrollToBottom();
  }

  async function requestEmail() {
    if (sending || !lastLead) return;
    sending = true;
    addThinking();
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "email_customer", lead: lastLead }),
      });
      removeThinking();
      const data = await res.json();
      addMessage("bot", data.answer || "Elküldtük az árajánlatot a megadott e-mail címre.");
    } catch (e) {
      removeThinking();
      addMessage("bot", "Sajnos most nem sikerült e-mailt küldeni. Kérjük, próbálja később.");
    } finally {
      sending = false;
    }
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function addMessage(sender, text) {
    const msg = document.createElement("div");
    msg.className = "faq-msg " + sender;

    if (sender === "bot") {
      const avatar = document.createElement("img");
      avatar.className = "faq-avatar";
      avatar.src = logoSrc();
      avatar.alt = "";
      avatar.setAttribute("aria-hidden", "true");
      msg.appendChild(avatar);
    }

    const bubble = document.createElement("div");
    bubble.className = "faq-bubble";
    if (sender === "bot") bubble.innerHTML = renderMarkdown(text);
    else bubble.textContent = text;

    msg.appendChild(bubble);
    messagesContainer.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function addThinking() {
    const msg = document.createElement("div");
    msg.className = "faq-msg bot";
    msg.innerHTML =
      `<img class="faq-avatar" src="${logoSrc()}" alt="" aria-hidden="true">` +
      `<div class="faq-bubble faq-typing"><span></span><span></span><span></span></div>`;
    messagesContainer.appendChild(msg);
    scrollToBottom();
    thinkingEl = msg;
  }

  function removeThinking() {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  }

  // Update the progress bar from the backend's answered/total counts. The label
  // shows the TIME LEFT rather than a percentage — the filled bar already
  // communicates progress, and "still only ~9 seconds" is far more persuasive
  // than "40%" for someone deciding whether to bother finishing.
  function updateProgress(done, total) {
    if (!progressFillEl || !total) return;
    const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    progressFillEl.style.width = pct + "%";
    const complete = done >= total;
    if (progressLabelEl) {
      const left = Math.max(1, Math.ceil((QUOTE_SECONDS * (total - done)) / total));
      progressLabelEl.textContent = complete ? "Kész!" : `még kb. ${left} mp`;
    }
    if (progressBarEl) {
      progressBarEl.classList.add("visible");
      progressBarEl.classList.toggle("complete", complete);
    }
  }

  // text: message to send. hidden: don't show as a user bubble (the kickoff).
  async function sendMessage(presetText, hidden) {
    if (sending) return;
    const text = (presetText !== undefined ? presetText : (inputElement.value || "")).trim();
    if (!text) return;

    clearChips();
    if (!hidden) { clearAskBlock(); addMessage("user", text); }
    if (presetText === undefined) inputElement.value = "";
    sending = true;

    conversationHistory.push({ role: "user", content: text });
    if (!hidden) { turns++; track("message_sent", { via: presetText !== undefined ? "chip" : "typed", after_field: lastField }); }
    let prevState = {};
    try { prevState = Object.assign({}, convState); } catch (e) {}
    addThinking();

    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, history: conversationHistory, state: convState }),
      });

      removeThinking();

      if (!res.ok) {
        track("widget_error", { kind: "http", status: res.status, after_field: lastField });
        addMessage("bot", "Elnézést, hiba történt. Kérjük, próbálja újra később.");
        sending = false;
        return;
      }

      const data = await res.json();
      if (data.state && typeof data.state === "object") convState = data.state;
      // Analytics only - wrapped so it can never interrupt the quote itself.
      try {
        if (!hidden) noteStateChange(prevState, data);
        if (data.lead && !quoteDone) {
          quoteDone = true;
          const qs = data.lead.quote || {};
          track("quote_completed", { fields_answered: filledFields.length, turns, quote_low: qs.low, quote_high: qs.high, quote_total: qs.total });
        }
      } catch (e) {}
      if (typeof data.progress === "number" && typeof data.progressTotal === "number") {
        updateProgress(data.progress, data.progressTotal);
      }
      const botResponse = data.answer || "Elnézést, nem találtam választ.";
      // A response may contain [[SPLIT]] markers → render as separate bubbles
      // for readability (e.g. the final quote: price / note / recap).
      const parts = botResponse.split("[[SPLIT]]").map(s => s.trim()).filter(Boolean);
      parts.forEach(p => addMessage("bot", p));
      conversationHistory.push({ role: "assistant", content: parts.join("\n\n") });

      const hasChips = Array.isArray(data.chips) && data.chips.length > 0;
      const isComplete = !!data.lead; // final quote turn carries the lead object

      if (data.emailOffer && data.lead) {
        lastLead = data.lead;
        renderEmailOffer();
        setInputMode(false);
      } else {
        renderChips(data.chips);
        // No buttons and the quote isn't finished yet => a free-text question
        // (name / e-mail / phone / postal code). Make that visually obvious.
        setInputMode(!hasChips && !isComplete);
      }
    } catch (err) {
      console.error(err);
      track("widget_error", { kind: "network", after_field: lastField });
      removeThinking();
      addMessage("bot", "Elnézést, nem sikerült kapcsolódni a szerverhez.");
    } finally {
      sending = false;
    }
  }

  function init() {
    injectStyles();
    createLauncher();
    initAnalytics();
    track("widget_loaded");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
