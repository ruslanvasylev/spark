const DEBUG_VIEW_OPTIONS = [
  ["Final", "Final"],
  ["SerializedColor", "SerializedColor"],
  ["BaseColor", "BaseColor"],
  ["DirectLighting", "DirectLighting"],
  ["AmbientLighting", "AmbientLighting"],
  ["AmbientOcclusion", "AmbientOcclusion"],
  ["Shadow", "Shadow"],
  ["Opacity", "Opacity"],
  ["Roughness", "Roughness"],
  ["Metallic", "Metallic"],
  ["Normal", "Normal"],
  ["RawNormal", "RawNormal"],
  ["CapturedSceneColor", "CapturedSceneColor"],
  ["CapturedTargetBaseColor", "CapturedTargetBaseColor"],
  ["CapturedTargetNormal", "CapturedTargetNormal"],
  ["CapturedSceneNormal", "CapturedSceneNormal"],
  ["CapturedDirectShadowed", "CapturedDirectShadowed"],
  ["CapturedDirectUnshadowed", "CapturedDirectUnshadowed"],
];

const statusEl = document.getElementById("status");
const compositeFrame = document.getElementById("composite-frame");
const debugFrame = document.getElementById("debug-frame");
const debugViewSelect = document.getElementById("debug-view-select");
const syncCameraCheckbox = document.getElementById("sync-camera");
const directLightingCheckbox = document.getElementById("direct-lighting");
const skyLightingCheckbox = document.getElementById("sky-lighting");
const ambientOcclusionCheckbox = document.getElementById("ambient-occlusion");
const bakedShadowCheckbox = document.getElementById("baked-shadow");
const refreshDebugButton = document.getElementById("refresh-debug");

let syncAnimationFrame = 0;
let lastSyncedPose = "";

function setStatus(message) {
  statusEl.textContent = message;
}

function parseBoolean(value, fallback) {
  if (value == null) {
    return fallback;
  }
  return value !== "0" && String(value).toLowerCase() !== "false";
}

function populateDebugViewSelect() {
  DEBUG_VIEW_OPTIONS.forEach(([label, value]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    debugViewSelect.appendChild(option);
  });
}

function currentDebugOptions() {
  return {
    debugViewMode: debugViewSelect.value,
    directLightingEnabled: directLightingCheckbox.checked,
    skyLightingEnabled: skyLightingCheckbox.checked,
    ambientOcclusionEnabled: ambientOcclusionCheckbox.checked,
    bakedShadowEnabled: bakedShadowCheckbox.checked,
  };
}

async function waitForViewer(iframe, label, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const dbg = iframe.contentWindow?.editorDebug;
    const meshes = dbg?.getMeshes?.() ?? [];
    if (dbg && meshes.length > 0) {
      return dbg;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function buildCompositeUrl() {
  const params = new URLSearchParams();
  params.set("ui", "0");
  return `/examples/editor/current-uegs-composite.html?${params.toString()}`;
}

function buildDebugUrl() {
  const params = new URLSearchParams();
  params.set("ui", "0");
  params.set("uegsDebugUi", "0");
  params.set("debugView", debugViewSelect.value);
  params.set("uegsDirectLighting", directLightingCheckbox.checked ? "1" : "0");
  params.set("uegsSkyLighting", skyLightingCheckbox.checked ? "1" : "0");
  params.set("uegsAmbientOcclusion", ambientOcclusionCheckbox.checked ? "1" : "0");
  params.set("uegsBakedShadow", bakedShadowCheckbox.checked ? "1" : "0");
  return `/examples/editor/current-uegs-debug.html?${params.toString()}`;
}

function getCompositeDebug() {
  return compositeFrame.contentWindow?.editorDebug ?? null;
}

function getDebugDebug() {
  return debugFrame.contentWindow?.editorDebug ?? null;
}

function poseSignature(pose) {
  return JSON.stringify({
    position: pose.position?.map((value) => Number(value).toFixed(5)),
    quaternion: pose.quaternion?.map((value) => Number(value).toFixed(5)),
    fov: Number(pose.fov).toFixed(5),
  });
}

function syncCameraLoop() {
  cancelAnimationFrame(syncAnimationFrame);
  const step = () => {
    const source = getCompositeDebug();
    const target = getDebugDebug();
    if (syncCameraCheckbox.checked && source?.getCameraPose && target?.setCameraPose) {
      const pose = source.getCameraPose();
      const signature = poseSignature(pose);
      if (signature !== lastSyncedPose) {
        target.setCameraPose(pose);
        lastSyncedPose = signature;
      }
    }
    syncAnimationFrame = requestAnimationFrame(step);
  };
  syncAnimationFrame = requestAnimationFrame(step);
}

async function applyDebugOptionsLive() {
  const dbg = getDebugDebug();
  if (!dbg?.setUegsDebugOptions) {
    return;
  }
  dbg.setUegsDebugOptions(currentDebugOptions());
}

async function loadDebugViewer() {
  return new Promise((resolve) => {
    debugFrame.onload = async () => {
      await waitForViewer(debugFrame, "debug viewer");
      await applyDebugOptionsLive();
      resolve();
    };
    debugFrame.src = buildDebugUrl();
  });
}

async function initialize() {
  const params = new URLSearchParams(window.location.search);
  populateDebugViewSelect();
  debugViewSelect.value = params.get("debugView") || "BaseColor";
  syncCameraCheckbox.checked = parseBoolean(params.get("syncCamera"), true);
  directLightingCheckbox.checked = parseBoolean(params.get("uegsDirectLighting"), true);
  skyLightingCheckbox.checked = parseBoolean(params.get("uegsSkyLighting"), true);
  ambientOcclusionCheckbox.checked = parseBoolean(params.get("uegsAmbientOcclusion"), true);
  bakedShadowCheckbox.checked = parseBoolean(params.get("uegsBakedShadow"), true);

  setStatus("Loading composite and debug viewers…");
  const compositeReady = new Promise((resolve) => {
    compositeFrame.onload = async () => {
      await waitForViewer(compositeFrame, "composite viewer");
      resolve();
    };
    compositeFrame.src = buildCompositeUrl();
  });
  const debugReady = loadDebugViewer();
  await Promise.all([compositeReady, debugReady]);
  syncCameraLoop();

  const compositeState = compositeFrame.contentWindow?.currentUegsViewerState?.preset;
  const debugState = debugFrame.contentWindow?.currentUegsViewerState?.preset;
  setStatus(
    `Composite ${compositeState?.gaussianCount ?? "?"} splats • Debug ${debugState?.gaussianCount ?? "?"} splats • synced=${syncCameraCheckbox.checked}`,
  );
}

async function refreshDebugViewer() {
  setStatus("Refreshing debug viewer…");
  await loadDebugViewer();
  setStatus(`Debug viewer refreshed (${debugViewSelect.value}).`);
}

debugViewSelect.addEventListener("change", async () => {
  await applyDebugOptionsLive();
  setStatus(`Debug term: ${debugViewSelect.value}`);
});

[directLightingCheckbox, skyLightingCheckbox, ambientOcclusionCheckbox, bakedShadowCheckbox].forEach(
  (element) => {
    element.addEventListener("change", async () => {
      await applyDebugOptionsLive();
      setStatus(`Updated debug lighting toggles.`);
    });
  },
);

syncCameraCheckbox.addEventListener("change", () => {
  lastSyncedPose = "";
  setStatus(`Camera sync ${syncCameraCheckbox.checked ? "enabled" : "disabled"}.`);
});

refreshDebugButton.addEventListener("click", async () => {
  await refreshDebugViewer();
});

window.currentUegsCompare = {
  refreshDebugViewer,
  getCompositeDebug,
  getDebugDebug,
  currentDebugOptions,
};

void initialize();
