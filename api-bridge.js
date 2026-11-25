window.FEUR_API_URL = "https://script.google.com/macros/s/AKfycbxYtoiXHUnPuLnQGbfQxbAUfnXXB-JY4TlsR6JG7QRm_MCF77_0TA84PeiPwlenGaW44Q/exec";

(function () {
  const CACHEABLE_READS = new Set([
    "searchLibraryHoldings",
    "fetchCurrentPatrons",
    "fetchRecentCheckouts",
    "fetchLibraryStatistics",
    "getAttendanceStatistics"
  ]);

  let jsonpCounter = 0;

  function serializeFormElement(formEl) {
    return new Promise((resolve, reject) => {
      const out = {};
      const elements = Array.from(formEl.elements || []);
      let filePromise = Promise.resolve();

      elements.forEach((el) => {
        if (!el.name) return;
        if (el.type === "file" && el.files && el.files[0]) {
          const file = el.files[0];
          filePromise = new Promise((resFile, rejFile) => {
            const reader = new FileReader();
            reader.onload = () => {
              const base64 = String(reader.result || "").split(",")[1] || "";
              out.fileName = file.name;
              out.mimeType = file.type || "image/jpeg";
              out.base64Data = base64;
              resFile();
            };
            reader.onerror = () => rejFile(new Error("Failed to read image file."));
            reader.readAsDataURL(file);
          });
        } else {
          out[el.name] = el.value;
        }
      });

      filePromise.then(() => resolve(out)).catch(reject);
    });
  }

  function callViaJsonp(payloadObj, timeoutMs) {
    return new Promise((resolve, reject) => {
      const cbName = "__feurJsonp_" + Date.now() + "_" + (++jsonpCounter);
      const script = document.createElement("script");
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("Request timed out. Verify your /exec URL and 'Anyone' access."));
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      window[cbName] = function (response) {
        if (done) return;
        done = true;
        cleanup();
        resolve(response);
      };

      script.onerror = function () {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("Apps Script blocked the request. Check that FEUR_API_URL ends in /exec and 'Who has access' is set to Anyone."));
      };

      const sep = window.FEUR_API_URL.indexOf("?") === -1 ? "?" : "&";
      script.src =
        window.FEUR_API_URL +
        sep +
        "callback=" +
        encodeURIComponent(cbName) +
        "&payload=" +
        encodeURIComponent(JSON.stringify(payloadObj));

      document.head.appendChild(script);
    });
  }

  async function callViaPost(payloadObj) {
    const res = await fetch(window.FEUR_API_URL, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payloadObj)
    });
    const text = await res.text();
    return JSON.parse(text);
  }

  function createRunner(successHandler, failureHandler, userObject) {
    return new Proxy(function () {}, {
      get(_, prop) {
        if (prop === "withSuccessHandler") {
          return (fn) => createRunner(fn, failureHandler, userObject);
        }
        if (prop === "withFailureHandler") {
          return (fn) => createRunner(successHandler, fn, userObject);
        }
        if (prop === "withUserObject") {
          return (obj) => createRunner(successHandler, failureHandler, obj);
        }

        return async function (...rawArgs) {
          const fnName = String(prop);
          const libraryKey = localStorage.getItem("FEUR_ACTIVE_LIBRARY") || "ELEMENTARY";

          if (fnName === "setActiveLibrary" && rawArgs[0]) {
            localStorage.setItem("FEUR_ACTIVE_LIBRARY", String(rawArgs[0]).toUpperCase());
          }

          const args = await Promise.all(
            rawArgs.map((arg) =>
              typeof HTMLFormElement !== "undefined" && arg instanceof HTMLFormElement
                ? serializeFormElement(arg)
                : arg
            )
          );

          const payloadObj = { fn: fnName, args, libraryKey };
          const cacheKey = "feur_cache_" + libraryKey + "_" + fnName + "_" + JSON.stringify(args);

          try {
            if (!window.FEUR_API_URL || !window.FEUR_API_URL.endsWith("/exec")) {
              throw new Error("FEUR_API_URL in api-bridge.js must end with /exec.");
            }

            const serialized = JSON.stringify(payloadObj);
            const data =
              serialized.length > 1800
                ? await callViaPost(payloadObj)
                : await callViaJsonp(payloadObj, 20000);

            if (!data || !data.ok) {
              throw new Error((data && data.error) || "Server error");
            }

            if (fnName === "setActiveLibrary" && data.result && data.result.success) {
              localStorage.setItem(
                "FEUR_ACTIVE_LIBRARY",
                String(data.result.libraryKey || rawArgs[0] || "ELEMENTARY").toUpperCase()
              );
              Object.keys(localStorage).forEach((k) => {
                if (k.startsWith("feur_cache_")) localStorage.removeItem(k);
              });
              data.result.appUrl = window.location.origin + window.location.pathname;
            }

            const isCatalogSave =
              (fnName === "saveBookToInventory" || fnName === "updateLibraryItem") &&
              data.result &&
              data.result.success;

            if (isCatalogSave && typeof window.clearCatalogDraft === "function") {
              window.clearCatalogDraft();
            }

            if (CACHEABLE_READS.has(fnName)) {
              try { localStorage.setItem(cacheKey, JSON.stringify(data.result)); } catch (e) {}
            }

            if (typeof successHandler === "function") {
              successHandler(data.result, userObject);
            }

            if (isCatalogSave && typeof window.handleCatalogSaveCleanup === "function") {
              setTimeout(() => window.handleCatalogSaveCleanup(), 150);
            }

            if (fnName === "setActiveLibrary" && data.result && data.result.success) {
              setTimeout(() => {
                window.location.reload();
              }, 300);
            }
          } catch (err) {
            const message = err && err.message ? err.message : String(err);

            if (CACHEABLE_READS.has(fnName)) {
              const cached = localStorage.getItem(cacheKey);
              if (cached && typeof successHandler === "function") {
                successHandler(JSON.parse(cached), userObject);
                return;
              }
            }

            if (typeof failureHandler === "function") {
              failureHandler(new Error(message), userObject);
            } else {
              console.error("API call failed (" + fnName + "):", message);
              if (typeof window.showToast === "function") {
                window.showToast("Connection error (" + fnName + "): " + message, "error", 6000);
              }
            }
          }
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = createRunner(null, null, null);
})();

(function initCatalogLibraryAutoSync() {
  function getCurrentLibraryKey() {
    const headerSelect = document.getElementById("activeLibrarySelect");
    if (headerSelect && headerSelect.value) {
      return String(headerSelect.value).toUpperCase();
    }
    const stored = localStorage.getItem("FEUR_ACTIVE_LIBRARY");
    if (stored === "HIGH_SCHOOL" || stored === "ELEMENTARY") {
      return stored;
    }
    const indicator = document.getElementById("activeLibraryIndicator");
    if (indicator && /high\s*school/i.test(indicator.textContent || "")) {
      return "HIGH_SCHOOL";
    }
    return "ELEMENTARY";
  }

  function findCatalogLibrarySelect() {
    const byId =
      document.getElementById("bookLibraryBranch") ||
      document.getElementById("catalogLibraryBranch");
    if (byId) return byId;

    const groups = document.querySelectorAll("#tab-cataloging .form-group");
    for (const group of groups) {
      const lbl = group.querySelector("label");
      const sel = group.querySelector("select");
      if (lbl && sel && /^library$/i.test((lbl.textContent || "").trim())) {
        return sel;
      }
    }

    const selects = document.querySelectorAll("#tab-cataloging select");
    for (const sel of selects) {
      const hasBranchOption = Array.from(sel.options || []).some((opt) =>
        /elementary library|high school library/i.test(opt.text || opt.value)
      );
      if (hasBranchOption) return sel;
    }
    return null;
  }

  function syncCatalogLibraryDropdown(force) {
    const editMode = document.getElementById("bookEditMode");
    if (!force && editMode && editMode.value === "1") return;

    const select = findCatalogLibrarySelect();
    if (!select || !select.options || select.options.length === 0) return;

    const key = getCurrentLibraryKey();
    const targetLabel =
      key === "HIGH_SCHOOL" ? "High School Library" : "Elementary Library";

    const match = Array.from(select.options).find(
      (opt) =>
        opt.value === targetLabel ||
        opt.value.toUpperCase() === key ||
        (opt.text || "").trim().toLowerCase() === targetLabel.toLowerCase()
    );

    if (match && select.value !== match.value) {
      select.value = match.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  window.syncCatalogLibraryDropdown = syncCatalogLibraryDropdown;
  window.findCatalogLibrarySelect = findCatalogLibrarySelect;

  function attachCatalogSyncListeners() {
    syncCatalogLibraryDropdown(false);

    const catalogingTab = document.getElementById("tab-cataloging");
    if (catalogingTab) {
      const observer = new MutationObserver((mutations) => {
        const hasNewNodes = mutations.some(
          (m) => m.addedNodes && m.addedNodes.length > 0
        );
        if (hasNewNodes) syncCatalogLibraryDropdown(false);
      });
      observer.observe(catalogingTab, { childList: true, subtree: true });
    }

    const headerSelect = document.getElementById("activeLibrarySelect");
    if (headerSelect) {
      headerSelect.addEventListener("change", () => {
        setTimeout(() => syncCatalogLibraryDropdown(false), 50);
      });
    }

    const bookForm = document.getElementById("newBookForm");
    if (bookForm) {
      bookForm.addEventListener("reset", () => {
        setTimeout(() => syncCatalogLibraryDropdown(true), 0);
      });
    }

    document.addEventListener("click", (e) => {
      const trigger = e.target.closest(
        '[onclick*="cataloging"], [onclick*="cancelCatalogEdit"]'
      );
      if (trigger) {
        setTimeout(() => syncCatalogLibraryDropdown(false), 60);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attachCatalogSyncListeners);
  } else {
    attachCatalogSyncListeners();
  }
})();

(function initCatalogDraftAutoSave() {
  const DRAFT_PREFIX = "FEUR_CATALOG_DRAFT_";
  const EXCLUDED_IDS = new Set([
    "bookEditMode",
    "bookOriginalAccession",
    "bookTargetLibraryKey",
    "catalogLibrarySearchInput"
  ]);
  let saveTimer = null;
  let isRestoring = false;

  function getLibraryKey() {
    const headerSelect = document.getElementById("activeLibrarySelect");
    if (headerSelect && headerSelect.value) {
      return String(headerSelect.value).toUpperCase();
    }
    const stored = localStorage.getItem("FEUR_ACTIVE_LIBRARY");
    return stored === "HIGH_SCHOOL" ? "HIGH_SCHOOL" : "ELEMENTARY";
  }

  function getDraftStorageKey() {
    return DRAFT_PREFIX + getLibraryKey();
  }

  function isEditingExistingItem() {
    const editMode = document.getElementById("bookEditMode");
    return Boolean(editMode && editMode.value === "1");
  }

  function updateDraftStatusBadge(text) {
    const subtitle = document.getElementById("catalogingPageSubtitle");
    if (!subtitle) return;

    let badge = document.getElementById("catalogDraftStatusBadge");
    if (!text) {
      if (badge) badge.remove();
      return;
    }

    if (!badge) {
      badge = document.createElement("span");
      badge.id = "catalogDraftStatusBadge";
      badge.style.cssText =
        "display:inline-flex;align-items:center;gap:8px;margin-left:10px;padding:2px 9px;" +
        "border-radius:999px;background:#e6f4ed;color:#006633;font-size:11px;font-weight:600;";
      subtitle.appendChild(badge);
    }

    badge.innerHTML = "";
    const label = document.createElement("span");
    label.textContent = text;
    badge.appendChild(label);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Discard";
    clearBtn.style.cssText =
      "border:none;background:none;color:#b91c1c;font-size:11px;font-weight:700;cursor:pointer;padding:0;text-decoration:underline;";
    clearBtn.onclick = function () {
      handleCatalogSaveCleanup();
      if (typeof window.showToast === "function") {
        window.showToast("Cataloging draft discarded.", "info", 2500);
      }
    };
    badge.appendChild(clearBtn);
  }

  function saveCatalogDraft() {
    if (isRestoring || isEditingExistingItem()) return;
    const form = document.getElementById("newBookForm");
    if (!form) return;

    const fields = {};
    let hasUserContent = false;

    const controls = form.querySelectorAll("input, select, textarea");
    controls.forEach((el) => {
      if (!el.id || EXCLUDED_IDS.has(el.id)) return;
      if (el.type === "file" || el.type === "button" || el.type === "submit") return;

      if (el.type === "checkbox" || el.type === "radio") {
        fields[el.id] = el.checked;
        if (el.checked) hasUserContent = true;
      } else {
        const val = el.value;
        fields[el.id] = val;
        if (
          val &&
          String(val).trim() !== "" &&
          el.tagName !== "SELECT" &&
          el.id !== "bookAccession"
        ) {
          hasUserContent = true;
        }
      }
    });

    if (!hasUserContent) {
      localStorage.removeItem(getDraftStorageKey());
      updateDraftStatusBadge("");
      return;
    }

    try {
      localStorage.setItem(
        getDraftStorageKey(),
        JSON.stringify({ updatedAt: Date.now(), fields })
      );
      const timeStr = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });
      updateDraftStatusBadge("Draft auto-saved (" + timeStr + ")");
    } catch (e) {
      console.warn("Unable to save cataloging draft:", e);
    }
  }

  function scheduleSaveDraft() {
    if (isRestoring || isEditingExistingItem()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCatalogDraft, 250);
  }

  function clearCatalogDraft() {
    clearTimeout(saveTimer);
    localStorage.removeItem(getDraftStorageKey());
    updateDraftStatusBadge("");
  }

  function handleCatalogSaveCleanup() {
    isRestoring = true;
    try {
      clearCatalogDraft();

      const editMode = document.getElementById("bookEditMode");
      const origAcc = document.getElementById("bookOriginalAccession");
      const targetLib = document.getElementById("bookTargetLibraryKey");
      const editBanner = document.getElementById("catalogEditingBanner");

      if (editMode) editMode.value = "0";
      if (origAcc) origAcc.value = "";
      if (targetLib) targetLib.value = "";
      if (editBanner) editBanner.classList.remove("active");

      const form = document.getElementById("newBookForm");
      const librarySelect =
        typeof window.findCatalogLibrarySelect === "function"
          ? window.findCatalogLibrarySelect()
          : null;

      if (form) {
        const controls = form.querySelectorAll("input, select, textarea");
        controls.forEach((el) => {
          if (el.type === "button" || el.type === "submit") return;
          if (el.id === "bookAccession") return;
          if (el.id === "bookCollectionType") return;
          if (librarySelect && el === librarySelect) return;

          if (el.type === "checkbox" || el.type === "radio") {
            el.checked = false;
          } else if (el.tagName === "SELECT") {
            el.selectedIndex = 0;
          } else {
            el.value = "";
          }
        });
      }

      const coverInput = document.getElementById("bookCoverUrl");
      if (coverInput) {
        coverInput.dispatchEvent(new Event("input", { bubbles: true }));
      }

      if (typeof window.syncCatalogLibraryDropdown === "function") {
        window.syncCatalogLibraryDropdown(true);
      }

      if (typeof window.handleCollectionChange === "function") {
        window.handleCollectionChange();
      }
    } finally {
      setTimeout(() => {
        isRestoring = false;
        clearCatalogDraft();
      }, 150);
    }
  }

  function applyFieldValue(el, value) {
    if (!el || value === undefined || value === null) return;
    if (el.type === "checkbox" || el.type === "radio") {
      el.checked = Boolean(value);
    } else if (String(value) !== "") {
      el.value = value;
    }
  }

  function restoreCatalogDraft() {
    if (isEditingExistingItem()) return;
    const form = document.getElementById("newBookForm");
    if (!form) return;

    const raw = localStorage.getItem(getDraftStorageKey());
    if (!raw) {
      updateDraftStatusBadge("");
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      localStorage.removeItem(getDraftStorageKey());
      return;
    }

    const fields = parsed && parsed.fields;
    if (!fields) return;

    isRestoring = true;
    try {
      const priorityIds = ["bookCollectionType", "bookType", "bookMainGenre", "bookSection"];
      priorityIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el && fields[id] !== undefined && String(fields[id]) !== "") {
          el.value = fields[id];
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });

      setTimeout(() => {
        Object.keys(fields).forEach((id) => {
          if (EXCLUDED_IDS.has(id) || priorityIds.includes(id)) return;
          const el = document.getElementById(id);
          applyFieldValue(el, fields[id]);
        });

        const coverInput = document.getElementById("bookCoverUrl");
        if (coverInput && coverInput.value) {
          coverInput.dispatchEvent(new Event("input", { bubbles: true }));
        }

        isRestoring = false;
        updateDraftStatusBadge("Draft restored");
      }, 120);
    } catch (err) {
      isRestoring = false;
    }
  }

  window.clearCatalogDraft = clearCatalogDraft;
  window.restoreCatalogDraft = restoreCatalogDraft;
  window.handleCatalogSaveCleanup = handleCatalogSaveCleanup;

  function bindCatalogDraftEvents() {
    const form = document.getElementById("newBookForm");
    if (!form) return;

    form.addEventListener("input", scheduleSaveDraft);
    form.addEventListener("change", scheduleSaveDraft);

    form.addEventListener("reset", () => {
      if (!isRestoring) {
        clearCatalogDraft();
      }
    });

    window.addEventListener("beforeunload", () => {
      if (!isRestoring && !isEditingExistingItem()) {
        saveCatalogDraft();
      }
    });

    const headerSelect = document.getElementById("activeLibrarySelect");
    if (headerSelect) {
      headerSelect.addEventListener("change", () => {
        setTimeout(restoreCatalogDraft, 150);
      });
    }

    document.addEventListener("click", (e) => {
      if (e.target.closest('[onclick*="cataloging"]')) {
        setTimeout(restoreCatalogDraft, 120);
      }
    });

    setTimeout(restoreCatalogDraft, 600);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindCatalogDraftEvents);
  } else {
    bindCatalogDraftEvents();
  }
})();
