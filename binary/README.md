# Continue Core Binary

The purpose of this folder is to package Typescript code in a way that can be run from any IDE or platform. We first bundle with `esbuild` and then package into binaries with `pkg`.

The `pkgJson/package.json` contains instructions for building with pkg, and needs to be in a separte folder because there is no CLI flag for the assets option (it must be in a package.json), and pkg doesn't recognize any name other than package.json, but if we use the same package.json with dependencies in it, pkg will automatically include these, significantly increasing the binary size.

The build process is otherwise defined entirely in `build.js`.

### List of native modules

- sqlite3/build/Release/node_sqlite3.node (\*)
- @lancedb/\*\*
- esbuild?
- @esbuild?
- onnxruntime-node?

### List of dynamically imported modules

- @octokit/rest
- esbuild

### List of .wasm files

- tree-sitter.wasm
- tree-sitter-wasms/

(\*) = need to download for each platform manually

## Debugging

To debug the binary with IntelliJ, set `useTcp` to `true` in `CoreMessenger.kt`, and then in VS Code run the "Core Binary" debug script. Instead of starting a subprocess for the binary and communicating over stdin/stdout, the IntelliJ extension will connect over TCP to the server started from the VS Code window. You can place breakpoints anywhere in the `core` or `binary` folders.

## Building

### Runtime and packaging contract

The repository host, packaging host, and embedded runtime are separate
contracts:

| Contract            | Current local candidate                  | Used for                                                                  |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| Repository host     | Node.js `20.20.1`, selected by `.nvmrc`  | Repository preparation and the package/Core/gui/VS Code build phases      |
| Packaging host      | Node.js `24.18.0` with npm `11.16.0`     | `binary` install, type check, contract test, package build, and test host |
| Packaged executable | Embedded Node.js `v24.18.0`, proved live | Running the produced `continue-binary` without a system Node.js runtime   |

The packaging dependency contract is exact:

- `binary/package.json` directly pins `@yao-pkg/pkg@6.21.0`.
- `binary/package-lock.json` must resolve that package to
  `@yao-pkg/pkg-fetch@3.6.4`, with both lockfile integrity values unchanged.
- Every root or platform package manifest must declare exactly one `node24-*`
  target. Legacy `node18-*` and `node20-*` targets are contract failures.
- Packaging uses the Standard-mode flags in `utils/bundle-binary.js`:
  `--no-bytecode --public-packages "*" --public --compress GZip`.

The packaging host and embedded runtime happen to use the same Node.js version
in the current candidate, but one does not prove the other. Record the
packaging-host Node.js and npm versions separately from the executable's live
`process.version`. Also bind each artifact to the exact selected pkg-fetch
base binary and its SHA-256 digest; a manifest target string alone is not
runtime evidence.

Node.js `24.18.0` is the accepted release and maintenance baseline for this
`6.21.0`/`3.6.4` tuple. Node `24.18.0`, its bundled Undici `7.28.0`, and the
direct npm dependency `undici@7.27.2` remain version-affected and must not be
described as patched. The bounded risk decision is based on the documented
first-party reachability assessment and remains subject to its reassessment
triggers.

Acceptance of this maintained baseline does not replace release validation.
Every produced target still requires source-, artifact-, hash-, and
architecture-bound native evidence through G4, followed by the remaining
publication gates.

### Target contract

`utils/targets.js` `ALL_TARGETS`, not the root manifest's default pkg target,
is the source of truth for an unqualified build:

| Configuration                        | Exact `pkg.targets` value | Produced by `npm run build`  | Native acceptance required |
| ------------------------------------ | ------------------------- | ---------------------------- | -------------------------- |
| Root `package.json` default metadata | `node24-darwin-arm64`     | No                           | No                         |
| `pkgJson/darwin-arm64/package.json`  | `node24-macos-arm64`      | Yes                          | macOS arm64                |
| `pkgJson/darwin-x64/package.json`    | `node24-macos-x64`        | Yes                          | macOS x64                  |
| `pkgJson/linux-arm64/package.json`   | `node24-linux-arm64`      | Yes                          | Linux arm64                |
| `pkgJson/linux-x64/package.json`     | `node24-linux-x64`        | Yes                          | Linux x64                  |
| `pkgJson/win32-arm64/package.json`   | `node24-win-arm64`        | No; checked-in contract only | No                         |
| `pkgJson/win32-x64/package.json`     | `node24-win-x64`          | Yes                          | Windows x64                |

The checked-in Windows arm64 manifest must continue to pass the manifest
contract, but Windows arm64 is not currently a produced or supported shipping
target. Adding it to `ALL_TARGETS` requires a separate support decision and
matching native evidence.

Every produced target must include the core executable, ripgrep, the matching
LanceDB native module, and SQLite's `node_sqlite3.node`. Cross-packaging proves
only that the bundle can be produced. It does not replace execution on a
matching native host.

### Focused commands

On a fresh checkout, prepare the local packages and the two dependency trees
consumed by `binary/build.js` with the repository-host toolchain:

```bash
node scripts/build-packages.js
npm --prefix core ci
npm --prefix extensions/vscode ci
```

The VS Code dependency install is required because the binary build reuses its
native-module copy helper. After that preparation, switch to the packaging-host
toolchain and run these commands from `binary`:

```bash
npm ci --ignore-scripts --no-audit --fund=false
npm run test:packaged-runtime-contract
npx tsc --noEmit
npm run build -- --target <target>
npm run build
npm run test:packaged-runtime
```

`test:packaged-runtime-contract` validates the direct and lock-resolved
packager/fetch dependency graph plus all seven checked-in manifest targets
without building an executable. Use the packaging-host tuple for every command
above. `npm run build -- --target <target>` produces one reviewed target;
`npm run build` without a target produces exactly every entry in `ALL_TARGETS`.

`test:packaged-runtime` must run on the native host matching the selected
bundle and requires a Node 24 test host. It auto-selects
`bin/<process.platform>-<process.arch>`, so copying a differently targeted
bundle into that directory is not valid evidence. A passing result proves more
than startup: it requires protocol readiness, LanceDB and SQLite native-addon
loading, configuration and SQLite creation, execution of the packaged ripgrep
companion, deterministic mock completion, and supported codebase indexing.
The only accepted degraded indexing path is Linux x64 hardware without both
AVX2 and FMA, where the core must emit the actionable indexing-disabled
warning and remain responsive.

### Local build and launch sequence

Use the accepted maintained tuple to exercise the runtime path in this order.
Set `JAVA_HOME` to a JDK 17 installation before the JetBrains phase.
Immediately before `testIntegration`, warn the operator that IntelliJ IDE
Starter may control the desktop.

1. Verify the accepted Node release artifacts and checksums and confirm that
   the maintained packager/fetch route supplies the same embedded runtime for
   every required target.
2. Confirm the pinned package, lockfile, manifests, and recorded base hashes
   match the accepted contract.
3. Run the focused commands above, including the Windows x64 native
   `test:packaged-runtime` pass on the local host.
4. From `extensions/intellij`, run the unchanged unit and integration checks,
   build the plugin, and launch the development IDE:

   ```powershell
   .\gradlew.bat test testIntegration buildPlugin
   .\gradlew.bat runIde
   ```

   On macOS or Linux, use `./gradlew` in place of `.\gradlew.bat`.

5. Record the exact source identity, binary and plugin artifact identities,
   embedded `process.version`, launch command, readiness result, and clean
   shutdown. Launch readiness means the development IDE opens the configured
   `manual-testing-sandbox` project with the Continue plugin loaded, the
   packaged core reaches its proven protocol-ready state without a fatal
   startup diagnostic, and `runIde` exits cleanly after the operator closes
   the IDE.

Local application acceptance does not make the version-affected tuple patched
or satisfy G4. The five-host native matrix, curated commits, a pull request,
push, and release remain separate publication-grade work.

### Native validation and retained diagnostics

Release-level validation must use one unchanged source revision and one
artifact manifest across all five produced targets:

| Target         | Required native host | Required result                                                               |
| -------------- | -------------------- | ----------------------------------------------------------------------------- |
| `win32-x64`    | Windows x64          | Full packaged-runtime capability pass                                         |
| `linux-x64`    | Linux x64            | Full pass, or only the accepted missing-AVX2/FMA degraded path                |
| `linux-arm64`  | Linux arm64          | Full packaged-runtime capability pass                                         |
| `darwin-x64`   | macOS x64            | Full pass plus execute-permission, quarantine, and signing-state observations |
| `darwin-arm64` | macOS arm64          | Full pass plus execute-permission, quarantine, and signing-state observations |

For each cell, bind the source revision, artifact-manifest digest, manifest
target, selected-base digest, bundle and companion digests, runner or host
identity, test-host `process.platform`/`process.arch`, and an OS-native
architecture check. QEMU, emulation, a cross-build, an allowed failure, a
skip, or startup-only evidence is not native acceptance.

Run every install, build, contract, and packaged-runtime command through a
bounded process and keep its public-safe diagnostics whether it passes, fails,
or times out. A command record must include:

- source revision and artifact identity;
- selected target and native host;
- executable path and argument array;
- start time, elapsed time, configured timeout, and timeout state;
- spawn/process error plus exit code, close code, and signal state;
- complete captured stdout and stderr;
- structured capability result, when the command reaches that stage; and
- paths and digests for related diagnostic files.

Create a new, previously absent evidence directory for each attempt. Preserve
the failed directory unchanged before retrying, write the retry to a different
directory, and retain both the failure and the final passing record. Do not
turn a timeout, missing close event, partial capability result, skipped cell,
or overwritten log into a pass.

## Testing

```bash
npm run test
```
