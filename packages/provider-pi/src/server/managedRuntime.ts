// @effect-diagnostics nodeBuiltinImport:off -- Incremental SHA-256 avoids buffering native release archives in memory.
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";
import { managedPiHome } from "./managedHome.ts";

export const PINNED_PI_VERSION = "1.5.0";
const ASSETS: Readonly<Record<string, { readonly sha256: string; readonly size: number }>> = {
  "darwin-arm64": {
    sha256: "a9bf0d82d58d2a7d337f4ae4171b5fc9ebffe42509527a831364c4b65adf2cdf",
    size: 48027930,
  },
  "darwin-x64": {
    sha256: "f41b26cd9a1754abe259e05a421fb33b00936779cb0783c893a6389d1bd2ee0d",
    size: 50541720,
  },
  "linux-arm64": {
    sha256: "5d5711b48600756473682e86360b026b11abf7591e5d112eb411d4da2c100d9a",
    size: 58742522,
  },
  "linux-x64": {
    sha256: "df870ba0e344cb7b3358d8d8f19397b8b8d225a8669784736ad68a5c2169d53b",
    size: 58876253,
  },
  "win32-arm64": {
    sha256: "9843e4241b6935a85d49b704562cdcb6fdc78a8ec643410f32b3876a87414283",
    size: 56568696,
  },
  "win32-x64": {
    sha256: "12d58a70e80b16ba9f764950b7a42bdeb07959495c0db68396cf2988c0b71af3",
    size: 61890147,
  },
};

class ManagedPiRuntimeError extends Schema.TaggedError<
  ManagedPiRuntimeError,
  { readonly brand: unique symbol }
>()("ManagedPiRuntimeError", {
  stage: Schema.Literals([
    "platform",
    "home",
    "cache",
    "staging",
    "download",
    "integrity",
    "extract",
    "version",
    "publish",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return "Could not prepare the pinned Pi runtime.";
  }
}

export const makeManagedPiRuntime = Effect.fn("Pi.makeManagedPiRuntime")(function* (options: {
  readonly instanceId: ProviderInstanceId;
}) {
  const host = yield* ProviderHost.ProviderHost;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const processEnv = yield* HostProcess.Environment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const assetKey = `${platform}-${arch}`;
  const asset = ASSETS[assetKey];
  if (!asset) return yield* new ManagedPiRuntimeError({ stage: "platform" });

  const windows = platform === "win32";
  const systemRoot = processEnv.SystemRoot ?? processEnv.SYSTEMROOT;
  if (windows && (!systemRoot || !path.isAbsolute(systemRoot))) {
    return yield* new ManagedPiRuntimeError({ stage: "platform" });
  }
  const runtimeParent = path.join(host.paths.baseDir, "providers", "pi", PINNED_PI_VERSION);
  const runtimeDir = path.join(runtimeParent, assetKey);
  const binaryName = windows ? "pi.exe" : "pi";
  const binaryPath = path.join(runtimeDir, binaryName);
  const home = managedPiHome(host.paths.baseDir, options.instanceId, path);
  const environment: NodeJS.ProcessEnv = {
    ...processEnv,
    PI_CODING_AGENT_DIR: home,
    PI_CODING_AGENT_SESSION_DIR: path.join(home, "sessions"),
    PI_PACKAGE_DIR: runtimeDir,
    // Pi splits this value on whitespace, not shell quoting; no package updater may run here.
    PI_SELF_UPDATE_COMMAND: windows
      ? `${path.join(systemRoot!, "System32", "cmd.exe")} /d /c exit 1`
      : "/usr/bin/false",
  };
  yield* fs
    .makeDirectory(environment.PI_CODING_AGENT_SESSION_DIR!, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError((cause) => new ManagedPiRuntimeError({ stage: "home", cause })));

  const marker = `${PINNED_PI_VERSION}\n${assetKey}\n${asset.sha256}\n${asset.size}\n`;
  const isReady = Effect.fn("Pi.managedRuntime.isReady")(
    function* () {
      const content = yield* fs.readFileString(path.join(runtimeDir, ".ready"));
      if (content !== marker) return false;
      return (yield* fs.stat(binaryPath)).type === "File";
    },
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(false)
          : Effect.fail(new ManagedPiRuntimeError({ stage: "cache", cause })),
    }),
  );
  if (
    yield* fs
      .exists(runtimeDir)
      .pipe(Effect.mapError((cause) => new ManagedPiRuntimeError({ stage: "cache", cause })))
  ) {
    if (yield* isReady()) return { binaryPath, environment };
    return yield* new ManagedPiRuntimeError({ stage: "cache" });
  }

  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* fs
        .makeDirectory(runtimeParent, { recursive: true })
        .pipe(Effect.mapError((cause) => new ManagedPiRuntimeError({ stage: "staging", cause })));
      const staging = yield* fs
        .makeTempDirectoryScoped({
          directory: runtimeParent,
          prefix: `.${assetKey}-`,
        })
        .pipe(Effect.mapError((cause) => new ManagedPiRuntimeError({ stage: "staging", cause })));
      const archiveName = windows ? `pi-windows-${arch}.zip` : `pi-${platform}-${arch}.tar.gz`;
      const archive = path.join(staging, archiveName);
      const extracted = path.join(staging, "runtime");
      const response = yield* http
        .pipe(HttpClient.withScope, HttpClient.followRedirects(), HttpClient.filterStatusOk)
        .get(
          `https://github.com/earendil-works/pi/releases/download/v${PINNED_PI_VERSION}/${archiveName}`,
        )
        .pipe(Effect.mapError((cause) => new ManagedPiRuntimeError({ stage: "download", cause })));
      const hash = NodeCrypto.createHash("sha256");
      let size = 0;
      yield* response.stream.pipe(
        Stream.mapError((cause) => new ManagedPiRuntimeError({ stage: "download", cause })),
        Stream.mapEffect((chunk) => {
          size += chunk.byteLength;
          if (size > asset.size)
            return Effect.fail(new ManagedPiRuntimeError({ stage: "integrity" }));
          hash.update(chunk);
          return Effect.succeed(chunk);
        }),
        Stream.run(
          fs
            .sink(archive)
            .pipe(
              Sink.mapError((cause) => new ManagedPiRuntimeError({ stage: "download", cause })),
            ),
        ),
      );
      if (size !== asset.size || hash.digest("hex") !== asset.sha256) {
        return yield* new ManagedPiRuntimeError({ stage: "integrity" });
      }

      yield* fs
        .makeDirectory(extracted)
        .pipe(Effect.mapError((cause) => new ManagedPiRuntimeError({ stage: "extract", cause })));
      const exitCode = yield* spawner
        .exitCode(
          ChildProcess.make(
            windows ? path.join(systemRoot!, "System32", "tar.exe") : "tar",
            [windows ? "-xf" : "-xzf", archive, "-C", extracted],
            { env: environment },
          ),
        )
        .pipe(Effect.mapError((cause) => new ManagedPiRuntimeError({ stage: "extract", cause })));
      if (exitCode !== 0) return yield* new ManagedPiRuntimeError({ stage: "extract" });
      const stagedBinary = path.join(extracted, binaryName);
      if (!windows) {
        yield* fs
          .chmod(stagedBinary, 0o755)
          .pipe(Effect.mapError((cause) => new ManagedPiRuntimeError({ stage: "extract", cause })));
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(stagedBinary, ["--version"], {
              env: { ...environment, PI_PACKAGE_DIR: extracted },
            }),
          );
          const [output, , code] = yield* Effect.all(
            [
              Stream.mkString(handle.stdout.pipe(Stream.decodeText)),
              Stream.runDrain(handle.stderr),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (
            code !== 0 ||
            (output.trim() !== PINNED_PI_VERSION && output.trim() !== `pi ${PINNED_PI_VERSION}`)
          ) {
            return yield* new ManagedPiRuntimeError({ stage: "version" });
          }
        }),
      ).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            Effect.fail(new ManagedPiRuntimeError({ stage: "version", cause })),
        }),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new ManagedPiRuntimeError({ stage: "version" })),
        }),
      );
      yield* fs
        .writeFileString(path.join(extracted, ".ready"), marker)
        .pipe(Effect.mapError((cause) => new ManagedPiRuntimeError({ stage: "publish", cause })));
      yield* fs.rename(extracted, runtimeDir).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            isReady().pipe(
              Effect.flatMap((ready) =>
                ready
                  ? Effect.void
                  : Effect.fail(new ManagedPiRuntimeError({ stage: "publish", cause })),
              ),
            ),
        }),
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: "10 minutes",
        orElse: () => Effect.fail(new ManagedPiRuntimeError({ stage: "download" })),
      }),
    ),
  );
  return { binaryPath, environment };
});
