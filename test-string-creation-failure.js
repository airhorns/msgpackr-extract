// Regression test: extractStrings must not emit garbage entries when napi_create_string_* fails.
//
// When V8 string allocation fails, napi_create_string_latin1/utf8 return a non-ok status and do
// NOT write the out value. If those statuses are ignored, an uninitialized napi_value (in
// practice: a stale handle, often a string from a *previous* extraction) is pushed into the
// result array. msgpackr then consumes that entry blindly and silently mis-slices every
// subsequent string in the bundled-string block out of the source buffer — corrupting decoded
// data without any error (observed in production as length-preserving neighbor-byte strings).
//
// This test uses the MSGPACKR_EXTRACT_TEST_FAIL_MARKER hook (read at module init) to
// deterministically simulate the allocation failure for strings starting with a marker, and
// asserts that every returned entry is a real string drawn from the source buffer.
//
// Run: node test-string-creation-failure.js   (re-spawns itself with the env var set)

"use strict";
const assert = require("assert");

const MARKER = "XFAILX";

// hand-encode a msgpack-shaped byte sequence: fixstr tokens separated by bin8 blobs
// (gap > 40 bytes prevents string-block bundling across groups, giving multiple entries)
function fixstr(s) {
	return Buffer.concat([Buffer.from([0xa0 + s.length]), Buffer.from(s, "latin1")]);
}
function bin8(n) {
	return Buffer.concat([Buffer.from([0xc4, n]), Buffer.alloc(n, 0x2e)]);
}
function build(parts) {
	const buf = Buffer.concat(parts);
	// standalone ArrayBuffer (no pool offset)
	const u8 = new Uint8Array(buf.length);
	u8.set(buf);
	return u8;
}

function entriesOf(result) {
	return Array.isArray(result) ? result : [result];
}

function assertEntriesComeFromBuffer(entries, u8, label) {
	const latin1 = Buffer.from(u8).toString("latin1");
	for (const entry of entries) {
		assert.strictEqual(typeof entry, "string", `${label}: entry is not a string: ${String(entry).slice(0, 60)} (${typeof entry})`);
		assert.ok(latin1.includes(entry), `${label}: entry is not content from the source buffer (stale/garbage): ${JSON.stringify(entry.slice(0, 60))}`);
	}
}

const { extractStrings } = require("./index.js");
assert.strictEqual(typeof extractStrings, "function", "native addon not built? run: npm run recompile");

if (!process.env.MSGPACKR_EXTRACT_TEST_FAIL_MARKER) {
	// ---- parent: sanity without the hook, then re-run self with the failure hook enabled ----
	const u8 = build([fixstr("alpha"), fixstr("bravo"), bin8(50), fixstr("delta"), fixstr("echo")]);
	const entries = entriesOf(extractStrings(0, u8.length, u8.buffer));
	assert.ok(entries.length >= 2, "sanity: expected at least two entries");
	assertEntriesComeFromBuffer(entries, u8, "sanity");

	const { spawnSync } = require("child_process");
	const child = spawnSync(process.execPath, [__filename], {
		env: { ...process.env, MSGPACKR_EXTRACT_TEST_FAIL_MARKER: MARKER },
		stdio: "inherit",
	});
	if (child.status !== 0) {
		console.error(`\nstring-creation-failure regression test FAILED (exit ${child.status}, signal ${child.signal})`);
		process.exit(1);
	}
	console.log("string-creation-failure regression test passed");
	process.exit(0);
}

// ---- child: the failure hook is active for strings starting with MARKER ----

// seed the native stack with distinctive strings from a *previous* extraction, so a stale
// uninitialized napi_value is detectable as content that is not part of the next buffer
const primer = build([fixstr("PRIMER_ONE_AAAA"), fixstr("PRIMER_TWO_BBBB")]);
entriesOf(extractStrings(0, primer.length, primer.buffer));

// case 1: the failing string is at the end — a correct implementation returns the earlier,
// successfully-created entries (partial batch) and nothing containing garbage
const u8 = build([
	fixstr("alpha"),
	fixstr("bravo"),
	bin8(50),
	fixstr("delta"),
	fixstr("echo"),
	bin8(50),
	fixstr(MARKER + "boom"),
	fixstr("tail"),
]);
const entries = entriesOf(extractStrings(0, u8.length, u8.buffer));
assertEntriesComeFromBuffer(entries, u8, "partial-batch");
for (const entry of entries) {
	assert.ok(!entry.includes(MARKER), `partial-batch: marker string must not be present, got ${JSON.stringify(entry)}`);
}
assert.ok(
	entries.some((e) => e.includes("alpha")) && entries.some((e) => e.includes("delta")),
	"partial-batch: entries before the failure must be returned"
);

// case 2: the failing string is the *first* string scanned — there is nothing valid to return.
// A correct implementation either throws a real error or returns a clean (possibly empty)
// result; it must never hand back an uninitialized value.
const latin1 = Buffer.from(u8).toString("latin1");
const markerHeader = latin1.indexOf(MARKER) - 1;
assert.ok(markerHeader > 0, "test bug: marker not found");
let threw = false;
let result;
try {
	result = entriesOf(extractStrings(markerHeader, u8.length, u8.buffer));
} catch (err) {
	threw = true; // loud failure is acceptable
	assert.ok(err instanceof Error, "first-string-failure: thrown value must be an Error");
}
if (!threw) {
	assertEntriesComeFromBuffer(result.filter((e) => e !== undefined), u8, "first-string-failure");
	assert.ok(
		result.every((e) => e !== undefined && typeof e === "string" && !e.includes(MARKER)),
		`first-string-failure: silent garbage returned: ${JSON.stringify(result.map((e) => String(e).slice(0, 40)))}`
	);
}

console.log("child assertions passed (hook active)");
process.exit(0);
