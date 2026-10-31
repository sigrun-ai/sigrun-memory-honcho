# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Repo scaffold (family layout) and settings/secret resolution:
  `resolveSettings` (eleven keys with defaults and numeric validation)
  and `resolveApiKey` (stored `api-key` secret, then env
  `SIGRUN_EXT_MEMORY_HONCHO_API_KEY`).
