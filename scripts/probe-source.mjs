import { readSourceObservation, SOURCE, validateObservation } from "./collect.mjs";

// Probe the upstream directly every time. Existing hourly history must never
// make this succeed without a fresh source response, and this probe writes none.
try {
  const raw = await readSourceObservation();
  const observation = validateObservation(raw, new Date());
  console.log(JSON.stringify({ source: SOURCE, ...observation }));
} catch (error) {
  console.error(`Source probe failed: ${error.message}`);
  process.exitCode = 1;
}
