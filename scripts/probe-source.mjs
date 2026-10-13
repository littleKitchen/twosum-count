import { readSourceCount, SOURCE, validCount } from "./collect.mjs";

// Probe the upstream directly every time. Existing hourly history must never
// make this succeed without a fresh source response, and this probe writes none.
try {
  const count = validCount(await readSourceCount());
  console.log(JSON.stringify({ source: SOURCE, capturedAt: new Date().toISOString(), count }));
} catch (error) {
  console.error(`Source probe failed: ${error.message}`);
  process.exitCode = 1;
}
