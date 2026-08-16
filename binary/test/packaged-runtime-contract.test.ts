import * as fs from "node:fs";
import * as path from "node:path";

type PackageJson = {
  devDependencies?: Record<string, string>;
  pkg?: {
    assets?: string[];
    targets?: string[];
  };
};

type LockPackage = {
  version?: string;
  devDependencies?: Record<string, string>;
};

type PackageLock = {
  lockfileVersion?: number;
  requires?: boolean;
  packages?: Record<string, LockPackage>;
};

const BINARY_ROOT = path.resolve(__dirname, "..");
const EXPECTED_PKG_VERSION = "6.21.0";
const EXPECTED_PKG_FETCH_VERSION = "3.6.4";
const EXPECTED_TARGET_LANCEDB_ASSET = "../../node_modules/@lancedb/**/*";

const EXPECTED_TARGETS: Record<string, string> = {
  "package.json": "node24-darwin-arm64",
  "pkgJson/darwin-arm64/package.json": "node24-macos-arm64",
  "pkgJson/darwin-x64/package.json": "node24-macos-x64",
  "pkgJson/linux-arm64/package.json": "node24-linux-arm64",
  "pkgJson/linux-x64/package.json": "node24-linux-x64",
  "pkgJson/win32-arm64/package.json": "node24-win-arm64",
  "pkgJson/win32-x64/package.json": "node24-win-x64",
};

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(BINARY_ROOT, relativePath), "utf8"),
  ) as T;
}

function formatDependency(name: string, version: string | undefined) {
  if (!version) {
    return `${name}@<missing>`;
  }
  return `${name}@${version.replace(/^[~^]/, "")}`;
}

function pushTargetViolations(
  failures: string[],
  relativePath: string,
  manifest: PackageJson,
) {
  const targets = manifest.pkg?.targets;
  const expectedTarget = EXPECTED_TARGETS[relativePath];

  if (!Array.isArray(targets)) {
    failures.push(`${relativePath} pkg.targets is missing or not an array`);
    return;
  }

  if (targets.length !== 1) {
    failures.push(
      `${relativePath} must declare exactly one pkg target; found ${JSON.stringify(
        targets,
      )}`,
    );
  }

  const actualTarget = targets[0];
  if (actualTarget !== expectedTarget) {
    failures.push(
      `${relativePath} target is ${actualTarget ?? "<missing>"}; expected ${expectedTarget}`,
    );
  }

  if (/^node(?:18|20)-/.test(actualTarget ?? "")) {
    failures.push(`${relativePath} still uses legacy ${actualTarget}`);
  }

  if (
    relativePath !== "package.json" &&
    !manifest.pkg?.assets?.includes(EXPECTED_TARGET_LANCEDB_ASSET)
  ) {
    failures.push(
      `${relativePath} pkg.assets must contain ${EXPECTED_TARGET_LANCEDB_ASSET}`,
    );
  }
}

describe("packaged runtime contract", () => {
  it("uses the approved packager, lock graph, and Node 24 target manifests", () => {
    const failures: string[] = [];
    const packageJson = readJson<PackageJson>("package.json");
    const lockfile = readJson<PackageLock>("package-lock.json");
    const rootDevDependencies = packageJson.devDependencies ?? {};
    const lockPackages = lockfile.packages ?? {};
    const lockRootDevDependencies = lockPackages[""]?.devDependencies ?? {};
    const scopedPkg = lockPackages["node_modules/@yao-pkg/pkg"];
    const scopedPkgFetch = lockPackages["node_modules/@yao-pkg/pkg-fetch"];
    const legacyLockNodes = Object.keys(lockPackages).filter((key) =>
      /(^|\/)node_modules\/(pkg|pkg-fetch)$/.test(key),
    );

    if (rootDevDependencies.pkg !== undefined) {
      failures.push(
        `devDependencies still contains legacy ${formatDependency(
          "pkg",
          rootDevDependencies.pkg,
        )}`,
      );
    }
    if (rootDevDependencies["@yao-pkg/pkg"] !== EXPECTED_PKG_VERSION) {
      failures.push(
        `devDependencies must contain @yao-pkg/pkg@${EXPECTED_PKG_VERSION}; found ${formatDependency(
          "@yao-pkg/pkg",
          rootDevDependencies["@yao-pkg/pkg"],
        )}`,
      );
    }

    if (lockRootDevDependencies.pkg !== undefined) {
      failures.push(
        `lockfile root still contains legacy ${formatDependency(
          "pkg",
          lockRootDevDependencies.pkg,
        )}`,
      );
    }
    if (lockRootDevDependencies["@yao-pkg/pkg"] !== EXPECTED_PKG_VERSION) {
      failures.push(
        `lockfile root must contain @yao-pkg/pkg@${EXPECTED_PKG_VERSION}; found ${formatDependency(
          "@yao-pkg/pkg",
          lockRootDevDependencies["@yao-pkg/pkg"],
        )}`,
      );
    }
    if (
      lockRootDevDependencies["@yao-pkg/pkg"] !==
      rootDevDependencies["@yao-pkg/pkg"]
    ) {
      failures.push(
        'lockfile root packages[""].devDependencies does not agree with package.json for @yao-pkg/pkg',
      );
    }

    if (scopedPkg?.version !== EXPECTED_PKG_VERSION) {
      failures.push(
        `lockfile is missing @yao-pkg/pkg@${EXPECTED_PKG_VERSION}; found ${formatDependency(
          "@yao-pkg/pkg",
          scopedPkg?.version,
        )}`,
      );
    }
    if (scopedPkgFetch?.version !== EXPECTED_PKG_FETCH_VERSION) {
      failures.push(
        `lockfile is missing @yao-pkg/pkg-fetch@${EXPECTED_PKG_FETCH_VERSION}; found ${formatDependency(
          "@yao-pkg/pkg-fetch",
          scopedPkgFetch?.version,
        )}`,
      );
    }
    if (legacyLockNodes.length > 0) {
      failures.push(`legacy lock nodes remain: ${legacyLockNodes.join(", ")}`);
    }

    for (const [relativePath, expectedTarget] of Object.entries(
      EXPECTED_TARGETS,
    )) {
      expect(expectedTarget.startsWith("node24-")).toBe(true);
      pushTargetViolations(
        failures,
        relativePath,
        readJson<PackageJson>(relativePath),
      );
    }

    if (failures.length > 0) {
      throw new Error(
        `Packaged runtime contract violations:\n- ${failures.join("\n- ")}`,
      );
    }
  });
});
