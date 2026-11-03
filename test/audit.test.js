"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { reviewAudit } = require("../script/check-audit");

function fixture() {
  const advisory = {
    source: 1244012,
    name: "minimatch",
    dependency: "minimatch",
    url: "https://github.com/advisories/GHSA-g3hv-75wg-m249",
    severity: "moderate",
    range: "<11.0.1",
  };
  const lockfile = { lockfileVersion: 3, packages: {} };
  for (const [name, version] of Object.entries({
    "@eslint-community/eslint-utils": "4.10.1",
    "@eslint/js": "10.0.1",
    "eslint-compat-utils": "0.5.1",
    "eslint-config-prettier": "10.1.8",
    "eslint-plugin-es-x": "7.8.0",
    "eslint-plugin-n": "18.5.0",
  }))
    lockfile.packages[`node_modules/${name}`] = { version, dev: true };
  const vulnerabilities = {};
  for (const [name, version, via] of [
    ["eslint", "10.13.0", ["@eslint/config-array"]],
    ["@eslint/config-array", "0.23.5", ["minimatch"]],
    ["minimatch", "10.2.6", [advisory]],
  ]) {
    const node = `node_modules/${name}`;
    lockfile.packages[node] = { version, dev: true };
    vulnerabilities[name] = { name, severity: "moderate", nodes: [node], via };
  }
  const report = {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 3, high: 0, critical: 0, total: 3 } },
  };
  return { report, lockfile };
}

test("accepts a complete audit with no findings", () => {
  const { report, lockfile } = fixture();
  report.vulnerabilities = {};
  report.metadata.vulnerabilities.moderate = 0;
  report.metadata.vulnerabilities.total = 0;
  lockfile.packages = {};
  assert.equal(reviewAudit(report, lockfile), 0);
});

test("accepts only the reviewed dev-only advisory chain, including peer cycles", () => {
  const { report, lockfile } = fixture();
  assert.equal(reviewAudit(report, lockfile), 3);
  report.vulnerabilities["@eslint/config-array"].via.push("eslint");
  assert.equal(reviewAudit(report, lockfile), 3);
});

test("retains the moderate threshold for unrelated low-severity findings", () => {
  const { report, lockfile } = fixture();
  report.vulnerabilities = { minimatch: report.vulnerabilities.minimatch };
  const entry = report.vulnerabilities.minimatch;
  entry.severity = entry.via[0].severity = "low";
  entry.via[0].url = "https://github.com/advisories/unrelated";
  report.metadata.vulnerabilities.moderate = 0;
  report.metadata.vulnerabilities.low = 1;
  report.metadata.vulnerabilities.total = 1;
  assert.equal(reviewAudit(report, lockfile), 0);
});

for (const [name, change, expected] of [
  [
    "a new high-severity finding",
    ({ report, lockfile }) => {
      lockfile.packages["node_modules/other"] = { version: "1.0.0", dev: true };
      report.vulnerabilities.other = {
        name: "other",
        severity: "high",
        nodes: ["node_modules/other"],
        via: [
          {
            ...report.vulnerabilities.minimatch.via[0],
            name: "other",
            dependency: "other",
            severity: "high",
          },
        ],
      };
      report.metadata.vulnerabilities.high = 1;
      report.metadata.vulnerabilities.total++;
    },
    /Unaccepted audit finding/,
  ],
  [
    "a new advisory",
    ({ report }) => {
      report.vulnerabilities.minimatch.via[0].url += "-new";
    },
    /Unaccepted advisory/,
  ],
  [
    "a runtime dependency",
    ({ lockfile }) => {
      delete lockfile.packages["node_modules/minimatch"].dev;
    },
    /Unreviewed audit exception dependency/,
  ],
  [
    "a changed caller version",
    ({ lockfile }) => {
      lockfile.packages["node_modules/eslint"].version = "10.14.0";
    },
    /Unreviewed audit exception dependency/,
  ],
  [
    "a changed config-array version",
    ({ lockfile }) => {
      lockfile.packages["node_modules/@eslint/config-array"].version = "0.24.0";
    },
    /Unreviewed audit exception dependency/,
  ],
  [
    "a changed minimatch version",
    ({ lockfile }) => {
      lockfile.packages["node_modules/minimatch"].version = "11.0.0";
    },
    /Unreviewed audit exception dependency/,
  ],
  [
    "a changed plugin version",
    ({ lockfile }) => {
      lockfile.packages["node_modules/eslint-plugin-n"].version = "18.6.0";
    },
    /Unreviewed audit exception dependency/,
  ],
  [
    "a missing cause",
    ({ report }) => {
      report.vulnerabilities.eslint.via.push("missing");
    },
    /Malformed or unresolved audit cause/,
  ],
  [
    "an incomplete report",
    ({ report }) => {
      delete report.metadata;
    },
    /Incomplete or unsupported/,
  ],
  [
    "an audit service error",
    ({ report }) => {
      report.error = { code: "ENOTFOUND" };
    },
    /Incomplete or unsupported/,
  ],
  [
    "incorrect summary counts",
    ({ report }) => {
      report.metadata.vulnerabilities.moderate++;
    },
    /Incorrect audit count/,
  ],
  [
    "a malformed cause",
    ({ report }) => {
      report.vulnerabilities.minimatch.via = [null];
    },
    /Malformed or unresolved audit cause/,
  ],
  [
    "a missing lockfile node",
    ({ lockfile }) => {
      delete lockfile.packages["node_modules/eslint"];
    },
    /Malformed audit finding/,
  ],
  [
    "an unrelated cause cycle",
    ({ report }) => {
      report.vulnerabilities.eslint.via = ["@eslint/config-array"];
      report.vulnerabilities["@eslint/config-array"].via = ["eslint"];
    },
    /Unresolved audit cause cycle/,
  ],
]) {
  test(`rejects ${name}`, () => {
    const data = fixture();
    change(data);
    assert.throws(() => reviewAudit(data.report, data.lockfile), expected);
  });
}
