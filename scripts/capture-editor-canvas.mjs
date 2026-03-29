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
    windowSize: "1400,1000",
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

    const readyState = await waitForEditorReady(cdp, options.timeoutMs);

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
          return {
            digest: window.editorDebug?.capturePixelDigest?.() ?? null,
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
            },
          };
        })()`,
        returnByValue: true,
      },
      "capture editor canvas",
    );

    const value = captureResult.result?.value ?? null;
    const pngCapture = await cdpSend(
      "Runtime.evaluate",
      {
        expression: "(() => window.editorDebug?.capturePixelPng?.() ?? null)()",
        returnByValue: true,
      },
      "capture editor canvas",
    );
    const pngDataUrl = pngCapture.result?.value ?? null;
    if (!pngDataUrl?.startsWith("data:image/png;base64,")) {
      throw new Error("Editor pixel capture did not return a PNG data URL");
    }
    await writeFile(
      options.outputPng,
      Buffer.from(pngDataUrl.slice("data:image/png;base64,".length), "base64"),
    );

    const artifact = {
      pageUrl: options.pageUrl,
      readyState,
      digest: value.digest,
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
