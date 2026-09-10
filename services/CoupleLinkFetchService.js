/* POST /wedding/:id/registry/fetch-link — § 05.1's "paste a link from any shop".
 *
 * THE COUPLE PASTES A URL AND THIS SERVER FETCHES IT. That sentence is the
 * whole threat model: an authenticated user chooses an address and a machine
 * inside our network goes and gets it. Treated naively that is a
 * server-side-request-forgery primitive pointed at everything wedsy-server can
 * reach and the browser cannot — the EC2 instance metadata service, the
 * database's private address, an internal admin port.
 *
 * So four controls, and every one of them refuses rather than sanitises:
 *
 *   1. SCHEME. http and https. Not file:, not gopher:, not data:, not ftp:.
 *   2. ADDRESS. Every IP the hostname resolves to is checked against the
 *      private, loopback, link-local, carrier-NAT, multicast and reserved
 *      ranges — v4 and v6, including v4-mapped and 6to4-embedded v6 — and one
 *      bad address refuses the whole request. The check is installed as the
 *      socket's OWN `lookup`, so it runs again at connect time: a DNS name that
 *      answers publicly on the first query and 169.254.169.254 on the second
 *      (DNS rebinding) is refused by the connection, not just by the pre-check.
 *   3. PORT. 80 and 443. An internal service on 8080 behind a public DNS name
 *      is not a shop.
 *   4. BUDGET. A hard total timeout, a byte cap enforced as the body arrives
 *      (not after), at most three redirects, and every redirect re-validated
 *      from scratch — a 302 to http://169.254.169.254/ is the oldest trick here.
 *
 * WHAT COMES BACK IS UNTRUSTED TEXT. `parseProduct` is a pure function over a
 * string; it reads meta tags with regular expressions rather than building a
 * DOM, emits only strings it has bounded, and never evaluates anything. Every
 * field is optional — wedsy-user's `api.fetchRegistryLink` says so explicitly,
 * and a missing price and a missing image are the ordinary case, not the error.
 */

const http = require("http");
const https = require("https");
const dns = require("dns");
const { URL } = require("url");

const MAX_BYTES = 512 * 1024;      // half a megabyte of HTML is a very long page
const TIMEOUT_MS = 6000;           // total, not per socket event
const MAX_REDIRECTS = 3;
const ALLOWED_PORTS = [80, 443];
const MAX_TITLE = 200;
const MAX_URL = 2000;

const fail = (status, code, message) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

/* ── the address guard (pure) ─────────────────────────────────────────────── */

/** Hostnames that are never a shop, whatever DNS says about them. */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".localdomain"];
const BLOCKED_HOSTS = ["localhost", "metadata", "metadata.google.internal", "instance-data"];

const blockedHostname = (host) => {
  const name = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  if (!name) return true;
  if (BLOCKED_HOSTS.indexOf(name) !== -1) return true;
  return BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix));
};

const v4Octets = (address) => {
  const parts = String(address).split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
};

/**
 * Is this IPv4 address one a shop could never legitimately live at?
 *
 * Deliberately a deny-list of the RFC ranges rather than an allow-list of "the
 * public internet": the public internet has no enumeration, and an allow-list
 * would have to be written as "everything except these", which is this.
 */
const blockedV4 = (address) => {
  const o = v4Octets(address);
  if (!o) return true; // unparseable is not a thing we connect to
  const [a, b] = o;
  if (a === 0) return true;                                   // 0.0.0.0/8 "this network"
  if (a === 10) return true;                                  // private
  if (a === 127) return true;                                 // loopback
  if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64/10 carrier NAT
  if (a === 169 && b === 254) return true;                    // link-local — EC2/GCP metadata
  if (a === 172 && b >= 16 && b <= 31) return true;           // private
  if (a === 192 && b === 168) return true;                    // private
  if (a === 192 && o[1] === 0 && (o[2] === 0 || o[2] === 2)) return true; // 192.0.0/24, TEST-NET-1
  if (a === 192 && o[1] === 88 && o[2] === 99) return true;   // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true;        // benchmarking
  if (a === 198 && b === 51 && o[2] === 100) return true;      // TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return true;       // TEST-NET-3
  if (a >= 224) return true;                                   // multicast, reserved, broadcast
  return false;
};

/** IPv6, including the two shapes that smuggle an IPv4 address inside one. */
const blockedV6 = (raw) => {
  const address = String(raw || "").toLowerCase().split("%")[0]; // drop any zone index
  if (!address) return true;
  if (address === "::" || address === "::1") return true;
  // v4-mapped (::ffff:10.0.0.1) and v4-compatible — judge the address inside.
  const mapped = address.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return blockedV4(mapped[1]);
  const first = address.split(":")[0];
  const head = parseInt(first || "0", 16);
  if (!Number.isFinite(head)) return true;
  if ((head & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique local
  if ((head & 0xffc0) === 0xfe80) return true;   // fe80::/10 link local
  if ((head & 0xff00) === 0xff00) return true;   // ff00::/8 multicast
  // 2002:xxyy:zzww::/16 — 6to4 carries an IPv4 address in the next 32 bits.
  if (head === 0x2002) {
    const parts = address.split(":");
    const hi = parseInt(parts[1] || "0", 16);
    const lo = parseInt(parts[2] || "0", 16);
    const embedded = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".");
    return blockedV4(embedded);
  }
  // 64:ff9b::/96 — NAT64, another IPv4 in the low bits.
  if (head === 0x64) return true;
  return false;
};

/** One answer for both families, so no call site has to choose. */
const blockedAddress = (address, family) => {
  const value = String(address || "");
  if (!value) return true;
  const isV6 = family === 6 || family === "IPv6" || value.indexOf(":") !== -1;
  return isV6 ? blockedV6(value) : blockedV4(value);
};

/**
 * Parse and vet the URL the couple pasted. PURE — no DNS, no network.
 * @returns {{ok:true, url:URL} | {ok:false, code:string, message:string}}
 */
const vetUrl = (raw) => {
  const value = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!value) return { ok: false, code: "validation", message: "Paste a link to the gift." };
  if (value.length > MAX_URL) return { ok: false, code: "validation", message: "That link is too long." };

  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return { ok: false, code: "validation", message: "That does not look like a link." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "unsupported_url", message: "We can only read ordinary web links." };
  }
  if (url.username || url.password) {
    return { ok: false, code: "unsupported_url", message: "We can only read ordinary web links." };
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (ALLOWED_PORTS.indexOf(port) === -1) {
    return { ok: false, code: "unsupported_url", message: "We can only read ordinary web links." };
  }
  if (blockedHostname(url.hostname)) {
    return { ok: false, code: "unsupported_url", message: "That link points somewhere we cannot read." };
  }
  // A bare IP literal is judged immediately; a name is judged by DNS below.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(literal) || literal.indexOf(":") !== -1) {
    if (blockedAddress(literal)) {
      return { ok: false, code: "unsupported_url", message: "That link points somewhere we cannot read." };
    }
  }
  return { ok: true, url, port };
};

/* ── the guarded fetch ────────────────────────────────────────────────────── */

/**
 * A drop-in for dns.lookup that refuses a private answer.
 *
 * Passed to http.request as `lookup`, so it is what the SOCKET uses. That is
 * the point: the pre-flight check below can be defeated by a name that answers
 * differently the second time it is asked; this cannot, because there is no
 * second lookup that skips it.
 */
const guardedLookup = (hostname, options, callback) => {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : options || {};
  dns.lookup(hostname, { ...opts, all: true }, (error, addresses) => {
    if (error) return cb(error);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    const clean = list.filter((entry) => entry && !blockedAddress(entry.address, entry.family));
    if (!clean.length || clean.length !== list.length) {
      // ONE bad answer refuses the lot. A host that resolves to both a public
      // and a private address is not a host we are willing to guess about.
      return cb(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }));
    }
    if (opts.all) return cb(null, clean);
    return cb(null, clean[0].address, clean[0].family);
  });
};

/** GET one URL, bounded. Rejects on anything that is not a small HTML page. */
const getOnce = (url, deadline) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(fail(504, "fetch_timeout", "That shop took too long to answer."));

    const request = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        lookup: guardedLookup,
        headers: {
          // Identify honestly. A shop that blocks us may then say so, which is
          // a better outcome than pretending to be somebody's browser. No URL
          // is baked in here (repo rule 3); the name is enough to be findable.
          "User-Agent": "WedsyRegistryBot/1.0",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-IN,en;q=0.9",
        },
        timeout: Math.min(remaining, TIMEOUT_MS),
      },
      (response) => {
        const status = response.statusCode || 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.destroy();
          return resolve({ redirect: String(location) });
        }
        if (status < 200 || status >= 300) {
          response.destroy();
          return reject(fail(422, "fetch_failed", "That shop would not let us read the page."));
        }
        const type = String(response.headers["content-type"] || "");
        if (type && !/text\/html|application\/xhtml/i.test(type)) {
          response.destroy();
          return reject(fail(422, "unsupported_url", "That link is not a page we can read."));
        }

        let size = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          // Enforced AS IT ARRIVES: a hostile server streaming forever must not
          // be able to spend our memory before we notice.
          if (size > MAX_BYTES) {
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ html: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", () => reject(fail(422, "fetch_failed", "We could not read that link.")));
      }
    );

    request.on("timeout", () => {
      request.destroy();
      reject(fail(504, "fetch_timeout", "That shop took too long to answer."));
    });
    request.on("error", (error) => {
      if (error && error.code === "EBLOCKED") {
        return reject(fail(422, "unsupported_url", "That link points somewhere we cannot read."));
      }
      reject(fail(422, "fetch_failed", "We could not reach that link."));
    });
    request.end();
  });

/** Follow up to MAX_REDIRECTS hops, re-vetting every one from scratch. */
const fetchHtml = async (startUrl) => {
  const deadline = Date.now() + TIMEOUT_MS;
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const answer = await getOnce(url, deadline);
    if (answer.html !== undefined) return { html: answer.html, url };
    // A redirect is a NEW url the couple never typed, so it goes through the
    // same door as the one they did.
    let next;
    try {
      next = new URL(answer.redirect, url);
    } catch (_) {
      throw fail(422, "fetch_failed", "That link redirected somewhere we could not follow.");
    }
    const vetted = vetUrl(next.toString());
    if (!vetted.ok) throw fail(422, "unsupported_url", "That link redirected somewhere we cannot read.");
    url = vetted.url;
  }
  throw fail(422, "fetch_failed", "That link redirected too many times.");
};

/* ── reading the page (pure) ──────────────────────────────────────────────── */

const entities = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

const decode = (value) =>
  String(value || "")
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
      if (entities[name]) return entities[name];
      if (name[0] === "#") {
        const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return whole;
    })
    .replace(/\s+/g, " ")
    .trim();

/** `<meta property="og:title" content="…">`, in either attribute order. */
const meta = (html, names) => {
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const forward = new RegExp(`<meta[^>]+(?:property|name|itemprop)\\s*=\\s*["']${name}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`, "i");
    const backward = new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name|itemprop)\\s*=\\s*["']${name}["']`, "i");
    const hit = html.match(forward) || html.match(backward);
    if (hit && hit[1]) return decode(hit[1]);
  }
  return "";
};

/**
 * "₹1,24,999.00" → 124999. "1.299,00" → 1299. Rupees, whole.
 *
 * Shops write prices a dozen ways and the couple can correct whatever comes
 * back, so this leans towards NOT guessing: anything it cannot read confidently
 * comes back as 0, which the screen renders as § 05.1's "Add & set a price".
 */
const parsePrice = (raw) => {
  const text = String(raw || "").replace(/[^\d.,]/g, "");
  if (!text) return 0;
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  let normalised = text;
  // A comma AFTER the last dot is a decimal comma only if one or two digits
  // follow it. Exactly three means it is a group separator — "₹24,999" is not
  // twenty-four rupees and ninety-nine paise, which is the whole reason this
  // branch is written out rather than guessed at.
  const afterComma = lastComma === -1 ? -1 : text.length - lastComma - 1;
  if (lastComma > lastDot && afterComma >= 1 && afterComma <= 2) {
    // European: dots group, comma is the decimal point.
    normalised = text.replace(/\./g, "").replace(",", ".");
  } else {
    normalised = text.replace(/,/g, "");
  }
  const value = Number(normalised);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
};

/** Pull `"price": 1299` out of a JSON-LD Product block without evaluating it. */
const jsonLdPrice = (html) => {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (let i = 0; i < blocks.length; i += 1) {
    const hit = blocks[i].match(/"price"\s*:\s*"?([\d.,]+)"?/i);
    if (hit) {
      const price = parsePrice(hit[1]);
      if (price > 0) return price;
    }
  }
  return 0;
};

/**
 * Everything the page will honestly tell us, and nothing invented.
 * PURE — a string in, a plain object out. Every field may be empty.
 *
 * @param {string} html
 * @param {string} pageUrl  used to resolve a relative image and to name the shop
 */
const parseProduct = (html, pageUrl) => {
  const source = String(html || "");
  const title =
    meta(source, ["og:title", "twitter:title"]) ||
    decode((source.match(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i) || [])[1] || "");

  const rawImage = meta(source, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src", "image"]);
  const rawPrice =
    meta(source, ["product:price:amount", "og:price:amount", "price", "twitter:data1"]) || "";

  let host = "";
  let image = "";
  try {
    const base = new URL(pageUrl);
    host = base.hostname.replace(/^www\./i, "");
    if (rawImage) {
      const resolved = new URL(rawImage, base);
      // The image is rendered as a CSS background by wedsy-user, so a
      // `javascript:` or `data:` value is refused here rather than shipped.
      if (resolved.protocol === "http:" || resolved.protocol === "https:") image = resolved.toString().slice(0, MAX_URL);
    }
  } catch (_) {
    image = "";
  }

  return {
    title: title.slice(0, MAX_TITLE),
    image,
    price: parsePrice(rawPrice) || jsonLdPrice(source),
    source: host,
    sourceUrl: String(pageUrl || "").slice(0, MAX_URL),
  };
};

/**
 * The endpoint's whole job: vet, fetch, read, answer.
 *
 * The response is `{ image, title, price, source, sourceUrl }` with EVERY FIELD
 * OPTIONAL — that is the client's contract, in its own words: "a missing image
 * and a missing price are the normal case, not the error case."
 */
const fetchLink = async (rawUrl) => {
  const vetted = vetUrl(rawUrl);
  if (!vetted.ok) {
    throw vetted.code === "validation"
      ? Object.assign(fail(422, "validation", vetted.message), { extra: { fields: { url: vetted.message } } })
      : fail(422, vetted.code, vetted.message);
  }
  const { html, url } = await fetchHtml(vetted.url);
  return parseProduct(html, url.toString());
};

module.exports = {
  fetchLink,
  // exported for tests/couple-registry-linkfetch.test.js — no network, no DNS
  vetUrl,
  blockedAddress,
  blockedV4,
  blockedV6,
  blockedHostname,
  parseProduct,
  parsePrice,
  meta,
  decode,
  guardedLookup,
  MAX_BYTES,
  TIMEOUT_MS,
  MAX_REDIRECTS,
};
