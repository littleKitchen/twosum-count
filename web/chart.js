(() => {
  "use strict";

  const HOUR = 3_600_000;
  const WINDOW = 30 * 24 * HOUR;
  const TIME_ZONE = "America/Los_Angeles";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const TOP = 30;
  const BOTTOM = 286;
  const HEIGHT = 360;
  const EDGE = 12;
  const BASE_CAPTION = "Last 30 days · Actual capture times · Pacific Time (PT) · Missing samples are gaps.";
  const numberFormat = new Intl.NumberFormat("en-US");
  const hourFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit",
  });
  const dateFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, month: "short", day: "numeric",
  });
  const fullFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  });
  const sampleHourFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

  const svg = document.getElementById("chart");
  const plot = document.getElementById("chart-plot");
  const axis = document.getElementById("y-axis");
  const emptyState = document.getElementById("empty-state");
  const caption = document.getElementById("caption");
  const tooltip = document.getElementById("chart-tooltip");
  let observations = [];
  let displayed = [];
  let geometry = null;
  let collectionStatus = "";
  let requestNumber = 0;
  let controller = null;
  let hasRead = false;
  let stopped = false;
  let lastChartKey = "";

  function svgNode(name, attributes = {}, text = null) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== null) node.textContent = text;
    return node;
  }

  function parseHistory(data) {
    if (!data || !Array.isArray(data.observations)) throw new Error("Invalid history");
    const records = new Map();
    for (const record of data.observations) {
      if (!record || typeof record.hour !== "string" || typeof record.capturedAt !== "string") {
        throw new Error("Invalid observation");
      }
      const hour = Date.parse(record.hour);
      const capturedAt = Date.parse(record.capturedAt);
      if (!Number.isFinite(hour) || hour % HOUR !== 0 || !Number.isFinite(capturedAt)
        || Math.floor(capturedAt / HOUR) * HOUR !== hour
        || !Number.isSafeInteger(record.count) || record.count < 0) {
        throw new Error("Invalid observation");
      }
      const previous = records.get(hour);
      if (!previous || capturedAt < previous.capturedAt) records.set(hour, { hour, capturedAt, count: record.count });
    }
    return [...records.values()].sort((first, second) => first.capturedAt - second.capturedAt);
  }

  function scaleCeiling(maximum) {
    const rawStep = Math.max(1, maximum / 4);
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    return Math.ceil(rawStep / magnitude) * magnitude * 4;
  }

  function sampleDetails(item) {
    return `${numberFormat.format(item.count)} online\nCaptured: ${fullFormat.format(item.capturedAt)}`;
  }

  function drawChart() {
    const end = Date.now();
    const cutoff = end - WINDOW;
    displayed = observations.filter((record) => record.capturedAt >= cutoff && record.capturedAt <= end);
    // Use the available history while the project is younger than a month.
    const start = displayed.length
      ? Math.max(cutoff, Math.min(Math.floor(displayed[0].capturedAt / HOUR) * HOUR, end - HOUR)) : cutoff;
    const width = Math.max(1, plot.clientWidth);
    const chartKey = JSON.stringify([start, end, displayed, width]);
    if (chartKey === lastChartKey) return;
    lastChartKey = chartKey;
    tooltip.hidden = true;
    const right = Math.max(EDGE, width - EDGE);
    const x = (timestamp) => EDGE + (timestamp - start) / (end - start) * (right - EDGE);
    const maximum = displayed.reduce((max, item) => Math.max(max, item.count), 0);
    const ceiling = scaleCeiling(maximum);
    const y = (count) => BOTTOM - count / ceiling * (BOTTOM - TOP);
    geometry = { start, end, width, right, x, y };
    const content = document.createDocumentFragment();
    const description = displayed.length
      ? `${displayed.length} samples plotted at their actual capture times from ${fullFormat.format(displayed[0].capturedAt)} to ${fullFormat.format(displayed[displayed.length - 1].capturedAt)}. Time is Pacific Time. Missing samples are gaps.`
      : "No recorded samples in the last 30 days. Time is Pacific Time. Missing samples are gaps.";
    content.append(svgNode("desc", { id: "chart-description" }, description));
    axis.replaceChildren();

    for (let tick = 0; tick <= 4; tick += 1) {
      const position = BOTTOM - tick / 4 * (BOTTOM - TOP);
      content.append(svgNode("line", { x1: EDGE, y1: position, x2: right, y2: position, class: "grid" }));
      const label = document.createElement("span");
      label.style.top = `${position}px`;
      label.textContent = displayed.length ? numberFormat.format(ceiling * tick / 4) : "—";
      axis.append(label);
    }

    const firstTick = Math.ceil(start / HOUR) * HOUR;
    const lastTick = Math.floor(end / HOUR) * HOUR;
    const hours = Math.max(0, Math.round((lastTick - firstTick) / HOUR));
    const tickCount = Math.min(hours + 1, 8, Math.max(2, Math.floor((right - EDGE) / 100) + 1));
    const compactRange = end - start <= 2 * 24 * HOUR;
    const seenDates = new Set();
    const endDate = dateFormat.format(lastTick);
    for (let index = 0; index < tickCount; index += 1) {
      const hour = firstTick + Math.round(hours * index / Math.max(1, tickCount - 1)) * HOUR;
      const date = dateFormat.format(hour);
      if (!compactRange && (seenDates.has(date) || (date === endDate && index !== tickCount - 1))) continue;
      seenDates.add(date);
      const position = x(hour);
      const anchor = position - EDGE < 36 ? "start" : right - position < 36 ? "end" : "middle";
      const label = svgNode("text", { x: position, y: 314, "text-anchor": anchor, class: "axis" });
      if (compactRange) {
        label.append(svgNode("tspan", { x: position }, hourFormat.format(hour)));
        label.append(svgNode("tspan", { x: position, dy: 17 }, date));
      } else {
        label.append(svgNode("tspan", { x: position }, date));
      }
      label.setAttribute("aria-label", sampleHourFormat.format(hour));
      content.append(label);
    }

    const segments = [];
    for (const item of displayed) {
      const segment = segments[segments.length - 1];
      if (!segment || item.hour - segment[segment.length - 1].hour !== HOUR) segments.push([item]);
      else segment.push(item);
    }
    for (const segment of segments) {
      if (segment.length > 1) content.append(svgNode("polyline", {
        points: segment.map((item) => `${x(item.capturedAt)},${y(item.count)}`).join(" "), class: "trace",
      }));
    }
    const radius = displayed.length > 200 ? 1.2 : displayed.length > 12 ? 2 : 3.5;
    const showValues = displayed.length <= 12 && displayed.every((item, index) => index === 0 || x(item.capturedAt) - x(displayed[index - 1].capturedAt) >= 52);
    for (const item of displayed) {
      const point = svgNode("circle", { cx: x(item.capturedAt), cy: y(item.count), r: radius, class: "point" });
      point.setAttribute("data-captured-at", new Date(item.capturedAt).toISOString());
      point.setAttribute("aria-label", sampleDetails(item));
      content.append(point);
      if (showValues) content.append(svgNode("text", {
        x: x(item.capturedAt), y: y(item.count) - 11,
        "text-anchor": x(item.capturedAt) - EDGE < 36 ? "start" : right - x(item.capturedAt) < 36 ? "end" : "middle", class: "value",
      }, numberFormat.format(item.count)));
    }
    svg.setAttribute("width", String(width));
    svg.setAttribute("viewBox", `0 0 ${width} ${HEIGHT}`);
    svg.replaceChildren(content);
  }

  function showState(error = false) {
    emptyState.hidden = displayed.length > 0;
    emptyState.textContent = !hasRead ? "Loading data…"
      : error ? "Data is temporarily unavailable. Retrying automatically." : "No recorded samples in the last 30 days.";
    const collectionNote = collectionStatus === "blocked" ? " Collection is temporarily unavailable; showing recorded history." : "";
    caption.textContent = `${error && displayed.length ? "Update failed; showing saved data. " : ""}${BASE_CAPTION}${collectionNote}`;
  }

  function showTooltip(event) {
    if (!geometry || !displayed.length || geometry.right <= EDGE) return;
    const bounds = plot.getBoundingClientRect();
    const position = event.clientX - bounds.left;
    const top = event.clientY - bounds.top;
    if (position < EDGE || position > geometry.right || top < TOP || top > BOTTOM) {
      tooltip.hidden = true;
      return;
    }
    const hourWidth = (geometry.right - EDGE) * HOUR / (geometry.end - geometry.start);
    const hitDistance = Math.min(12, Math.max(4, hourWidth / 2));
    let item = null;
    let nearestDistance = Infinity;
    for (const record of displayed) {
      const dx = geometry.x(record.capturedAt) - position;
      const dy = geometry.y(record.count) - top;
      const distance = dx * dx + dy * dy;
      if (Math.abs(dx) <= hitDistance && Math.abs(dy) <= 12 && distance < nearestDistance) {
        item = record;
        nearestDistance = distance;
      }
    }
    if (!item) { tooltip.hidden = true; return; }
    tooltip.textContent = sampleDetails(item);
    tooltip.hidden = false;
    const left = Math.max(0, Math.min(geometry.width - tooltip.offsetWidth, geometry.x(item.capturedAt) - tooltip.offsetWidth / 2));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(0, geometry.y(item.count) - tooltip.offsetHeight - 12)}px`;
  }
  plot.addEventListener("pointermove", showTooltip);
  plot.addEventListener("pointerdown", showTooltip);
  plot.addEventListener("pointerleave", () => { tooltip.hidden = true; });

  async function readHistory() {
    if (stopped) return;
    const currentRequest = ++requestNumber;
    controller?.abort();
    controller = new AbortController();
    try {
      const response = await fetch(`./data/history.json?minute=${Math.floor(Date.now() / 60_000)}`, {
        cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw new Error("History unavailable");
      const raw = await response.json();
      const data = parseHistory(raw);
      if (stopped || currentRequest !== requestNumber) return;
      observations = data;
      collectionStatus = typeof raw.collectionStatus === "string" ? raw.collectionStatus : "";
      hasRead = true;
      drawChart();
      showState();
    } catch (error) {
      if (stopped || currentRequest !== requestNumber || error.name === "AbortError") return;
      hasRead = true;
      drawChart();
      showState(true);
    }
  }

  drawChart();
  readHistory();
  const scheduleRefresh = () => window.setInterval(() => {
    if (document.visibilityState === "visible") readHistory();
  }, 60_000);
  let timer = scheduleRefresh();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") readHistory();
  });
  window.addEventListener("resize", drawChart);
  window.addEventListener("pagehide", () => {
    stopped = true;
    requestNumber += 1;
    controller?.abort();
    window.clearInterval(timer);
  });
  window.addEventListener("pageshow", () => {
    if (!stopped) return;
    stopped = false;
    timer = scheduleRefresh();
    readHistory();
  });
})();
