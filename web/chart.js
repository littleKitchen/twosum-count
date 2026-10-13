(() => {
  "use strict";

  const HOUR = 3_600_000;
  const TIME_ZONE = "America/Los_Angeles";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const TOP = 30;
  const BOTTOM = 286;
  const HEIGHT = 360;
  const HOUR_WIDTH = 58;
  const EDGE = 24;
  const BASE_CAPTION = "时间为 PT（太平洋时间），没有采样的小时留空。";
  const numberFormat = new Intl.NumberFormat("zh-CN");
  const hourFormat = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const dateFormat = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE, month: "2-digit", day: "2-digit",
  });
  const fullFormat = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    timeZoneName: "short",
  });

  const svg = document.getElementById("chart");
  const scroll = document.getElementById("chart-scroll");
  const axis = document.getElementById("y-axis");
  const emptyState = document.getElementById("empty-state");
  const caption = document.getElementById("caption");
  let observations = [];
  let collectionStatus = "";
  let requestNumber = 0;
  let controller = null;
  let hasRead = false;
  let stopped = false;
  let lastChartKey = "";
  let positioned = false;

  function svgNode(name, attributes = {}, text = null) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) {
      node.setAttribute(key, String(value));
    }
    if (text !== null) node.textContent = text;
    return node;
  }

  function parseHistory(data) {
    if (!data || !Array.isArray(data.observations)) throw new Error("Invalid history");
    const byHour = new Map();
    for (const record of data.observations) {
      if (!record || typeof record.hour !== "string" || typeof record.capturedAt !== "string") {
        throw new Error("Invalid observation");
      }
      const hour = Date.parse(record.hour);
      const capturedAt = Date.parse(record.capturedAt);
      if (!Number.isFinite(hour) || hour % HOUR !== 0 || !Number.isFinite(capturedAt)
        || !Number.isSafeInteger(record.count) || record.count < 0) {
        throw new Error("Invalid observation");
      }
      const previous = byHour.get(hour);
      if (!previous || previous.capturedAt < capturedAt) {
        byHour.set(hour, { hour, capturedAt, count: record.count });
      }
    }
    return [...byHour.values()].sort((first, second) => first.hour - second.hour);
  }

  function scaleCeiling(maximum) {
    const rawStep = Math.max(1, maximum / 4);
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const step = Math.ceil(rawStep / magnitude) * magnitude;
    return step * 4;
  }

  function drawChart() {
    const currentHour = Math.floor(Date.now() / HOUR) * HOUR;
    const firstHour = observations.length ? observations[0].hour : currentHour;
    const lastHour = observations.length ? observations[observations.length - 1].hour : currentHour;
    const start = observations.length ? firstHour : currentHour - HOUR;
    const end = Math.max(start + HOUR, currentHour, lastHour);
    const hours = Math.round((end - start) / HOUR) + 1;
    const chartKey = JSON.stringify([start, end, observations, scroll.clientWidth]);
    if (chartKey === lastChartKey) return;
    lastChartKey = chartKey;

    const wasAtEnd = scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft < 5;
    const oldScrollLeft = scroll.scrollLeft;
    const width = Math.max(scroll.clientWidth, (hours - 1) * HOUR_WIDTH + EDGE * 2);
    const right = width - EDGE;
    const x = (hour) => EDGE + (hour - start) / (end - start) * (right - EDGE);
    const maximum = observations.reduce((max, item) => Math.max(max, item.count), 0);
    const ceiling = scaleCeiling(maximum);
    const y = (count) => BOTTOM - count / ceiling * (BOTTOM - TOP);
    const content = document.createDocumentFragment();
    content.append(svgNode("title", { id: "chart-title" }, "Two Sum 每小时在线人数"));
    const description = observations.length
      ? observations.map((item) => `${fullFormat.format(item.hour)}，${item.count} 人`).join("；")
      : "尚无成功采样。横轴为 PT 时间，纵轴为在线人数，没有采样的小时留空。";
    content.append(svgNode("desc", { id: "chart-description" }, description));
    axis.replaceChildren();

    for (let tick = 0; tick <= 4; tick += 1) {
      const position = BOTTOM - tick / 4 * (BOTTOM - TOP);
      content.append(svgNode("line", {
        x1: EDGE, y1: position, x2: right, y2: position, class: "grid",
      }));
      const label = document.createElement("span");
      label.style.top = `${position}px`;
      label.textContent = observations.length ? numberFormat.format(ceiling * tick / 4) : "—";
      axis.append(label);
    }

    for (let index = 0; index < hours; index += 1) {
      const hour = start + index * HOUR;
      const position = x(hour);
      const label = svgNode("text", { x: position, y: 314, "text-anchor": "middle", class: "axis" });
      label.append(svgNode("tspan", { x: position }, hourFormat.format(hour)));
      label.append(svgNode("tspan", { x: position, dy: 17 }, dateFormat.format(hour)));
      label.append(svgNode("title", {}, fullFormat.format(hour)));
      content.append(label);
    }

    const segments = [];
    for (const item of observations) {
      const segment = segments[segments.length - 1];
      if (!segment || item.hour - segment[segment.length - 1].hour !== HOUR) {
        segments.push([item]);
      } else {
        segment.push(item);
      }
    }
    for (const segment of segments) {
      if (segment.length > 1) {
        content.append(svgNode("polyline", {
          points: segment.map((item) => `${x(item.hour)},${y(item.count)}`).join(" "),
          class: "trace",
        }));
      }
    }
    for (const item of observations) {
      const point = svgNode("circle", { cx: x(item.hour), cy: y(item.count), r: 3.5, class: "point" });
      point.append(svgNode("title", {}, `${fullFormat.format(item.hour)}：${numberFormat.format(item.count)} 人；实际采集：${fullFormat.format(item.capturedAt)}`));
      content.append(point);
      content.append(svgNode("text", {
        x: x(item.hour), y: y(item.count) - 11, "text-anchor": "middle", class: "value",
      }, numberFormat.format(item.count)));
    }

    svg.setAttribute("width", String(width));
    svg.setAttribute("viewBox", `0 0 ${width} ${HEIGHT}`);
    svg.replaceChildren(content);
    if (observations.length && (!positioned || wasAtEnd)) {
      scroll.scrollLeft = scroll.scrollWidth;
      positioned = true;
    } else {
      scroll.scrollLeft = oldScrollLeft;
    }
  }

  function showState(error = false) {
    emptyState.hidden = observations.length > 0;
    emptyState.textContent = !hasRead
      ? "正在读取数据…"
      : error ? "暂时无法读取数据，稍后自动重试" : "尚未采集到在线人数";
    const collectionNote = collectionStatus === "blocked"
      ? " 云端自动采集尚受 LeetCode 验证阻拦，目前仅显示已验证的历史记录。" : "";
    caption.textContent = `${error && observations.length ? "更新失败，显示已保存的数据。" : ""}${BASE_CAPTION}${collectionNote}`;
  }

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
