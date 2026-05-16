import {
  fitReferenceViewportIntoContainers,
  getUegsReferenceViewport,
  resolveSharedUegsReferenceViewport,
} from "./uegs-reference-viewport.js";

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
let referenceViewportLayout = {
  enabled: true,
  allowUpscale: false,
  viewport: null,
  fit: null,
  mismatch: false,
};

function setStatus(message) {
  statusEl.textContent = message;
}

function parseBoolean(value, fallback) {
  if (value == null) {
    return fallback;
  }
  return value !== "0" && String(value).toLowerCase() !== "false";
}

async function fetchJsonNoStore(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}

function buildManifestUrl(preset) {
  const url = new URL(preset.files.manifest, window.location.href);
  if (preset.cacheToken != null) {
    url.searchParams.set("cb", preset.cacheToken);
  }
  return url.toString();
}

async function loadSharedReferenceViewport() {
  const state = await fetchJsonNoStore(
    "/examples/editor/assets/current-uegs-viewers.json",
  );
  const [compositeManifest, debugManifest] = await Promise.all([
    fetchJsonNoStore(buildManifestUrl(state.composite)),
    fetchJsonNoStore(buildManifestUrl(state.debug)),
  ]);
  return resolveSharedUegsReferenceViewport([
    getUegsReferenceViewport(compositeManifest),
    getUegsReferenceViewport(debugManifest),
  ]);
}

function clearReferenceViewportLayout() {
  for (const frame of [compositeFrame, debugFrame]) {
    frame.style.width = "";
    frame.style.height = "";
  }
  referenceViewportLayout = {
    ...referenceViewportLayout,
    viewport: null,
    fit: null,
  };
  document.documentElement.dataset.referenceViewportLocked = "0";
}

function applyReferenceViewportLayout(viewport) {
  if (viewport == null) {
    clearReferenceViewportLayout();
    return;
  }

  const panels = [compositeFrame.parentElement, debugFrame.parentElement];
  const containers = panels.map((panel) => ({
    width: panel.clientWidth,
    height: panel.clientHeight,
  }));
  const fit = fitReferenceViewportIntoContainers(viewport, containers, {
    allowUpscale: referenceViewportLayout.allowUpscale,
  });
  if (fit == null) {
    for (const frame of [compositeFrame, debugFrame]) {
      frame.style.width = "";
      frame.style.height = "";
    }
    referenceViewportLayout = {
      ...referenceViewportLayout,
      viewport,
      fit: null,
    };
    document.documentElement.dataset.referenceViewportLocked = "0";
    return;
  }

  for (const frame of [compositeFrame, debugFrame]) {
    frame.style.width = `${fit.width}px`;
    frame.style.height = `${fit.height}px`;
  }
  referenceViewportLayout = {
    ...referenceViewportLayout,
    viewport,
    fit,
  };
  document.documentElement.dataset.referenceViewportLocked = "1";
}

async function initializeReferenceViewportLayout(
  enabled,
  { allowUpscale = false } = {},
) {
  referenceViewportLayout = {
    enabled,
    allowUpscale,
    viewport: null,
    fit: null,
    mismatch: false,
  };
  if (!enabled) {
    clearReferenceViewportLayout();
    return;
  }

  const { viewport, mismatch } = await loadSharedReferenceViewport();
  referenceViewportLayout = {
    ...referenceViewportLayout,
    viewport,
    mismatch,
  };
  if (mismatch) {
    console.warn(
      "Composite/debug reference viewport manifests differ; using composite viewport.",
    );
  }
  applyReferenceViewportLayout(viewport);
}

window.addEventListener("resize", () => {
  if (
    referenceViewportLayout.enabled &&
    referenceViewportLayout.viewport != null
  ) {
    applyReferenceViewportLayout(referenceViewportLayout.viewport);
  }
});

function populateDebugViewSelect() {
  for (const [label, value] of DEBUG_VIEW_OPTIONS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    debugViewSelect.appendChild(option);
  }
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
  params.set(
    "uegsAmbientOcclusion",
    ambientOcclusionCheckbox.checked ? "1" : "0",
  );
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
    if (
      syncCameraCheckbox.checked &&
      source?.getCameraPose &&
      target?.setCameraPose
    ) {
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
  directLightingCheckbox.checked = parseBoolean(
    params.get("uegsDirectLighting"),
    true,
  );
  skyLightingCheckbox.checked = parseBoolean(
    params.get("uegsSkyLighting"),
    true,
  );
  ambientOcclusionCheckbox.checked = parseBoolean(
    params.get("uegsAmbientOcclusion"),
    true,
  );
  bakedShadowCheckbox.checked = parseBoolean(
    params.get("uegsBakedShadow"),
    true,
  );

  const referenceViewportEnabled = parseBoolean(
    params.get("referenceViewport"),
    true,
  );
  const referenceViewportAllowUpscale =
    parseBoolean(params.get("referenceViewportUpscale"), false) ||
    params.get("referenceViewportScale") === "fit";
  const referenceViewportReady = initializeReferenceViewportLayout(
    referenceViewportEnabled,
    { allowUpscale: referenceViewportAllowUpscale },
  ).catch((error) => {
    console.warn("Failed to initialize UEGS reference viewport layout", error);
    referenceViewportLayout = {
      enabled: false,
      allowUpscale: false,
      viewport: null,
      fit: null,
      mismatch: false,
    };
    clearReferenceViewportLayout();
  });

  setStatus("Loading composite and debug viewers…");
  const compositeReady = new Promise((resolve) => {
    compositeFrame.onload = async () => {
      await waitForViewer(compositeFrame, "composite viewer");
      resolve();
    };
    compositeFrame.src = buildCompositeUrl();
  });
  const debugReady = loadDebugViewer();
  await Promise.all([compositeReady, debugReady, referenceViewportReady]);
  syncCameraLoop();

  const compositeState =
    compositeFrame.contentWindow?.currentUegsViewerState?.preset;
  const debugState = debugFrame.contentWindow?.currentUegsViewerState?.preset;
  const referenceViewportStatus = referenceViewportLayout.fit
    ? ` • viewport ${referenceViewportLayout.viewport.width}×${referenceViewportLayout.viewport.height}`
    : "";
  setStatus(
    `Composite ${compositeState?.gaussianCount ?? "?"} splats • Debug ${debugState?.gaussianCount ?? "?"} splats • synced=${syncCameraCheckbox.checked}${referenceViewportStatus}`,
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

for (const element of [
  directLightingCheckbox,
  skyLightingCheckbox,
  ambientOcclusionCheckbox,
  bakedShadowCheckbox,
]) {
  element.addEventListener("change", async () => {
    await applyDebugOptionsLive();
    setStatus("Updated debug lighting toggles.");
  });
}

syncCameraCheckbox.addEventListener("change", () => {
  lastSyncedPose = "";
  setStatus(
    `Camera sync ${syncCameraCheckbox.checked ? "enabled" : "disabled"}.`,
  );
});

refreshDebugButton.addEventListener("click", async () => {
  await refreshDebugViewer();
});

window.currentUegsCompare = {
  refreshDebugViewer,
  getCompositeDebug,
  getDebugDebug,
  currentDebugOptions,
  getReferenceViewportLayout: () => referenceViewportLayout,
};

void initialize();
