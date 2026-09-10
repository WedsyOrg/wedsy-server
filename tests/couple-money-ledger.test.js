// COUPLE APP § 06.3 INVARIANT 2, AT THE MONEY ENDPOINTS — the offset, the race
// and the ledger.
// Run: node tests/couple-money-ledger.test.js
//
// PURE unit tests (NO DATABASE). tests/couple-wallet-ledger.test.js asserts the
// foundation's arithmetic; this file asserts what the ENDPOINTS do with it:
//
//   • the offset in both directions, and that it cannot be client-supplied
//   • `mode: "full"` re-derived server-side, and the already-funded race
//   • a fund is never capped, a priced item always is
//   • the ledger summing to the right balance across credit / debit / claim /
//     reversal, and the SPENDABLE figure that stops the same rupees being
//     claimed twice while a claim is in flight
//   • a payment row shaped into the client's vocabulary
const wallet = require("../services/CoupleWalletService");
const rules = require("../services/CoupleRegistryRules");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

/* ────────────────────────────────────────────────────────────── the offset */

console.log("The Pay-flow offset, in both directions:");
{
  // Wallet smaller than the bill: the wallet is spent, the gateway takes the rest.
  const small = wallet.applyWallet(150000, 24000, true);
  eq(small.walletApplied, 24000, "a small wallet is applied in full");
  eq(small.gatewayAmount, 126000, "and the gateway takes the remainder");
  eq(small.fullyCovered, false, "so the row is not covered");

  // Wallet larger than the bill: only the bill leaves the wallet.
  const big = wallet.applyWallet(24000, 150000, true);
  eq(big.walletApplied, 24000, "a large wallet is applied only up to the bill");
  eq(big.gatewayAmount, 0, "there is nothing for the gateway");
  eq(big.fullyCovered, true, "and the row is covered outright");

  // Exactly equal.
  const exact = wallet.applyWallet(50000, 50000, true);
  eq(exact.walletApplied, 50000, "an exact wallet covers exactly");
  eq(exact.fullyCovered, true, "and is a covered row, not a ₹0 gateway call");

  // Off.
  const off = wallet.applyWallet(150000, 24000, false);
  eq(off.walletApplied, 0, "unchecked, nothing leaves the wallet");
  eq(off.gatewayAmount, 150000, "and the gateway takes the whole bill");
  eq(off.fullyCovered, false, "an uncovered row");

  eq(wallet.applyWallet(150000, 0, true).walletApplied, 0, "an empty wallet applies nothing");
  eq(wallet.applyWallet(0, 90000, true).walletApplied, 0, "a ₹0 bill takes nothing out of the wallet");
}

console.log("The offset CANNOT be client-supplied:");
{
  // The only door a Pay request comes through.
  const hostile = rules.payBody({
    method: "upi",
    useWallet: true,
    amount: 1,                 // ← a client-authored bill
    walletApplied: 999999,     // ← a client-authored debit
    gatewayAmount: 0,
    balance: 999999,
    spendable: 999999,
  });
  eq(Object.keys(hostile).sort().join(","), "method,useWallet", "payBody emits exactly two keys — there is no third to carry an amount");
  eq(hostile.walletApplied, undefined, "`walletApplied` does not survive the door");
  eq(hostile.amount, undefined, "`amount` does not survive the door");
  eq(hostile.gatewayAmount, undefined, "`gatewayAmount` does not survive the door");

  // And the function that computes it has nowhere to put one either.
  eq(wallet.applyWallet.length, 3, "applyWallet takes exactly three arguments");
  const extra = wallet.applyWallet(150000, 24000, true, 999999);
  eq(extra.walletApplied, 24000, "a fourth argument changes nothing — it is not a parameter");

  eq(rules.payBody({ useWallet: "true" }).useWallet, false, "the STRING 'true' is not true — a serialised checkbox cannot spend gift money");
  eq(rules.payBody({ useWallet: 1 }).useWallet, false, "nor is 1");
  eq(rules.payBody({ useWallet: true }).useWallet, true, "only the boolean is");
  eq(rules.payBody({}).method, "upi", "a missing method falls back rather than reaching the gateway empty");
  eq(rules.payBody({ method: "bitcoin" }).method, "upi", "a method outside the four is not passed through");
  eq(rules.payBody({ method: "CARD" }).method, "card", "and a real one is normalised");
  eq(rules.payBody(null).useWallet, false, "no body at all is not a payout");
}

/* ─────────────────────────────────────────────── mode: "full" and the race */

console.log("`mode: \"full\"` is re-derived server-side:");
{
  const fresh = { price: 24000, funded: 0 };
  eq(wallet.contributionAmount(fresh, "full"), 24000, "an untouched gift costs its price");
  eq(rules.fullReserve(fresh).amount, 24000, "and the reserve agrees");

  const part = { price: 24000, funded: 9000 };
  eq(wallet.contributionAmount(part, "full"), 15000, "a part-funded gift costs what is left");
  eq(rules.fullReserve(part).amount, 15000, "and the reserve agrees");

  // What a guest typed is irrelevant on the "full" path.
  eq(wallet.contributionAmount(part, "full", 1), 15000, "the guest's own figure is not consulted");
  eq(wallet.contributionAmount(part, "full", 999999), 15000, "in either direction");
}

console.log("Two guests cannot both pay in full — the 409:");
{
  // Guest A's conditional update matched the row and set funded = price.
  const before = { _id: "i1", price: 24000, funded: 0 };
  const a = rules.fullReserve(before);
  ok(a.ok, "the first guest wins");
  eq(a.amount, 24000, "and is charged the whole price");

  // Guest B now reads the row Guest A left behind. Their update matches
  // nothing, and the same pure function says what they are told.
  const after = { _id: "i1", price: 24000, funded: 24000 };
  const b = rules.fullReserve(after);
  eq(b.ok, false, "the second guest does not");
  eq(b.refusal.status, 409, "409, not 500 and not a silent double charge");
  eq(b.refusal.body.error, "already_funded", "with the code the client renders");
  eq(b.refusal.body.funded, 24000, "and the numbers to say why");
  eq(b.refusal.body.price, 24000, "both of them");

  // The degenerate case: no price yet is not "free".
  const priceless = rules.fullReserve({ price: 0, funded: 0 });
  eq(priceless.ok, false, "a gift with no price cannot be taken in full");
  eq(priceless.refusal.status, 422, "it is a question for the guest, not a race");
}

console.log("Chipping in: a priced item is capped, a fund never is:");
{
  const item = { price: 24000, funded: 20000 };
  eq(rules.partReserve(item, 4000).ok, true, "the last ₹4,000 is accepted");
  eq(rules.partReserve(item, 4000).amount, 4000, "at exactly that");
  const over = rules.partReserve(item, 9000);
  eq(over.ok, false, "₹9,000 into a ₹4,000 hole is refused");
  eq(over.refusal.status, 422, "as a 422 the guest can correct");
  ok(String(over.refusal.body.fields.amount).indexOf("4,000") !== -1, "and it names what is left");

  const taken = rules.partReserve({ price: 24000, funded: 24000 }, 1000);
  eq(taken.refusal.status, 409, "chipping into a finished gift is the same 409");

  eq(rules.partReserve({ price: 0, funded: 0 }, 5000).ok, true, "a gift with no price yet has no ceiling");
  eq(rules.partReserve(item, 0).refusal.status, 422, "nothing is not an amount");
  eq(rules.partReserve(item, -500).refusal.status, 422, "and neither is a negative");

  // A fund is a goal. contributionAmount reads target/raised, and the service
  // never calls partReserve for one.
  eq(wallet.contributionAmount({ target: 80000, raised: 79000 }, "part", 20000), 20000, "a fund accepts money past its target");
  eq(wallet.contributionAmount({ target: 80000, raised: 80000 }, "full"), 0, "a met fund has nothing left to 'complete'");
}

/* ────────────────────────────────────────────────────────── the whole ledger */

console.log("The ledger sums to the right balance across all four types:");
{
  const ledger = [
    { type: "credit", amount: 24000, status: "settled" },   // a gift
    { type: "credit", amount: 18000, status: "settled" },   // another
    { type: "debit", amount: 12000, status: "settled" },    // applied to a payment
    { type: "claim", amount: 10000, status: "settled" },    // gone to the bank
    { type: "claim", amount: 5000, status: "failed" },      // never left
    { type: "reversal", amount: 5000, status: "settled" },  // a failed claim, back
  ];
  eq(wallet.balance(ledger), 24000 + 18000 - 12000 - 10000 + 5000, "credits and reversals up, debits and claims down");

  const payload = rules.walletPayload(ledger);
  eq(payload.balance, 25000, "the payload's balance is the ledger's balance");
  eq(payload.credited, 47000, "credited counts the credits and the reversal");
  eq(payload.claimed, 22000, "claimed counts the debit and the settled claim");
  eq(payload.transactions.length, 6, "every row is readable, including the failed one");
  eq(payload.transactions[0].id, null, "a row with no _id shapes to a null id rather than throwing");
  ok(payload.transactions.every((t) => t.amount >= 0), "every amount is positive — the type carries the sign");
  eq(rules.walletPayload([]).balance, 0, "an empty ledger is 0");
  eq(rules.walletPayload(null).balance, 0, "a missing ledger is 0, not a throw");
  ok(!Object.prototype.hasOwnProperty.call(payload, "stored"), "there is no stored balance in the payload");
}

console.log("SPENDABLE — the same rupees cannot be claimed twice:");
{
  const withClaimInFlight = [
    { type: "credit", amount: 50000, status: "settled" },
    { type: "claim", amount: 50000, status: "pending" },
  ];
  eq(wallet.balance(withClaimInFlight), 50000, "the balance still shows the money — it has not left the bank yet");
  eq(rules.pendingOutflow(withClaimInFlight), 50000, "but ₹50,000 is already promised");
  eq(rules.spendable(withClaimInFlight), 0, "so nothing is spendable, and a second claim is refused");

  const reserved = [
    { type: "credit", amount: 50000, status: "settled" },
    { type: "debit", amount: 20000, status: "pending" },  // reserved for a payment in progress
  ];
  eq(rules.spendable(reserved), 30000, "a debit reserved against an intent is not offered again");
  eq(wallet.applyWallet(90000, rules.spendable(reserved), true).walletApplied, 30000, "and the next Pay modal offers only what is left");

  const pendingCredit = [
    { type: "credit", amount: 9000, status: "pending" },   // an unsettled gateway intent
    { type: "credit", amount: 1000, status: "settled" },
  ];
  eq(rules.spendable(pendingCredit), 1000, "a pending CREDIT is not spendable either — it is not money yet");
  eq(rules.pendingOutflow(pendingCredit), 0, "and it is not an outflow");

  eq(rules.spendable([{ type: "claim", amount: 5000, status: "pending" }]), 0, "spendable never goes negative");
}

console.log("The claim refuses more than is spendable:");
{
  const ledger = [
    { type: "credit", amount: 40000, status: "settled" },
    { type: "claim", amount: 15000, status: "pending" },
  ];
  const available = rules.spendable(ledger);
  eq(available, 25000, "₹25,000 is genuinely available");
  eq(wallet.claimWrite({ weddingId: "w", amount: 40000, walletBalance: available }).ok, false, "the whole balance cannot be claimed while ₹15,000 is in flight");
  eq(wallet.claimWrite({ weddingId: "w", amount: 40000, walletBalance: available }).error, "insufficient_balance", "and it says why");
  const all = wallet.claimWrite({ weddingId: "w", walletBalance: available });
  eq(all.ok, true, "claiming with no amount named claims what is there");
  eq(all.txn.amount, 25000, "which is the spendable figure, not the balance");
  eq(all.txn.status, "pending", "and it sits pending for the 2–3 working days § 05.1 promises");
  eq(wallet.claimWrite({ weddingId: "w", walletBalance: 0 }).error, "nothing_to_claim", "an empty wallet has nothing to claim");
}

/* ──────────────────────────────────────────────── the § 07.1 chain, end to end */

console.log("§ 07.1 M4 — a gift becomes the next payment's offset with no step in between:");
{
  const ledger = [];

  // A guest takes a ₹24,000 gift in full on the public route.
  const reserve = rules.fullReserve({ _id: "i1", title: "Copper cookware", price: 24000, funded: 0 });
  const writes = wallet.contributionWrites({
    weddingId: "w1", gift: { _id: "i1", title: "Copper cookware", price: 24000, funded: 0 },
    giftType: "item", mode: "full", amount: reserve.amount, guest: { name: "Meera Iyer" },
  });
  ledger.push(writes.walletTxn);
  eq(rules.walletPayload(ledger).balance, 24000, "the gift is in the wallet before the response returns");

  // The couple opens the Pay modal on a ₹1,50,000 instalment and ticks the box.
  const applied = wallet.applyWallet(150000, rules.spendable(ledger), rules.payBody({ method: "upi", useWallet: true }).useWallet);
  eq(applied.walletApplied, 24000, "the offset offered is exactly that gift");
  eq(applied.gatewayAmount, 126000, "and the gateway is asked for the rest");

  ledger.push(wallet.debitWrite({ weddingId: "w1", paymentId: "y2", amount: applied.walletApplied }));
  eq(rules.walletPayload(ledger).balance, 0, "the wallet is spent");
  eq(wallet.applyWallet(150000, rules.spendable(ledger), true).walletApplied, 0, "and the same money is never offered twice");
}

/* ───────────────────────────────────────────────────────── payment shaping */

console.log("A Payment row, in the client's vocabulary:");
{
  const due = rules.shapePayment({
    _id: "y2", amount: 150000, amountPaid: 0, amountDue: 150000, status: "created",
    coupleApp: { label: "Venue hold — Taj West End", vendor: "Taj West End", ref: "WD-2026-0518", dueDate: "2026-09-20", walletApplied: 0 },
  });
  eq(due.status, "due", "an unpaid row reads 'due', not the gateway's 'created'");
  eq(due.amount, 150000, "the amount is the row's");
  eq(due.outstanding, 150000, "and nothing has been paid");
  eq(due.label, "Venue hold — Taj West End", "the label is the couple's, not the CRM's");
  eq(due.vendor, "Taj West End", "with the vendor");
  eq(due.method, "", "and no method until there is one");

  const paid = rules.shapePayment({ _id: "y1", amount: 85000, amountPaid: 85000, amountDue: 0, status: "paid", paymentMethod: "upi", coupleApp: { label: "Booking advance", walletApplied: 24000 } });
  eq(paid.status, "paid", "a paid row reads paid");
  eq(paid.walletApplied, 24000, "and says how much of it came from the gift wallet");
  eq(paid.outstanding, 0, "with nothing outstanding");

  eq(rules.outstanding({ amount: 100000, amountPaid: 40000 }), 60000, "outstanding falls back to amount − paid when amountDue is absent");
  eq(rules.outstanding({ amount: 100000, amountPaid: 0, amountDue: 999999 }), 100000, "and can never exceed the row itself");
  eq(rules.outstanding({}), 0, "an empty row owes nothing rather than NaN");
  eq(rules.shapePayment({}).status, "due", "a row with no status is not silently paid");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
