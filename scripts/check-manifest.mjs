#!/usr/bin/env node
/**
 * Release-manifest hygiene check (release-0.1 Task 3): asserts this
 * package's npm-facing shape — the published name, the peer/dev split
 * for host modules, publish metadata, and the tarball files whitelist.
 *
 * Invoked as `node scripts/check-manifest.mjs` from `npm test` (this
 * repo's manifest contract is part of the gate). Exits nonzero naming
 * every violation.
 *
 * Usage: node scripts/check-manifest.mjs [--expect-name @scope/name]
 * (defaults to this repo's manifest name when --expect-name is absent).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(
	readFileSync(join(repoDir, "package.json"), "utf8"),
);

const args = process.argv.slice(2);
function argValue(flag) {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

const failures = [];
function check(condition, message) {
	if (!condition) failures.push(message);
}

const expectedName = argValue("--expect-name");
const name = expectedName ?? manifest.name;

check(name !== undefined, "package.json: name is absent");
if (expectedName !== undefined) {
	check(
		manifest.name === expectedName,
		`package.json: name is "${manifest.name}", expected "${expectedName}"`,
	);
}

check(manifest.private !== true, "package.json: private:true — this package is published");
check(manifest.license === "MIT", `package.json: license must be "MIT" (got ${JSON.stringify(manifest.license)})`);
check(
	manifest.engines?.node === ">=22.19.0",
	`package.json: engines.node must be ">=22.19.0" (got ${JSON.stringify(manifest.engines?.node)})`,
);
check(
	manifest.publishConfig?.access === "public" && manifest.publishConfig?.provenance === true,
	`package.json: publishConfig must be {"access":"public","provenance":true} (got ${JSON.stringify(manifest.publishConfig)})`,
);
check(Array.isArray(manifest.files) && manifest.files.length > 0, "package.json: files whitelist is absent/empty");
check(
	typeof manifest.repository?.url === "string" && manifest.repository.url.startsWith("git+https://github.com/sigrun-ai/"),
	`package.json: repository.url must point at github.com/sigrun-ai/<repo> (got ${JSON.stringify(manifest.repository?.url)})`,
);
check(typeof manifest.bugs?.url === "string", "package.json: bugs.url absent");
check(typeof manifest.homepage === "string", "package.json: homepage absent");

/** Every host module a sigrun extension/provider imports must be a peer.
 * The @earendil-works host modules ship 1.3.0 with sigrun 0.1.0; peers
 * also accept 1.4.0 (forward-compat). Phase 2 develops against
 * the 1.4.0 host family (DEV_PIN_OVERRIDES below), keeping one
 * type-compatible copy of chord/pi-ai/pi-durable.
 * typebox is pi-ai 1.3.0's own exact dependency (1.3.27) — the
 * host-linked single copy extensions see. */
const HOST_MODULE_PINS = {
	"@earendil-works/pi-durable": "1.3.0",
	"@earendil-works/pi-ai": "1.3.0",
	"@earendil-works/chord": "1.3.0",
	"@earendil-works/pi-codemode": "1.3.0",
	typebox: "1.3.27",
};
/** Phase 2 (core 0.3.0): development happens against pi-durable 1.4.0;
 * the peer keeps the widened "1.3.0 || 1.4.0" acceptance above. */
const DEV_PIN_OVERRIDES = {
	"@earendil-works/chord": "1.4.0",
	"@earendil-works/pi-ai": "1.4.0",
	"@earendil-works/pi-codemode": "1.4.0",
	"@earendil-works/pi-durable": "1.4.0",
};
const PEER_FORWARD_COMPAT = " || 1.4.0";
const peers = manifest.peerDependencies ?? {};
const devDeps = manifest.devDependencies ?? {};
for (const [module, spec] of Object.entries(peers)) {
	check(
		module in HOST_MODULE_PINS,
		`package.json: peerDependencies carries non-host module "${module}"`,
	);
	const pin = HOST_MODULE_PINS[module];
	check(
		spec === pin || (module.startsWith("@earendil-works/") && spec === `${pin}${PEER_FORWARD_COMPAT}`),
		`package.json: peerDependencies["${module}"] must be exact "${pin}" or "${pin}${PEER_FORWARD_COMPAT}" for @earendil-works host modules (got ${JSON.stringify(spec)})`,
	);
	const devPin = DEV_PIN_OVERRIDES[module] ?? pin;
	check(
		devDeps[module] === devPin,
		`package.json: devDependencies["${module}"] must mirror the dev pin at exact "${devPin}" (got ${JSON.stringify(devDeps[module])})`,
	);
}

/** No stray file: specifiers in a published dependencies field. */
for (const field of ["dependencies", "peerDependencies"]) {
	for (const [module, spec] of Object.entries(manifest[field] ?? {})) {
		check(
			!String(spec).startsWith("file:"),
			`package.json: ${field}["${module}"] carries a file: specifier ("${spec}") — published deps must be registry specs`,
		);
	}
}

if (failures.length > 0) {
	console.error(`check-manifest: ${failures.length} violation(s) in ${repoDir}:`);
	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}
	process.exit(1);
}
console.log(`check-manifest: ok (${name})`);