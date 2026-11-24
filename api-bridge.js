window.FEUR_API_URL = "https://script.google.com/macros/s/AKfycbxYtoiXHUnPuLnQGbfQxbAUfnXXB-JY4TIsR6JG7QRm_MCF77_0TA84PeiPwlenGaW44Q/exec";

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

            // Override appUrl so library selection stays on GitHub Pages
            if (fnName === "setActiveLibrary" && data.result) {
              data.result.appUrl = window.location.origin + window.location.pathname;
            }

            if (CACHEABLE_READS.has(fnName)) {
              try { localStorage.setItem(cacheKey, JSON.stringify(data.result)); } catch (e) {}
            }

            if (typeof successHandler === "function") {
              successHandler(data.result, userObject);
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
