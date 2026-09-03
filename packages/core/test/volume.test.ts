// Amount + date matching at volume: what a run's key matches teach about
// agreeing descriptions, weighed against how many items of an amount the
// date window holds. See docs/acceptance.md (6M rows).
import { describe, expect, it } from "vitest";
import { reconcile, type RecRecord } from "../src/recon/match";
import { KIND_CARD, KIND_CHEQUE, KIND_DEPOSIT, KIND_FEE, kindOf, kindsDiffer, NAME_NO_TEXT, NAME_NONE, nameAgreement, normText, partyWords } from "../src/recon/text";

const D = 45000;
const rec = (row: number, key: string | undefined, amount: number, date: number, text?: string): RecRecord => ({ row, key, amount, date, text });
const words = (s: string) => partyWords(normText(s));

const PLACE = ["Leeds", "Bristol", "Kent", "Cardiff", "York", "Essex", "Dundee", "Bath", "Derby", "Surrey", "Norfolk", "Exeter"];
const ADJ = ["North", "Blue", "Red", "Green", "Silver", "Oak", "Pine", "River", "Harbour", "Summit", "Kestrel", "Falcon"];
const NOUN = ["Traders", "Supplies", "Logistics", "Foods", "Engineering", "Consulting", "Media", "Systems", "Plastics", "Textiles", "Motors", "Pharma"];
const party = (k: number) => `${PLACE[k % 12]} ${ADJ[Math.floor(k / 12) % 12]} ${NOUN[Math.floor(k / 144) % 12]}`;

/** 400 pairs the reference pass matches, with descriptions the way a ledger and a bank write them: what the run learns from */
function keyed(): { a: RecRecord[]; b: RecRecord[] } {
  const a: RecRecord[] = [];
  const b: RecRecord[] = [];
  for (let k = 0; k < 400; k++) {
    const p = party(k * 7 + 3);
    const amt = 1000 + k * 3.17;
    a.push(rec(a.length, `INV-${10000 + k}`, amt, D + (k % 20), `Receipt - ${p} Ltd`));
    b.push(rec(b.length, `INV-${10000 + k}`, amt, D + (k % 20) + 1, `BGC ${p.toUpperCase()}`));
  }
  return { a, b };
}

/** strangers left over on both sides, with descriptions, at amounts nothing else has */
function strangers(a: RecRecord[], b: RecRecord[], n = 300) {
  for (let k = 0; k < n; k++) {
    a.push(rec(a.length, `PO-${50000 + k}`, -(20 + k * 1.13), D + (k % 20), `Payment to ${party(k * 11 + 5)}`));
    b.push(rec(b.length, undefined, 30 + k * 1.31, D + (k % 20), `FASTER PAYMENT RECEIVED ${party(k * 13 + 1).toUpperCase()}`));
  }
}

const pairs = (r: ReturnType<typeof reconcile>, rule: string) => r.matches.filter((m) => m.rule === rule).map((m) => [m.a[0], m.b[0]]);

describe("name agreement and kinds", () => {
  it("counts words in common, a truncated word too, and what's left over on each side", () => {
    const pw = words("Payment to Bristol Willow Plastics Ltd");
    expect(pw).toEqual(["BRISTOL", "WILLOW", "PLASTICS"]);
    // all three, nothing left over: 2 + 4·3
    expect(nameAgreement(pw, words("FPO BRISTOL WILLOW PLAS"))).toBe(14);
    // two in common, one left over on each side: 2 + 4·2 + 2 + 1
    expect(nameAgreement(pw, words("FPO BRISTOL WILLOW FARMS"))).toBe(13);
    expect(nameAgreement(pw, words("CHAPS FEE"))).toBe(NAME_NONE);
    expect(nameAgreement(null, words("FPO BRISTOL"))).toBe(NAME_NO_TEXT);
  });
  it("drops kind words and date stamps from party words", () => {
    expect(words("CARD PAYMENT TO OAK MEDIA ON 05MAR")).toEqual(["OAK", "MEDIA"]);
    expect(words("COUNTER CREDIT")).toEqual([]);
  });
  it("reads the kind of transaction a description names", () => {
    expect(kindOf(normText("CHAPS FEE"))).toBe(KIND_FEE);
    expect(kindOf(normText("Cheque 102918 Crown Metals"))).toBe(KIND_CHEQUE | KIND_DEPOSIT);
    expect(kindOf(normText("CARD PAYMENT TO OAK"))).toBe(KIND_CARD);
    expect(kindOf(normText("Payment to Oak Media"))).toBe(0);
    expect(kindsDiffer(kindOf(normText("Cheque 1 Oak")), kindOf(normText("CHEQUE DEPOSIT")))).toBe(false);
    expect(kindsDiffer(kindOf(normText("Cheque 1 Oak")), kindOf(normText("BANK CHARGES")))).toBe(true);
    expect(kindsDiffer(kindOf(normText("Payment to Oak")), kindOf(normText("BANK CHARGES")))).toBe(false);
  });
});

describe("amount and date at volume", () => {
  it("leaves an unpresented cheque alone among a crowd of bank fees of its amount (a small file still pairs them)", () => {
    const cheque = rec(0, "CHQ 123456", -15, D + 2, "Cheque 123456 Oak Media Ltd");
    const fees = Array.from({ length: 40 }, (_, k) => rec(k, undefined, -15, D + (k % 4), "CHAPS FEE"));
    // nothing to learn from: as before, nearest date
    expect(pairs(reconcile([cheque], fees), "amount+date")).toHaveLength(1);
    // in a run with key matches to learn from
    const { a, b } = keyed();
    strangers(a, b);
    const i = a.push({ ...cheque, row: a.length }) - 1;
    for (const f of fees) b.push({ ...f, row: b.length });
    const r = reconcile(a, b);
    expect(r.matches.some((m) => m.a.includes(i))).toBe(false);
    expect(r.unmatchedA).toContain(i);
  });

  it("pairs the bank line naming the same party, not a stranger sharing two of its three words", () => {
    const { a, b } = keyed();
    strangers(a, b);
    const i1 = a.push(rec(a.length, "PO-77001", -100, D + 5, "Payment to Bristol Willow Plastics Ltd")) - 1;
    const i2 = a.push(rec(a.length, "PO-77002", -100, D + 5, "Payment to Leeds Oak Media Ltd")) - 1;
    const j1 = b.push(rec(b.length, undefined, -100, D + 6, "FPO BRISTOL WILLOW FARMS")) - 1;
    const j2 = b.push(rec(b.length, undefined, -100, D + 6, "FPO LEEDS OAK MEDIA")) - 1;
    // a crowd of other parties paid 100.00 the same days
    for (let k = 0; k < 30; k++) b.push(rec(b.length, undefined, -100, D + 4 + (k % 4), `BACS ${party(k * 5 + 2).toUpperCase()}`));
    const r = reconcile(a, b);
    const ad = pairs(r, "amount+date").concat(pairs(r, "fuzzy"));
    expect(ad).toContainEqual([i2, j2]);
    expect(ad.some(([x, y]) => x === i1 || y === j1)).toBe(false);
  });

  it("without descriptions, pairs equal amounts when both sides hold about as many, not a lone item among a crowd", () => {
    const { a, b } = keyed();
    strangers(a, b);
    // balanced: five 250.00 receipts on each side over the same days
    const bal: number[] = [];
    for (let k = 0; k < 5; k++) {
      bal.push(a.push(rec(a.length, undefined, 250, D + k)) - 1);
      b.push(rec(b.length, undefined, 250, D + k + 1));
    }
    // a lone ledger 75.00 among ten bank lines of 75.00 the same days
    const lone = a.push(rec(a.length, undefined, 75, D + 10)) - 1;
    for (let k = 0; k < 10; k++) b.push(rec(b.length, undefined, 75, D + 9 + (k % 3)));
    const r = reconcile(a, b);
    const matched = new Set(pairs(r, "amount+date").map(([x]) => x));
    for (const i of bal) expect(matched.has(i)).toBe(true);
    expect(matched.has(lone)).toBe(false);
  });

  it("flags a keying error with the party's own line among many lines at the keyed amount", () => {
    const { a, b } = keyed();
    strangers(a, b);
    const i = a.push(rec(a.length, "PO-88001", -20.5, D + 3, "Payment to Leeds Willow Textiles Ltd")) - 1;
    const j = b.push(rec(b.length, undefined, -25, D + 3, "FPO LEEDS WILLOW TEXTILES")) - 1;
    for (let k = 0; k < 40; k++) b.push(rec(b.length, undefined, -25, D + 2 + (k % 3), "SERVICE CHARGE"));
    const r = reconcile(a, b);
    expect(r.flags).toContainEqual({ a: i, b: j, field: "amount", kind: "transposition", mismatched: false });
  });
});

describe("duplicates at volume", () => {
  it("doesn't list a routine fee that falls twice on one day, but still lists a posting keyed twice", () => {
    const a: RecRecord[] = [];
    // the same fee most days of the month, twice on some
    for (let d = 0; d < 30; d++) {
      a.push(rec(a.length, undefined, -5, D + d, "SERVICE CHARGE"));
      if (d % 5 === 0) a.push(rec(a.length, undefined, -5, D + d, "SERVICE CHARGE"));
    }
    a.push(rec(a.length, undefined, -61.2, D + 4, "BACS OAK MEDIA"), rec(a.length + 1, undefined, -61.2, D + 4, "BACS OAK MEDIA"));
    const r = reconcile(a, []);
    expect(r.duplicates).toEqual([{ side: "A", items: [a.length - 2, a.length - 1] }]);
  });
});
