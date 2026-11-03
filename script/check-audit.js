"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ADVISORY = "https://github.com/advisories/GHSA-g3hv-75wg-m249";
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const REVIEWED_VERSIONS = {
  "@eslint-community/eslint-utils": "4.10.1",
  "@eslint/js": "10.0.1",
  eslint: "10.13.0",
  "@eslint/config-array": "0.23.5",
  "eslint-compat-utils": "0.5.1",
  "eslint-config-prettier": "10.1.8",
  "eslint-plugin-es-x": "7.8.0",
  "eslint-plugin-n": "18.5.0",
  minimatch: "10.2.6",
};

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reviewAudit(report, lockfile) {
  requireCondition(
    object(report) &&
      !Object.hasOwn(report, "error") &&
      report.auditReportVersion === 2 &&
      object(report.vulnerabilities) &&
      object(report.metadata?.vulnerabilities) &&
      lockfile?.lockfileVersion === 3 &&
      object(lockfile.packages),
    "Incomplete or unsupported npm audit report or lockfile",
  );
  const findings = report.vulnerabilities;
  const totals = report.metadata.vulnerabilities;
  for (const severity of SEVERITIES) {
    const count = Object.values(findings).filter((entry) => entry?.severity === severity).length;
    requireCondition(totals[severity] === count, `Incorrect audit count for ${severity}`);
  }
  requireCondition(totals.total === Object.keys(findings).length, "Incorrect audit total");
  for (const [name, entry] of Object.entries(findings)) {
    requireCondition(
      object(entry) &&
        entry.name === name &&
        SEVERITIES.includes(entry.severity) &&
        Array.isArray(entry.nodes) &&
        entry.nodes.length > 0 &&
        entry.nodes.every((node) => typeof node === "string" && object(lockfile.packages[node])) &&
        Array.isArray(entry.via) &&
        entry.via.length > 0,
      `Malformed audit finding: ${name}`,
    );
    for (const via of entry.via) {
      requireCondition(
        typeof via === "string"
          ? Object.hasOwn(findings, via)
          : object(via) &&
              Number.isInteger(via.source) &&
              typeof via.name === "string" &&
              typeof via.dependency === "string" &&
              typeof via.url === "string" &&
              typeof via.range === "string" &&
              SEVERITIES.includes(via.severity),
        `Malformed or unresolved audit cause: ${name}`,
      );
    }
  }

  const blocking = Object.keys(findings).filter(
    (name) => SEVERITIES.indexOf(findings[name].severity) >= 2,
  );
  if (blocking.length === 0) return 0;

  // The advisory requires optimizationLevel >= 2. In these reviewed versions,
  // ESLint's two Minimatch constructors pass only {dot:true}; config-array's
  // sole constructor adds at most {flipNegate:true}. Both use the safe default
  // optimizationLevel=1, so the vulnerable firstPhasePreProcess is unreachable.
  // Re-review this exception whenever either caller or minimatch changes.
  for (const [name, version] of Object.entries(REVIEWED_VERSIONS)) {
    const entry = lockfile.packages[`node_modules/${name}`];
    requireCondition(
      entry?.version === version && entry.dev === true,
      `Unreviewed audit exception dependency: ${name}`,
    );
  }

  const reviewed = new Set();
  const pending = [...blocking];
  while (pending.length) {
    const name = pending.pop();
    if (reviewed.has(name)) continue;
    reviewed.add(name);
    const entry = findings[name];
    requireCondition(
      Object.hasOwn(REVIEWED_VERSIONS, name) &&
        entry.severity === "moderate" &&
        entry.nodes.every(
          (node) => node === `node_modules/${name}` && lockfile.packages[node].dev === true,
        ),
      `Unaccepted audit finding: ${name}`,
    );
    for (const via of entry.via) {
      if (typeof via === "string") pending.push(via);
      else {
        requireCondition(
          name === "minimatch" &&
            via.name === "minimatch" &&
            via.dependency === "minimatch" &&
            via.url === ADVISORY &&
            via.severity === "moderate" &&
            via.range === "<11.0.1",
          `Unaccepted advisory: ${via.url}`,
        );
      }
    }
  }

  // Every affected node must reach the reviewed advisory. Checking each node
  // separately handles peer-dependency cycles without accepting unrelated ones.
  for (const name of reviewed) {
    const seen = new Set();
    const queue = [name];
    let reachesAdvisory = false;
    while (queue.length) {
      const current = queue.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const via of findings[current].via) {
        if (typeof via === "string") queue.push(via);
        else reachesAdvisory = true;
      }
    }
    requireCondition(reachesAdvisory, `Unresolved audit cause cycle: ${name}`);
  }
  return blocking.length;
}

function main() {
  const root = path.join(__dirname, "..");
  // The fixed command works with npm.cmd on Windows as well as POSIX npm.
  const result = spawnSync("npm audit --json --audit-level=moderate", {
    cwd: root,
    encoding: "utf8",
    shell: true,
  });
  // Keep the complete registry report visible, including accepted findings.
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.error) throw result.error;
  requireCondition(result.status === 0 || result.status === 1, "npm audit failed to complete");
  const report = JSON.parse(result.stdout);
  const lockfile = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const accepted = reviewAudit(report, lockfile);
  const counts = report.metadata.vulnerabilities;
  requireCondition(
    result.status === (counts.moderate + counts.high + counts.critical > 0 ? 1 : 0),
    "npm audit exit status disagrees with its report",
  );
  if (accepted) {
    console.log(
      `Reviewed dev-only exception: GHSA-g3hv-75wg-m249 (${accepted} affected packages); ` +
        "optimizationLevel >= 2 is unreachable in the locked ESLint callers.",
    );
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Dependency audit failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { reviewAudit };
