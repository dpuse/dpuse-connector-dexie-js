# DPUse Dexie.js Connector

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## Introduction

A TypeScript library that implements the Dexie.js connector.

## Installation

There’s no need to install this connector manually. Once released, it’s uploaded to the Data Positioning Engine cloud and becomes instantly available to all new instances of the browser app. A notification about the new version is also sent to all existing browser apps.

## Repository Management Commands

The following list details the repository management commands implementation by this project. For more details, please refer to the scripts section of the 'package.json' file in this project.

| Name           | VSCode Shortcuts | Notes                                                                                                           |
| -------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| audit          | alt+ctrl+shift+a | Audit the project's dependencies for known security vulnerabilities.                                            |
| build          | alt+ctrl+shift+b | Type-check, compile and minify for production. Output in '/dist' directory.                                     |
| check          | alt+ctrl+shift+c | List the dependencies in the project that are outdated.                                                         |
| document       | alt+ctrl+shift+d | Identify the licenses of the project's dependencies.                                                            |
| document       | alt+ctrl+shift+f | Enforce formatting style rules.                                                                                 |
| lint           | alt+ctrl+shift+l | Check the code for potential errors and enforces coding styles.                                                 |
| release        | alt+ctrl+shift+r | Synchronise local repository with the main GitHub repository and upload connector to Data Positioning platform. |
| syncWithGitHub | alt+ctrl+shift+s | Synchronise local repository with the main GitHub repository.                                                   |
| update         | alt+ctrl+shift+l | Install the latest version of Data Positioning dependencies.                                                    |

## Compliance

The following badge reflects FOSSA's assessment of this repository's open-source license compliance.

<!-- DEPENDENCY_LICENSES_START -->

| Dependency                                                   | Version | License(s) | Document                                                              |
| :----------------------------------------------------------- | :-----: | :--------- | :-------------------------------------------------------------------- |
| [@dpuse/dpuse-shared](https://github.com/dpuse/dpuse-shared) | 0.3.719 | MIT        | [LICENSE](licenses/downloads/@dpuse/dpuse-shared@0.3.719-LICENSE.txt) |
| [dexie](https://github.com/dexie/Dexie.js)                   |  4.4.4  | Apache-2.0 | [LICENSE](licenses/downloads/dexie@4.4.4-LICENSE.txt)                 |

<!-- DEPENDENCY_LICENSES_END -->

<!-- DEPENDENCY_TREE_START -->

- **[@dpuse/dpuse-shared](https://github.com/dpuse/dpuse-shared)** 0.3.719 — this month: 2026-06-29
- **[dexie](https://github.com/dexie/Dexie.js)** 4.4.4 — this month: 2026-06-16

<!-- DEPENDENCY_TREE_END -->

<!-- BUNDLE_START -->

| Chunk/Module/File                                                            | Composition                        |
| :--------------------------------------------------------------------------- | :--------------------------------- |
| dpuse-connector-dexie-js.es.js                                               | 139.6 kB · gz 37.9 kB · br 32.7 kB |
| &nbsp;&nbsp;&nbsp;&nbsp;dexie                                                | `██████████████████░░` 89.4%       |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;dist/dexie.min.js            | `██████████████████░░` 89.0%       |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;import-wrapper-prod.mjs      | `░░░░░░░░░░░░░░░░░░░░` 0.4%        |
| &nbsp;&nbsp;&nbsp;&nbsp;src                                                  | `██░░░░░░░░░░░░░░░░░░` 9.3%        |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;index.ts                     | `█░░░░░░░░░░░░░░░░░░░` 4.9%        |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;config.json                  | `█░░░░░░░░░░░░░░░░░░░` 4.4%        |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;package.json                 | `░░░░░░░░░░░░░░░░░░░░` 0.0%        |
| &nbsp;&nbsp;&nbsp;&nbsp;(runtime) → rolldown/runtime.js                      | `░░░░░░░░░░░░░░░░░░░░` 0.8%        |
| &nbsp;&nbsp;&nbsp;&nbsp;@dpuse/dpuse-shared → dist/dpuse-shared-errors.es.js | `░░░░░░░░░░░░░░░░░░░░` 0.5%        |

<!-- BUNDLE_END -->

## License

[MIT](./LICENSE) © 2026 Data Positioning Pty Ltd
