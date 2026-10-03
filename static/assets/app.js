/* Manweta AI dashboard - plain JS, no build step.
   Structure: helpers -> api -> auth -> shell/router -> pages -> actions */
(function () {
  "use strict";

  /* =====================================================================
     Helpers
     ===================================================================== */
  class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
  const raw = (s) => new Raw(s);
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const one = (v) => (v instanceof Raw ? v.s : esc(v));
  /* Tagged template: every interpolated value is escaped unless it is itself html`` / raw(). */
  function html(strings, ...vals) {
    let out = "";
    strings.forEach((s, i) => {
      out += s;
      if (i < vals.length) out += Array.isArray(vals[i]) ? vals[i].map(one).join("") : one(vals[i]);
    });
    return new Raw(out);
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const state = { token: store.get("manweta_token"), session: null, currency: "₹", overview: null, timers: [] };

  function money(n, cur) {
    const v = Number(n || 0);
    return (cur || state.currency) + v.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: v % 1 ? 2 : 0 });
  }
  function timeAgo(iso) {
    if (!iso) return "never";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
    return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }
  function dateText(iso) {
    return iso ? new Date(iso + (iso.length === 10 ? "T00:00:00" : "")).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "-";
  }
  function dateTime(iso) {
    return iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "-";
  }

  const ICON = {
    overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    customers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2 .7 3.1 2.4 3.5 5.2"/></svg>',
    reminders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
    replies: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
    whatsapp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1.3-4.2A8.5 8.5 0 1 1 8.4 19z"/><path d="M9 9.2c0 3 2.8 5.8 5.8 5.8l1.2-1.4-2.1-1-.9.7a4 4 0 0 1-1.9-1.9l.7-.9-1-2.1z"/></svg>',
    tally: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M7 10l2.5 2L14 8"/></svg>',
    contact: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  };
  const TICK1 = '<svg viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 5.8L5 9.2 12 1.8"/></svg>';
  const TICK2 = '<svg viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5.8l3.4 3.4L10.8 2M6.2 8.6l.6.6L14 1.8"/></svg>';

  function statusChip(status) {
    const map = {
      queued: ["", "Queued", ""],
      sent: ["", "Sent", TICK1],
      delivered: ["", "Delivered", TICK2],
      read: ["read", "Read", TICK2],
      failed: ["bad", "Failed", ""],
    };
    const [cls, label, icon] = map[status] || ["", status, ""];
    return html`<span class="chip ${cls}">${raw(icon)}${label}</span>`;
  }

  function toast(msg, kind) {
    const el = document.createElement("div");
    el.className = "toast " + (kind || "");
    el.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), kind === "bad" ? 7000 : 4000);
  }

  function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }
  function every(ms, fn) { state.timers.push(setInterval(fn, ms)); }

  /* =====================================================================
     API
     ===================================================================== */
  async function api(path, opts = {}) {
    const headers = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (state.token) headers.Authorization = "Bearer " + state.token;

    let res;
    try {
      res = await fetch("/api/v1" + path, {
        method: opts.method || "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      throw new Error("Can't reach the server. Check your internet connection and try again.");
    }

    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }

    if (res.status === 401 && state.token && !opts.noAuthRedirect) {
      logout(true);
      throw new Error("Your session expired. Please log in again.");
    }
    if (!res.ok) {
      let msg = data && data.detail;
      if (Array.isArray(msg)) msg = msg.map((e) => (e.msg || "").replace(/^Value error, /, "")).join(". ");
      throw new Error(msg || "Something went wrong (HTTP " + res.status + ")");
    }
    return data;
  }

  /* =====================================================================
     Auth
     ===================================================================== */
  function saveSession(data) {
    state.token = data.access_token;
    state.session = { user: data.user, tenant: data.tenant };
    store.set("manweta_token", state.token);
  }
  function logout(silent) {
    state.token = null; state.session = null; state.overview = null;
    store.del("manweta_token");
    clearTimers();
    location.hash = "";
    renderAuth("login");
    if (!silent) toast("Logged out");
  }

  function renderAuth(mode) {
    clearTimers();
    document.body.classList.remove("nav-open");
    const signup = mode === "signup";
    const forgot = mode === "forgot";
    $("#app").innerHTML = html`
      <div class="auth">
        <section class="auth-pitch">
          <div class="brand"><img src="/assets/logo.png" alt="Manweta AI Logo" referrerpolicy="no-referrer">Manweta AI</div>
          <div>
            <h1>Get paid faster, straight from Tally.</h1>
            <p class="lead">Manweta AI reads your outstanding bills and sends WhatsApp payment reminders from your own business number. No manual follow-up.</p>
          </div>
          <div>
            <div class="route" aria-label="How it works">
              <div class="route-item"><span class="route-step">1</span><div><b>Tally Prime</b><small>your outstanding bills</small></div></div>
              <div class="route-item"><span class="route-step">2</span><div><b>Manweta AI</b><small>decides who to remind</small></div></div>
              <div class="route-item"><span class="route-step">3</span><div><b>Your WhatsApp</b><small>sends the message</small></div></div>
              <div class="route-item"><span class="route-step">4</span><div><b>Your customer</b><small>pays sooner</small></div></div>
            </div>
          </div>
        </section>
        <section class="auth-form">
          <form class="auth-card" id="auth-form" novalidate>
            <h2>${signup ? "Create your account" : forgot ? "Reset your password" : "Log in"}</h2>
            <p class="muted" style="margin-bottom:22px">
              ${signup ? "Set up takes about ten minutes." : forgot ? "Enter your account email and choose a new password." : "Welcome back."}
            </p>
            ${signup ? html`
              <label class="field"><span>Company name</span><input type="text" name="company_name" autocomplete="organization" required></label>
              <label class="field"><span>Your name</span><input type="text" name="full_name" autocomplete="name"></label>` : ""}
            <label class="field"><span>Work email</span><input type="email" name="email" autocomplete="email" required></label>
            ${forgot ? html`
              <label class="field"><span>New password</span><input type="password" name="password" autocomplete="new-password" minlength="8" required>
                <small>At least 8 characters.</small></label>
              <label class="field"><span>Confirm new password</span><input type="password" name="confirm_password" autocomplete="new-password" minlength="8" required></label>
            ` : html`
              <label class="field">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                  <span style="font-weight:500;font-size:14px;">Password</span>
                  ${!signup ? html`<button type="button" class="linkbtn small" data-action="auth-mode" data-mode="forgot" style="font-size:12.5px;">Forgot password?</button>` : ""}
                </div>
                <input type="password" name="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="8" required>
                ${signup ? html`<small>At least 8 characters.</small>` : ""}
              </label>
            `}
            <div id="auth-error" class="notice bad" hidden style="margin-bottom:14px"></div>
            <button class="btn primary" style="width:100%" type="submit">
              ${signup ? "Create account" : forgot ? "Reset password" : "Log in"}
            </button>
            ${!signup && !forgot ? html`
              <div style="margin-top:14px;padding:12px;background:var(--line-2);border-radius:var(--r-ctl);font-size:12px;color:var(--ink-2);text-align:center;">
                <div>Demo: <b>demo@manweta.ai</b> &bull; Password: <b>password123</b></div>
                <button type="button" class="btn ghost small" id="demo-login-btn" style="margin-top:8px;width:100%">Quick Demo Log In</button>
              </div>` : ""}
            <p class="switch-mode small">
              ${forgot ? html`Remembered your password? <button type="button" class="linkbtn" data-action="auth-mode" data-mode="login">Back to log in</button>`
                : signup ? html`Already have an account? <button type="button" class="linkbtn" data-action="auth-mode" data-mode="login">Log in</button>`
                : html`New to Manweta AI? <button type="button" class="linkbtn" data-action="auth-mode" data-mode="signup">Create an account</button>`}
            </p>
            <div class="auth-legal-footer">
              <a href="#/privacy">Privacy Policy</a>
              <span>&bull;</span>
              <a href="#/terms">Terms & Conditions</a>
              <span>&bull;</span>
              <a href="#/contact">Contact Support (support@manweta.com)</a>
            </div>
          </form>
        </section>
      </div>`.s;

    const demoBtn = $("#demo-login-btn");
    if (demoBtn) {
      demoBtn.addEventListener("click", () => {
        const form = $("#auth-form");
        if (form && form.elements.email && form.elements.password) {
          form.elements.email.value = "demo@manweta.ai";
          form.elements.password.value = "password123";
          $("button[type=submit]", form)?.click();
        }
      });
    }

    $("#auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const btn = $("button[type=submit]", form);
      const err = $("#auth-error");
      err.hidden = true;
      const body = Object.fromEntries(new FormData(form).entries());
      btn.disabled = true;

      if (forgot) {
        if (!body.password || body.password.length < 8) {
          err.textContent = "Password must be at least 8 characters long";
          err.hidden = false;
          btn.disabled = false;
          return;
        }
        if (body.password !== body.confirm_password) {
          err.textContent = "Passwords do not match";
          err.hidden = false;
          btn.disabled = false;
          return;
        }
        try {
          const res = await api("/auth/reset-password", {
            method: "POST",
            body: { email: body.email, new_password: body.password },
            noAuthRedirect: true,
          });
          toast(res.message || "Password updated! Please log in.", "good");
          renderAuth("login");
          const loginForm = $("#auth-form");
          if (loginForm && loginForm.elements.email) {
            loginForm.elements.email.value = body.email;
          }
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          btn.disabled = false;
        }
        return;
      }

      try {
        const data = await api(signup ? "/auth/signup" : "/auth/login", { method: "POST", body, noAuthRedirect: true });
        saveSession(data);
        location.hash = "#/overview";
        boot();
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false; btn.disabled = false;
      }
    });
  }

  /* =====================================================================
     Shell + router
     ===================================================================== */
  const NAV = [
    ["overview", "Overview"],
    ["customers", "Customers"],
    ["reminders", "Reminders"],
    ["replies", "Replies"],
    ["whatsapp", "WhatsApp"],
    ["tally", "Tally"],
    ["contact", "Support & Contact"],
  ];

  const PUBLIC_PAGES = ["privacy", "terms", "contact"];

  function renderPublicShell(pageKey) {
    clearTimers();
    $("#app").innerHTML = html`
      <div style="min-height: 100vh; background: var(--bg);">
        <header class="public-header">
          <a href="#/overview" class="brand" style="text-decoration:none;"><img src="/assets/logo.png" alt="Manweta AI Logo" referrerpolicy="no-referrer">Manweta AI</a>
          <nav class="public-nav">
            <a href="#/privacy" class="linkbtn small" ${pageKey === "privacy" ? 'style="font-weight:700;color:var(--brand);"' : ""}>Privacy Policy</a>
            <a href="#/terms" class="linkbtn small" ${pageKey === "terms" ? 'style="font-weight:700;color:var(--brand);"' : ""}>Terms & Conditions</a>
            <a href="#/contact" class="linkbtn small" ${pageKey === "contact" ? 'style="font-weight:700;color:var(--brand);"' : ""}>Contact Us</a>
            <a href="#/overview" class="btn small primary">${state.token ? "Back to Dashboard" : "Sign In"}</a>
          </nav>
        </header>
        <main class="main" id="view" style="max-width: 900px; margin: 0 auto; padding: 24px 16px 60px;"></main>
      </div>`.s;
  }

  function renderShell() {
    $("#app").innerHTML = html`
      <div class="mobile-bar">
        <button class="btn ghost small" data-action="toggle-nav" aria-label="Open menu">&#9776;</button>
        <div class="brand"><img src="/assets/logo.png" alt="Manweta AI Logo" referrerpolicy="no-referrer">Manweta AI</div>
      </div>
      <div class="shell">
        <aside class="side" aria-label="Main">
          <div class="brand"><img src="/assets/logo.png" alt="Manweta AI Logo" referrerpolicy="no-referrer">Manweta AI</div>
          <nav class="nav">
            ${NAV.map(([key, label]) => html`<a href="#/${key}" data-nav="${key}">${raw(ICON[key])}${label}</a>`)}
          </nav>
          <div class="who">
            <b>${state.session.tenant.name}</b>
            <span>${state.session.user.email}</span><br>
            <button class="linkbtn small" data-action="logout" style="margin-top:6px">Log out</button>
            <div class="sidebar-legal-links">
              <a href="#/contact" style="display:flex;align-items:center;gap:6px;color:var(--brand);font-weight:600;margin-bottom:6px;">
                <span>Support: support@manweta.com</span>
              </a>
              <div style="display:flex;gap:6px;color:var(--ink-3);">
                <a href="#/privacy">Privacy</a> &bull;
                <a href="#/terms">Terms</a> &bull;
                <a href="#/contact">Contact</a>
              </div>
            </div>
          </div>
        </aside>
        <main class="main" id="view" tabindex="-1"></main>
      </div>`.s;
  }

  const PAGES = {};

  async function route() {
    clearTimers();
    document.body.classList.remove("nav-open");
    const key = (location.hash.replace(/^#\//, "").split("?")[0]) || "overview";

    if (PUBLIC_PAGES.includes(key)) {
      if (!state.token) {
        renderPublicShell(key);
      } else {
        if (!$("#view") || !$(".side")) renderShell();
      }
      const view = $("#view");
      if (view) {
        view.innerHTML = '<div class="loading">Loading…</div>';
        try {
          await PAGES[key](view);
          window.scrollTo(0, 0);
        } catch (ex) {
          view.innerHTML = html`<div class="notice bad">${ex.message}</div>`.s;
        }
      }
      return;
    }

    if (!state.token) {
      renderAuth(key === "signup" ? "signup" : "login");
      return;
    }

    if (!$("#view") || !$(".side")) renderShell();
    const page = PAGES[key] ? key : "overview";
    document.querySelectorAll(".nav a").forEach((a) => {
      if (a.dataset.nav === page) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    const view = $("#view");
    view.innerHTML = '<div class="loading">Loading…</div>';
    try {
      await PAGES[page](view);
      window.scrollTo(0, 0);
    } catch (ex) {
      view.innerHTML = html`<div class="notice bad">${ex.message}</div>`.s;
    }
  }

  async function boot() {
    const key = (location.hash.replace(/^#\//, "").split("?")[0]) || "overview";
    if (PUBLIC_PAGES.includes(key) && !state.token) {
      await route();
      return;
    }
    if (!state.token) { renderAuth("login"); return; }
    if (!state.session) {
      try { state.session = await api("/auth/me"); }
      catch { renderAuth("login"); return; }
    }
    renderShell();
    route();
  }

  /* =====================================================================
     Page: Overview
     ===================================================================== */
  const STEP_COPY = {
    company: ["Company", "Your account is created.", null],
    tally: ["Connect Tally", "Install the small connector on the PC that runs Tally so your bills sync automatically.", "#/tally"],
    whatsapp: ["Connect WhatsApp", "Link your own WhatsApp Business number. Reminders go out from it.", "#/whatsapp"],
    reminders: ["Turn on reminders", "Choose which bills to chase and when. You can preview before anything is sent.", "#/reminders"],
  };

  PAGES.overview = async (view) => {
    const o = await api("/portal/overview");
    state.overview = o; state.currency = o.currency || "₹";
    const st = Object.fromEntries(o.steps.map((s) => [s.key, s.state]));
    const r = o.receivables, m = o.messaging_30d;
    const firstOpen = o.steps.find((s) => s.state !== "done");

    const stepper = o.onboarding_complete ? "" : html`
      <div class="panel section">
        <div class="panel-head"><div><h2>Finish setting up</h2><p class="muted small">${o.steps.filter((s) => s.state === "done").length} of 4 done</p></div></div>
        <div class="steps">
          ${o.steps.map((s, i) => {
            const [title, text, href] = STEP_COPY[s.key];
            const label = s.state === "done" ? "Done" : s.state === "in_progress" ? "Continue" : "Start";
            return html`<div class="step ${s.state} ${firstOpen && firstOpen.key === s.key ? "current" : ""}">
              <span class="n">${s.state === "done" ? raw("&#10003;") : i + 1}</span>
              <h3>${title}</h3>
              <p>${s.key === "company" ? s.detail : text}</p>
              ${href && s.state !== "done" ? html`<a class="btn ${firstOpen && firstOpen.key === s.key ? "primary" : ""} small" href="${href}">${label}</a>` : ""}
            </div>`;
          })}
        </div>
      </div>`;

    const tallyDot = st.tally === "done" ? "good" : st.tally === "in_progress" ? "warn" : "";
    const waDot = st.whatsapp === "done" ? "good" : st.whatsapp === "in_progress" ? "warn" : "";
    const pipeline = html`
      <div class="panel section">
        <div class="pipe">
          <div class="node">
            <div class="lbl"><span class="dot ${tallyDot}"></span>Tally</div>
            <div class="big">${o.last_sync ? timeAgo(o.last_sync.at) : "Not synced"}</div>
            <div class="sub">${o.last_sync ? o.last_sync.records + " customers read" : "Waiting for the connector"}</div>
            ${st.tally !== "done" ? html`<a class="more" href="#/tally">Connect Tally</a>` : ""}
          </div>
          <div class="node">
            <div class="lbl"><span class="dot ${r.customers_owing ? "good" : ""}"></span>Manweta AI</div>
            <div class="big">${r.customers_owing} ${r.customers_owing === 1 ? "customer owes" : "customers owe"}</div>
            <div class="sub">${r.open_bills} open ${r.open_bills === 1 ? "bill" : "bills"}</div>
            <a class="more" href="#/customers">View customers</a>
          </div>
          <div class="node">
            <div class="lbl"><span class="dot ${waDot}"></span>WhatsApp</div>
            <div class="big">${st.whatsapp === "done" ? "Ready" : st.whatsapp === "in_progress" ? "Almost ready" : "Not connected"}</div>
            <div class="sub">${st.whatsapp === "done" ? "Sending from your number" : st.whatsapp === "in_progress" ? "Waiting on template approval" : "Connect your business number"}</div>
            ${st.whatsapp !== "done" ? html`<a class="more" href="#/whatsapp">${st.whatsapp === "todo" ? "Connect WhatsApp" : "Check status"}</a>` : ""}
          </div>
          <div class="node">
            <div class="lbl"><span class="dot ${m.delivered ? "good" : ""}"></span>Your customers</div>
            <div class="big">${m.delivered} delivered</div>
            <div class="sub">${m.read} read, ${m.failed} failed (30 days)</div>
            <a class="more" href="#/reminders">See history</a>
          </div>
        </div>
      </div>`;

    const overduePct = r.total_outstanding > 0 ? Math.min(100, Math.round((r.overdue_amount / r.total_outstanding) * 100)) : 0;
    const receivables = html`
      <div class="panel">
        <div class="panel-head"><h2>Money owed to you</h2></div>
        <div class="panel-body">
          <dl class="kv">
            <dt>Total outstanding</dt><dd class="big">${money(r.total_outstanding)}</dd>
            <dt>Overdue</dt><dd style="color:var(--bad)">${money(r.overdue_amount)}</dd>
          </dl>
          <div class="bar" role="img" aria-label="${overduePct}% of outstanding is overdue"><i style="width:${overduePct}%"></i><i class="ok" style="width:${100 - overduePct}%"></i></div>
          <p class="small muted">${overduePct}% of what's owed is past its due date, across ${r.overdue_customers} ${r.overdue_customers === 1 ? "customer" : "customers"}.</p>
          ${r.owing_without_phone > 0 ? html`<div class="notice warn" style="margin-top:16px">
            ${r.owing_without_phone} ${r.owing_without_phone === 1 ? "customer who owes you has" : "customers who owe you have"} no phone number, so they can't be reminded.
            <a href="#/customers?filter=no_phone">Add numbers</a></div>` : ""}
        </div>
      </div>`;

    let recent = html`<div class="empty"><b>No reminders sent yet</b>Once WhatsApp is connected, every reminder shows up here with its delivery status.</div>`;
    if (m.total > 0) {
      const logs = await api("/portal/reminders/logs?limit=6");
      recent = html`<div class="table-wrap"><table>
        <thead><tr><th>Customer</th><th class="right">Amount</th><th>Status</th><th>When</th></tr></thead>
        <tbody>${logs.items.map((l) => html`<tr>
          <td class="name">${l.customer_name}</td><td class="right num">${l.amount != null ? money(l.amount) : "-"}</td>
          <td>${statusChip(l.status)}</td><td class="faint small">${timeAgo(l.sent_at || l.created_at)}</td></tr>`)}</tbody></table></div>`;
    }

    view.innerHTML = html`
      <div class="page-head"><div><h1>${o.tenant.name}</h1>
        <p>${o.onboarding_complete ? "Everything is connected. Reminders run automatically." : "Follow the steps below and you'll be sending reminders today."}</p></div></div>
      ${stepper}
      ${pipeline}
      <div class="cols section">
        ${receivables}
        <div class="panel"><div class="panel-head"><h2>Recent reminders</h2><a class="small" href="#/reminders">All history</a></div>${recent}</div>
      </div>`.s;
  };

  /* =====================================================================
     Page: Customers
     ===================================================================== */
  const cust = { search: "", filter: "all", offset: 0, limit: 50 };

  PAGES.customers = async (view) => {
    const q = new URLSearchParams((location.hash.split("?")[1] || ""));
    if (q.get("filter")) { cust.filter = q.get("filter"); cust.offset = 0; }
    await drawCustomers(view, true);
  };

  async function drawCustomers(view, first) {
    const params = new URLSearchParams({ search: cust.search, filter: cust.filter, limit: cust.limit, offset: cust.offset });
    const data = await api("/portal/customers?" + params);
    const tabs = [["all", "All"], ["owing", "Owing"], ["no_phone", "No phone"], ["opted_out", "Opted out"]];
    const from = data.total ? cust.offset + 1 : 0, to = Math.min(cust.offset + cust.limit, data.total);

    const body = data.items.length === 0
      ? html`<div class="empty"><b>${cust.search || cust.filter !== "all" ? "Nobody matches that" : "No customers yet"}</b>
          ${cust.search || cust.filter !== "all" ? "Try a different search or filter." : "Customers appear here after the Tally connector's first sync."}
          ${!cust.search && cust.filter === "all" ? html`<br><a class="btn primary" href="#/tally">Connect Tally</a>` : ""}</div>`
      : html`<div class="table-wrap"><table>
        <thead><tr><th>Customer</th><th>WhatsApp number</th><th class="right">Owes</th><th>Last reminder</th><th class="right">Actions</th></tr></thead>
        <tbody>${data.items.map((c) => html`<tr data-id="${c.id}">
          <td class="name">
            <button class="linkbtn" style="text-align:left;font-weight:600;color:var(--ink);cursor:pointer;" data-action="bills" data-id="${c.id}">${c.name}</button>
            ${(c.bills_count || 1) > 1 ? html` <button class="chip chip-multi" data-action="bills" data-id="${c.id}" title="Multiple bills: Click to see all ${c.bills_count} bills">⚡ ${c.bills_count} bills &bull; View all</button>` : html` <button class="chip" data-action="bills" data-id="${c.id}" title="Click to view bill details">1 bill</button>`}
            ${c.whatsapp_opt_out ? html` <span class="chip warn">Opted out</span>` : ""}
          </td>
          <td class="phone-cell">${phoneCell(c)}</td>
          <td class="right num"><span class="owed">${c.total_pending > 0 ? money(c.total_pending) : "-"}</span></td>
          <td>${c.last_reminder ? html`${statusChip(c.last_reminder.status)} <span class="faint small">${timeAgo(c.last_reminder.at)}</span>` : html`<span class="faint">-</span>`}</td>
          <td class="right"><div class="row" style="justify-content:flex-end;gap:6px">
            <button class="btn small" data-action="bills" data-id="${c.id}" title="Click to see all bills">View bills (${c.bills_count || 1})</button>
            <button class="btn small primary" data-action="remind" data-id="${c.id}" data-name="${c.name}" data-bills="${c.bills_count || 1}" data-pending="${c.total_pending || 0}" ${c.total_pending > 0 && !c.whatsapp_opt_out ? "" : "disabled"}>Remind</button>
            <button class="btn small ghost" data-action="optout" data-id="${c.id}" data-value="${c.whatsapp_opt_out ? "0" : "1"}">${c.whatsapp_opt_out ? "Opt in" : "Opt out"}</button>
          </div></td></tr>`)}</tbody></table></div>
        <div class="pager"><span class="small muted">${from}-${to} of ${data.total}</span>
          <div class="row"><button class="btn small" data-action="page" data-dir="-1" ${cust.offset === 0 ? "disabled" : ""}>Previous</button>
          <button class="btn small" data-action="page" data-dir="1" ${to >= data.total ? "disabled" : ""}>Next</button></div></div>`;

    const listHtml = html`<div class="toolbar">
        <div class="tabs" role="group" aria-label="Filter customers">${tabs.map(([k, l]) => html`<button data-action="filter" data-filter="${k}" aria-pressed="${cust.filter === k}">${l}</button>`)}</div>
        <input type="search" id="cust-search" placeholder="Search customers" value="${cust.search}" aria-label="Search customers">
      </div>${body}`;

    if (first) {
      view.innerHTML = html`
        <div class="page-head"><div><h1>Customers</h1>
          <p>Synced from Tally. Add or fix a WhatsApp number here and it is kept even when Tally syncs again.</p></div></div>
        <div class="panel" id="cust-panel">${listHtml}</div>`.s;
      $("#cust-search").addEventListener("input", debounce((e) => { cust.search = e.target.value; cust.offset = 0; drawCustomers(view, false); }, 300));
    } else {
      const focused = document.activeElement && document.activeElement.id === "cust-search";
      $("#cust-panel").innerHTML = listHtml.s;
      const inp = $("#cust-search");
      inp.addEventListener("input", debounce((e) => { cust.search = e.target.value; cust.offset = 0; drawCustomers(view, false); }, 300));
      if (focused) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }
  }

  function phoneCell(c) {
    return c.phone_number
      ? html`<span class="num">${c.phone_number}</span> <button class="linkbtn small" data-action="edit-phone" data-id="${c.id}" data-phone="${c.phone_number}">Edit</button>`
      : html`<button class="linkbtn" data-action="edit-phone" data-id="${c.id}" data-phone="">Add number</button>`;
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  /* =====================================================================
     Page: Reminders (rules, preview, run, history)
     ===================================================================== */
  const hist = { status: "", offset: 0, limit: 25 };
  let currentPreviewMode = null;

  PAGES.reminders = async (view) => {
    const cfg = await api("/portal/reminders/settings");
    const s = cfg.settings;
    if (!currentPreviewMode) currentPreviewMode = s.reminder_mode || "customer_wise";

    const [wa, prev] = await Promise.all([
      api("/portal/whatsapp"),
      api("/portal/reminders/preview?mode=" + currentPreviewMode),
    ]);
    const account = wa.account;
    const common = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York"];
    const zones = [...new Set([s.timezone, ...common, ...cfg.timezones])];
    const ready = account && account.ready_to_send;

    const gate = !account
      ? html`<div class="notice warn">Connect WhatsApp before turning reminders on. <a href="#/whatsapp">Connect WhatsApp</a></div>`
      : !ready ? html`<div class="notice warn">Your WhatsApp reminder template isn't approved yet (${account.template_status || "not created"}). Reminders can't be sent until it is. <a href="#/whatsapp">Check status</a></div>` : "";

    const sk = prev.skipped;
    const skippedBits = [
      sk.missing_phone && `${sk.missing_phone} without a phone number`,
      sk.opted_out && `${sk.opted_out} opted out`,
      sk.recently_reminded && `${sk.recently_reminded} reminded recently`,
      sk.below_minimum && `${sk.below_minimum} below the minimum amount`,
    ].filter(Boolean);

    view.innerHTML = html`
      <div class="page-head"><div><h1>Reminders</h1>
        <p>Decide which bills to chase and when. Reminders go from your own WhatsApp number to customers with a phone number on file.</p></div></div>
      ${gate}
      <div class="cols section">
        <form class="panel" id="rules-form">
          <div class="panel-head"><h2>Rules</h2>
            <label class="switch"><input type="checkbox" name="enabled" ${s.enabled ? "checked" : ""}><span class="track"></span><span>${s.enabled ? "Automatic reminders on" : "Automatic reminders off"}</span></label></div>
          <div class="panel-body">
            <div class="fieldset"><legend>Which bills</legend>
              <label class="switch" style="margin-bottom:10px"><input type="checkbox" name="remind_overdue" ${s.remind_overdue ? "checked" : ""}><span class="track"></span><span>Bills past their due date</span></label><br>
              <label class="switch"><input type="checkbox" name="remind_upcoming" ${s.remind_upcoming ? "checked" : ""}><span class="track"></span>
                <span>Bills due within <input class="inline-num" type="number" name="days_before_due" min="0" max="60" value="${s.days_before_due}" aria-label="Days before due date"> days</span></label>
            </div>
            <div class="fieldset"><legend>Default Reminder Mode / Granularity</legend>
              <label class="switch" style="margin-bottom:12px;display:flex;align-items:flex-start;gap:10px;">
                <input type="radio" name="reminder_mode" value="customer_wise" ${s.reminder_mode !== "bill_wise" ? "checked" : ""}>
                <span style="display:inline-block;">
                  <b>Customer-wise (Consolidated)</b><br>
                  <span class="muted small">Send a single WhatsApp message per customer summarizing their total outstanding balance across all due bills. (Recommended & saves message charges)</span>
                </span>
              </label>
              <label class="switch" style="display:flex;align-items:flex-start;gap:10px;">
                <input type="radio" name="reminder_mode" value="bill_wise" ${s.reminder_mode === "bill_wise" ? "checked" : ""}>
                <span style="display:inline-block;">
                  <b>Bill-wise (Per-Bill Itemized)</b><br>
                  <span class="muted small">Send a separate reminder for each individual invoice with its specific invoice number and due date.</span>
                </span>
              </label>
            </div>
            <div class="fieldset"><legend>How often</legend>
              <div class="grid2">
                <label class="field"><span>Send daily at</span>
                  <select name="send_hour">${Array.from({ length: 24 }, (_, h) => html`<option value="${h}" ${h === s.send_hour ? "selected" : ""}>${(h % 12 || 12) + ":00 " + (h < 12 ? "AM" : "PM")}</option>`)}</select></label>
                <label class="field"><span>Time zone</span>
                  <select name="timezone">${zones.map((z) => html`<option value="${z}" ${z === s.timezone ? "selected" : ""}>${z.replace(/_/g, " ")}</option>`)}</select></label>
              </div>
              <label class="field" style="margin-bottom:0"><span>Wait between reminders to the same customer</span>
                <input type="number" name="repeat_every_days" min="0" max="90" value="${s.repeat_every_days}" style="width:100px"> <span class="muted small">days</span>
                <small>Set 0 to remind on every run.</small></label>
            </div>
            <label class="field"><span>Skip balances below</span>
              <input type="number" name="min_amount" min="0" step="1" value="${s.min_amount}" style="width:140px">
              <small>Amounts in ${state.currency}. Set 0 to include everything.</small></label>
            <div class="sticky-actions"><button class="btn primary" type="submit">Save rules</button>
              ${s.last_auto_run_at ? html`<span class="small faint">Last automatic run ${timeAgo(s.last_auto_run_at)}</span>` : ""}</div>
          </div>
        </form>

        <div class="panel">
          <div class="panel-head">
            <div>
              <h2>Who would get a message now</h2>
              <div style="display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap;">
                <button type="button" class="btn small ${currentPreviewMode === 'customer_wise' ? 'primary' : 'ghost'}" data-action="switch-preview-mode" data-mode="customer_wise" style="padding:4px 10px;font-size:12px;">
                  👥 Customer-wise Preview
                </button>
                <button type="button" class="btn small ${currentPreviewMode === 'bill_wise' ? 'primary' : 'ghost'}" data-action="switch-preview-mode" data-mode="bill_wise" style="padding:4px 10px;font-size:12px;">
                  📄 Bill-wise Preview
                </button>
              </div>
            </div>
            <button class="btn primary small" data-action="run-now" data-mode="${currentPreviewMode}" ${ready && prev.count ? "" : "disabled"}>
              Send ${prev.count} ${currentPreviewMode === 'bill_wise' ? (prev.count === 1 ? 'bill' : 'bills') : (prev.count === 1 ? 'customer' : 'customers')} now
            </button>
          </div>
          ${prev.count === 0
            ? html`<div class="empty"><b>Nobody is due right now</b>${skippedBits.length ? "Skipped: " + skippedBits.join(", ") + "." : "No bill matches your rules today."}</div>`
            : html`<div class="table-wrap"><table><thead><tr><th>Customer</th>${prev.reminder_mode === 'bill_wise' ? html`<th>Bill Ref</th>` : html`<th>Bills</th>`}<th class="right">Amount</th><th>Why</th></tr></thead>
              <tbody>${prev.candidates.slice(0, 12).map((c) => html`<tr>
                <td class="name">${c.name}</td>
                <td>${prev.reminder_mode === 'bill_wise' ? html`<b>${c.bill_ref || "-"}</b>` : html`<span class="chip">${c.bills} ${c.bills === 1 ? "bill" : "bills"}</span>`}</td>
                <td class="right num">${money(c.amount)}</td>
                <td>${c.overdue_days > 0 ? html`<span class="chip bad">${c.overdue_days} d overdue</span>` : html`<span class="chip good">${c.reason || 'Due soon'}</span>`}</td>
              </tr>`)}</tbody></table></div>
              <div class="pager"><span class="small muted">${prev.count} ${prev.reminder_mode === 'bill_wise' ? (prev.count === 1 ? "reminder (1 bill)" : "reminders (bill-wise)") : (prev.count === 1 ? "customer" : "customers")}, ${money(prev.total_amount)} in total${prev.count > 12 ? ", top 12 shown" : ""}</span></div>
              ${skippedBits.length ? html`<div class="panel-body small muted" style="border-top:1px solid var(--line-2)">Skipped: ${skippedBits.join(", ")}.</div>` : ""}`}
        </div>
      </div>

      <div class="section"><div class="panel" id="hist-panel"></div></div>`.s;

    $("#rules-form").addEventListener("submit", saveRules);
    await drawHistory();
  };

  async function saveRules(e) {
    e.preventDefault();
    const f = e.target, v = (n) => f.elements[n];
    const btn = $("button[type=submit]", f);
    btn.disabled = true;
    const mode = f.elements["reminder_mode"] ? f.elements["reminder_mode"].value : "customer_wise";
    try {
      await api("/portal/reminders/settings", {
        method: "PUT",
        body: {
          enabled: v("enabled").checked, send_hour: +v("send_hour").value, timezone: v("timezone").value,
          remind_overdue: v("remind_overdue").checked, remind_upcoming: v("remind_upcoming").checked,
          days_before_due: +v("days_before_due").value || 0, repeat_every_days: +v("repeat_every_days").value || 0,
          min_amount: +v("min_amount").value || 0,
          reminder_mode: mode,
        },
      });
      currentPreviewMode = mode;
      toast("Rules saved", "good");
      route();
    } catch (ex) { toast(ex.message, "bad"); btn.disabled = false; }
  }

  async function drawHistory() {
    const params = new URLSearchParams({ limit: hist.limit, offset: hist.offset });
    if (hist.status) params.set("status", hist.status);
    const d = await api("/portal/reminders/logs?" + params);
    const tabs = [["", "All"], ["read", "Read"], ["delivered", "Delivered"], ["sent", "Sent"], ["failed", "Failed"]];
    const to = Math.min(hist.offset + hist.limit, d.total);
    $("#hist-panel").innerHTML = html`
      <div class="panel-head"><h2>History</h2>
        <div class="tabs" role="group" aria-label="Filter history">${tabs.map(([k, l]) => html`<button data-action="hist-filter" data-status="${k}" aria-pressed="${hist.status === k}">${l}</button>`)}</div></div>
      ${d.items.length === 0 ? html`<div class="empty"><b>Nothing here yet</b>Sent reminders and their delivery status will be listed here.</div>`
        : html`<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Format</th><th>Number</th><th class="right">Amount</th><th>Status</th><th>Sent</th><th>By</th></tr></thead>
          <tbody>${d.items.map((l) => html`<tr>
            <td class="name">${l.customer_name}</td>
            <td><span class="chip" style="font-size:11px;">${l.reminder_mode === 'bill_wise' ? (l.bill_ref ? `Bill: ${l.bill_ref}` : 'Bill-wise') : (l.bills_count > 1 ? `Consolidated (${l.bills_count} bills)` : 'Customer-wise')}</span></td>
            <td class="num muted">${l.phone_number}</td>
            <td class="right num">${l.amount != null ? money(l.amount) : "-"}</td>
            <td>${statusChip(l.status)}${l.error_message ? html`<div class="small" style="color:var(--bad);max-width:280px">${l.error_message}</div>` : ""}</td>
            <td class="small muted">${dateTime(l.sent_at || l.created_at)}</td><td class="small muted">${l.trigger === "auto" ? "Automatic" : "Manual"}</td></tr>`)}</tbody></table></div>
          <div class="pager"><span class="small muted">${hist.offset + 1}-${to} of ${d.total}</span>
            <div class="row"><button class="btn small" data-action="hist-page" data-dir="-1" ${hist.offset === 0 ? "disabled" : ""}>Previous</button>
            <button class="btn small" data-action="hist-page" data-dir="1" ${to >= d.total ? "disabled" : ""}>Next</button></div></div>`}`.s;
  }

  /* =====================================================================
     Page: Replies
     ===================================================================== */
  PAGES.replies = async (view) => {
    const d = await api("/portal/replies");
    view.innerHTML = html`
      <div class="page-head"><div><h1>Replies</h1>
        <p>What your customers wrote back on WhatsApp. If someone replies STOP, they're opted out automatically.</p></div></div>
      <div class="panel">${d.items.length === 0
        ? html`<div class="empty"><b>No replies yet</b>When a customer answers a reminder, their message shows up here.</div>`
        : html`<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Message</th><th>Received</th></tr></thead>
          <tbody>${d.items.map((m) => html`<tr><td class="name">${m.customer_name || html`<span class="muted">Unknown</span>`}<div class="small faint num">${m.phone_number}</div></td>
            <td style="max-width:460px">${m.body || html`<span class="faint">(${m.message_type})</span>`}</td><td class="small muted">${dateTime(m.received_at)}</td></tr>`)}</tbody></table></div>`}</div>`.s;
  };

  /* =====================================================================
     Page: Tally
     ===================================================================== */
  PAGES.tally = async (view) => {
    const paint = async () => {
      const t = await api("/portal/tally");
      const active = t.connectors.filter((c) => c.status === "active");
      const synced = active.find((c) => c.last_sync_at);
      const connected = !!synced;

      view.innerHTML = html`
        <div class="page-head"><div><h1>Connect Tally</h1>
          <p>A small Windows program runs next to TallyPrime, reads your outstanding bills every 15 minutes and sends them here. Your Tally port is never exposed to the internet.</p></div></div>
        ${connected ? html`<div class="notice good">Connected. Last sync ${timeAgo(synced.last_sync_at)}.</div>`
          : active.length ? html`<div class="notice info">The connector is activated and waiting for its first sync. This page updates by itself.</div>` : ""}
        <div class="panel section"><div class="panel-body"><ol class="how">
          <li class="${active.length ? "ok" : ""}"><div><h3>Install the connector</h3></div><div class="body">
            <p class="muted">Run the installer on the Windows PC where TallyPrime is used. It reads local data and needs internet access.</p>
            <div style="margin-top:12px;">
              <a class="btn primary" href="${t.download_url || '/api/v1/portal/tally/download'}" download="TallyConnector-Setup.exe" style="display:inline-flex;align-items:center;gap:8px;font-weight:600;padding:10px 18px;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Download for Windows (.exe)
              </a>
            </div>
          </div></li>
          <li><div><h3>Switch on Tally's local server</h3></div><div class="body">
            <p class="muted">In TallyPrime press <span class="kbd">F1</span> &rarr; Settings &rarr; Advanced Configuration. Set <b>HTTP Server</b> to Yes and <b>Port</b> to 9000, then open the company you want to sync.</p></div></li>
          <li class="${active.length ? "ok" : ""}"><div><h3>Enter your activation code</h3></div><div class="body">
            ${t.activation_code
              ? html`<p class="muted" style="margin-bottom:12px">Paste this when the connector asks for it. It works once.</p>
                <div class="row"><span class="code" id="act-code">${t.activation_code}</span>
                <button class="btn small" data-action="copy" data-text="${t.activation_code}">Copy</button></div>
                <p style="margin-top:12px"><button class="linkbtn small" data-action="new-code">Generate a new code</button></p>`
              : html`<p class="muted">${active.length ? "Your code has been used." : "You don't have an unused code."} Need to connect another PC?</p>
                <p style="margin-top:10px"><button class="btn small" data-action="new-code">Generate a new code</button></p>`}</div></li>
          <li class="${connected ? "ok" : ""}"><div><h3>Wait for the first sync</h3></div><div class="body">
            <p class="muted">${connected ? "Bills are flowing in. Check the customer list." : "Once the connector starts, it appears below within a minute or two."}</p>
            ${connected ? html`<a class="btn small primary" style="margin-top:8px" href="#/customers">View customers</a>` : ""}</div></li>
        </ol></div></div>

        <div class="panel section"><div class="panel-head"><h2>Connected computers</h2></div>
          ${t.connectors.length === 0 ? html`<div class="empty"><b>Nothing connected yet</b>Complete the steps above and your computer will show up here.</div>`
            : html`<div class="table-wrap"><table><thead><tr><th>Connector</th><th>Status</th><th>Last seen</th><th>Last sync</th><th class="right"></th></tr></thead>
              <tbody>${t.connectors.map((c) => html`<tr><td class="num">${c.connector_id}</td>
                <td><span class="chip ${c.status === "active" ? "good" : ""}">${c.status === "active" ? "Active" : "Revoked"}</span></td>
                <td class="muted small">${timeAgo(c.last_seen_at)}</td><td class="muted small">${timeAgo(c.last_sync_at)}</td>
                <td class="right">${c.status === "active" ? html`<button class="btn small danger" data-action="revoke" data-id="${c.connector_id}">Revoke</button>` : ""}</td></tr>`)}</tbody></table></div>`}
        </div>`.s;
      return connected;
    };

    const connected = await paint();
    if (!connected) every(10000, async () => { if (location.hash.startsWith("#/tally") && !document.querySelector(".modal")) { try { if (await paint()) clearTimers(); } catch { /* keep polling */ } } });
  };

  /* =====================================================================
     Page: WhatsApp
     ===================================================================== */
  const TEMPLATE_INFO = {
    APPROVED: ["good", "Approved", "Reminders can be sent."],
    PENDING: ["warn", "Under review", "WhatsApp is reviewing the reminder message. This usually takes a few minutes."],
    IN_APPEAL: ["warn", "In appeal", "WhatsApp is re-reviewing the reminder message."],
    REJECTED: ["bad", "Rejected", "WhatsApp rejected the reminder message."],
    PAUSED: ["bad", "Paused", "WhatsApp paused the reminder message because of low quality."],
    DISABLED: ["bad", "Disabled", "WhatsApp disabled the reminder message."],
    MISSING: ["bad", "Not created", "The reminder message hasn't been created in your WhatsApp account."],
  };

  PAGES.whatsapp = async (view) => {
    const [wa, cfg] = await Promise.all([api("/portal/whatsapp"), api("/portal/whatsapp/config")]);
    const a = wa.account;

    if (!a) {
      view.innerHTML = html`
        <div class="page-head"><div><h1>Connect WhatsApp</h1>
          <p>Reminders are sent from your own WhatsApp Business number, so customers see a name they recognise. You'll sign in with Facebook in a pop-up. We never see your password.</p></div></div>
        <div class="panel"><div class="panel-body">
          <h2>What you'll be asked</h2>
          <div class="flow-list">
            <div><b>1. Log in with Facebook</b>Use the account that manages your business.</div>
            <div><b>2. Choose a business</b>Pick your business portfolio, or create one.</div>
            <div><b>3. Choose a WhatsApp account</b>Use an existing one or create a new one.</div>
            <div><b>4. Verify your phone</b>Enter your business number; you'll get a code.</div>
            <div><b>5. Allow access</b>Review what Manweta AI can do and confirm.</div>
            <div><b>6. Back here</b>You'll land back on this page, connected.</div>
          </div>
          ${cfg.embedded_signup_enabled
            ? html`<button class="btn primary" data-action="wa-connect" id="wa-connect-btn">Connect WhatsApp</button>`
            : html`<div class="notice warn">One-click connect isn't switched on for this server yet (the Meta app settings are missing). You can still connect with your WhatsApp credentials below.</div>`}
          <details class="adv" ${cfg.embedded_signup_enabled ? "" : "open"}>
            <summary>Connect with existing credentials instead</summary>
            <p class="muted small" style="margin-bottom:12px">Find these in Meta's WhatsApp Manager and app dashboard. Use a permanent (system user) access token.</p>
            <form id="manual-form" style="max-width:460px">
              <label class="field"><span>WhatsApp Business Account ID</span><input type="text" name="waba_id" required inputmode="numeric"></label>
              <label class="field"><span>Phone number ID</span><input type="text" name="phone_number_id" required inputmode="numeric"></label>
              <label class="field"><span>Access token</span><input type="password" name="access_token" required autocomplete="off"><small>Stored encrypted. It is never shown again.</small></label>
              <button class="btn" type="submit">Connect</button>
            </form>
          </details>
        </div></div>`.s;
      const mf = $("#manual-form");
      if (mf) mf.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = $("button", mf); btn.disabled = true;
        try {
          await api("/portal/whatsapp/manual", { method: "POST", body: Object.fromEntries(new FormData(mf).entries()) });
          toast("WhatsApp connected", "good"); route();
        } catch (ex) { toast(ex.message, "bad"); btn.disabled = false; }
      });
      return;
    }

    const [tcls, tlabel, ttext] = TEMPLATE_INFO[a.template_status] || TEMPLATE_INFO.MISSING;
    const qual = { GREEN: ["good", "Quality: high"], YELLOW: ["warn", "Quality: medium"], RED: ["bad", "Quality: low"] }[a.quality_rating];
    const needs = a.status === "reauth_required";

    view.innerHTML = html`
      <div class="page-head"><div><h1>WhatsApp</h1><p>Your business number, connected to Manweta AI.</p></div></div>
      ${needs ? html`<div class="notice bad">WhatsApp access was revoked or expired, so reminders are paused. ${cfg.embedded_signup_enabled ? html`<button class="linkbtn" data-action="wa-connect">Reconnect WhatsApp</button>` : "Reconnect with fresh credentials after disconnecting."}</div>` : ""}
      ${a.template_status === "REJECTED" && a.template_reject_reason ? html`<div class="notice bad">WhatsApp rejected the reminder message: ${a.template_reject_reason}</div>` : ""}
      ${a.last_error && !needs ? html`<div class="notice warn">${a.last_error}</div>` : ""}
      <div class="panel"><div class="panel-body">
        <div class="identity"><div class="avatar">${raw(ICON.whatsapp)}</div>
          <div><h2>${a.verified_name || "WhatsApp Business"}</h2>
            <div class="row" style="gap:8px;margin-top:4px"><span class="num" style="font-size:17px">${a.display_phone_number || "-"}</span>
              <span class="chip ${needs ? "bad" : "good"}">${needs ? "Needs reconnecting" : "Connected"}</span>${qual ? html`<span class="chip ${qual[0]}">${qual[1]}</span>` : ""}</div></div></div>
        <dl class="facts">
          <div><dt>Reminder message</dt><dd><span class="chip ${tcls}">${tlabel}</span></dd></div>
          <div><dt>Connected</dt><dd>${dateTime(a.connected_at)}</dd></div>
          <div><dt>Connected via</dt><dd>${a.connection_method === "embedded" ? "Facebook sign-in" : "Access token"}</dd></div>
          <div><dt>WhatsApp Business Account</dt><dd class="num small">${a.waba_id}</dd></div>
        </dl>
        <p class="muted small" style="margin-top:16px">${ttext}</p>
        <div class="row" style="margin-top:14px"><button class="btn small" data-action="wa-refresh">Refresh status</button></div>
      </div></div>

      <div class="panel"><div class="panel-head"><h2>Send a test message</h2></div><div class="panel-body">
        <form id="test-form" class="row" style="align-items:flex-end">
          <label class="field" style="margin:0;flex:1;min-width:220px"><span>Your phone number</span><input type="tel" name="to" placeholder="+91 98765 43210" required autocomplete="tel"></label>
          <button class="btn primary" type="submit">Send test</button></form>
        <p class="small muted" style="margin-top:10px">${a.template_status === "APPROVED" ? "Sends a sample payment reminder so you can see exactly what customers get." : "While the reminder message is under review, this sends WhatsApp's built-in sample message."}</p>
      </div></div>

      <div class="panel"><div class="panel-body row between"><div><b>Disconnect WhatsApp</b><p class="muted small">Stops all reminders. Your WhatsApp account itself is not deleted.</p></div>
        <button class="btn danger" data-action="wa-disconnect">Disconnect</button></div></div>`.s;

    $("#test-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("button", e.target); btn.disabled = true;
      try {
        const r = await api("/portal/whatsapp/test", { method: "POST", body: { to: e.target.elements.to.value } });
        toast("Test message sent to +" + r.to, "good");
      } catch (ex) { toast(ex.message, "bad"); }
      btn.disabled = false;
    });

    if (["PENDING", "IN_APPEAL"].includes(a.template_status)) {
      every(20000, async () => {
        if (!location.hash.startsWith("#/whatsapp")) return;
        try {
          const r = await api("/portal/whatsapp/refresh", { method: "POST" });
          if (r.account.template_status !== a.template_status) route();
        } catch { /* try again later */ }
      });
    }
  };

  /* =====================================================================
     Page: Privacy Policy
     ===================================================================== */
  PAGES.privacy = async (view) => {
    view.innerHTML = html`
      <div class="legal-page">
        <div class="page-head" style="margin-bottom:20px;">
          <div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
              <span class="chip good">Official Policy</span>
              <span class="small muted">Effective Date: October 2026</span>
            </div>
            <h1>Privacy Policy</h1>
            <p>How Manweta AI safeguards and manages accounting and WhatsApp messaging data.</p>
          </div>
        </div>

        <div class="legal-card">
          <div style="background:var(--brand-soft);border:1px solid #dcd8f8;border-radius:var(--r-ctl);padding:14px 18px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
            <div>
              <b style="color:var(--brand);">Questions or Data Requests?</b>
              <div class="small muted">Reach our Data Protection & Privacy Team directly at <b>support@manweta.com</b>.</div>
            </div>
            <a href="#/contact" class="btn small primary">Contact Support</a>
          </div>

          <h2>1. Overview & Commitment</h2>
          <p>Manweta AI ("we", "our", or "us") provides a software-as-a-service platform connecting Tally ERP / Tally Prime accounting records with WhatsApp Business API to send payment reminders and track debt collections. We respect the privacy of our tenant businesses and their underlying customers (Sundry Debtors). We never sell, rent, or trade your accounting or contact data to third parties or advertising networks.</p>

          <h2>2. Information We Process</h2>
          <p>To deliver automated and manual payment reminders, our desktop connector and cloud service collect and process:</p>
          <ul>
            <li><b>Debtor / Customer Data:</b> Ledger names, business contact names, WhatsApp mobile numbers, billing addresses, and opt-out preferences.</li>
            <li><b>Financial & Invoice Records:</b> Tally bill reference numbers, invoice dates, agreed credit periods, due dates, outstanding/pending balances, and payment statuses.</li>
            <li><b>WhatsApp Messaging Telemetry:</b> WhatsApp message IDs (wamid), delivery timestamps, read receipts, and inbound customer replies (such as NEFT references or STOP opt-out requests).</li>
            <li><b>Account Credentials:</b> Business organization name, administrator email address, password hashes, and Meta WhatsApp Business API tokens (encrypted at rest).</li>
          </ul>

          <h2>3. Purpose of Processing</h2>
          <p>We process your data strictly for legitimate business accounting and payment collection operations:</p>
          <ul>
            <li>Calculating customer overdue balances and determining reminder eligibility based on your configured rules.</li>
            <li>Formatting and transmitting authorized WhatsApp payment reminder notifications (in both customer-wise consolidated format and bill-wise itemized format).</li>
            <li>Recording real-time delivery and read confirmations so you know which clients received reminders.</li>
            <li>Enforcing customer opt-out requests (such as replies containing "STOP") so that unsubscribed contacts never receive automated messages.</li>
          </ul>

          <h2>4. WhatsApp Business & Meta Cloud API Compliance</h2>
          <p>Reminders are transmitted through the official Meta WhatsApp Business Cloud API under your authorized WhatsApp Business Account (WABA). All messages conform to pre-approved WhatsApp Business templates. We do not store conversational histories beyond payment status acknowledgments, NEFT/UTR payment details, and opt-out commands.</p>

          <h2>5. Data Security & Multi-Tenant Isolation</h2>
          <p>We maintain strict administrative and technical safeguards:</p>
          <ul>
            <li><b>Multi-Tenant Isolation:</b> Every company's customer ledgers and invoices are segregated by tenant ID and cryptographically partitioned.</li>
            <li><b>In-Transit & At-Rest Encryption:</b> All data transmission between Tally desktop connector, Manweta cloud, and Meta APIs uses TLS 1.3 encryption.</li>
            <li><b>Connector Security:</b> The desktop Tally connector uses single-use activation codes and unique secret tokens. It operates in read-only mode and cannot write or alter your local Tally database.</li>
          </ul>

          <h2>6. Customer Rights & Opt-Outs</h2>
          <p>Customers have an absolute right to stop receiving automated reminders:</p>
          <ul>
            <li>A debtor can reply <code>STOP</code> to any reminder message at any time; our webhook immediately marks their record as opted out.</li>
            <li>You can toggle opt-in / opt-out status manually at any time in the <a href="#/customers">Customers tab</a>.</li>
            <li>Tenants may request complete export or deletion of their stored customer logs by contacting <b>support@manweta.com</b>.</li>
          </ul>

          <h2>7. Contact Us</h2>
          <p>For any privacy questions, security disclosures, or data rights requests, please contact:</p>
          <div style="margin-top:10px;">
            <b>Manweta AI Privacy Office</b><br>
            Email: <a href="mailto:support@manweta.com" style="color:var(--brand);font-weight:600;">support@manweta.com</a><br>
            Support Portal: <a href="#/contact">#/contact</a>
          </div>
        </div>
      </div>`.s;
  };

  /* =====================================================================
     Page: Terms and Conditions
     ===================================================================== */
  PAGES.terms = async (view) => {
    view.innerHTML = html`
      <div class="legal-page">
        <div class="page-head" style="margin-bottom:20px;">
          <div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
              <span class="chip good">Terms of Service</span>
              <span class="small muted">Last Updated: October 2026</span>
            </div>
            <h1>Terms & Conditions</h1>
            <p>Rules and terms governing the use of Manweta AI platform and Tally connector.</p>
          </div>
        </div>

        <div class="legal-card">
          <div style="background:var(--brand-soft);border:1px solid #dcd8f8;border-radius:var(--r-ctl);padding:14px 18px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
            <div>
              <b style="color:var(--brand);">Need Assistance or Clarification?</b>
              <div class="small muted">Contact support at <b>support@manweta.com</b> for billing or compliance questions.</div>
            </div>
            <a href="#/contact" class="btn small primary">Contact Support</a>
          </div>

          <h2>1. Acceptance of Terms</h2>
          <p>By creating an account, installing the Manweta AI Tally Connector, or accessing our web application, you agree to be bound by these Terms & Conditions. If you are entering into this agreement on behalf of a company or other legal entity, you represent that you have authority to bind that entity.</p>

          <h2>2. Service Description</h2>
          <p>Manweta AI provides software that integrates local Tally ERP 9 / Tally Prime accounting data with WhatsApp Business Cloud API to deliver payment reminders, statement summaries, and track customer replies. Features include multi-bill ledger tracking, customer-wise and bill-wise reminder dispatching, and inbound payment reply monitoring.</p>

          <h2>3. User Responsibilities & Messaging Consent</h2>
          <p>You agree and certify that:</p>
          <ul>
            <li>You possess a valid commercial relationship with every recipient and have obtained lawful consent to send transactional accounting reminders to their WhatsApp phone number.</li>
            <li>You will not use Manweta AI to transmit spam, unsolicited commercial advertisements, harassment, or unlawful content.</li>
            <li>You will promptly respect and honor all opt-out requests (whether requested via WhatsApp reply or external request).</li>
            <li>You will keep your account login credentials and Tally connector activation tokens secure and confidential.</li>
          </ul>

          <h2>4. Tally Connector Software</h2>
          <p>The Manweta Tally Connector is provided as a companion client tool that runs locally on your PC or accounting server. It accesses Tally exclusively via Tally's local read-only XML port. You are responsible for ensuring that your Tally installation and Windows server have appropriate security measures, backup protocols, and firewall rules in place.</p>

          <h2>5. WhatsApp Business Policies</h2>
          <p>Usage of WhatsApp Business features is subject to Meta's WhatsApp Business Terms of Service and Messaging Policies. We are not liable for any account restrictions, rate limits, or message template rejections imposed by Meta due to policy violations, recipient complaints, or spam reports.</p>

          <h2>6. Reminder Modes & Message Charges</h2>
          <p>Manweta AI offers both <b>Customer-wise (Consolidated)</b> reminders and <b>Bill-wise (Itemized)</b> reminders. While customer-wise mode reduces WhatsApp conversation charges by consolidating multiple bills into a single notification, bill-wise mode sends individual notifications per invoice. You are responsible for any applicable Meta conversation charges incurred by your WhatsApp Business Account.</p>

          <h2>7. Limitation of Liability</h2>
          <p>To the maximum extent permitted by law, Manweta AI shall not be liable for any indirect, incidental, punitive, or consequential damages, or any loss of profits, revenue, or business resulting from delayed message delivery, network carrier outages, or the collection or non-collection of debts.</p>

          <h2>8. Termination & Contact</h2>
          <p>You may cancel your account at any time. For questions regarding these terms, please write to us at <b>support@manweta.com</b>.</p>
        </div>
      </div>`.s;
  };

  /* =====================================================================
     Page: Contact & Support (support@manweta.com)
     ===================================================================== */
  PAGES.contact = async (view) => {
    const userEmail = state.session ? state.session.user.email : "";
    const userName = state.session ? (state.session.user.full_name || state.session.tenant.name) : "";

    view.innerHTML = html`
      <div class="legal-page">
        <div class="page-head" style="margin-bottom:20px;">
          <div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
              <span class="chip good">Support Team Available</span>
              <span class="small muted">Response SLA: 2–4 Hours</span>
            </div>
            <h1>Contact Us & Support</h1>
            <p>Get in touch with the Manweta AI engineering and customer support team.</p>
          </div>
        </div>

        <div class="contact-hero">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--brand);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">Official Support Desk</div>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0 8px;">
              <div class="contact-email-badge">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                <span>support@manweta.com</span>
              </div>
              <button class="btn small primary" data-action="copy" data-text="support@manweta.com">Copy Email</button>
              <a href="mailto:support@manweta.com?subject=Manweta%20AI%20Support%20Request" class="btn small">Open Mail App</a>
            </div>
            <div class="small muted">Direct assistance for Tally connector setup, WhatsApp template approvals, and multi-bill configuration.</div>
          </div>
        </div>

        <div class="cols section" style="grid-template-columns:1fr 1.15fr;gap:20px;">
          <div>
            <div class="panel" style="margin-top:0;">
              <div class="panel-head"><h2>Support Channels</h2></div>
              <div class="panel-body">
                <div style="margin-bottom:18px;">
                  <b style="display:block;margin-bottom:2px;">Email Support</b>
                  <div class="num" style="color:var(--brand);font-weight:600;"><a href="mailto:support@manweta.com" style="color:var(--brand);text-decoration:none;">support@manweta.com</a></div>
                  <div class="small muted">Monitored 6 days a week by engineering.</div>
                </div>

                <div style="margin-bottom:18px;">
                  <b style="display:block;margin-bottom:2px;">Operating Hours</b>
                  <div style="font-size:14px;color:var(--ink);">Monday to Saturday</div>
                  <div class="small muted">9:00 AM – 7:00 PM IST</div>
                </div>

                <div style="margin-bottom:18px;">
                  <b style="display:block;margin-bottom:2px;">Typical Response Time</b>
                  <div style="font-size:14px;color:var(--ink);"><span class="chip good">Within 2 to 4 hours</span></div>
                  <div class="small muted">Urgent connector sync and reminder queries prioritized.</div>
                </div>

                <div style="border-top:1px solid var(--line-2);padding-top:14px;margin-top:14px;">
                  <b style="display:block;margin-bottom:6px;">Helpful Quick Links</b>
                  <ul style="padding-left:18px;margin:0;font-size:13.5px;color:var(--brand);">
                    <li><a href="#/customers">Customers & Multi-Bill Viewer</a></li>
                    <li><a href="#/reminders">Reminder Rules & Settings</a></li>
                    <li><a href="#/whatsapp">WhatsApp Business Connection</a></li>
                    <li><a href="#/tally">Tally Connector Download & Activation</a></li>
                    <li><a href="#/privacy">Privacy Policy</a></li>
                    <li><a href="#/terms">Terms & Conditions</a></li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          <div>
            <form class="panel" id="support-inquiry-form" style="margin-top:0;">
              <div class="panel-head"><h2>Send Support Message</h2></div>
              <div class="panel-body">
                <div id="support-feedback" class="notice good" hidden style="margin-bottom:14px;"></div>
                <div id="support-error" class="notice bad" hidden style="margin-bottom:14px;"></div>

                <label class="field">
                  <span>Your Name</span>
                  <input type="text" name="name" value="${userName}" placeholder="Rajesh Sharma" required>
                </label>

                <label class="field">
                  <span>Your Email Address</span>
                  <input type="email" name="email" value="${userEmail}" placeholder="name@company.com" required>
                  <small>Our support team will reply directly to this address.</small>
                </label>

                <div class="grid2">
                  <label class="field">
                    <span>Category</span>
                    <select name="category">
                      <option value="tally_connector">Tally Connector & Sync</option>
                      <option value="whatsapp_setup">WhatsApp Setup / Template</option>
                      <option value="multi_bill">Multi-bill Reminders</option>
                      <option value="account_billing">Account & Billing</option>
                      <option value="general" selected>General Question</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Subject</span>
                    <input type="text" name="subject" placeholder="Need help with multi-bill reminder" required>
                  </label>
                </div>

                <label class="field">
                  <span>Message Details</span>
                  <textarea name="message" rows="4" placeholder="Please describe how we can help you with your Tally integration or reminder setup..." required style="width:100%;font-family:inherit;padding:8px 12px;border:1px solid var(--line);border-radius:var(--r-ctl);resize:vertical;"></textarea>
                </label>

                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;flex-wrap:wrap;">
                  <button type="submit" class="btn primary" id="support-submit-btn">Send Message to Support</button>
                  <span class="small muted">Delivers directly to <b>support@manweta.com</b></span>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>`.s;

    const form = $("#support-inquiry-form");
    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const submitBtn = $("#support-submit-btn");
        const okBox = $("#support-feedback");
        const errBox = $("#support-error");
        okBox.hidden = true;
        errBox.hidden = true;
        submitBtn.disabled = true;

        const data = Object.fromEntries(new FormData(form).entries());
        try {
          if (state.token) {
            const res = await api("/portal/support/inquiry", { method: "POST", body: data });
            okBox.innerHTML = html`<b>Message Received (${res.ticket_id})!</b><br>${res.message}`.s;
            okBox.hidden = false;
            form.elements.message.value = "";
          } else {
            // Mailto fallback when unauthenticated
            const subject = encodeURIComponent(`[${data.category}] ${data.subject}`);
            const body = encodeURIComponent(`From: ${data.name} (${data.email})\n\n${data.message}`);
            window.location.href = `mailto:support@manweta.com?subject=${subject}&body=${body}`;
            okBox.innerHTML = html`<b>Opening your email client...</b><br>You can also send your email directly to <b>support@manweta.com</b>.`.s;
            okBox.hidden = false;
          }
        } catch (ex) {
          errBox.textContent = ex.message;
          errBox.hidden = false;
        } finally {
          submitBtn.disabled = false;
        }
      });
    }
  };

  /* ---- Meta Embedded Signup (browser side) ---- */
  let fbReady = null;
  function loadFacebookSdk(cfg) {
    if (fbReady) return fbReady;
    fbReady = new Promise((resolve, reject) => {
      window.fbAsyncInit = function () {
        window.FB.init({ appId: cfg.app_id, autoLogAppEvents: true, xfbml: false, version: cfg.api_version });
        resolve(window.FB);
      };
      const s = document.createElement("script");
      s.src = "https://connect.facebook.net/en_US/sdk.js";
      s.async = true; s.crossOrigin = "anonymous";
      s.onerror = () => { fbReady = null; reject(new Error("Couldn't load Facebook. Disable ad blockers for this page and try again.")); };
      document.body.appendChild(s);
    });
    return fbReady;
  }

  async function startEmbeddedSignup(btn) {
    const cfg = await api("/portal/whatsapp/config");
    if (!cfg.embedded_signup_enabled) throw new Error("WhatsApp sign-in isn't configured on this server.");
    const FB = await loadFacebookSdk(cfg);

    let session = null;
    const onMessage = (event) => {
      if (!["https://www.facebook.com", "https://web.facebook.com"].includes(event.origin)) return;
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data && data.type === "WA_EMBEDDED_SIGNUP") session = data;
      } catch { /* not our message */ }
    };
    window.addEventListener("message", onMessage);

    try {
      const response = await new Promise((resolve) => {
        FB.login(resolve, {
          config_id: cfg.config_id,
          response_type: "code",
          override_default_response_type: true,
          extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
        });
      });

      const code = response && response.authResponse && response.authResponse.code;
      if (!code) {
        if (session && session.event === "CANCEL") toast("WhatsApp sign-in was cancelled");
        else toast("WhatsApp sign-in was cancelled or didn't finish");
        return;
      }

      // Meta posts the WABA / phone ids in a separate browser message; give it a moment.
      for (let i = 0; i < 20 && !(session && session.event && session.event.startsWith("FINISH")); i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      const d = (session && session.data) || {};
      await api("/portal/whatsapp/embedded-signup", {
        method: "POST",
        body: { code, waba_id: d.waba_id || null, phone_number_id: d.phone_number_id || null, business_id: d.business_id || null },
      });
      toast("WhatsApp connected", "good");
      route();
    } finally {
      window.removeEventListener("message", onMessage);
    }
  }

  /* =====================================================================
     Modals + actions
     ===================================================================== */
  function openModal(title, bodyHtml, footHtml, isWide) {
    $("#modal-root").innerHTML = html`
      <div class="modal-back" data-action="modal-backdrop"><div class="modal ${isWide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
        <div class="modal-head"><h2>${title}</h2><button class="btn ghost small" data-action="modal-close" aria-label="Close">&#10005;</button></div>
        <div class="modal-body">${bodyHtml}</div>${footHtml ? html`<div class="modal-foot">${footHtml}</div>` : ""}
      </div></div>`.s;
    const first = $("#modal-root button.primary, #modal-root input");
    if (first) first.focus();
  }
  const closeModal = () => { $("#modal-root").innerHTML = ""; };

  function confirmDialog(title, message, confirmLabel, danger) {
    return new Promise((resolve) => {
      openModal(title, html`<p>${message}</p>`, html`<button class="btn" data-action="modal-close">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" data-action="modal-confirm">${confirmLabel}</button>`);
      const root = $("#modal-root");
      const done = (v) => { root.removeEventListener("click", h); resolve(v); };
      const h = (e) => {
        const a = e.target.closest("[data-action]");
        if (!a) return;
        if (a.dataset.action === "modal-confirm") { closeModal(); done(true); }
        else if (["modal-close", "modal-backdrop"].includes(a.dataset.action)) { if (a.dataset.action === "modal-backdrop" && e.target.closest(".modal")) return; closeModal(); done(false); }
      };
      root.addEventListener("click", h);
    });
  }

  async function withBusy(btn, fn) {
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
  }

  const ACTIONS = {
    "auth-mode": (el) => renderAuth(el.dataset.mode),
    logout: () => logout(),
    "toggle-nav": () => document.body.classList.toggle("nav-open"),
    "modal-close": closeModal,
    "modal-backdrop": (el, e) => { if (!e.target.closest(".modal")) closeModal(); },

    copy: async (el) => {
      try { await navigator.clipboard.writeText(el.dataset.text); toast("Copied", "good"); }
      catch { toast("Couldn't copy. Select the code and copy it manually."); }
    },

    "new-code": async (el) => {
      await withBusy(el, () => api("/portal/tally/activation-code", { method: "POST" }));
      toast("New activation code created", "good"); route();
    },

    revoke: async (el) => {
      if (!(await confirmDialog("Revoke this computer?", "It will stop syncing immediately. You can connect it again with a new activation code.", "Revoke", true))) return;
      try { await api(`/portal/tally/connectors/${encodeURIComponent(el.dataset.id)}/revoke`, { method: "POST" }); toast("Connector revoked"); route(); }
      catch (ex) { toast(ex.message, "bad"); }
    },

    "wa-connect": async (el) => {
      try { await withBusy(el, () => startEmbeddedSignup(el)); }
      catch (ex) { toast(ex.message, "bad"); }
    },
    "wa-refresh": async (el) => {
      try { await withBusy(el, () => api("/portal/whatsapp/refresh", { method: "POST" })); toast("Status updated"); route(); }
      catch (ex) { toast(ex.message, "bad"); }
    },
    "wa-disconnect": async () => {
      if (!(await confirmDialog("Disconnect WhatsApp?", "Automatic reminders will be turned off. You can reconnect at any time.", "Disconnect", true))) return;
      try { await api("/portal/whatsapp", { method: "DELETE" }); toast("WhatsApp disconnected"); route(); }
      catch (ex) { toast(ex.message, "bad"); }
    },

    /* customers */
    filter: (el) => { cust.filter = el.dataset.filter; cust.offset = 0; drawCustomers($("#view"), false).catch((x) => toast(x.message, "bad")); },
    page: (el) => { cust.offset = Math.max(0, cust.offset + cust.limit * +el.dataset.dir); drawCustomers($("#view"), false).catch((x) => toast(x.message, "bad")); },
    "edit-phone": (el) => {
      const cell = el.closest(".phone-cell");
      cell.innerHTML = html`<form class="phone-edit" data-id="${el.dataset.id}"><input type="tel" value="${el.dataset.phone}" placeholder="+91 98765 43210" aria-label="WhatsApp number">
        <button class="btn small primary" type="submit">Save</button><button class="btn small ghost" type="button" data-action="cancel-phone">Cancel</button></form>`.s;
      const inp = $("input", cell); inp.focus(); inp.select();
    },
    "cancel-phone": () => drawCustomers($("#view"), false),
    optout: async (el) => {
      try {
        await api("/portal/customers/" + el.dataset.id, { method: "PATCH", body: { whatsapp_opt_out: el.dataset.value === "1" } });
        toast(el.dataset.value === "1" ? "Customer opted out of reminders" : "Customer opted back in");
        drawCustomers($("#view"), false);
      } catch (ex) { toast(ex.message, "bad"); }
    },
    remind: async (el) => {
      const customerId = el.dataset.id;
      const customerName = el.dataset.name;
      const billsCount = parseInt(el.dataset.bills) || 1;
      const pendingAmount = parseFloat(el.dataset.pending) || 0;

      if (billsCount > 1) {
        // Multi-bill customer choice dialog
        const modalBody = html`
          <div>
            <p style="margin-top:0;margin-bottom:16px;">
              <b>${customerName}</b> has <b>${billsCount} open bills</b> totaling <b>${money(pendingAmount)}</b>. How would you like to send this reminder?
            </p>

            <div class="remind-choice-card">
              <h4>👥 1. Customer-wise Reminder (Consolidated)</h4>
              <p>Send <b>1 single WhatsApp message</b> summarizing the total balance of <b>${money(pendingAmount)}</b> across all ${billsCount} bills. Recommended to save WhatsApp message charges.</p>
              <button class="btn primary small"
                data-action="remind-customer-wise"
                data-id="${customerId}"
                data-name="${customerName}"
                data-total="${pendingAmount}"
                data-count="${billsCount}">
                Send Consolidated Reminder (${money(pendingAmount)})
              </button>
            </div>

            <div class="remind-choice-card">
              <h4>📄 2. Bill-wise Reminders (Separate Per Bill)</h4>
              <p>Send <b>${billsCount} separate WhatsApp messages</b> (one for each individual invoice) with specific invoice numbers and due dates.</p>
              <button class="btn secondary small"
                data-action="remind-all-bill-wise"
                data-id="${customerId}"
                data-name="${customerName}"
                data-count="${billsCount}">
                Send All Bill-wise Reminders (${billsCount} messages)
              </button>
            </div>

            <div class="remind-choice-card" style="margin-bottom:0;">
              <h4>🔍 3. Inspect All Bills & Pick</h4>
              <p>View each bill individually with bill date, due date, overdue days, and choose which bill to remind.</p>
              <button class="btn small" data-action="bills" data-id="${customerId}">
                View All ${billsCount} Bills & Select
              </button>
            </div>
          </div>`;

        openModal(`Send Reminder: ${customerName}`, modalBody, html`<button class="btn small" data-action="modal-close">Cancel</button>`);
        return;
      }

      // Single bill customer
      if (!(await confirmDialog("Send a reminder now?", `${customerName} will get a WhatsApp payment reminder for their outstanding bill (${money(pendingAmount)}).`, "Send reminder"))) return;
      try {
        const r = await api(`/portal/customers/${customerId}/remind`, { method: "POST" });
        if (r.reminder.status === "failed") toast("WhatsApp couldn't deliver it: " + r.reminder.error_message, "bad");
        else toast("Reminder sent to " + customerName, "good");
        drawCustomers($("#view"), false);
      } catch (ex) { toast(ex.message, "bad"); }
    },

    bills: async (el) => {
      try {
        const d = await api(`/portal/customers/${el.dataset.id}/invoices`);
        const totalPending = d.items.reduce((sum, item) => sum + item.pending_amount, 0);
        const overdueItems = d.items.filter((item) => item.overdue_days > 0);
        const maxOverdue = Math.max(0, ...d.items.map((i) => i.overdue_days || 0));

        const summaryHtml = html`
          <div class="bills-summary-bar">
            <div>
              <div class="small muted">Customer</div>
              <div style="font-weight:600;font-size:15px;color:var(--ink);">${d.customer.name}</div>
              <div class="small muted">${d.customer.phone_number ? html`<span>WhatsApp: <b>${d.customer.phone_number}</b></span>` : html`<span style="color:var(--bad);">No phone number</span>`}</div>
            </div>
            <div>
              <div class="small muted">Total Outstanding</div>
              <div class="metric-val" style="color:var(--brand);">${money(totalPending)}</div>
            </div>
            <div>
              <div class="small muted">Open Bills</div>
              <div class="metric-val">${d.items.length} ${d.items.length === 1 ? "bill" : "bills"}</div>
            </div>
            <div>
              <div class="small muted">Overdue Status</div>
              <div>${overdueItems.length > 0 ? html`<span class="chip bad">${overdueItems.length} overdue (up to ${maxOverdue}d)</span>` : html`<span class="chip good">All on schedule</span>`}</div>
            </div>
          </div>`;

        const tableHtml = d.items.length === 0
          ? html`<div class="empty"><b>No open bills</b>This customer is fully settled.</div>`
          : html`
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Bill Ref</th>
                    <th>Bill Date</th>
                    <th>Due Date</th>
                    <th>Overdue Status</th>
                    <th class="right">Pending Amount</th>
                    <th class="right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${d.items.map((i) => html`
                    <tr>
                      <td style="font-weight:600;">
                        ${i.bill_ref || "-"}
                        ${i.is_on_account ? html` <span class="chip">On account</span>` : ""}
                      </td>
                      <td class="small">${dateText(i.bill_date)}</td>
                      <td class="small">${dateText(i.due_date)}</td>
                      <td>
                        ${i.overdue_days > 0
                          ? html`<span class="chip bad">${i.overdue_days} d overdue</span>`
                          : html`<span class="chip good">Current</span>`}
                      </td>
                      <td class="right num"><span class="owed ${i.overdue_days > 0 ? 'over' : ''}">${money(i.pending_amount)}</span></td>
                      <td class="right">
                        <button class="btn small primary"
                          data-action="remind-single-bill"
                          data-customer-id="${d.customer.id}"
                          data-invoice-id="${i.id}"
                          data-bill-ref="${i.bill_ref}"
                          data-amount="${i.pending_amount}"
                          data-name="${d.customer.name}"
                          ${d.customer.phone_number ? "" : "disabled"}
                          title="Send reminder for only this specific bill">
                          Remind this bill
                        </button>
                      </td>
                    </tr>`)}
                </tbody>
              </table>
            </div>`;

        const footHtml = html`
          <div style="display:flex;justify-content:space-between;align-items:center;width:100%;gap:10px;flex-wrap:wrap;">
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              ${d.items.length > 0 ? html`
                <button class="btn primary small"
                  data-action="remind-customer-wise"
                  data-id="${d.customer.id}"
                  data-name="${d.customer.name}"
                  data-total="${totalPending}"
                  data-count="${d.items.length}"
                  ${d.customer.phone_number ? "" : "disabled"}>
                  👥 Send Customer-wise (${money(totalPending)} for all ${d.items.length} bills)
                </button>
                ${d.items.length > 1 ? html`
                  <button class="btn secondary small"
                    data-action="remind-all-bill-wise"
                    data-id="${d.customer.id}"
                    data-name="${d.customer.name}"
                    data-count="${d.items.length}"
                    ${d.customer.phone_number ? "" : "disabled"}>
                    📄 Send All Bill-wise (${d.items.length} messages)
                  </button>` : ""}
              ` : ""}
            </div>
            <button class="btn small" data-action="modal-close">Close</button>
          </div>`;

        openModal(`${d.customer.name} — All Open Bills (${d.items.length})`, html`${summaryHtml}${tableHtml}`, footHtml, true);
      } catch (ex) { toast(ex.message, "bad"); }
    },

    "remind-single-bill": async (el) => {
      const { customerId, invoiceId, billRef, amount, name } = el.dataset;
      if (!(await confirmDialog(`Send reminder for ${billRef}?`, `Send a WhatsApp payment reminder to ${name} specifically for bill ${billRef} (${money(+amount)}).`, "Send bill reminder"))) return;
      try {
        const r = await api(`/portal/customers/${customerId}/remind`, {
          method: "POST",
          body: { invoice_id: invoiceId, mode: "bill_wise" },
        });
        if (r.reminder && r.reminder.status === "failed") toast("WhatsApp couldn't deliver it: " + r.reminder.error_message, "bad");
        else toast(`Reminder sent for bill ${billRef} to ${name}`, "good");
        closeModal();
        drawCustomers($("#view"), false);
      } catch (ex) { toast(ex.message, "bad"); }
    },

    "remind-customer-wise": async (el) => {
      const { id, name, total, count } = el.dataset;
      if (!(await confirmDialog("Send consolidated reminder?", `Send 1 WhatsApp reminder to ${name} covering all ${count} open bills totaling ${money(+total)}.`, "Send Customer-wise"))) return;
      try {
        const r = await api(`/portal/customers/${id}/remind`, {
          method: "POST",
          body: { mode: "customer_wise" },
        });
        if (r.reminder && r.reminder.status === "failed") toast("WhatsApp couldn't deliver it: " + r.reminder.error_message, "bad");
        else toast(`Consolidated reminder sent to ${name} (${money(+total)})`, "good");
        closeModal();
        drawCustomers($("#view"), false);
      } catch (ex) { toast(ex.message, "bad"); }
    },

    "remind-all-bill-wise": async (el) => {
      const { id, name, count } = el.dataset;
      if (!(await confirmDialog("Send separate bill reminders?", `This will send ${count} individual WhatsApp reminders to ${name} (one per open bill).`, "Send All Bill-wise"))) return;
      try {
        const r = await api(`/portal/customers/${id}/remind`, {
          method: "POST",
          body: { mode: "bill_wise" },
        });
        toast(r.detail || `Sent ${r.count || count} individual bill reminders to ${name}`, "good");
        closeModal();
        drawCustomers($("#view"), false);
      } catch (ex) { toast(ex.message, "bad"); }
    },

    "switch-preview-mode": (el) => {
      currentPreviewMode = el.dataset.mode;
      PAGES.reminders($("#view"));
    },

    /* reminders */
    "run-now": async (el) => {
      const mode = el.dataset.mode || currentPreviewMode || "customer_wise";
      const label = mode === "bill_wise" ? "separate bill-wise reminders" : "customer-wise reminders";
      if (!(await confirmDialog("Send reminders now?", `This will send WhatsApp ${label} to qualifying customers using your rules. It can't be undone.`, "Send reminders"))) return;
      try {
        const r = await withBusy(el, () => api("/portal/reminders/run", { method: "POST", body: { mode } }));
        toast(`${r.sent} sent${r.failed ? ", " + r.failed + " failed" : ""}`, r.failed ? "bad" : "good");
        route();
      } catch (ex) { toast(ex.message, "bad"); }
    },
    "hist-filter": (el) => { hist.status = el.dataset.status; hist.offset = 0; drawHistory().catch((x) => toast(x.message, "bad")); },
    "hist-page": (el) => { hist.offset = Math.max(0, hist.offset + hist.limit * +el.dataset.dir); drawHistory().catch((x) => toast(x.message, "bad")); },
  };

  document.addEventListener("click", (e) => {
    if (document.body.classList.contains("nav-open")) {
      if (!e.target.closest(".side") && !e.target.closest("[data-action='toggle-nav']")) {
        document.body.classList.remove("nav-open");
      }
    }
    const el = e.target.closest("[data-action]");
    if (!el || el.disabled) return;
    const fn = ACTIONS[el.dataset.action];
    if (fn) fn(el, e);
  });

  /* form submits */
  document.addEventListener("submit", async (e) => {
    const phoneForm = e.target.closest(".phone-edit");
    if (phoneForm) {
      e.preventDefault();
      const btn = $("button[type=submit]", phoneForm); btn.disabled = true;
      try {
        await api("/portal/customers/" + phoneForm.dataset.id, { method: "PATCH", body: { phone_number: $("input", phoneForm).value } });
        toast("Number saved", "good");
        drawCustomers($("#view"), false);
      } catch (ex) { toast(ex.message, "bad"); btn.disabled = false; }
      return;
    }

  });

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  window.addEventListener("hashchange", route);

  boot();
})();
