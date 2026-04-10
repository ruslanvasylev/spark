import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const options = {
    chromePath: "/usr/bin/google-chrome",
    port: 9700 + Math.floor(Math.random() * 500),
    timeoutMs: 120000,
    pageUrl: "",
    outputPng: "",
    summaryJson: "",
    presentationProfile: "leave",
    presentationExposure: null,
    windowSize: "1400,1000",
    captureSource: "auto",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--page-url":
        options.pageUrl = next;
        index += 1;
        break;
      case "--output-png":
        options.outputPng = next;
        index += 1;
        break;
      case "--summary-json":
        options.summaryJson = next;
        index += 1;
        break;
      case "--chrome-path":
        options.chromePath = next;
        index += 1;
        break;
      case "--port":
        options.port = Number(next);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(next);
        index += 1;
        break;
      case "--window-size":
        options.windowSize = next;
        index += 1;
        break;
      case "--capture-source":
        options.captureSource = next;
        index += 1;
        break;
      case "--presentation-profile":
        options.presentationProfile = next;
        index += 1;
        break;
      case "--presentation-exposure":
        options.presentationExposure = Number(next);
        index += 1;
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
  if (!["auto", "pixel", "canvas", "screenshot"].includes(options.captureSource)) {
    throw new Error(
      "--capture-source must be one of: auto, pixel, canvas, screenshot",
    );
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

async function waitForEditorReady(cdp, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const meshes = window.editorDebug?.getMeshes?.() ?? [];
        const progressDisplay =
          document.getElementById("progress-bar")?.style?.display ?? null;
        return {
          readyState: document.readyState,
          hasEditorDebug: Boolean(window.editorDebug),
          meshCount: meshes.length,
          splatCounts: meshes.map((mesh) => mesh.numSplats ?? null),
          allMeshesLoaded:
            meshes.length > 0 &&
            meshes.every(
              (mesh) =>
                Number.isFinite(mesh.numSplats) &&
                mesh.numSplats > 0 &&
                mesh.initialized != null,
            ),
          progressDisplay,
        };
      })()`,
      returnByValue: true,
    });
    const value = result.result?.value ?? null;
    if (
      value?.readyState === "complete" &&
      value?.hasEditorDebug &&
      value?.allMeshesLoaded &&
      value?.progressDisplay !== "block"
    ) {
      return value;
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for editor readiness");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const viewport = parseWindowSize(options.windowSize);
  const userDataDir = await mkdtemp(
    path.join(tmpdir(), "spark-editor-browser-"),
  );
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
                entry.url.includes("examples/editor/index.html"),
            )
          : undefined,
      options.timeoutMs,
    );

    const cdp = await openCdp(target.webSocketDebuggerUrl);
    const cdpTimeoutMs = Math.max(5000, Math.min(options.timeoutMs, 60000));
    const cdpSend = (method, params = {}, label = method) =>
      withTimeout(cdp.send(method, params), cdpTimeoutMs, label);

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

    const readyState = await waitForEditorReady(cdp, options.timeoutMs);

    if (options.presentationProfile !== "leave") {
      await cdpSend(
        "Runtime.evaluate",
        {
          expression: `(async () => {
            await window.editorDebug?.applyPresentationProfile?.({
              profile: ${JSON.stringify(options.presentationProfile)},
              exposure: ${
                options.presentationExposure == null
                  ? "undefined"
                  : JSON.stringify(options.presentationExposure)
              },
            });
            return window.editorDebug?.getRuntimeState?.() ?? null;
          })()`,
          awaitPromise: true,
          returnByValue: true,
        },
        "apply editor presentation profile",
      );
    }

    await cdpSend(
      "Runtime.evaluate",
      {
        expression: `(async () => {
          for (let index = 0; index < 8; index += 1) {
            await new Promise((resolve) => requestAnimationFrame(() => resolve()));
          }
          return true;
        })()`,
        awaitPromise: true,
        returnByValue: true,
      },
      "settle frames",
    );

    const captureResult = await cdpSend(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const canvas = document.getElementById("canvas");
          if (!canvas) {
            throw new Error("Editor canvas not found");
          }
          const meshes = window.editorDebug?.getMeshes?.() ?? [];
          const pixelPng = window.editorDebug?.capturePixelPng?.() ?? null;
          const pixelDigest = window.editorDebug?.capturePixelDigest?.() ?? null;
          const canvasPng = window.editorDebug?.captureCanvasPng?.() ?? null;
          let canvasDigest = window.editorDebug?.captureCanvasDigest?.() ?? null;
          if (canvasDigest == null) {
          const sampleCanvas = document.createElement("canvas");
          const maxDimension = 256;
          const scale = Math.min(
            1,
            maxDimension / Math.max(canvas.width, canvas.height, 1),
          );
          const sampleWidth = Math.max(1, Math.round(canvas.width * scale));
          const sampleHeight = Math.max(1, Math.round(canvas.height * scale));
          sampleCanvas.width = sampleWidth;
          sampleCanvas.height = sampleHeight;
          const sampleContext = sampleCanvas.getContext("2d", {
            willReadFrequently: true,
          });
          if (sampleContext) {
            sampleContext.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
            const { data } = sampleContext.getImageData(
              0,
              0,
              sampleWidth,
              sampleHeight,
            );
            let hash = 2166136261 >>> 0;
            let lumaSum = 0;
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i];
              const g = data[i + 1];
              const b = data[i + 2];
              hash ^= r;
              hash = Math.imul(hash, 16777619) >>> 0;
              hash ^= g;
              hash = Math.imul(hash, 16777619) >>> 0;
              hash ^= b;
              hash = Math.imul(hash, 16777619) >>> 0;
              lumaSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
            }
            const pixelCount = sampleWidth * sampleHeight;
            canvasDigest = {
              sourceWidth: canvas.width,
              sourceHeight: canvas.height,
              sampleWidth,
              sampleHeight,
              pixelCount,
              hash32: hash >>> 0,
              meanLuma: pixelCount > 0 ? lumaSum / pixelCount : 0,
            };
          }
          }
          return {
            pixelDigest,
            pixelPng,
            canvasPng,
            canvasDigest,
            canvas: {
              width: canvas.width,
              height: canvas.height,
            },
            camera: {
              position: window.editorDebug?.camera?.position?.toArray?.() ?? null,
              quaternion: window.editorDebug?.camera?.quaternion?.toArray?.() ?? null,
              fov: window.editorDebug?.camera?.fov ?? null,
            },
            runtime: {
              meshCount: meshes.length,
              splatCounts: meshes.map((mesh) => mesh.numSplats ?? null),
              maxSh: meshes.map((mesh) => mesh.maxSh ?? null),
              background:
                window.editorDebug?.scene?.background?.getHexString?.() ?? null,
              sortRadial: window.spark?.defaultView?.sortRadial ?? null,
              sort32: window.spark?.defaultView?.sort32 ?? null,
              stochastic: window.spark?.defaultView?.stochastic ?? null,
              presentationState:
                window.editorDebug?.getRuntimeState?.()?.presentationContract ?? null,
            },
          };
        })()`,
        returnByValue: true,
      },
      "capture editor canvas",
    );

    const value = captureResult.result?.value ?? null;
    const screenshotResult = await cdpSend(
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      },
      "capture editor screenshot",
    );
    const screenshotBase64 = screenshotResult.data ?? null;
    const screenshotBuffer = screenshotBase64
      ? Buffer.from(screenshotBase64, "base64")
      : null;
    const pixelDigest = value?.pixelDigest ?? null;
    const canvasDigest = value?.canvasDigest ?? null;
    const useCanvasCapture = options.captureSource === "canvas";
    const useScreenshotCapture =
      options.captureSource === "screenshot" || options.captureSource === "auto";

    if (useScreenshotCapture) {
      if (!screenshotBuffer) {
        throw new Error("Editor screenshot capture did not return PNG data");
      }
      await writeFile(options.outputPng, screenshotBuffer);
    } else {
      const pngDataUrl = useCanvasCapture
        ? (value?.canvasPng ?? null)
        : (value?.pixelPng ?? null);
      if (!pngDataUrl?.startsWith("data:image/png;base64,")) {
        throw new Error(
          useCanvasCapture
            ? "Editor canvas capture did not return a PNG data URL"
            : "Editor pixel capture did not return a PNG data URL",
        );
      }
      await writeFile(
        options.outputPng,
        Buffer.from(pngDataUrl.slice("data:image/png;base64,".length), "base64"),
      );
    }

    const artifact = {
      pageUrl: options.pageUrl,
      readyState,
      digest: pixelDigest,
      captureDigests: {
        pixelDigest,
        canvasDigest,
      },
      captureSource: useScreenshotCapture
        ? "screenshot"
        : useCanvasCapture
          ? "canvas"
          : "pixel",
      canvas: value.canvas,
      camera: value.camera,
      runtime: value.runtime,
      chromeStderr,
    };

    if (options.summaryJson) {
      await writeFile(
        options.summaryJson,
        `${JSON.stringify(artifact, null, 2)}\n`,
      );
    }

    console.log(JSON.stringify(artifact, null, 2));
  } finally {
    await cleanup();
  }
}

void main();
