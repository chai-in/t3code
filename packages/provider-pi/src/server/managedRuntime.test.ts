// @effect-diagnostics nodeBuiltinImport:off -- The digest spy substitutes release fixtures without checking large binaries into the repository.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";

import { makeManagedPiRuntime } from "./managedRuntime.ts";

const releases = [
  {
    platform: "darwin",
    arch: "arm64",
    size: 48027930,
    sha256: "a9bf0d82d58d2a7d337f4ae4171b5fc9ebffe42509527a831364c4b65adf2cdf",
  },
  {
    platform: "darwin",
    arch: "x64",
    size: 50541720,
    sha256: "f41b26cd9a1754abe259e05a421fb33b00936779cb0783c893a6389d1bd2ee0d",
  },
  {
    platform: "linux",
    arch: "arm64",
    size: 58742522,
    sha256: "5d5711b48600756473682e86360b026b11abf7591e5d112eb411d4da2c100d9a",
  },
  {
    platform: "linux",
    arch: "x64",
    size: 58876253,
    sha256: "df870ba0e344cb7b3358d8d8f19397b8b8d225a8669784736ad68a5c2169d53b",
  },
  {
    platform: "win32",
    arch: "arm64",
    size: 56568696,
    sha256: "9843e4241b6935a85d49b704562cdcb6fdc78a8ec643410f32b3876a87414283",
  },
  {
    platform: "win32",
    arch: "x64",
    size: 61890147,
    sha256: "12d58a70e80b16ba9f764950b7a42bdeb07959495c0db68396cf2988c0b71af3",
  },
] as const;

const makeFixture = Effect.fn("managedRuntime.test.makeFixture")(function* (
  options: {
    readonly release?: (typeof releases)[number];
    readonly platform?: NodeJS.Platform;
    readonly arch?: NodeJS.Architecture;
    readonly bodySize?: number;
    readonly version?: string;
    readonly versionExitCode?: number;
    readonly concurrent?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-pi-" });
  const release = options.release ?? releases[5];
  const platform = options.platform ?? release.platform;
  const arch = options.arch ?? release.arch;
  const runtimeParent = path.join(baseDir, "providers", "pi", "1.5.0");
  const runtimeDir = path.join(runtimeParent, `${platform}-${arch}`);
  const standalone = path.join(baseDir, "standalone-pi");
  yield* fs.makeDirectory(standalone);
  yield* fs.writeFileString(path.join(standalone, "sentinel"), "personal installation");
  const processEnv = {
    PATH: "unchanged-path",
    SystemRoot: path.join(baseDir, "system-root"),
    PI_CODING_AGENT_DIR: standalone,
    PI_CODING_AGENT_SESSION_DIR: path.join(standalone, "sessions"),
    PI_PACKAGE_DIR: standalone,
    PI_SELF_UPDATE_COMMAND: "unwanted-updater",
  };
  const requests: Array<string> = [];
  const http = HttpClient.make((request) => {
    requests.push(request.url);
    let remaining = options.bodySize ?? release.size;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (remaining === 0) {
                controller.close();
                return;
              }
              const chunk = new Uint8Array(Math.min(1024 * 1024, remaining));
              remaining -= chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
        ),
      ),
    );
  });
  const bothVerifying = yield* Deferred.make<void>();
  const launches: Array<ChildProcess.StandardCommand> = [];
  let verifications = 0;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      launches.push(command);
      const version = command.args.includes("--version");
      if (!version) {
        const destination = String(command.args[command.args.indexOf("-C") + 1]!);
        // Official Unix archives wrap the complete distribution in pi/; Windows ZIPs are flat.
        const root =
          platform === "win32" || command.args.includes("--strip-components=1")
            ? destination
            : path.join(destination, "pi");
        yield* fs.makeDirectory(root, { recursive: true });
        yield* fs.writeFileString(
          path.join(root, platform === "win32" ? "pi.exe" : "pi"),
          "native fixture",
        );
        yield* fs.makeDirectory(path.join(root, "assets"));
        yield* fs.writeFileString(path.join(root, "assets", "fixture"), "complete archive");
      } else {
        assert.equal((yield* fs.stat(command.command)).type, "File");
        assert.isFalse(yield* fs.exists(runtimeDir));
        assert.equal(command.options.env?.PI_PACKAGE_DIR, path.dirname(command.command));
        verifications++;
        if (options.concurrent) {
          if (verifications === 2) yield* Deferred.succeed(bothVerifying, undefined);
          yield* Deferred.await(bothVerifying);
        }
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: Effect.succeed(
          ChildProcessSpawner.ExitCode(version ? (options.versionExitCode ?? 0) : 0),
        ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: version
          ? Stream.succeed(new TextEncoder().encode(options.version ?? "1.5.0\n"))
          : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const acquire = (instanceId = "pi-default") =>
    makeManagedPiRuntime({
      instanceId: ProviderInstanceId.make(instanceId),
    }).pipe(
      Effect.provideService(ProviderHost.ProviderHost, {
        ...host,
        paths: { ...host.paths, baseDir },
      }),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Architecture, arch),
      Effect.provideService(HostProcess.Environment, processEnv),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  return {
    acquire,
    fs,
    path,
    baseDir,
    runtimeParent,
    runtimeDir,
    processEnv,
    requests,
    launches,
    standalone,
  };
});

const layer = TestProviderHost.layer().pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("managed Pi runtime", (it) => {
  it.effect.each(releases)(
    "publishes the complete pinned $platform-$arch native archive",
    (release) =>
      Effect.gen(function* () {
        using _digest = vi
          .spyOn(NodeCrypto.Hash.prototype, "digest")
          .mockReturnValue(release.sha256);
        const fixture = yield* makeFixture({ release });
        const runtime = yield* fixture.acquire();
        const { path, fs, runtimeDir, runtimeParent } = fixture;
        const windows = release.platform === "win32";
        const archiveName = windows
          ? `pi-windows-${release.arch}.zip`
          : `pi-${release.platform}-${release.arch}.tar.gz`;
        assert.deepEqual(fixture.requests, [
          `https://github.com/earendil-works/pi/releases/download/v1.5.0/${archiveName}`,
        ]);
        assert.equal(runtime.binaryPath, path.join(runtimeDir, windows ? "pi.exe" : "pi"));
        assert.equal(
          yield* fs.readFileString(path.join(runtimeDir, "assets", "fixture")),
          "complete archive",
        );
        assert.equal(
          yield* fs.readFileString(path.join(runtimeDir, ".ready")),
          `1.5.0\n${release.platform}-${release.arch}\n${release.sha256}\n${release.size}\n`,
        );
        assert.deepEqual(yield* fs.readDirectory(runtimeParent), [
          `${release.platform}-${release.arch}`,
        ]);
        const extraction = fixture.launches[0]!;
        assert.equal(
          extraction.command,
          windows ? path.join(fixture.processEnv.SystemRoot, "System32", "tar.exe") : "tar",
        );
        assert.equal(extraction.args[0], windows ? "-xf" : "-xzf");
        assert.equal(path.basename(String(extraction.args[1]!)), archiveName);
        assert.equal(fixture.launches[1]!.args[0], "--version");
      }),
  );

  it.effect("reuses the ready cache without HTTP or subprocesses and isolates each instance", () =>
    Effect.gen(function* () {
      using _digest = vi
        .spyOn(NodeCrypto.Hash.prototype, "digest")
        .mockReturnValue(releases[5].sha256);
      const fixture = yield* makeFixture();
      const first = yield* fixture.acquire("Pi_work-one");
      const second = yield* fixture.acquire("pi_work-one");
      assert.equal(first.binaryPath, second.binaryPath);
      assert.lengthOf(fixture.requests, 1);
      assert.lengthOf(fixture.launches, 2);
      const homes = fixture.path.join(fixture.baseDir, "provider-homes", "pi");
      assert.equal(
        first.environment.PI_CODING_AGENT_DIR,
        fixture.path.join(homes, "instance-50695f776f726b2d6f6e65"),
      );
      assert.equal(
        second.environment.PI_CODING_AGENT_DIR,
        fixture.path.join(homes, "instance-70695f776f726b2d6f6e65"),
      );
      for (const runtime of [first, second]) {
        assert.equal(
          runtime.environment.PI_CODING_AGENT_SESSION_DIR,
          fixture.path.join(runtime.environment.PI_CODING_AGENT_DIR!, "sessions"),
        );
        assert.isTrue(yield* fixture.fs.exists(runtime.environment.PI_CODING_AGENT_SESSION_DIR!));
        assert.equal(runtime.environment.PI_PACKAGE_DIR, fixture.runtimeDir);
        assert.equal(runtime.environment.PATH, fixture.processEnv.PATH);
        assert.equal(
          runtime.environment.PI_SELF_UPDATE_COMMAND,
          `${fixture.path.join(fixture.processEnv.SystemRoot, "System32", "cmd.exe")} /d /c exit 1`,
        );
      }
      assert.equal(fixture.processEnv.PI_SELF_UPDATE_COMMAND, "unwanted-updater");
      assert.deepEqual(yield* fixture.fs.readDirectory(fixture.standalone), ["sentinel"]);
      assert.equal(
        yield* fixture.fs.readFileString(fixture.path.join(fixture.standalone, "sentinel")),
        "personal installation",
      );
    }),
  );

  it.effect.each(["checksum", "truncated", "oversized"] as const)(
    "rejects a %s download before extraction and cleans staging",
    (failure) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          bodySize:
            failure === "truncated"
              ? releases[5].size - 1
              : failure === "oversized"
                ? releases[5].size + 1
                : releases[5].size,
        });
        const error = yield* fixture.acquire().pipe(Effect.flip);
        assert.equal(error._tag, "ManagedPiRuntimeError");
        assert.equal(error.stage, "integrity");
        assert.equal(error.message, "Could not prepare the pinned Pi runtime.");
        assert.isEmpty(fixture.launches);
        assert.isFalse(yield* fixture.fs.exists(fixture.runtimeDir));
        assert.isEmpty(yield* fixture.fs.readDirectory(fixture.runtimeParent));
      }),
  );

  it.effect.each([
    { version: "1.5.1\n", versionExitCode: 0 },
    { version: "pi 1.5.0 extra\n", versionExitCode: 0 },
    { version: "pi 1.5.0\n", versionExitCode: 1 },
  ])("does not publish an invalid version probe: $version / $versionExitCode", (probe) =>
    Effect.gen(function* () {
      using _digest = vi
        .spyOn(NodeCrypto.Hash.prototype, "digest")
        .mockReturnValue(releases[5].sha256);
      const fixture = yield* makeFixture(probe);
      const error = yield* fixture.acquire().pipe(Effect.flip);
      assert.equal(error.stage, "version");
      assert.lengthOf(fixture.launches, 2);
      assert.isFalse(yield* fixture.fs.exists(fixture.runtimeDir));
      assert.isEmpty(yield* fixture.fs.readDirectory(fixture.runtimeParent));
    }),
  );

  it.effect.each([
    { platform: "freebsd", arch: "x64" },
    { platform: "linux", arch: "ia32" },
  ] as const)("rejects unsupported $platform-$arch without acquiring anything", (target) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(target);
      const error = yield* fixture.acquire().pipe(Effect.flip);
      assert.equal(error.stage, "platform");
      assert.isEmpty(fixture.requests);
      assert.isEmpty(fixture.launches);
      assert.isFalse(yield* fixture.fs.exists(fixture.runtimeParent));
    }),
  );

  it.effect("does not overwrite an incomplete existing directory", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.fs.makeDirectory(fixture.runtimeDir, { recursive: true });
      const sentinel = fixture.path.join(fixture.runtimeDir, "unverified");
      yield* fixture.fs.writeFileString(sentinel, "keep");
      const error = yield* fixture.acquire().pipe(Effect.flip);
      assert.equal(error.stage, "cache");
      assert.isEmpty(fixture.requests);
      assert.equal(yield* fixture.fs.readFileString(sentinel), "keep");
    }),
  );

  it.effect("concurrent installers publish once and reuse the verified winner", () =>
    Effect.gen(function* () {
      using _digest = vi
        .spyOn(NodeCrypto.Hash.prototype, "digest")
        .mockReturnValue(releases[5].sha256);
      const fixture = yield* makeFixture({ concurrent: true, version: "pi 1.5.0\n" });
      const [first, second] = yield* Effect.all(
        [fixture.acquire("first"), fixture.acquire("second")],
        { concurrency: "unbounded" },
      );
      assert.equal(first.binaryPath, second.binaryPath);
      assert.notEqual(
        first.environment.PI_CODING_AGENT_DIR,
        second.environment.PI_CODING_AGENT_DIR,
      );
      assert.lengthOf(fixture.requests, 2);
      assert.lengthOf(fixture.launches, 4);
      const extractionDirectories = fixture.launches
        .filter((launch) => !launch.args.includes("--version"))
        .map((launch) => launch.args[3]);
      assert.notEqual(extractionDirectories[0], extractionDirectories[1]);
      assert.deepEqual(yield* fixture.fs.readDirectory(fixture.runtimeParent), ["win32-x64"]);
      assert.equal(
        yield* fixture.fs.readFileString(
          fixture.path.join(fixture.runtimeDir, "assets", "fixture"),
        ),
        "complete archive",
      );
      yield* fixture.acquire("third");
      assert.lengthOf(fixture.requests, 2);
    }),
  );
});
