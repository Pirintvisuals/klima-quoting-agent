(function () {
  // Configuration with defaults for local development
  const config = window.KLIMA_CONFIG || window.KAZAN_CONFIG || {};
  const apiUrl = config.apiUrl || "/api/faq-agent";
  const assetsUrl = config.assetsUrl || ""; // e.g. "https://your-app.vercel.app"
  const PHONE = "+36 30 260 57 56";
  const BRAND = "Kecskemét Klíma";

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

  // --- Inline SVG icons (no emojis used as UI icons) ---
  const ICON = {
    chat: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    mail: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    write: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
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
      "Üdv! Kérjen pár kattintással ingyenes árajánlatot klímára.",
      "Mennyibe kerül egy klíma felszerelve? Kérdezzen most.",
      "Mekkora szobába kell a klíma? Számoljunk árat egy perc alatt.",
      "Melyik klíma illik a szobájához? Segítek kiválasztani.",
      "Klíma ára telepítéssel együtt — nézze meg most.",
      "Kérdése van a klímáról? Írjon, azonnal válaszolok.",
      "Nem hűt eléggé a klímája? Kérdezzen bátran.",
      "Klímatisztítás, javítás vagy új klíma? Segítek.",
      "Ingyenes, kötelezettség nélküli árajánlat, kezdjük el!",
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
      '<div class="faq-progress-track"><div class="faq-progress-fill"></div></div>' +
      '<span class="faq-progress-label"></span>';
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
    questionHint.textContent = "Kérdezzen bátran – pl. árakról, márkákról, garanciáról, karbantartásról";

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
      addMessage("bot", `Üdvözlöm a **${BRAND}** árajánló asszisztensénél! Néhány kérdés alapján elkészítem az **előzetes árajánlatát**.\n\n**Bármit megkérdezhet** – árakról, márkákról, garanciáról, karbantartásról vagy bármi másról!`);
      // Clickable example questions so visitors see they can ask freely
      const exWrap = document.createElement("div");
      exWrap.className = "faq-chips faq-example-questions";
      const examples = [
        "Mennyibe kerül egy klíma telepítése?",
        "Mennyi ideig tart a telepítés?",
        "Milyen márkákat szereltek?",
      ];
      examples.forEach((q) => {
        const chip = makeChip(q);
        chip.onclick = () => { exWrap.remove(); sendMessage(q); };
        exWrap.appendChild(chip);
      });
      messagesContainer.appendChild(exWrap);
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

  function clearChips() {
    messagesContainer.querySelectorAll(".faq-chips").forEach((c) => c.remove());
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
        : "Válasszon fent, vagy írjon ide…";
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
    yes.onclick = () => { clearChips(); requestEmail(); };

    const no = makeChip("Köszönöm, nem");
    no.onclick = () => {
      clearChips();
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

  // Update the progress bar from the backend's answered/total counts.
  function updateProgress(done, total) {
    if (!progressFillEl || !total) return;
    const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    progressFillEl.style.width = pct + "%";
    if (progressLabelEl) progressLabelEl.textContent = pct + "%";
    if (progressBarEl) {
      progressBarEl.classList.add("visible");
      progressBarEl.classList.toggle("complete", done >= total);
    }
  }

  // text: message to send. hidden: don't show as a user bubble (the kickoff).
  async function sendMessage(presetText, hidden) {
    if (sending) return;
    const text = (presetText !== undefined ? presetText : (inputElement.value || "")).trim();
    if (!text) return;

    clearChips();
    if (!hidden) addMessage("user", text);
    if (presetText === undefined) inputElement.value = "";
    sending = true;

    conversationHistory.push({ role: "user", content: text });
    addThinking();

    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, history: conversationHistory, state: convState }),
      });

      removeThinking();

      if (!res.ok) {
        addMessage("bot", "Elnézést, hiba történt. Kérjük, próbálja újra később.");
        sending = false;
        return;
      }

      const data = await res.json();
      if (data.state && typeof data.state === "object") convState = data.state;
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
      removeThinking();
      addMessage("bot", "Elnézést, nem sikerült kapcsolódni a szerverhez.");
    } finally {
      sending = false;
    }
  }

  function init() {
    injectStyles();
    createLauncher();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
