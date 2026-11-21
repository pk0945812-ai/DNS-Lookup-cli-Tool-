const resolvers = {
  google: { name: "Google Public DNS", address: "8.8.8.8", endpoint: "https://dns.google/resolve" },
  cloudflare: { name: "Cloudflare", address: "1.1.1.1", endpoint: "https://cloudflare-dns.com/dns-query" },
};

const recordTypes = new Map([
  [1, "A"], [2, "NS"], [5, "CNAME"], [6, "SOA"], [12, "PTR"], [15, "MX"], [16, "TXT"],
  [28, "AAAA"], [33, "SRV"], [39, "DNAME"], [43, "DS"], [46, "RRSIG"], [47, "NSEC"],
  [48, "DNSKEY"], [50, "NSEC3"], [52, "TLSA"], [64, "SVCB"], [65, "HTTPS"], [257, "CAA"],
]);

const dnsStatuses = new Map([
  [0, { code: "NOERROR" }],
  [1, { code: "FORMERR", message: "The resolver could not read the DNS query." }],
  [2, { code: "SERVFAIL", message: "The resolver could not complete the lookup. Try again or switch resolvers." }],
  [3, { code: "NXDOMAIN", message: "The resolver reports that this domain does not exist." }],
  [4, { code: "NOTIMP", message: "The resolver does not support this DNS query." }],
  [5, { code: "REFUSED", message: "The resolver refused to answer the query. Try another resolver." }],
]);

const historyKey = "dns-studio-history-v1";
const historyLimit = 7;
const maximumLookupTime = 12000;

const form = document.getElementById("lookup-form");
const domainInput = document.getElementById("domain-input");
const domainLabel = document.getElementById("domain-label");
const recordType = document.getElementById("record-type");
const resolverSelect = document.getElementById("resolver");
const dnssec = document.getElementById("dnssec");
const lookupButton = document.getElementById("lookup-button");
const lookupLabel = lookupButton.querySelector("[data-button-label]");
const formError = document.getElementById("form-error");
const results = document.getElementById("results");
const resultStatus = document.getElementById("result-status");
const resultMeta = document.getElementById("result-meta");
const resultTable = document.getElementById("result-table");
const resultRows = document.getElementById("result-rows");
const resultEmpty = document.getElementById("result-empty");
const emptyTitle = document.getElementById("empty-title");
const emptyMessage = document.getElementById("empty-message");
const copyResults = document.getElementById("copy-results");
const cliCommand = document.getElementById("cli-command");
const copyCommand = document.getElementById("copy-command");
const historyList = document.getElementById("history-list");
const historyEmpty = document.getElementById("history-empty");
const clearHistory = document.getElementById("clear-history");

let activeRequest;
let resultText = "";
let history = readHistory();

function ptrName(value) {
  const ipv4 = value.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return `${ipv4.map(Number).reverse().join(".")}.in-addr.arpa`;
  }

  if (!value.includes(":")) return null;
  const address = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (!/^[0-9a-f:.]+$/i.test(address)) throw new Error("Enter a valid IPv6 address or a DNS name.");

  let canonical;
  try {
    canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  } catch {
    throw new Error("Enter a valid IPv6 address or a DNS name.");
  }
  const [left, right] = canonical.split("::");
  const first = left ? left.split(":") : [];
  const last = right ? right.split(":") : [];
  const groups = right === undefined ? first : [...first, ...Array(8 - first.length - last.length).fill("0"), ...last];
  const digits = groups.map((group) => group.padStart(4, "0")).join("");
  return `${[...digits].reverse().join(".")}.ip6.arpa`;
}

function normalizeDomain(rawValue, type) {
  const value = rawValue.trim().replace(/[\u3002\uff0e\uff61]/g, ".");
  if (!value) throw new Error("Enter a domain name to look up.");
  const reverse = type === "PTR" ? ptrName(value) : null;
  if (reverse) return reverse;

  const invalidName = "Enter a valid domain name, such as example.com.";
  if (!/^[\p{L}\p{M}\p{N}._-]+$/u.test(value)) throw new Error(invalidName);
  const trailingDot = value.endsWith(".");
  const name = trailingDot ? value.slice(0, -1) : value;
  const labels = name.split(".").map((label) => {
    if (/^[\x00-\x7f]*$/.test(label)) return label.toLowerCase();
    try {
      return new URL(`http://${label}.example`).hostname.slice(0, -".example".length);
    } catch {
      throw new Error(invalidName);
    }
  });

  if (labels.some((label) => !/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))) {
    throw new Error(invalidName);
  }

  const asciiName = labels.join(".");
  if (asciiName.length > 253) throw new Error("A DNS name can contain at most 253 characters.");
  return `${asciiName}${trailingDot ? "." : ""}`;
}

function readQuery() {
  return {
    domain: normalizeDomain(domainInput.value, recordType.value),
    type: recordType.value,
    resolver: resolverSelect.value,
    dnssec: dnssec.checked,
  };
}

function updateCommand() {
  const type = recordType.value;
  const address = resolvers[resolverSelect.value].address;
  const reverseLookup = type === "PTR";
  const example = reverseLookup ? "8.8.8.8" : "example.com";
  domainLabel.textContent = reverseLookup ? "IP address or DNS name" : "Domain name";
  domainInput.placeholder = example;
  try {
    const domain = normalizeDomain(domainInput.value.trim() || example, type);
    cliCommand.textContent = `dig @${address} ${domain} ${type}${dnssec.checked ? " +dnssec" : ""}`;
    copyCommand.disabled = false;
  } catch {
    cliCommand.textContent = "Enter a valid name to build a command.";
    copyCommand.disabled = true;
  }
}

function setInputError(message = "") {
  formError.textContent = message;
  formError.hidden = !message;
  domainInput.setAttribute("aria-invalid", String(Boolean(message)));
}

function setResultView({ state, status, meta, title = "", message = "", records = [] }) {
  resultStatus.dataset.state = state;
  resultStatus.textContent = status;
  resultMeta.textContent = meta;
  emptyTitle.textContent = title;
  emptyMessage.textContent = message;
  resultRows.replaceChildren(...records.map(renderRecord));
  resultTable.hidden = records.length === 0;
  resultEmpty.hidden = records.length > 0;
  copyResults.hidden = records.length === 0;
  resultText = records.map((record) => `${record.name}\t${record.ttl}\tIN\t${record.type}\t${record.value}`).join("\n");
}

function renderRecord(record) {
  const row = document.createElement("tr");
  const columns = [
    ["record-name", record.name],
    ["record-type-cell", record.type],
    ["record-ttl", record.ttl],
    ["record-value", record.value],
  ];
  for (const [className, value] of columns) {
    const cell = document.createElement("td");
    cell.className = className;
    cell.textContent = value;
    row.append(cell);
  }
  return row;
}

async function fetchRecords(query, signal) {
  const resolver = resolvers[query.resolver];
  const url = new URL(resolver.endpoint);
  url.searchParams.set("name", query.domain);
  url.searchParams.set("type", query.type);
  if (query.dnssec) url.searchParams.set("do", "1");
  if (query.resolver === "google") url.searchParams.set("edns_client_subnet", "0.0.0.0/0");

  const response = await fetch(url, {
    headers: { Accept: "application/dns-json" },
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error(`${resolver.name} returned HTTP ${response.status}. Try again or switch resolvers.`);

  const data = await response.json().catch((error) => {
    if (signal.aborted) throw error;
    throw new Error("The resolver sent an unreadable response. Try another resolver.");
  });
  if (!data || !Number.isInteger(data.Status)) throw new Error("The resolver sent an invalid DNS response.");

  const answers = Array.isArray(data.Answer) ? data.Answer : [];
  const records = answers
    .filter((answer) => answer && typeof answer.name === "string" && typeof answer.data === "string")
    .map((answer) => ({
      name: answer.name,
      type: recordTypes.get(answer.type) ?? `TYPE${answer.type}`,
      ttl: Number.isInteger(answer.TTL) ? String(answer.TTL) : "—",
      value: answer.data,
    }));
  return { status: data.Status, records, authenticated: data.AD === true, truncated: data.TC === true };
}

function displayResponse(query, response, duration) {
  const resolver = resolvers[query.resolver];
  const summary = dnsStatuses.get(response.status) ?? {
    code: `DNS ${response.status}`,
    message: `The resolver returned DNS response code ${response.status}.`,
  };
  const metadata = [`${query.domain} · ${query.type}`, resolver.name, `${duration} ms`];
  if (response.authenticated) metadata.push("DNSSEC validated");
  if (response.truncated) metadata.push("Truncated response");

  setResultView({
    state: response.status === 0 ? "success" : "error",
    status: summary.code,
    meta: metadata.join(" · "),
    title: response.status === 0 ? "No records returned" : "Lookup unsuccessful",
    message: summary.message ?? `The resolver returned no answers for this ${query.type} query.`,
    records: response.records,
  });
}

async function runLookup(event) {
  event.preventDefault();
  let query;
  try {
    query = readQuery();
  } catch (error) {
    setInputError(error.message);
    domainInput.focus();
    return;
  }

  setInputError();
  activeRequest?.abort();
  const request = new AbortController();
  activeRequest = request;
  const timeout = window.setTimeout(() => request.abort(), maximumLookupTime);
  const started = performance.now();
  lookupButton.disabled = true;
  lookupLabel.textContent = "Looking up…";
  results.setAttribute("aria-busy", "true");
  setResultView({
    state: "loading",
    status: "Querying",
    meta: `${query.domain} · ${query.type}`,
    title: "Looking up DNS records",
    message: `Waiting for ${resolvers[query.resolver].name}.`,
  });

  try {
    const response = await fetchRecords(query, request.signal);
    if (activeRequest !== request) return;
    displayResponse(query, response, Math.round(performance.now() - started));
    rememberQuery(query);
  } catch (error) {
    if (activeRequest !== request) return;
    let message = error.message;
    if (request.signal.aborted) message = "The resolver took too long to respond. Try again or switch resolvers.";
    else if (error instanceof TypeError) message = "Could not reach the resolver. Check your connection or try another resolver.";
    setResultView({
      state: "error",
      status: "Error",
      meta: `${query.domain} · ${query.type}`,
      title: "Lookup failed",
      message,
    });
  } finally {
    window.clearTimeout(timeout);
    if (activeRequest === request) {
      activeRequest = undefined;
      lookupButton.disabled = false;
      lookupLabel.textContent = "Run lookup";
      results.setAttribute("aria-busy", "false");
    }
  }
}

function readHistory() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(historyKey));
    if (!Array.isArray(stored)) return [];
    return stored.filter((entry) => entry && typeof entry.domain === "string"
      && [...recordType.options].some((option) => option.value === entry.type)
      && Object.hasOwn(resolvers, entry.resolver) && typeof entry.dnssec === "boolean"
      && Number.isFinite(new Date(entry.time).getTime())).slice(0, historyLimit);
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    window.localStorage.setItem(historyKey, JSON.stringify(history));
  } catch {
    // Keep this page's history available when browser storage is disabled.
  }
  renderHistory();
}

function rememberQuery(query) {
  const sameQuery = (entry) => entry.domain === query.domain && entry.type === query.type
    && entry.resolver === query.resolver && entry.dnssec === query.dnssec;
  history = [{ ...query, time: Date.now() }, ...history.filter((entry) => !sameQuery(entry))].slice(0, historyLimit);
  saveHistory();
}

function openHistoryEntry(entry) {
  domainInput.value = entry.domain;
  recordType.value = entry.type;
  resolverSelect.value = entry.resolver;
  dnssec.checked = entry.dnssec;
  updateCommand();
  form.requestSubmit();
}

function renderHistory() {
  historyList.replaceChildren();
  historyEmpty.hidden = history.length > 0;
  clearHistory.hidden = history.length === 0;
  const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  for (const entry of history) {
    const item = document.createElement("li");
    item.className = "history-item";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-entry";
    button.setAttribute("aria-label", `Look up ${entry.domain}, ${entry.type}, with ${resolvers[entry.resolver].name}`);
    button.addEventListener("click", () => openHistoryEntry(entry));

    const domain = document.createElement("span");
    domain.className = "history-domain";
    domain.textContent = entry.domain;

    const time = document.createElement("time");
    time.className = "history-time";
    const date = new Date(entry.time);
    time.dateTime = date.toISOString();
    time.title = date.toLocaleString();
    time.textContent = clock.format(date);

    const type = document.createElement("span");
    type.className = "history-type";
    type.textContent = entry.type;

    button.append(domain, time, type);
    item.append(button);
    historyList.append(item);
  }
}

async function writeClipboard(value) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    // Text selection keeps copying available from local HTML files.
  }

  const focused = document.activeElement;
  const selection = document.createElement("textarea");
  selection.value = value;
  selection.readOnly = true;
  selection.setAttribute("aria-hidden", "true");
  Object.assign(selection.style, { position: "fixed", left: "-9999px", top: "0" });
  document.body.append(selection);
  try {
    selection.select();
    if (!document.execCommand("copy")) throw new Error("Copy unavailable");
  } finally {
    selection.remove();
    focused?.focus();
  }
}

function bindCopy(button, readValue, accessibleLabel) {
  const label = button.querySelector("[data-copy-label]");
  const originalLabel = label?.textContent;
  let resetTimer;
  button.addEventListener("click", async () => {
    const value = readValue();
    if (!value) return;
    let feedback = "Copied";
    try {
      await writeClipboard(value);
    } catch {
      feedback = "Copy failed";
    }
    window.clearTimeout(resetTimer);
    button.dataset.copied = String(feedback === "Copied");
    button.setAttribute("aria-label", feedback);
    button.title = feedback;
    if (label) label.textContent = feedback;
    resetTimer = window.setTimeout(() => {
      delete button.dataset.copied;
      button.setAttribute("aria-label", accessibleLabel);
      button.title = accessibleLabel;
      if (label) label.textContent = originalLabel;
    }, 1600);
  });
}

form.noValidate = true;
form.addEventListener("submit", runLookup);
form.addEventListener("input", () => {
  setInputError();
  updateCommand();
});

for (const pick of document.querySelectorAll("[data-domain][data-record]")) {
  pick.addEventListener("click", (event) => {
    event.preventDefault();
    domainInput.value = pick.dataset.domain;
    recordType.value = pick.dataset.record;
    updateCommand();
    form.requestSubmit();
  });
}

clearHistory.addEventListener("click", () => {
  history = [];
  saveHistory();
});

bindCopy(copyCommand, () => cliCommand.textContent, "Copy command");
bindCopy(copyResults, () => resultText, "Copy results");
updateCommand();
renderHistory();
