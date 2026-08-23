export function managementUiScript(): string {
  return `(function () {
  var csrf = null;
  var view = "providers";
  var cache = {};
  var VIEWS = ["providers","accounts","pools","profiles","health","audit","traces"];
  var LABELS = {providers:"Providers",accounts:"Accounts",pools:"Pools",profiles:"Profiles",health:"Health / quota",audit:"Audit",traces:"Route traces"};

  function $(id) { return document.getElementById(id); }
  function status(text, kind) {
    var node = $("status");
    node.textContent = text;
    node.setAttribute("data-kind", kind || "info");
    if (kind === "alert") node.setAttribute("role", "alert");
    else node.setAttribute("role", "status");
  }
  function qsView() {
    var value = new URLSearchParams(location.search).get("view");
    return VIEWS.indexOf(value) >= 0 ? value : "providers";
  }
  function setView(next) {
    view = next;
    var url = new URL(location.href);
    url.searchParams.set("view", next);
    history.replaceState(null, "", url.pathname + url.search);
    document.querySelectorAll("[data-view-btn]").forEach(function (btn) {
      btn.setAttribute("aria-current", btn.getAttribute("data-view-btn") === next ? "page" : "false");
    });
    $("view-select").value = next;
    $("view-title").textContent = LABELS[next];
  }
  function field(id, label, attrs) {
    return "<label for=\\"" + id + "\\"><span>" + label + "</span><input id=\\"" + id + "\\" " + (attrs || "") + "></label>";
  }
  function selectField(id, label, options) {
    return "<label for=\\"" + id + "\\"><span>" + label + "</span><select id=\\"" + id + "\\">" + options + "</select></label>";
  }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;" })[ch];
    });
  }
  function cell(value) { return "<td class=\\"mono\\">" + escapeHtml(value == null || value === "" ? "—" : value) + "</td>"; }
  function jsonCell(value) { return value == null ? cell("") : "<td class=\\"mono\\">" + escapeHtml(JSON.stringify(value)) + "</td>"; }

  function api(path, method, body) {
    var headers = { accept: "application/json", "referrer-policy": "no-referrer" };
    var options = { method: method || "GET", credentials: "same-origin", referrerPolicy: "no-referrer", headers: headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      if (csrf) headers["x-csrf-token"] = csrf;
      options.body = JSON.stringify(body);
    }
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return { error: "invalid" }; }).then(function (payload) {
        return { ok: response.ok, status: response.status, body: payload };
      });
    });
  }

  function handleError(result, reload) {
    var code = result.body && result.body.error;
    if (result.status === 409 && code === "stale-version") {
      status("Record changed. Reload, then retry.", "alert");
      if (reload) return reload();
      return;
    }
    if (result.status === 401) return signedOut("Session missing. Run admin ui.");
    if (result.status === 403 && code === "invalid-csrf") {
      return resume().then(function (ok) {
        if (!ok) signedOut("Session expired. Run admin ui.");
        else status("Session recovered. Retry the action.");
      });
    }
    if (result.status === 403 && code === "invalid-origin") {
      status("Open this UI from the management origin only.", "alert");
      return;
    }
    status(code ? "Request failed: " + code : "Management listener not reachable.", "alert");
  }

  function signedOut(message) {
    csrf = null;
    $("app").classList.add("hidden");
    $("gate").classList.remove("hidden");
    $("gate-message").textContent = message;
    status(message, "alert");
  }

  function resume() {
    return api("/auth/resume", "POST", {}).then(function (result) {
      if (!result.ok || !result.body.csrfToken) return false;
      csrf = result.body.csrfToken;
      return true;
    }).catch(function () { return false; });
  }

  function bootstrap() {
    var hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
    var params = new URLSearchParams(hash);
    var token = params.get("t");
    var next = location.pathname + (location.search || "");
    history.replaceState(null, "", next);
    var start = token
      ? api("/auth/exchange", "POST", { token: token })
      : resume().then(function (ok) { return ok ? { ok: true, body: { csrfToken: csrf } } : { ok: false, status: 401, body: { error: "unauthorized" } }; });
    return start.then(function (result) {
      if (!result.ok || !result.body.csrfToken) {
        signedOut(token ? "Management session exchange failed." : "Management session token is missing.");
        return;
      }
      csrf = result.body.csrfToken;
      $("gate").classList.add("hidden");
      $("app").classList.remove("hidden");
      status(token ? "Management session established. The bootstrap token was removed from history." : "Management session resumed.");
      setView(qsView());
      return load();
    }).catch(function () {
      signedOut("Management listener not reachable.");
    });
  }

  function loadReady() {
    return api("/readyz").then(function (result) {
      $("policy-revision").textContent = result.ok ? "policy " + String(result.body.policyRevision || 0) : "policy unknown";
    });
  }

  function load() {
    status("Loading " + LABELS[view] + ".");
    return loadReady().then(function () {
      if (view === "providers") return loadCollection("providers", renderProviders);
      if (view === "accounts") return loadCollection("accounts", renderAccounts);
      if (view === "pools") return loadAll(["pools", "accounts", "providers"], renderPools);
      if (view === "profiles") return loadAll(["profiles", "pools", "providers"], renderProfiles);
      if (view === "health") return Promise.all([loadCollection("accounts", function () {}), loadItems("/v1/health", "health", "items")]).then(renderHealth);
      if (view === "audit") return loadItems("/v1/audit", "audit", "events").then(function (ok) { if (ok) renderAudit(); });
      return loadItems("/v1/route-traces", "traces", "traces").then(function (ok) { if (ok) renderTraces(); });
    });
  }

  function loadCollection(name, then) {
    return api("/v1/" + name).then(function (result) {
      if (!result.ok) return handleError(result, load);
      cache[name] = result.body.items || [];
      then();
    });
  }

  function loadAll(names, then) {
    return Promise.all(names.map(function (name) { return loadCollection(name, function () {}); })).then(then);
  }

  function loadItems(path, key, listKey) {
    return api(path).then(function (result) {
      if (!result.ok) {
        handleError(result);
        return false;
      }
      cache[key] = result.body[listKey] || [];
      return true;
    });
  }

  function optionList(items, valueKey, labelKey, selected) {
    return (items || []).map(function (item) {
      return "<option value=\\"" + escapeHtml(item[valueKey]) + "\\"" + (item[valueKey] === selected ? " selected" : "") + ">" + escapeHtml(item[labelKey]) + "</option>";
    }).join("");
  }

  function table(headers, rows, emptyText) {
    if (!rows.length) return "<div class=\\"empty\\">" + emptyText + "</div>";
    return "<table><thead><tr>" + headers.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead><tbody>" + rows.join("") + "</tbody></table>";
  }

  function renderProviders() {
    var items = cache.providers || [];
    $("panel").innerHTML = table(["Name","Mode","Enabled","Version","Terms","Updated",""], items.map(function (item) {
      return "<tr>" + cell(item.name) + cell(item.integrationMode) + cell(item.enabled) + cell(item.version) + cell(item.requiredTermsRevision) + cell(item.updatedAt) +
        "<td><button type=\\"button\\" data-edit-provider=\\"" + escapeHtml(item.id) + "\\">Edit</button></td></tr>";
    }), "No providers. Create one to attach accounts.") +
      "<form class=\\"editor\\" id=\\"provider-form\\">" +
      "<h2>Provider</h2>" +
      "<input type=\\"hidden\\" id=\\"p-id\\"><input type=\\"hidden\\" id=\\"p-version\\">" +
      field("p-name", "Name (catalog id)", "required placeholder=\\"openrouter\\"") +
      selectField("p-mode", "Integration mode", "<option value=\\"direct\\">direct</option><option value=\\"oauth\\">oauth</option><option value=\\"bridge\\">bridge</option>") +
      field("p-endpoint", "Endpoint policy") +
      field("p-terms", "Required terms revision") +
      field("p-prov", "Provenance ref") +
      selectField("p-enabled", "Enabled", "<option value=\\"true\\">true</option><option value=\\"false\\">false</option>") +
      "<div class=\\"row\\"><button type=\\"submit\\" class=\\"primary\\" id=\\"p-save\\">Save</button></div></form>";
    $("provider-form").addEventListener("submit", saveProvider);
    bindEdit("data-edit-provider", cache.providers, fillProvider);
  }

  function fillProvider(item) {
    $("p-id").value = item.id;
    $("p-version").value = String(item.version);
    $("p-name").value = item.name;
    $("p-mode").value = item.integrationMode;
    $("p-endpoint").value = item.endpointPolicy || "";
    $("p-terms").value = item.requiredTermsRevision || "";
    $("p-prov").value = item.provenanceRef || "";
    $("p-enabled").value = String(item.enabled);
  }

  function saveProvider(event) {
    event.preventDefault();
    $("p-save").disabled = true;
    upsert("providers", $("p-id").value, {
      name: $("p-name").value,
      integrationMode: $("p-mode").value,
      endpointPolicy: $("p-endpoint").value || undefined,
      requiredTermsRevision: $("p-terms").value || undefined,
      provenanceRef: $("p-prov").value || undefined,
      enabled: $("p-enabled").value === "true"
    }, $("p-version").value).then(function (result) {
      return finishSave("p-save", result, "Provider saved.");
    }).catch(function () { $("p-save").disabled = false; status("Management listener not reachable.", "alert"); });
  }

  function renderAccounts() {
    var items = cache.accounts || [];
    $("panel").innerHTML = table(["Pseudonym","State","Readiness","Quota","Cooldown","Generation","Version",""], items.map(function (item) {
      return "<tr>" + cell(item.pseudonym) + cell(item.state) + cell(item.readiness) + cell(item.quotaClass) + cell(item.cooldownUntil) + cell(item.generation) + cell(item.version) +
        "<td class=\\"row\\">" +
        "<button type=\\"button\\" data-acct=\\"" + escapeHtml(item.id) + "\\" data-act=\\"pause\\">Pause</button>" +
        "<button type=\\"button\\" data-acct=\\"" + escapeHtml(item.id) + "\\" data-act=\\"resume\\">Resume</button>" +
        "<button type=\\"button\\" data-acct=\\"" + escapeHtml(item.id) + "\\" data-act=\\"select\\">Pin</button>" +
        "<button type=\\"button\\" data-acct=\\"" + escapeHtml(item.id) + "\\" data-act=\\"refresh\\">Refresh</button>" +
        "<button type=\\"button\\" class=\\"danger\\" data-acct=\\"" + escapeHtml(item.id) + "\\" data-act=\\"revoke\\">Revoke</button>" +
        "</td></tr>";
    }), "No accounts. Import via path, start OAuth, or bind a direct env reference.") +
      "<form class=\\"editor\\" id=\\"env-form\\">" +
      "<h2>Direct env account</h2>" +
      field("e-pseudo", "Pseudonym", "required") +
      selectField("e-provider", "Provider", optionList((cache.providers || []).filter(function (item) { return item.integrationMode === "direct"; }), "id", "name")) +
      field("e-env", "Credential env name", "required placeholder=\\"OPENROUTER_API_KEY\\" autocomplete=\\"off\\"") +
      "<button type=\\"submit\\" class=\\"primary\\">Create</button>" +
      "<p class=\\"hint\\">Stores the variable name only. Never paste a secret.</p></form>" +
      "<form class=\\"editor\\" id=\\"terms-form\\">" +
      "<h2>Acknowledge terms</h2>" +
      selectField("t-account", "Account", optionList(items, "id", "pseudonym")) +
      field("t-revision", "Terms revision", "required") +
      "<button type=\\"submit\\" class=\\"primary\\">Acknowledge</button></form>" +
      "<form class=\\"editor\\" id=\\"import-form\\">" +
      "<h2>Import credential</h2>" +
      field("i-path", "Source path", "required") +
      field("i-pseudo", "Pseudonym", "required") +
      selectField("i-provider", "Provider", optionList(cache.providers || [], "id", "name")) +
      "<div class=\\"row\\"><button type=\\"button\\" id=\\"i-preview\\">Preview</button><button type=\\"submit\\" class=\\"primary\\">Import</button></div>" +
      "<p class=\\"hint\\" id=\\"i-preview-out\\"></p></form>" +
      "<form class=\\"editor\\" id=\\"login-form\\">" +
      "<h2>OAuth login</h2>" +
      field("l-pseudo", "Pseudonym", "required") +
      selectField("l-provider", "Provider", optionList(cache.providers || [], "id", "name")) +
      "<div class=\\"row\\"><button type=\\"submit\\" class=\\"primary\\">Start</button><button type=\\"button\\" id=\\"l-complete\\">Complete</button><button type=\\"button\\" id=\\"l-cancel\\">Cancel</button></div>" +
      "<p class=\\"hint\\" id=\\"l-out\\"></p></form>";
    document.querySelectorAll("[data-act]").forEach(function (btn) {
      btn.addEventListener("click", function () { accountAction(btn.getAttribute("data-acct"), btn.getAttribute("data-act"), btn); });
    });
    $("terms-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var account = (cache.accounts || []).find(function (item) { return item.id === $("t-account").value; });
      if (!account) return;
      mutateAccount(account.id, { version: account.version, termsRevision: $("t-revision").value });
    });
    $("env-form").addEventListener("submit", createEnvAccount);
    $("i-preview").addEventListener("click", previewImport);
    $("import-form").addEventListener("submit", runImport);
    $("login-form").addEventListener("submit", startLogin);
    $("l-complete").addEventListener("click", completeLogin);
    $("l-cancel").addEventListener("click", cancelLogin);
  }

  function accountById(id) { return (cache.accounts || []).find(function (item) { return item.id === id; }); }

  function accountAction(id, act, btn) {
    var account = accountById(id);
    if (!account) return;
    if (act === "revoke") {
      $("confirm-text").textContent = "Revoke " + account.pseudonym + "? This cannot be undone from the UI.";
      $("confirm").showModal();
      $("confirm-ok").onclick = function () { $("confirm").close(); postAccount(id, act, account.version, btn); };
      return;
    }
    if (act === "pause") return mutateAccount(id, { version: account.version, state: "paused" }, btn);
    if (act === "resume") return mutateAccount(id, { version: account.version, state: "ready" }, btn);
    postAccount(id, act, account.version, btn);
  }

  function accountRequest(btn, request, okMessage) {
    if (btn) btn.disabled = true;
    return request.then(function (result) {
      if (btn) btn.disabled = false;
      if (!result.ok) return handleError(result, load);
      status(okMessage);
      return load();
    });
  }

  function mutateAccount(id, payload, btn) {
    return accountRequest(btn, api("/v1/accounts/" + id, "PATCH", payload), "Account updated.");
  }

  function postAccount(id, act, version, btn) {
    return accountRequest(btn, api("/v1/accounts/" + id + "/" + act, "POST", { version: version }), "Account " + act + " completed.");
  }

  function createEnvAccount(event) {
    event.preventDefault();
    var name = $("e-env").value.trim();
    if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(name)) {
      status("Credential env name must be an environment variable name.", "alert");
      return;
    }
    api("/v1/accounts", "POST", {
      providerId: $("e-provider").value,
      pseudonym: $("e-pseudo").value,
      credentialRef: "env:" + name
    }).then(function (result) {
      if (!result.ok) return handleError(result, load);
      status("Direct env account created.");
      return load();
    });
  }

  var importFingerprint = "";
  function previewImport() {
    api("/v1/credentials/import/preview", "POST", { sourcePath: $("i-path").value, providerId: $("i-provider").value || undefined }).then(function (result) {
      if (!result.ok) return handleError(result);
      importFingerprint = result.body.sourceFingerprint || "";
      $("i-preview-out").textContent = "schema " + (result.body.schema || "unknown") + ", provider " + (result.body.provider || "unknown") + ", fingerprint ready.";
    });
  }
  function runImport(event) {
    event.preventDefault();
    api("/v1/credentials/import", "POST", {
      sourcePath: $("i-path").value,
      providerId: $("i-provider").value,
      pseudonym: $("i-pseudo").value,
      sourceFingerprint: importFingerprint
    }).then(function (result) {
      if (!result.ok) return handleError(result, load);
      status("Credential imported.");
      return load();
    });
  }
  var loginState = "";
  function startLogin(event) {
    event.preventDefault();
    api("/v1/credentials/login", "POST", { providerId: $("l-provider").value, pseudonym: $("l-pseudo").value }).then(function (result) {
      if (!result.ok) return handleError(result);
      loginState = result.body.state || "";
      $("l-out").innerHTML = "Open the authorization URL, then complete. Redirect: " + escapeHtml(result.body.redirectUri || "") +
        (result.body.authorizationUrl ? " <a href=\\"" + escapeHtml(result.body.authorizationUrl) + "\\">authorization link</a>" : "");
    });
  }
  function completeLogin() {
    api("/v1/credentials/login/complete", "POST", {}).then(function (result) {
      if (!result.ok) return handleError(result, load);
      status("OAuth login completed.");
      return load();
    });
  }
  function cancelLogin() {
    api("/v1/credentials/login/cancel", "POST", { state: loginState }).then(function (result) {
      if (!result.ok) return handleError(result);
      status("OAuth login cancelled.");
    });
  }

  function renderPools() {
    var items = cache.pools || [];
    $("panel").innerHTML = table(["Name","Strategy","Retry","Members","Version",""], items.map(function (item) {
      return "<tr>" + cell(item.name) + cell(item.strategy) + cell(item.retryBudget) + cell((item.memberships || []).length) + cell(item.version) +
        "<td><button type=\\"button\\" data-edit-pool=\\"" + escapeHtml(item.id) + "\\">Edit</button></td></tr>";
    }), "No pools. Create a pool before a profile can route.") +
      "<form class=\\"editor\\" id=\\"pool-form\\">" +
      "<h2>Pool</h2><input type=\\"hidden\\" id=\\"o-id\\"><input type=\\"hidden\\" id=\\"o-version\\">" +
      field("o-name", "Name", "required") +
      selectField("o-provider", "Provider", optionList(cache.providers || [], "id", "name")) +
      // eslint-disable-next-line no-useless-escape
      selectField("o-strategy", "Strategy", "<option value=\\"manual\\">manual</option><option value=\\"round-robin\\">round-robin</option><option value=\\"fill-first\\">fill-first</option><option value=\\"adaptive\\">adaptive</option>") +
      field("o-retry", "Retry budget", "type=\\"number\\" min=\\"0\\" value=\\"0\\"") +
      "<label for=\\"o-accounts\\"><span>Account IDs (comma, pin order)</span><input id=\\"o-accounts\\"></label>" +
      "<button type=\\"submit\\" class=\\"primary\\" id=\\"o-save\\">Save</button></form>";
    $("pool-form").addEventListener("submit", savePool);
    bindEdit("data-edit-pool", cache.pools, function (item) {
      $("o-id").value = item.id;
      $("o-version").value = String(item.version);
      $("o-name").value = item.name;
      $("o-provider").value = item.providerId;
      $("o-strategy").value = item.strategy;
      $("o-retry").value = String(item.retryBudget);
      $("o-accounts").value = (item.memberships || []).map(function (m) { return m.accountId; }).join(",");
    });
  }

  function savePool(event) {
    event.preventDefault();
    $("o-save").disabled = true;
    var ids = $("o-accounts").value.split(",").map(function (part) { return part.trim(); }).filter(Boolean);
    upsert("pools", $("o-id").value, {
      name: $("o-name").value,
      providerId: $("o-provider").value,
      strategy: $("o-strategy").value,
      retryBudget: Number($("o-retry").value),
      accountIds: ids
    }, $("o-version").value).then(function (result) {
      return finishSave("o-save", result, "Pool saved.");
    });
  }

  function renderProfiles() {
    var items = cache.profiles || [];
    $("panel").innerHTML = table(["Name","Harness","Provider","Pool","Primary","Fast","Reasoning","Version",""], items.map(function (item) {
      var roles = item.modelRoles || {};
      return "<tr>" + cell(item.name) + cell(item.harness) + cell(item.providerId) + cell(item.poolId) +
        cell(roles.primary) + cell(roles.fast) + cell(roles.reasoning) + cell(item.version) +
        "<td><button type=\\"button\\" data-edit-profile=\\"" + escapeHtml(item.id) + "\\">Edit</button></td></tr>";
    }), "No profiles. Create a profile that references a pool.") +
      "<form class=\\"editor\\" id=\\"profile-form\\">" +
      "<h2>Profile</h2><input type=\\"hidden\\" id=\\"f-id\\"><input type=\\"hidden\\" id=\\"f-version\\">" +
      field("f-name", "Name", "required") +
      selectField("f-harness", "Harness", "<option value=\\"claude\\">claude</option><option value=\\"codex\\">codex</option>") +
      selectField("f-provider", "Provider", "<option value=\\"\\"></option>" + optionList(cache.providers || [], "id", "name")) +
      selectField("f-pool", "Pool", "<option value=\\"\\"></option>" + optionList(cache.pools || [], "id", "name")) +
      field("f-roles", "Model roles JSON", "required value='{\\"primary\\":\\"replace-with-model\\"}'") +
      "<button type=\\"submit\\" class=\\"primary\\" id=\\"f-save\\">Save</button></form>";
    $("profile-form").addEventListener("submit", saveProfile);
    bindEdit("data-edit-profile", cache.profiles, function (item) {
      $("f-id").value = item.id;
      $("f-version").value = String(item.version);
      $("f-name").value = item.name;
      $("f-harness").value = item.harness;
      $("f-provider").value = item.providerId || "";
      $("f-pool").value = item.poolId || "";
      $("f-roles").value = JSON.stringify(item.modelRoles || {});
    });
  }

  function saveProfile(event) {
    event.preventDefault();
    $("f-save").disabled = true;
    var roles;
    try { roles = JSON.parse($("f-roles").value); } catch (error) { $("f-save").disabled = false; status("Model roles must be JSON.", "alert"); return; }
    upsert("profiles", $("f-id").value, {
      name: $("f-name").value,
      harness: $("f-harness").value,
      providerId: $("f-provider").value || undefined,
      poolId: $("f-pool").value || undefined,
      modelRoles: roles
    }, $("f-version").value).then(function (result) {
      return finishSave("f-save", result, "Profile saved.");
    });
  }

  function bindEdit(attr, items, fill) {
    document.querySelectorAll("[" + attr + "]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var item = (items || []).find(function (row) { return row.id === btn.getAttribute(attr); });
        if (item) fill(item);
      });
    });
  }

  function upsert(collection, id, payload, version) {
    return id
      ? api("/v1/" + collection + "/" + id, "PATCH", Object.assign({ version: Number(version) }, payload))
      : api("/v1/" + collection, "POST", payload);
  }

  function finishSave(buttonId, result, okMessage) {
    $(buttonId).disabled = false;
    if (!result.ok) return handleError(result, load);
    status(okMessage);
    return load();
  }

  function renderHealth() {
    var health = {};
    (cache.health || []).forEach(function (item) { health[item.accountId] = item; });
    $("panel").innerHTML = table(["Pseudonym","State","Readiness","Quota","Cooldown","Last outcome","Failures"], (cache.accounts || []).map(function (item) {
      var row = health[item.id] || {};
      return "<tr>" + cell(item.pseudonym) + cell(item.state) + cell(item.readiness) + cell(item.quotaClass) + cell(item.cooldownUntil || row.cooldownUntil) + cell(row.lastOutcome) + cell(row.consecutiveFailures) + "</tr>";
    }), "No account health yet.");
  }

  function renderAudit() {
    $("panel").innerHTML = table(["When","Action","Resource","Actor","Result","Metadata"], (cache.audit || []).map(function (item) {
      return "<tr>" + cell(item.createdAt) + cell(item.action) + cell((item.resourceType || "") + " " + (item.resourceId || "")) + cell(item.actor) + cell(item.result) + jsonCell(item.metadata) + "</tr>";
    }), "No audit events.");
  }

  function renderTraces() {
    $("panel").innerHTML = table(["When","Request","Profile","Reason","Requested","Resolved","Provider","Adapter","Selected","Candidates"], (cache.traces || []).map(function (item) {
      var selected = item.selected ? item.selected.accountPseudonym + " g" + item.selected.credentialGeneration : "";
      var reason = item.modelSelection && item.modelSelection.reason ? item.modelSelection.reason : (item.sourceRule || "");
      var requested = (item.intent && item.intent.sourceSelector) || item.requestedModel;
      var target = item.effectiveModelDecision && item.effectiveModelDecision.target;
      var candidates = (item.candidates || []).map(function (c) {
        return c.accountPseudonym + (c.eligible ? " eligible" : " " + (c.reasons || []).join(","));
      }).join("; ");
      return "<tr>" + cell(item.decidedAt) + cell(item.requestId) + cell(item.profileName) + cell(reason) +
        cell(requested) + cell(target && target.physicalModelId) + cell(target && target.accessProviderId) +
        cell(target && target.adapterId) + cell(selected) + cell(candidates) + "</tr>";
    }), "No route traces in this instance.");
  }

  function bindNav() {
    document.querySelectorAll("[data-view-btn]").forEach(function (btn) {
      btn.addEventListener("click", function () { setView(btn.getAttribute("data-view-btn")); load(); });
    });
    $("view-select").addEventListener("change", function () { setView($("view-select").value); load(); });
    $("logout").addEventListener("click", function () {
      api("/auth/logout", "POST", {}).then(function () { signedOut("Logged out."); });
    });
    $("refresh").addEventListener("click", load);
    $("confirm-cancel").addEventListener("click", function () { $("confirm").close(); });
  }

  bindNav();
  bootstrap();
})();`;
}