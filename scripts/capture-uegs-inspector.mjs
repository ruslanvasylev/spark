import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const options = {
    chromePath: "/usr/bin/google-chrome",
    port: 9200 + Math.floor(Math.random() * 500),
    timeoutMs: 120000,
    pageUrl: "",
    outputPng: "",
    summaryJson: "",
    hideOverlay: false,
    bakedShadow: "leave",
    directLight: "leave",
    skyLight: "leave",
    ambientOcclusion: "leave",
    sortRadial: "leave",
    sort32: "leave",
    surface2d: "leave",
    debugView: "final",
    presentationProfile: "leave",
    presentationExposure: null,
    windowSize: "1400,1000",
    captureSource: "auto",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--page-url":
        options.pageUrl = next;
        i += 1;
        break;
      case "--output-png":
        options.outputPng = next;
        i += 1;
        break;
      case "--summary-json":
        options.summaryJson = next;
        i += 1;
        break;
      case "--chrome-path":
        options.chromePath = next;
        i += 1;
        break;
      case "--port":
        options.port = Number(next);
        i += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(next);
        i += 1;
        break;
      case "--window-size":
        options.windowSize = next;
        i += 1;
        break;
      case "--capture-source":
        options.captureSource = next;
        i += 1;
        break;
      case "--baked-shadow":
        options.bakedShadow = next;
        i += 1;
        break;
      case "--direct-light":
        options.directLight = next;
        i += 1;
        break;
      case "--sky-light":
        options.skyLight = next;
        i += 1;
        break;
      case "--ambient-occlusion":
        options.ambientOcclusion = next;
        i += 1;
        break;
      case "--sort-radial":
        options.sortRadial = next;
        i += 1;
        break;
      case "--sort32":
        options.sort32 = next;
        i += 1;
        break;
      case "--surface-2d":
        options.surface2d = next;
        i += 1;
        break;
      case "--debug-view":
        options.debugView = next;
        i += 1;
        break;
      case "--presentation-profile":
        options.presentationProfile = next;
        i += 1;
        break;
      case "--presentation-exposure":
        options.presentationExposure = Number(next);
        i += 1;
        break;
      case "--hide-overlay":
        options.hideOverlay = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.pageUrl) {
    throw new Error("--page-url is required");
  }
  if (!options.outputPng) {
    throw new Error("--output-png is required");
  }
  if (!["leave", "on", "off"].includes(options.bakedShadow)) {
    throw new Error("--baked-shadow must be one of: leave, on, off");
  }
  if (!["leave", "on", "off"].includes(options.directLight)) {
    throw new Error("--direct-light must be one of: leave, on, off");
  }
  if (!["leave", "on", "off"].includes(options.skyLight)) {
    throw new Error("--sky-light must be one of: leave, on, off");
  }
  if (!["leave", "on", "off"].includes(options.ambientOcclusion)) {
    throw new Error("--ambient-occlusion must be one of: leave, on, off");
  }
  if (!["leave", "on", "off"].includes(options.sortRadial)) {
    throw new Error("--sort-radial must be one of: leave, on, off");
  }
  if (!["leave", "on", "off"].includes(options.sort32)) {
    throw new Error("--sort32 must be one of: leave, on, off");
  }
  if (!["leave", "on", "off"].includes(options.surface2d)) {
    throw new Error("--surface-2d must be one of: leave, on, off");
  }
  if (
    !["leave", "spark-default", "ue-truth", "ue-presentation"].includes(
      options.presentationProfile,
    )
  ) {
    throw new Error(
      "--presentation-profile must be one of: leave, spark-default, ue-truth, ue-presentation",
    );
  }
  if (
    options.presentationExposure != null &&
    !Number.isFinite(options.presentationExposure)
  ) {
    throw new Error("--presentation-exposure must be a finite number");
  }
  if (
    ![
      "final",
      "base-color",
      "serialized-color",
      "normal",
      "raw-normal",
      "direct-light",
      "ambient-light",
      "ambient-transfer",
      "ambient-transfer-ao",
      "ambient-contribution",
      "ambient-contribution-ao",
      "emissive",
      "ambient-occlusion",
      "baked-shadow",
      "direct-transfer",
      "direct-transfer-shadow",
      "direct-contribution",
      "direct-contribution-shadow",
      "baked-composition",
    ].includes(options.debugView)
  ) {
    throw new Error(
      "--debug-view must be one of: final, base-color, serialized-color, normal, raw-normal, direct-light, ambient-light, ambient-transfer, ambient-transfer-ao, ambient-contribution, ambient-contribution-ao, emissive, ambient-occlusion, baked-shadow, direct-transfer, direct-transfer-shadow, direct-contribution, direct-contribution-shadow, baked-composition",
    );
  }
  if (!["auto", "pixel", "canvas", "screenshot"].includes(options.captureSource)) {
    throw new Error(
      "--capture-source must be one of: auto, pixel, canvas, screenshot",
    );
  }
  return options;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseWindowSize(windowSize) {
  const [widthText, heightText] = String(windowSize).split(",", 2);
  const width = Number.parseInt(widthText, 10);
  const height = Number.parseInt(heightText, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`Invalid --window-size: ${windowSize}`);
  }
  return { width, height };
}

async function pollJson(url, predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const json = await response.json();
        const result = predicate(json);
        if (result) {
          return result;
        }
      }
    } catch {
      // Ignore until timeout.
    }
    await sleep(250);
  }
  throw new Error(`Timed out polling ${url}`);
}

async function openCdp(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) {
      return;
    }
    const handlers = pending.get(message.id);
    if (!handlers) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      handlers.reject(new Error(JSON.stringify(message.error)));
      return;
    }
    handlers.resolve(message.result ?? {});
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return {
    send,
    close() {
      for (const { reject } of pending.values()) {
        reject(new Error("CDP connection closed"));
      }
      pending.clear();
      ws.close();
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const viewport = parseWindowSize(options.windowSize);
  const debugViewModes = {
    final: 0,
    "base-color": 1,
    "serialized-color": 18,
    normal: 2,
    "raw-normal": 8,
    "direct-light": 3,
    "ambient-light": 4,
    emissive: 5,
    "ambient-occlusion": 6,
    "baked-shadow": 7,
    "ambient-transfer": 9,
    "ambient-transfer-ao": 10,
    "direct-transfer": 11,
    "direct-transfer-shadow": 12,
    "ambient-contribution": 13,
    "ambient-contribution-ao": 14,
    "direct-contribution": 15,
    "direct-contribution-shadow": 16,
    "baked-composition": 17,
  };
  const userDataDir = await mkdtemp(path.join(tmpdir(), "spark-uegs-browser-"));
  const chromeArgs = [
    "-a",
    options.chromePath,
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-sandbox",
    "--ignore-gpu-blocklist",
    "--enable-webgl",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--use-gl=angle",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-extensions",
    "--no-first-run",
    `--window-size=${options.windowSize}`,
    options.pageUrl,
  ];

  const chrome = spawn("xvfb-run", chromeArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let chromeStderr = "";
  chrome.stderr.on("data", (chunk) => {
    chromeStderr += String(chunk);
  });

  const cleanup = async () => {
    if (chrome.exitCode === null && !chrome.killed) {
      try {
        process.kill(-chrome.pid, "SIGTERM");
      } catch {
        chrome.kill("SIGTERM");
      }
      await sleep(500);
    }
    if (chrome.exitCode === null && !chrome.killed) {
      try {
        process.kill(-chrome.pid, "SIGKILL");
      } catch {
        chrome.kill("SIGKILL");
      }
    }
    await rm(userDataDir, { recursive: true, force: true });
  };

  try {
    const target = await pollJson(
      `http://127.0.0.1:${options.port}/json/list`,
      (json) =>
        Array.isArray(json)
          ? json.find(
              (entry) =>
                entry.type === "page" &&
                typeof entry.url === "string" &&
                entry.url.includes("uegs-inspector"),
            )
          : undefined,
      options.timeoutMs,
    );

    const cdp = await openCdp(target.webSocketDebuggerUrl);
    const cdpTimeoutMs = Math.max(5000, Math.min(options.timeoutMs, 60000));
    const cdpSend = (method, params = {}, label = method) =>
      withTimeout(cdp.send(method, params), cdpTimeoutMs, label);
    const artifact = {
      pageUrl: options.pageUrl,
      captureStatus: "failed",
      ready: false,
      statusText: "",
      runtimeState: null,
      chromeStderr: "",
      screenshotCaptured: false,
      error: null,
    };

    await cdpSend("Runtime.enable", {}, "Runtime.enable");
    await cdpSend("Page.enable", {}, "Page.enable");
    await cdpSend(
      "Emulation.setDeviceMetricsOverride",
      {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
      },
      "Emulation.setDeviceMetricsOverride",
    );
    await cdpSend(
      "Runtime.evaluate",
      {
        expression: `(() => {
          window.dispatchEvent(new Event("resize"));
          return true;
        })()`,
        returnByValue: true,
      },
      "dispatch resize",
    );

    const startedAt = Date.now();
    let statusText = "";
    let ready = false;
    let runtimeProbe = null;
    while (Date.now() - startedAt < options.timeoutMs) {
      const result = await cdpSend(
        "Runtime.evaluate",
        {
          expression: `(() => document.getElementById("status")?.textContent ?? "")()`,
          returnByValue: true,
        },
        "read status",
      );
      statusText = String(result.result?.value ?? "");
      const readyResult = await cdpSend(
        "Runtime.evaluate",
        {
          expression: "(() => Boolean(window.uegsDebug?.isReady?.()))()",
          returnByValue: true,
        },
        "read ready flag",
      );
      ready = Boolean(readyResult.result?.value);
      const runtimeResult = await cdpSend(
        "Runtime.evaluate",
        {
          expression:
            "(() => window.uegsDebug?.getRuntimeState?.() ?? null)()",
          returnByValue: true,
        },
        "read runtime state",
      );
      runtimeProbe = runtimeResult.result?.value ?? null;
      const recordCount = Number(runtimeProbe?.bundleContract?.recordCount ?? 0);
      const hasLiveBundle = Number.isFinite(recordCount) && recordCount > 0;
      if (
        ready &&
        ((statusText.includes("Loaded UEGS bundle") ||
          statusText.includes("UEGS bundle attached")) ||
          hasLiveBundle)
      ) {
        break;
      }
      if (statusText.includes("failed")) {
        const summaryResult = await cdpSend(
          "Runtime.evaluate",
          {
            expression: `(() => document.getElementById("summary")?.textContent ?? "")()`,
            returnByValue: true,
          },
          "read failure summary",
        );
        throw new Error(
          `Inspector failed: ${statusText}\n${String(summaryResult.result?.value ?? "")}`,
        );
      }
      await sleep(500);
    }

    const finalRecordCount = Number(runtimeProbe?.bundleContract?.recordCount ?? 0);
    const finalHasLiveBundle =
      Number.isFinite(finalRecordCount) && finalRecordCount > 0;
    if (
      ((!statusText.includes("Loaded UEGS bundle") &&
        !statusText.includes("UEGS bundle attached") &&
        !finalHasLiveBundle) ||
        !ready)
    ) {
      throw new Error(
        `Timed out waiting for loaded+ready status. Last status: ${statusText}, ready=${ready}, recordCount=${finalRecordCount}`,
      );
    }
    artifact.ready = true;
    artifact.statusText = statusText;

    if (options.bakedShadow !== "leave") {
      await cdpSend(
        "Runtime.evaluate",
        {
          expression: `(async () => {
          const enabled = ${options.bakedShadow === "on" ? "true" : "false"};
          await window.uegsDebug?.applyBakedShadowEnabled(enabled);
          const checkbox = document.getElementById("baked-shadow");
          if (checkbox) checkbox.checked = enabled;
        })()`,
          awaitPromise: true,
        },
        "apply baked-shadow toggle",
      );
    }

    if (options.directLight !== "leave") {
      await cdpSend(
        "Runtime.evaluate",
        {
          expression: `(async () => {
          const enabled = ${options.directLight === "on" ? "true" : "false"};
          await window.uegsDebug?.applyDirectLightingEnabled(enabled);
          const checkbox = document.getElementById("direct-light");
          if (checkbox) checkbox.checked = enabled;
        })()`,
          awaitPromise: true,
        },
        "apply direct-light toggle",
      );
    }

    if (options.skyLight !== "leave") {
      await cdpSend(
        "Runtime.evaluate",
        {
          expression: `(async () => {
          const enabled = ${options.skyLight === "on" ? "true" : "false"};
          await window.uegsDebug?.applySkyLightingEnabled(enabled);
          const checkbox = document.getElementById("sky-light");
          if (checkbox) checkbox.checked = enabled;
        })()`,
          awaitPromise: true,
        },
        "apply sky-light toggle",
      );
    }

    if (options.ambientOcclusion !== "leave") {
      await cdpSend(
        "Runtime.evaluate",
        {
          expression: `(async () => {
          const enabled = ${options.ambientOcclusion === "on" ? "true" : "false"};
          await window.uegsDebug?.applyAmbientOcclusionEnabled(enabled);
          const checkbox = document.getElementById("ambient-occlusion");
          if (checkbox) checkbox.checked = enabled;
        })()`,
          awaitPromise: true,
        },
        "apply AO toggle",
      );
    }

    if (options.sortRadial !== "leave" || options.sort32 !== "leave") {
      await cdpSend(
        "Runtime.evaluate",
        {
          expression: `(async () => {
          const current = window.uegsDebug?.getRuntimeState?.()?.viewpointContract?.runtime ?? {};
          const sortRadial = ${
            options.sortRadial === "leave"
              ? "Boolean(current.sortRadial)"
              : options.sortRadial === "on"
                ? "true"
                : "false"
          };
          const sort32 = ${
            options.sort32 === "leave"
              ? "Boolean(current.sort32)"
              : options.sort32 === "on"
                ? "true"
                : "false"
          };
          await window.uegsDebug?.applySortConfiguration?.({ sortRadial, sort32 });
          const radial = document.getElementById("sort-radial");
          if (radial) radial.checked = sortRadial;
          const sort32Checkbox = document.getElementById("sort32");
          if (sort32Checkbox) sort32Checkbox.checked = sort32;
        })()`,
          awaitPromise: true,
        },
        "apply sort contract",
      );
    }

    if (options.surface2d !== "leave") {
      await cdpSend(
        "Runtime.evaluate",
        {
          expression: `(async () => {
          const enabled = ${options.surface2d === "on" ? "true" : "false"};
          await window.uegsDebug?.applySurface2dEnabled?.(enabled);
          const checkbox = document.getElementById("surface-2d");
          if (checkbox) checkbox.checked = enabled;
        })()`,
          awaitPromise: true,
        },
        "apply 2d-surface toggle",
      );
    }

    if (options.debugView !== "final") {
      await cdpSend(
        "Runtime.evaluate",
        {
          expression: `(async () => {
          const mode = ${debugViewModes[options.debugView]};
          await window.uegsDebug?.applyDebugViewMode(mode);
          const select = document.getElementById("debug-view");
          if (select) select.value = String(mode);
        })()`,
          awaitPromise: true,
        },
        "apply debug-view toggle",
      );
    }

    if (options.presentationProfile !== "leave") {
      await cdpSend(
        "Runtime.evaluate",
        {
          expression: `(async () => {
          await window.uegsDebug?.applyPresentationProfile?.(
            ${JSON.stringify(options.presentationProfile)},
            {
              exposure: ${
                options.presentationExposure == null
                  ? "undefined"
                  : JSON.stringify(options.presentationExposure)
              },
            },
          );
          const select = document.getElementById("presentation-profile");
          if (select) select.value = ${JSON.stringify(options.presentationProfile)};
          const exposureInput = document.getElementById("presentation-exposure");
          if (exposureInput && ${
            options.presentationExposure == null ? "false" : "true"
          }) {
            exposureInput.value = ${JSON.stringify(
              options.presentationExposure == null
                ? null
                : Number(options.presentationExposure).toFixed(2),
            )};
          }
        })()`,
          awaitPromise: true,
        },
        "apply presentation profile",
      );
    }

    await cdpSend(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const settle = window.uegsDebug?.awaitRenderSync?.({ stableFrames: 4 });
          const fallback = new Promise((resolve) =>
            setTimeout(
              () => requestAnimationFrame(() => requestAnimationFrame(resolve)),
              1500,
            ),
          );
          return settle ? Promise.race([settle, fallback]) : fallback;
        })()`,
        awaitPromise: true,
        returnByValue: true,
      },
      "await render sync",
    );

    const summaryResult = await cdpSend(
      "Runtime.evaluate",
      {
        expression: `(() => document.getElementById("summary")?.textContent ?? "")()`,
        returnByValue: true,
      },
      "read runtime summary",
    );
    const summaryText = String(summaryResult.result?.value ?? "");
    artifact.runtimeState = summaryText ? JSON.parse(summaryText) : null;

    if (options.hideOverlay) {
      await cdpSend(
        "Runtime.evaluate",
        {
          expression: `(() => { const overlay = document.getElementById("overlay"); if (overlay) overlay.style.display = "none"; })()`,
          awaitPromise: true,
        },
        "hide overlay",
      );
      await cdpSend(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const settle = window.uegsDebug?.awaitRenderSync?.({ stableFrames: 2 });
            const fallback = new Promise((resolve) =>
              setTimeout(
                () => requestAnimationFrame(() => requestAnimationFrame(resolve)),
                800,
              ),
            );
            return settle ? Promise.race([settle, fallback]) : fallback;
          })()`,
          awaitPromise: true,
          returnByValue: true,
        },
        "await overlay render sync",
      );
    }

    const captureDigests = await cdpSend(
      "Runtime.evaluate",
      {
        expression: `(() => ({
          pixelDigest: window.uegsDebug?.capturePixelDigest?.() ?? null,
          canvasDigest: window.uegsDebug?.captureCanvasDigest?.() ?? null,
        }))()`,
        returnByValue: true,
      },
      "capture inspector digests",
    );
    const digests = captureDigests.result?.value ?? null;
    const pixelDigest = digests?.pixelDigest ?? null;
    const canvasDigest = digests?.canvasDigest ?? null;
    const useCanvasCapture = options.captureSource === "canvas";
    // Treat the live viewport screenshot as the authoritative comparison surface.
    const useScreenshotCapture =
      options.captureSource === "screenshot" || options.captureSource === "auto";
    const canvasPng = await cdpSend(
      "Runtime.evaluate",
      {
        expression: useCanvasCapture
          ? "(() => window.uegsDebug?.captureCanvasPng?.() ?? null)()"
          : "(() => window.uegsDebug?.capturePixelPng?.() ?? null)()",
        returnByValue: true,
      },
      useCanvasCapture
        ? "capture inspector canvas png"
        : "capture inspector pixel png",
    );
    const screenshotResult = await cdpSend(
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      },
      "capture inspector screenshot",
    );
    const screenshotBase64 = screenshotResult.data ?? null;
    const screenshotBuffer = screenshotBase64
      ? Buffer.from(screenshotBase64, "base64")
      : null;
    if (useScreenshotCapture) {
      if (!screenshotBuffer) {
        throw new Error("Inspector screenshot capture did not return PNG data");
      }
      await writeFile(options.outputPng, screenshotBuffer);
    } else {
      const pngDataUrl = canvasPng.result?.value ?? null;
      if (!pngDataUrl?.startsWith("data:image/png;base64,")) {
        throw new Error("Inspector canvas capture did not return a PNG data URL");
      }
      await writeFile(
        options.outputPng,
        Buffer.from(pngDataUrl.slice("data:image/png;base64,".length), "base64"),
      );
    }
    artifact.captureStatus = "ok";
    artifact.screenshotCaptured = true;
    artifact.captureSource = useScreenshotCapture
      ? "screenshot"
      : useCanvasCapture
        ? "canvas"
        : "pixel";
    artifact.captureDigests = {
      pixelDigest,
      canvasDigest,
    };
    if (options.summaryJson) {
      await writeFile(
        options.summaryJson,
        JSON.stringify(artifact, null, 2),
        "utf8",
      );
    }
    cdp.close();
  } catch (error) {
    const artifact = {
      pageUrl: options.pageUrl,
      captureStatus: "failed",
      ready: false,
      statusText: "",
      runtimeState: null,
      chromeStderr,
      screenshotCaptured: false,
      error: error instanceof Error ? error.message : String(error),
    };
    try {
      if (options.summaryJson) {
        await writeFile(
          options.summaryJson,
          JSON.stringify(artifact, null, 2),
          "utf8",
        );
      }
    } catch {
      // Ignore secondary write failures while surfacing the primary capture failure.
    }
    if (chromeStderr.trim()) {
      console.error(chromeStderr);
    }
    throw error;
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
