window.FEUR_API_URL = "https://script.google.com/macros/s/AKfycbxKUcZbMsqZ7XohYgB6J_OfMyvESRpKkezuy4Yf3uBEFtyBkkyhLFL7NPzJ7TUKMmfh/exec";

(function () {
  const CACHEABLE_READS = new Set([
    "searchLibraryHoldings",
    "fetchCurrentPatrons",
    "fetchRecentCheckouts",
    "fetchLibraryStatistics",
    "getAttendanceStatistics"
  ]);

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

          const cacheKey = "feur_cache_" + libraryKey + "_" + fnName + "_" + JSON.stringify(args);

          try {
            const res = await fetch(window.FEUR_API_URL, {
              method: "POST",
              redirect: "follow",
              headers: { "Content-Type": "text/plain;charset=utf-8" },
              body: JSON.stringify({ fn: fnName, args, libraryKey })
            });

            const data = await res.json();
            if (!data.ok) {
              throw new Error(data.error || "Server error");
            }

            if (CACHEABLE_READS.has(fnName)) {
              try { localStorage.setItem(cacheKey, JSON.stringify(data.result)); } catch (e) {}
            }

            if (typeof successHandler === "function") {
              successHandler(data.result, userObject);
            }
          } catch (err) {
            if (CACHEABLE_READS.has(fnName)) {
              const cached = localStorage.getItem(cacheKey);
              if (cached && typeof successHandler === "function") {
                successHandler(JSON.parse(cached), userObject);
                return;
              }
            }
            if (typeof failureHandler === "function") {
              failureHandler(err, userObject);
            } else {
              console.error("API call failed (" + fnName + "):", err);
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
