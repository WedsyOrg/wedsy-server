// COUPLE APP INVARIANT 2 — REGISTRY → WALLET → PAYMENTS.
// Run: node tests/couple-wallet-ledger.test.js
// PURE unit tests (NO DATABASE). § 06.3: three screens, ONE ledger. Asserts:
//   • the balance is derived from the ledger, never stored
//   • a contribution's wallet credit is produced WITH the contribution, so the
//     controller cannot write one without the other
//   • "pay in full" is re-derived server-side (two guests cannot both succeed)
//   • the Pay-flow offset is computed from useWallet as a BOOLEAN — there is no
//     parameter a client-authored amount could arrive in
const wallet = require("../services/CoupleWalletService");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

console.log("The balance is the ledger:");
{
  eq(wallet.balance([]), 0, "an empty ledger is 0");
  eq(wallet.balance(null), 0, "a missing ledger is 0, not a throw");
  eq(wallet.balance([{ type: "credit", amount: 24000 }]), 24000, "a credit adds");
  eq(wallet.balance([{ type: "credit", amount: 24000 }, { type: "claim", amount: 10000 }]), 14000, "a claim subtracts");
  eq(wallet.balance([{ type: "credit", amount: 24000 }, { type: "debit", amount: 4000 }]), 20000, "a debit (wallet applied to a payment) subtracts");
  eq(wallet.balance([{ type: "claim", amount: 5000, status: "failed" }, { type: "credit", amount: 5000 }]), 5000, "a FAILED row moves nothing");
  eq(wallet.balance([{ type: "credit", amount: 5000 }, { type: "claim", amount: 5000, status: "pending" }]), 5000, "a PENDING claim has not left yet");
  eq(wallet.balance([{ type: "claim", amount: 5000 }, { type: "reversal", amount: 5000 }]), 0, "a reversal brings a failed claim back");
  eq(wallet.balance([{ type: "credit", amount: 100 }, { type: "claim", amount: 900 }]), 0, "a ledger that sums below zero reports 0 — never a debt offered as an offset");
  eq(wallet.balance([{ type: "mystery", amount: 900 }]), 0, "an unknown type moves nothing rather than guessing a direction");
}

console.log("A contribution and its credit are one write:");
{
  const w = wallet.contributionWrites({
    weddingId: "w1",
    gift: { _id: "i1", title: "Copper cookware", price: 24000, funded: 0 },
    giftType: "item",
    mode: "full",
    amount: 24000,
    guest: { name: "Meera Iyer", phone: "+91 98450 11223", note: "congratulations!" },
  });
  ok(Boolean(w.contribution) && Boolean(w.walletTxn), "both documents come back together");
  eq(w.walletTxn.amount, w.contribution.amount, "the credit is exactly the contribution");
  eq(w.walletTxn.type, "credit", "and it is a credit");
  eq(w.contribution.item, "i1", "an item contribution points at the item");
  eq(w.contribution.fund, null, "and not at a fund");
  eq(w.giftIncrement, 24000, "the gift's running total moves by the same amount ($inc, not read-modify-write)");
  eq(w.contribution.status, "settled", "settled money is what counts toward a balance");
}

console.log("'Pay in full' is re-derived, never taken from the client:");
{
  const item = { price: 24000, funded: 0 };
  eq(wallet.contributionAmount(item, "full", 1), 24000, "in full ignores what the client sent");
  eq(wallet.contributionAmount({ price: 24000, funded: 18000 }, "full", 24000), 6000, "in full on a part-funded gift is only what is left");
  eq(wallet.contributionAmount({ price: 24000, funded: 24000 }, "full", 24000), 0, "a gift already taken re-derives to 0 — the caller's 409 already_funded");
  eq(wallet.contributionAmount(item, "part", 5000), 5000, "chipping in is what the guest typed");
  eq(wallet.contributionAmount(item, "part", -5000), 0, "a negative chip-in is refused, not a refund");
  eq(wallet.contributionAmount(item, "part", "abc"), 0, "a nonsense amount is 0, not NaN in the ledger");
  eq(wallet.contributionAmount({ target: 80000, raised: 20000 }, "full", 1), 60000, "a fund 'in full' is the rest of the goal");
  eq(wallet.contributionAmount({ target: 80000, raised: 90000 }, "part", 5000), 5000, "an over-subscribed fund still accepts money");
}

console.log("The Pay-flow offset (useWallet is a BOOLEAN):");
{
  const partial = wallet.applyWallet(150000, 24000, true);
  eq(partial.walletApplied, 24000, "the whole balance is applied when the bill is bigger");
  eq(partial.gatewayAmount, 126000, "and the gateway is asked for the rest");
  ok(partial.fullyCovered === false, "not fully covered");

  const covered = wallet.applyWallet(20000, 24000, true);
  eq(covered.walletApplied, 20000, "the offset never exceeds the bill");
  eq(covered.gatewayAmount, 0, "a covered bill needs no gateway intent at all");
  ok(covered.fullyCovered === true, "fullyCovered says so");

  const off = wallet.applyWallet(150000, 24000, false);
  eq(off.walletApplied, 0, "useWallet false applies nothing");
  eq(off.gatewayAmount, 150000, "and the gateway is asked for all of it");

  eq(wallet.applyWallet(150000, 24000, "yes").walletApplied, 0, "only a real boolean true switches it on — a truthy string does not");
  eq(wallet.applyWallet(150000, 24000, 1).walletApplied, 0, "nor does a 1");
  eq(wallet.applyWallet(150000, 0, true).walletApplied, 0, "an empty wallet applies nothing");
  // The point of the whole signature: there is no argument for an amount.
  eq(wallet.applyWallet.length, 3, "applyWallet takes exactly (due, balance, useWallet) — no client amount can be passed");
}

console.log("Claiming to the bank:");
{
  const good = wallet.claimWrite({ weddingId: "w1", amount: 10000, walletBalance: 24000, initiatedBy: "u1" });
  ok(good.ok === true, "a claim within the balance is allowed");
  eq(good.txn.type, "claim", "it is a claim row");
  eq(good.txn.status, "pending", "and it sits pending for the 2–3 working days § 05.1 promises");
  eq(good.txn.amount, 10000, "for the amount asked");
  eq(good.txn.initiatedBy, "u1", "stamped with who moved it");

  const all = wallet.claimWrite({ weddingId: "w1", walletBalance: 24000 });
  eq(all.txn.amount, 24000, "no amount named claims everything — what the button says it does");

  const over = wallet.claimWrite({ weddingId: "w1", amount: 90000, walletBalance: 24000 });
  ok(over.ok === false && over.error === "insufficient_balance", "a claim beyond the balance is refused as a value, not an exception");
  const nothing = wallet.claimWrite({ weddingId: "w1", walletBalance: 0 });
  ok(nothing.ok === false && nothing.error === "nothing_to_claim", "an empty wallet has nothing to claim");
}

console.log("The three screens agree (end to end, in one ledger):");
{
  // A guest gives ₹24,000 → the couple's Pay modal offers exactly that.
  const ledger = [];
  const gift = wallet.contributionWrites({
    weddingId: "w1", gift: { _id: "i1", title: "Cookware", price: 24000, funded: 0 },
    giftType: "item", mode: "full", amount: wallet.contributionAmount({ price: 24000, funded: 0 }, "full"),
    guest: { name: "Meera" },
  });
  ledger.push(gift.walletTxn);
  eq(wallet.balance(ledger), 24000, "registry → wallet");

  const pay = wallet.applyWallet(150000, wallet.balance(ledger), true);
  ledger.push(wallet.debitWrite({ weddingId: "w1", paymentId: "y2", amount: pay.walletApplied }));
  eq(pay.walletApplied, 24000, "wallet → payments: the offset is the gift");
  eq(wallet.balance(ledger), 0, "and the ledger is spent — the same money cannot be offered twice");
  eq(wallet.applyWallet(150000, wallet.balance(ledger), true).walletApplied, 0, "a second pay is offered nothing");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
