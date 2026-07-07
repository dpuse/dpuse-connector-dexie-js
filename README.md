# DPUse Dexie.js Connector

<!-- OPENING_START -->

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![DPUse version](https://img.shields.io/github/v/release/dpuse/dpuse-connector-dexie-js?color=f6821f&label=DPUse)](https://github.com/dpuse/dpuse-connector-dexie-js/releases/latest)
[![CI](https://github.com/dpuse/dpuse-connector-dexie-js/actions/workflows/ci.yml/badge.svg)](https://github.com/dpuse/dpuse-connector-dexie-js/actions/workflows/ci.yml)
[![CodeQL](https://github.com/dpuse/dpuse-connector-dexie-js/actions/workflows/codeql.yml/badge.svg)](https://github.com/dpuse/dpuse-connector-dexie-js/actions/workflows/codeql.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=dpuse_dpuse-connector-dexie-js&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=dpuse_dpuse-connector-dexie-js)

[Documentation](https://www.dpuse.app) · [Report a Vulnerability](https://github.com/dpuse/dpuse-connector-dexie-js/security/advisories/new) · [Open an Issue](https://github.com/dpuse/dpuse-connector-dexie-js/issues)

## About DPUse

DPUse (Data Positioning & Use) is an in-browser application that positions your data for use through three core activities: sourcing, contextualising, and publishing. **Sourcing** uses a library of [Connectors](https://www.dpuse.app) to establish [Connections](https://www.dpuse.app) to applications, databases, file stores, and curated datasets; these connections are subsequently used to configure structured [Data Views](https://www.dpuse.app) from the underlying sources. **Contextualising** extracts chronological events from those [Data Views](https://www.dpuse.app) and maps them into comprehensive [Context Models](https://www.dpuse.app). This provides the DPUse Engine with the structural framework required to generate deterministic transactions, facts, or observations. **Publishing** employs a library of [Presenters](https://www.dpuse.app) to render standard [Presentations](https://www.dpuse.app) immediately using the contextualised data; additionally, [Cookbooks](https://www.dpuse.app) of [Recipes](https://www.dpuse.app) allow you to build Data Apps using your preferred tools.

## Introduction

Provides access to local Dexie.js (IndexedDB) databases in the browser. It is intended for local-first, offline-capable data storage and supports read/write operations. Each database may optionally be synced with Dexie Cloud, in which case access is governed by that database's own authentication and realm permissions; unsynced databases require no authentication and are scoped to the local device only.

<!-- OPENING_END -->

## Supported Actions

<!-- CONNECTOR_ACTIONS_START -->

Connectors conform to a unified interface contract by implementing a specific subset of standard actions. These standardised actions allow the DPUse application to interact with any underlying data source in the same way, enabling Connectors to be built independently and loaded dynamically at runtime.

This connector is a Bidirectional connector that supports both read and write actions. Connectors can also function as a Source (read-only) or Destination (write-only), depending on the actions they support. The table below lists all connector actions and highlights those supported by this connector.

| Action               | Supported |
| :------------------- | :-------: |
| Abort Operation      |     ✓     |
| Audit Object Content |           |
| Create Object        |     ✓     |
| Describe Connection  |           |
| Drop Object          |     ✓     |
| Find Object          |     ✓     |
| Get Readable Stream  |           |
| Get Record           |     ✓     |
| List Nodes           |     ✓     |
| Preview Object       |     ✓     |
| Remove Records       |     ✓     |
| Retrieve Chunks      |           |
| Retrieve Records     |     ✓     |
| Upsert Records       |     ✓     |

<!-- CONNECTOR_ACTIONS_END -->

## Usage

<!-- USAGE_START -->

This connector is automatically uploaded to the DPUse Engine cloud once released and becomes instantly available to all new browser app instances, with existing instances notified of the update.

You may view or clone this repository for your own purposes, such as building a new, similar connector, though there is currently no process to accept third-party connectors into DPUse at this stage. Cloned or forked code is unsupported and isn't guaranteed to remain compatible with the DPUse Engine as it evolves.

```bash
git clone https://github.com/dpuse/dpuse-connector-dexie-js.git
cd dpuse-connector-dexie-js
npm install
```

_Requires [Node.js](https://nodejs.org/) 22 or later, [npm](https://www.npmjs.com/) 11 or later, and [TypeScript](https://www.typescriptlang.org/) 6 or later._

<!-- USAGE_END -->

## Dependency Licenses

<!-- DEPENDENCY_LICENSES_START -->

License data is collected automatically on each release using [license-checker](https://github.com/RSeidelsohn/license-checker-rseidelsohn). The following table lists all production dependencies. These dependencies (including transitive ones) have been checked and confirmed to use Apache-2.0 or MIT — all permissive, commercially-friendly licenses. Users of the uploaded library are covered by these checks; developers cloning this repository should independently verify development dependencies.

| Dependency                                                   | Version | License(s) | Document                                                              |
| :----------------------------------------------------------- | :-----: | :--------- | :-------------------------------------------------------------------- |
| [@dpuse/dpuse-shared](https://github.com/dpuse/dpuse-shared) | 0.3.737 | MIT        | [LICENSE](licenses/downloads/@dpuse/dpuse-shared@0.3.737-LICENSE.txt) |
| [dexie](https://github.com/dexie/Dexie.js)                   |  4.4.4  | Apache-2.0 | [LICENSE](licenses/downloads/dexie@4.4.4-LICENSE.txt)                 |

<!-- DEPENDENCY_LICENSES_END -->

### Dependency Tree

<!-- DEPENDENCY_TREE_START -->

The dependency tree below lists every package in this project — direct and transitive — along with its installed version, release date, and update status. Packages flagged ❗ have a newer version available; ⚠️ indicates a package that hasn't been updated in the last 6 months or longer. Neither flag necessarily indicates a problem: we let new releases stabilise before upgrading, and some packages are simply mature and stable, requiring no active development.

- **[@dpuse/dpuse-shared](https://github.com/dpuse/dpuse-shared)** 0.3.737 — this month: 2026-07-07
- **[dexie](https://github.com/dexie/Dexie.js)** 4.4.4 — this month: 2026-06-16

<!-- DEPENDENCY_TREE_END -->

## Bundle Analysis

<!-- BUNDLE_START -->

The Bundle Analysis Report is generated automatically on each release using [Sonda](https://sonda.dev/), which analyses final source maps to reveal the actual effects of tree-shaking and minification rather than relying on pre-build estimates.

_Note: Sonda's Vite reports currently exclude CSS files, since Vite does not generate source maps for CSS._

| Chunk/Module/File                                                            | Composition                  |
| :--------------------------------------------------------------------------- | :--------------------------- |
| dist/dpuse-connector-dexie-js.es.js                                          | 139.7 kB · brotli 32.7 kB    |
| &nbsp;&nbsp;&nbsp;&nbsp;dexie                                                | `████████████████░░░░` 79.0% |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;dist/dexie.min.js            | `████████████████░░░░` 78.8% |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;import-wrapper-prod.mjs      | `░░░░░░░░░░░░░░░░░░░░` 0.3%  |
| &nbsp;&nbsp;&nbsp;&nbsp;(unassigned) → [unassigned]                          | `███░░░░░░░░░░░░░░░░░` 17.3% |
| &nbsp;&nbsp;&nbsp;&nbsp;src → index.ts                                       | `█░░░░░░░░░░░░░░░░░░░` 3.5%  |
| &nbsp;&nbsp;&nbsp;&nbsp;@dpuse/dpuse-shared → dist/dpuse-shared-errors.es.js | `░░░░░░░░░░░░░░░░░░░░` 0.2%  |

<!-- BUNDLE_END -->

<!-- GOVERNANCE_START -->

## Security & Quality

### CodeQL

[CodeQL](https://github.com/dpuse/dpuse-connector-dexie-js/security/code-scanning) static analysis runs on every push to `main` and on a weekly schedule, scanning TypeScript, JavaScript, Rust, and GitHub Actions workflow files for security vulnerabilities and coding errors.

### SonarCloud

[SonarCloud](https://sonarcloud.io/summary/new_code?id=dpuse_dpuse-connector-dexie-js) performs continuous code quality and security analysis on every push, detecting bugs, code smells, and security vulnerabilities in the TypeScript source.

### Vulnerability Scanning

Two complementary tools continuously monitor dependencies for known vulnerabilities:

- [npm audit](https://docs.npmjs.com/cli/v8/commands/npm-audit) runs on every push to `main` via the CI workflow, failing the build if any high or critical severity vulnerabilities are detected.
- [GitHub Dependabot](https://docs.github.com/en/code-security/dependabot) automatically raises pull requests to update vulnerable dependencies, drawing on the GitHub Advisory Database which combines NVD and npm-specific advisories.

### Supply Chain Security

[Socket.dev](https://socket.dev) monitors all dependencies for supply chain risk — detecting malicious packages, dependency confusion, typosquatting, and suspicious behaviour that may not yet have a CVE.

### Reporting Vulnerabilities

Please do not open public GitHub issues for security vulnerabilities. Use [GitHub private vulnerability reporting](https://github.com/dpuse/dpuse-connector-dexie-js/security/advisories/new) instead. See [SECURITY.md](./SECURITY.md) for the full disclosure policy, contact details, and expected response times.

### OpenSSF 🚧

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/dpuse/dpuse-connector-dexie-js/badge)](https://scorecard.dev/viewer/?uri=github.com/dpuse/dpuse-connector-dexie-js)

This project is working towards the [OpenSSF Best Practices](https://www.bestpractices.dev) Passing badge, a self-certification covering security policy, vulnerability reporting, build processes, code quality, and more. Currently the [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/dpuse/dpuse-connector-dexie-js) provides an independent automated assessment of the project's security practices and is an ongoing area of improvement.

## Contributing

This repository is maintained solely by its owner and does not, at present, accept external contributions into the canonical repo. Its source is published openly under the MIT License — every DPUse project is fully open source except DPUse Engine, which remains closed and proprietary.

For security vulnerabilities, see [Reporting Vulnerabilities](#reporting-vulnerabilities). For bugs, inconsistencies, or other feedback, [open a GitHub issue](https://github.com/dpuse/dpuse-connector-dexie-js/issues) — feedback is read, but responses and fixes are at the maintainer's discretion.

## License

This project is licensed under the MIT License, permitting free use, modification, and distribution.

[MIT](./LICENSE) © 2026-present Jonathan Terrell

<!-- GOVERNANCE_END -->
