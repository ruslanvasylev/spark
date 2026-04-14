const mode = document.documentElement.dataset.viewerMode;
const iframe = document.getElementById("viewer-frame");
const status = document.getElementById("viewer-status");

function setStatus(message, isError = false) {
  if (!status) {
    return;
  }
  status.textContent = message;
  status.dataset.error = isError ? "1" : "0";
}

Object.defineProperty(window, "editorDebug", {
  configurable: true,
  enumerable: true,
  get() {
    return iframe?.contentWindow?.editorDebug;
  },
});
Object.defineProperty(window, "viewerFrame", {
  configurable: true,
  enumerable: true,
  get() {
    return iframe?.contentWindow ?? null;
  },
});

async function loadViewerState() {
  const response = await fetch("/examples/editor/assets/current-uegs-viewers.json", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to load current-uegs-viewers.json (${response.status})`,
    );
  }
  return response.json();
}

function buildEditorUrl(state) {
  const preset = state?.[mode];
  if (!preset) {
    throw new Error(`Viewer preset not found for mode=${mode}`);
  }
  window.currentUegsViewerState = { mode, preset, state };

  const params = new URLSearchParams(window.location.search);
  const setDefault = (key, value) => {
    if (value != null && !params.has(key)) {
      params.set(key, String(value));
    }
  };
  const cacheToken = preset.cacheToken;

  setDefault("url", `${preset.files.spz}?cb=${encodeURIComponent(cacheToken)}`);
  setDefault(
    "manifest",
    `${preset.files.manifest}?cb=${encodeURIComponent(cacheToken)}`,
  );
  setDefault("ui", 1);
  setDefault("bg", "000000");
  setDefault("camera", "manifest");
  setDefault("sortRadial", 0);
  setDefault("opaqueShellCoverage", 1);
  setDefault("preBlurAmount", 0);
  setDefault("blurAmount", 0);
  setDefault("cb", cacheToken);

  if (mode === "composite") {
    setDefault("presentation", "ue-presentation");
    setDefault("presentationExposure", 1);
  } else if (mode === "debug") {
    setDefault("presentation", "ue-truth");
    setDefault("presentationExposure", 1);
    setDefault("uegsDebugUi", 1);
  }

  return `./index.html?${params.toString()}`;
}

async function main() {
  try {
    setStatus(`Loading current ${mode} viewer...`);
    const state = await loadViewerState();
    const src = buildEditorUrl(state);
    iframe.src = src;
    iframe.addEventListener(
      "load",
      () => {
        setStatus(`Loaded current ${mode} viewer.`);
        setTimeout(() => {
          if (status) {
            status.style.display = "none";
          }
        }, 1200);
      },
      { once: true },
    );
  } catch (error) {
    console.error(error);
    setStatus(String(error), true);
  }
}

void main();
