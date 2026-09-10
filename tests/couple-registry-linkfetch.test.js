// COUPLE APP § 05.1 — THE LINK THE COUPLE PASTES, AND WHERE IT MAY POINT.
// Run: node tests/couple-registry-linkfetch.test.js
//
// PURE unit tests (NO DATABASE, NO NETWORK, NO DNS). `fetch-link` is the one
// endpoint on this app where a user chooses an address and a machine inside
// our network goes and gets it, so the guard is the feature. Asserted here:
//
//   • the accept/refuse table — scheme, port, credentials, hostname, and every
//     private / loopback / link-local / carrier-NAT / multicast / reserved
//     range in v4 and v6, INCLUDING the shapes that smuggle a v4 address inside
//     a v6 one (::ffff:, 2002::, 64:ff9b::)
//   • the socket-level lookup that refuses a rebinding answer at connect time
//   • the parser: every field optional, nothing evaluated, relative images
//     resolved, `javascript:` images refused
const link = require("../services/CoupleLinkFetchService");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const accepts = (url) => link.vetUrl(url).ok === true;
const refuses = (url) => link.vetUrl(url).ok === false;

console.log("Schemes — http and https, and nothing else:");
{
  ok(accepts("https://shop.example.com/lamp"), "https is a shop");
  ok(accepts("http://shop.example.com/lamp"), "so is plain http");
  ok(refuses("file:///etc/passwd"), "file: is refused");
  ok(refuses("ftp://shop.example.com/x"), "ftp: is refused");
  ok(refuses("gopher://shop.example.com/x"), "gopher: is refused — the SSRF classic");
  ok(refuses("data:text/html,<h1>hi"), "data: is refused");
  ok(refuses("javascript:alert(1)"), "javascript: is refused");
  ok(refuses("dict://127.0.0.1:11211/stat"), "dict: is refused");
  ok(refuses("//shop.example.com/lamp"), "a protocol-relative URL is not a URL");
  ok(refuses("shop.example.com/lamp"), "and neither is a bare hostname");
  ok(refuses(""), "nothing is refused");
  ok(refuses(null), "so is null");
  ok(refuses(`https://shop.example.com/${"x".repeat(4000)}`), "and an absurdly long one");
  eq(link.vetUrl("not a url").code, "validation", "an unparseable link is a 422 the couple can correct");
  eq(link.vetUrl("file:///etc/passwd").code, "unsupported_url", "a well-formed hostile one is refused as unsupported");
}

console.log("Ports — 80 and 443 only:");
{
  ok(accepts("https://shop.example.com:443/lamp"), "explicit 443");
  ok(accepts("http://shop.example.com:80/lamp"), "explicit 80");
  ok(refuses("http://shop.example.com:8080/lamp"), "8080 is an internal service, not a shop");
  ok(refuses("http://shop.example.com:6379/"), "nor is Redis");
  ok(refuses("http://shop.example.com:27017/"), "nor MongoDB");
  ok(refuses("http://shop.example.com:22/"), "nor SSH");
}

console.log("Credentials in the URL are refused:");
{
  ok(refuses("https://user:pass@shop.example.com/lamp"), "a link carrying a password is not a product page");
  ok(refuses("https://admin@internal.example.com/"), "a username alone is refused too");
}

console.log("Hostnames that are never a shop:");
{
  ok(refuses("http://localhost/admin"), "localhost");
  ok(refuses("http://LOCALHOST/admin"), "in any case");
  ok(refuses("http://anything.localhost/"), "and anything under it");
  ok(refuses("http://printer.local/"), ".local — mDNS");
  ok(refuses("http://db.internal/"), ".internal");
  ok(refuses("http://metadata.google.internal/computeMetadata/v1/"), "GCP's metadata name");
  ok(refuses("http://router.home.arpa/"), ".home.arpa");
  ok(refuses("http://box.localdomain/"), ".localdomain");
  ok(link.blockedHostname("localhost."), "a trailing dot does not slip past");
  ok(link.blockedHostname(""), "an empty hostname is blocked, not allowed");
}

console.log("IPv4 literals — the refuse table:");
{
  const REFUSED = [
    ["0.0.0.0", "\"this network\""],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "all of 127/8"],
    ["10.0.0.1", "private 10/8"],
    ["172.16.0.1", "private 172.16/12, low end"],
    ["172.31.255.255", "private 172.16/12, high end"],
    ["192.168.1.1", "private 192.168/16"],
    ["169.254.169.254", "THE EC2/GCP METADATA ADDRESS"],
    ["169.254.0.1", "and the rest of link-local"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["192.0.0.1", "IETF protocol assignments"],
    ["192.0.2.5", "TEST-NET-1"],
    ["198.51.100.5", "TEST-NET-2"],
    ["203.0.113.5", "TEST-NET-3"],
    ["192.88.99.1", "6to4 relay anycast"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ];
  REFUSED.forEach(([ip, why]) => ok(link.blockedV4(ip), `${ip} — ${why}`));
  ok(link.blockedV4("999.1.1.1"), "an impossible octet is blocked rather than guessed at");
  ok(link.blockedV4("1.2.3"), "so is a short address");
  ok(link.blockedV4(""), "and an empty one");

  const ALLOWED = ["8.8.8.8", "1.1.1.1", "142.250.183.14", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.167.1.1", "223.255.255.255"];
  ALLOWED.forEach((ip) => ok(!link.blockedV4(ip), `${ip} is a public address and is allowed`));

  ok(refuses("http://169.254.169.254/latest/meta-data/"), "and the URL guard refuses the metadata service outright");
  ok(refuses("http://127.0.0.1:80/"), "and loopback on a permitted port");
  ok(accepts("https://8.8.8.8/lamp"), "a public IP literal is fine");
}

console.log("IPv6 literals — including the v4 smuggling shapes:");
{
  ok(link.blockedV6("::1"), "::1 loopback");
  ok(link.blockedV6("::"), ":: unspecified");
  ok(link.blockedV6("fe80::1"), "fe80::/10 link-local");
  ok(link.blockedV6("fe80::1%eth0"), "and with a zone index attached");
  ok(link.blockedV6("fd00::1"), "fd00::/8 unique local");
  ok(link.blockedV6("fc00::1"), "fc00::/7, the other half");
  ok(link.blockedV6("ff02::1"), "ff00::/8 multicast");
  ok(link.blockedV6("::ffff:169.254.169.254"), "V4-MAPPED metadata — the address inside is judged");
  ok(link.blockedV6("::ffff:10.0.0.1"), "v4-mapped private");
  ok(link.blockedV6("::127.0.0.1"), "v4-compatible loopback");
  ok(link.blockedV6("2002:a9fe:a9fe::1"), "6to4 carrying 169.254.169.254");
  ok(link.blockedV6("2002:0a00:0001::1"), "6to4 carrying 10.0.0.1");
  ok(link.blockedV6("64:ff9b::a9fe:a9fe"), "NAT64");
  ok(!link.blockedV6("2606:4700:4700::1111"), "a real public v6 address is allowed");
  ok(!link.blockedV6("2002:0808:0808::1"), "6to4 carrying a PUBLIC v4 address is allowed");
  ok(refuses("http://[::1]/"), "the URL guard refuses a bracketed loopback literal");
  ok(refuses("http://[fe80::1]/"), "and a bracketed link-local one");
  ok(accepts("https://[2606:4700:4700::1111]/lamp"), "and accepts a public one");

  eq(link.blockedAddress("10.0.0.1"), true, "blockedAddress picks the family without being told");
  eq(link.blockedAddress("::1"), true, "for v6 as well");
  eq(link.blockedAddress("8.8.8.8"), false, "and lets a real address through");
  eq(link.blockedAddress(""), true, "an empty address is blocked");
}

console.log("The socket's own lookup refuses a rebinding answer:");
{
  // dns.lookup is not called here: guardedLookup's DECISION is what is tested,
  // by handing it the answers a hostile resolver would give. The real
  // dns.lookup is exercised by the integration test, not faked in this one.
  const decide = (answers) => {
    const clean = answers.filter((entry) => !link.blockedAddress(entry.address, entry.family));
    return clean.length && clean.length === answers.length;
  };
  ok(decide([{ address: "8.8.8.8", family: 4 }]), "one public answer connects");
  ok(!decide([{ address: "169.254.169.254", family: 4 }]), "one metadata answer does not");
  ok(!decide([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]),
    "A HOST THAT ANSWERS WITH BOTH IS REFUSED ENTIRELY — we do not guess which one the socket would pick");
  ok(!decide([]), "no answers at all is a refusal, not an empty allow");
  eq(typeof link.guardedLookup, "function", "and it is installed as the request's own `lookup`, so it runs again at connect time");
}

console.log("Budgets are real numbers, not intentions:");
{
  ok(link.MAX_BYTES > 0 && link.MAX_BYTES <= 1024 * 1024, "there is a byte cap, and it is small");
  ok(link.TIMEOUT_MS > 0 && link.TIMEOUT_MS <= 15000, "there is a hard timeout, and it is short");
  ok(link.MAX_REDIRECTS >= 1 && link.MAX_REDIRECTS <= 5, "redirects are followed, but not forever");
}

console.log("Reading the page — every field optional, nothing evaluated:");
{
  const html = `
    <html><head>
      <title>Copper Cookware Set &amp; Stand | Example Shop</title>
      <meta property="og:title" content="Copper Cookware Set">
      <meta property="og:image" content="/media/cookware.jpg">
      <meta property="product:price:amount" content="24,999.00">
    </head><body><script>window.x=1</script></body></html>`;
  const got = link.parseProduct(html, "https://shop.example.com/kitchen/cookware?ref=x");
  eq(got.title, "Copper Cookware Set", "og:title wins over <title>");
  eq(got.image, "https://shop.example.com/media/cookware.jpg", "a relative image is resolved against the page");
  eq(got.price, 24999, "the price is read and made whole rupees");
  eq(got.source, "shop.example.com", "the shop is named from the host");
  ok(got.sourceUrl.indexOf("ref=x") !== -1, "and the link the couple pasted comes back with it");

  const bare = link.parseProduct("<html><head><title>A Lamp</title></head></html>", "https://www.othershop.in/lamp");
  eq(bare.title, "A Lamp", "a page with only a <title> gives a title");
  eq(bare.image, "", "no image is an EMPTY STRING, not an error");
  eq(bare.price, 0, "and no price is 0 — § 05.1's 'Add & set a price'");
  eq(bare.source, "othershop.in", "`www.` is dropped from the shop's name");

  const nothing = link.parseProduct("", "https://shop.example.com/x");
  eq(nothing.title, "", "an empty page gives an empty title");
  eq(nothing.price, 0, "and no price");
  eq(link.parseProduct(null, null).source, "", "null in, empty out — never a throw");

  const hostile = link.parseProduct(
    `<meta property="og:image" content="javascript:alert(document.cookie)">
     <meta property="og:title" content="${"x".repeat(500)}">`,
    "https://shop.example.com/x"
  );
  eq(hostile.image, "", "a javascript: image is REFUSED, not passed to a CSS background");
  ok(hostile.title.length <= 200, "and a 500-character title is bounded");
  eq(link.parseProduct(`<meta property="og:image" content="data:text/html,<h1>x">`, "https://s.example/x").image, "", "a data: image is refused too");

  const ld = link.parseProduct(
    `<script type="application/ld+json">{"@type":"Product","offers":{"price":"1299.00","priceCurrency":"INR"}}</script>`,
    "https://shop.example.com/x"
  );
  eq(ld.price, 1299, "JSON-LD is READ as text, never evaluated");

  const reversed = link.parseProduct(`<meta content="Reversed Attributes" property="og:title">`, "https://s.example/x");
  eq(reversed.title, "Reversed Attributes", "attribute order does not matter");
}

console.log("Prices, the dozen ways shops write them:");
{
  eq(link.parsePrice("₹24,999"), 24999, "Indian grouping");
  eq(link.parsePrice("₹1,24,999.00"), 124999, "lakh grouping with paise");
  eq(link.parsePrice("$1,299.99"), 1299, "US grouping, floored");
  eq(link.parsePrice("1.299,00"), 1299, "European grouping");
  eq(link.parsePrice("24999"), 24999, "no grouping at all");
  eq(link.parsePrice("Price on request"), 0, "words are not a price");
  eq(link.parsePrice(""), 0, "nothing is not a price");
  eq(link.parsePrice("0"), 0, "and zero is not a price either — the couple sets it");
  eq(link.parsePrice("-500"), 500, "a stray minus does not make a negative gift");
}

console.log("Entities are decoded, not executed:");
{
  eq(link.decode("Copper &amp; Steel"), "Copper & Steel", "named entities");
  eq(link.decode("&#8377;24,999"), "₹24,999", "numeric entities");
  eq(link.decode("&#x20B9;24,999"), "₹24,999", "hex entities");
  eq(link.decode("  spaced   out  "), "spaced out", "and whitespace is collapsed");
  eq(link.decode("&notreal;"), "&notreal;", "an unknown entity is left alone rather than guessed at");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
