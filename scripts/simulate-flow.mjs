/**
 * End-to-end flow simulator ("the whole thing, like an app").
 *
 * One command drives the LIVE dev server through the REAL public surfaces —
 * the device-facing Agent API and the buyer-facing Internal API — exactly the
 * way a supplier's Android agent and the Main Platform would, with real
 * credentials, real HMAC signing, real replay nonces. Nothing is mocked; every
 * step is a genuine HTTP round-trip against http://127.0.0.1:3001, and each
 * outcome is re-verified by reading the PostgreSQL rows the server wrote.
 *
 * The staged flow:
 *   0. Seed (Prisma): a fresh SIMULATOR device + minted device credential under
 *      the approved demo partner, plus the Main Platform's Internal-API HMAC
 *      service credential. (The partner, its active wa/ID/any offer, and the
 *      pricing config already exist.)
 *   1. Agent API  · POST /numbers/register        -> a +62 number appears
 *   2. Agent API  · POST /numbers/{id}/availability-> number goes AVAILABLE
 *   3. Agent API  · POST /heartbeat                -> device proves liveness
 *   4. Internal API· POST /orders/reserve (HMAC)   -> buyer reserves it, waiting_sms
 *   5. Agent API  · POST /sms  (OTP body)          -> OTP matched, order success
 *   6. Verify (DB): one PENDING earning at the payout price, a zero-sum ledger
 *      event, number released back to AVAILABLE.
 *
 * Usage:  node scripts/simulate-flow.mjs
 * Env:    SIM_BASE_URL (default http://127.0.0.1:3001)
 *
 * Secrets are read from the local .env (never printed, never committed).
 */
import { createRequire } from "node:module";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// .env loader (local only — values are used, never logged)
// ---------------------------------------------------------------------------
function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}
const env = loadEnv(join(ROOT, ".env"));

const BASE = process.env.SIM_BASE_URL ?? "http://127.0.0.1:3001";
const APP_DB = env.PARTNER_DATABASE_URL;
const HMAC_CLIENT = env.PARTNER_INTERNAL_API_HMAC_CLIENT_ID;
const HMAC_KEYID = env.PARTNER_INTERNAL_API_HMAC_CURRENT_KEY_ID;
const HMAC_SECRET = env.PARTNER_INTERNAL_API_HMAC_CURRENT_SECRET;
const PEPPER = env.PARTNER_DEVICE_CREDENTIAL_PEPPER;

for (const [k, v] of Object.entries({
  PARTNER_DATABASE_URL: APP_DB,
  PARTNER_INTERNAL_API_HMAC_CLIENT_ID: HMAC_CLIENT,
  PARTNER_INTERNAL_API_HMAC_CURRENT_KEY_ID: HMAC_KEYID,
  PARTNER_INTERNAL_API_HMAC_CURRENT_SECRET: HMAC_SECRET,
  PARTNER_DEVICE_CREDENTIAL_PEPPER: PEPPER,
})) {
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
}

// Prisma datasource reads env("PARTNER_DATABASE_URL").
process.env.PARTNER_DATABASE_URL = APP_DB;
const { PrismaClient } = require(join(ROOT, "src/generated/prisma"));
const prisma = new PrismaClient();

// The demo partner + its active wa/ID/any offer + pricing config already exist.
const DEMO_PARTNER_ID = "c77dd806-6b65-45cb-ac8a-5b20b7307572";
// Internal API reserve wire shape uses short field names (route maps them to *Code).
const FILTER = { service: "wa", country: "ID", operator: "any" };
// Verbatim real-world WhatsApp Business SMS: the code arrives dashed (718-891)
// and the parser normalizes it to six digits — the live run proves the real
// wire format, not a synthetic body.
const OTP_WIRE = "718-891";
const OTP = "718891";
const SMS_BODY = [
  "Akun WhatsApp Business Anda sedang didaftarkan di perangkat baru",
  "",
  "Jangan bagikan kode dengan siapa pun",
  `Kode WhatsApp Business Anda: ${OTP_WIRE}`,
  "rJbA/XP1K+V",
].join("\n");
const SMS_SENDER = "WhatsAppBusiness";

// The resent code: services routinely issue a second one when the buyer taps
// "kirim ulang". Different digits, same real dashed wire format.
const OTP2_WIRE = "204-517";
const OTP2 = "204517";
const SMS_BODY2 = [
  "Akun WhatsApp Business Anda sedang didaftarkan di perangkat baru",
  "",
  "Jangan bagikan kode dengan siapa pun",
  `Kode WhatsApp Business Anda: ${OTP2_WIRE}`,
  "rJbA/XP1K+V",
].join("\n");

// ---------------------------------------------------------------------------
// Pretty logging
// ---------------------------------------------------------------------------
const C = {
  head: (s) => `\x1b[1;36m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
let stepNo = 0;
function step(title) { console.log(`\n${C.head(`── ${++stepNo}. ${title}`)}`); }
function ok(msg) { console.log(`   ${C.ok("✓")} ${msg}`); }
function info(msg) { console.log(`   ${C.dim("·")} ${C.dim(msg)}`); }
function die(msg, extra) {
  console.log(`   ${C.bad("✗ " + msg)}`);
  if (extra !== undefined) console.log(C.dim("     " + JSON.stringify(extra)));
  throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Crypto / wire helpers
// ---------------------------------------------------------------------------
const nowSec = () => Math.floor(Date.now() / 1000);
const nonce = () => randomBytes(16).toString("hex"); // 128-bit, 32 hex chars
const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** Device-facing Agent API call: `Authorization: Device <pub>.<secret>` + replay headers. */
async function agent(method, path, body, cred, { idempotency } = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = {
    "content-type": "application/json",
    "x-forwarded-proto": "https",
    authorization: `Device ${cred.publicId}.${cred.secret}`,
    "x-agent-timestamp": String(nowSec()),
    "x-agent-nonce": nonce(),
  };
  if (idempotency) headers["idempotency-key"] = idempotency;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: raw || undefined });
  const text = await res.text();
  return { status: res.status, json: safeJson(text), text };
}

/** Buyer-facing Internal API call: HMAC-SHA256 over the canonical string. */
async function internal(method, path, body, { idempotency } = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = String(nowSec());
  const n = nonce();
  const idem = idempotency ?? "";
  const canonical = [method.toUpperCase(), path, ts, n, sha256hex(raw), idem].join("\n");
  const signature = createHmac("sha256", HMAC_SECRET).update(canonical, "utf8").digest("hex");
  const headers = {
    "content-type": "application/json",
    "x-forwarded-proto": "https",
    "x-kk-client-id": HMAC_CLIENT,
    "x-kk-key-id": HMAC_KEYID,
    "x-kk-timestamp": ts,
    "x-kk-nonce": n,
    "x-kk-signature": signature,
  };
  if (idempotency) headers["idempotency-key"] = idempotency;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: raw || undefined });
  const text = await res.text();
  return { status: res.status, json: safeJson(text), text };
}

function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }
const rupiah = (n) => "Rp" + Number(n).toLocaleString("id-ID");

// ---------------------------------------------------------------------------
// Preflight: is the dev server up?
// ---------------------------------------------------------------------------
async function assertServerUp() {
  try {
    await fetch(`${BASE}/api/agent/v1`, { method: "GET" });
  } catch {
    console.error(C.bad(`\nDev server tidak menjawab di ${BASE}.`));
    console.error(C.dim("Jalankan dulu di terminal lain:  npm run dev   (port 3001)\n"));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Step 0 — seed the service credential + a fresh simulator device
// ---------------------------------------------------------------------------
async function seed() {
  step("Setup — kredensial layanan Internal API + device simulator baru");

  // Internal API HMAC service credential (idempotent on clientId+keyId).
  const existingSvc = await prisma.serviceCredential.findUnique({
    where: { clientId_keyId: { clientId: HMAC_CLIENT, keyId: HMAC_KEYID } },
  });
  if (!existingSvc) {
    await prisma.serviceCredential.create({
      data: {
        clientId: HMAC_CLIENT,
        keyId: HMAC_KEYID,
        secretHash: sha256hex(`svc:${HMAC_CLIENT}:${HMAC_KEYID}:${randomUUID()}`),
        status: "ACTIVE",
      },
    });
    ok(`Service credential dibuat (client=${HMAC_CLIENT}, key=${HMAC_KEYID}, status=active)`);
  } else if (existingSvc.status !== "ACTIVE") {
    await prisma.serviceCredential.update({
      where: { id: existingSvc.id },
      data: { status: "ACTIVE", revokedAt: null },
    });
    ok("Service credential yang ada diaktifkan kembali");
  } else {
    ok("Service credential sudah aktif (dipakai ulang)");
  }

  // Make this run deterministic: park any leftover AVAILABLE numbers (from a
  // prior sim run) OFFLINE so the number we register below is the sole reserve
  // candidate. Safe in this dev DB — the only supply here is simulator supply.
  const parked = await prisma.partnerNumber.updateMany({
    where: { status: "AVAILABLE" }, data: { status: "OFFLINE", currentOrderId: null },
  });
  if (parked.count > 0) info(`${parked.count} nomor AVAILABLE sisa run sebelumnya di-park ke OFFLINE`);

  // A fresh ONLINE simulator device under the approved demo partner.
  const deviceId = randomUUID();
  await prisma.partnerDevice.create({
    data: {
      id: deviceId,
      partnerId: DEMO_PARTNER_ID,
      type: "SIMULATOR",
      label: `Sim Driver ${new Date().toISOString().slice(11, 19)}`,
      effectiveStatus: "ONLINE",
      lastSeenAt: new Date(),
      capabilitiesJson: { sms: true, notification: false, resend: false, operator: null, slots: 1 },
    },
  });

  // Mint a device credential: secret shown once; only the hash is stored.
  const publicId = randomBytes(16).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const secretHash = sha256hex(`${PEPPER} ${deviceId} ${secret}`);
  await prisma.deviceCredential.create({
    data: { partnerId: DEMO_PARTNER_ID, deviceId, publicId, secretHash, status: "ACTIVE" },
  });

  ok(`Device simulator ONLINE dibuat (id ${deviceId.slice(0, 8)}…, kapabilitas sms:true, 1 slot)`);
  info(`Kredensial device dicetak — secret 256-bit hanya di memori proses ini`);
  return { deviceId, cred: { publicId, secret } };
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
async function main() {
  console.log(C.bold("\n╔══════════════════════════════════════════════════════════════╗"));
  console.log(C.bold("║   KirimKode Partner — Simulasi Alur End-to-End (live server)  ║"));
  console.log(C.bold("╚══════════════════════════════════════════════════════════════╝"));
  console.log(C.dim(`   Target   : ${BASE}`));
  console.log(C.dim(`   Partner  : Demo Supplier (${DEMO_PARTNER_ID.slice(0, 8)}…)`));

  await assertServerUp();
  const { deviceId, cred } = await seed();

  // -- 1. Agent registers a number -----------------------------------------
  step("Agent API — device mendaftarkan nomor  (POST /numbers/register)");
  // Canonical rule: +628 then a non-zero digit then 8-11 more digits.
  const number = "+628" + (1 + Math.floor(Math.random() * 9))
    + Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join("");
  const reg = await agent("POST", "/api/agent/v1/numbers/register",
    { number, operator: "any" }, cred, { idempotency: randomUUID() });
  if (reg.status >= 400) die(`register gagal (HTTP ${reg.status})`, reg.json ?? reg.text);
  const numRow = await prisma.partnerNumber.findFirst({
    where: { deviceId, canonicalNumber: number },
    select: { id: true, status: true, canonicalNumber: true },
  });
  if (!numRow) die("nomor tidak ditemukan di DB setelah register");
  ok(`Nomor ${C.bold(number)} terdaftar (HTTP ${reg.status}, status awal: ${numRow.status})`);

  // -- 2. Agent flips it AVAILABLE -----------------------------------------
  step("Agent API — device mengumumkan nomor tersedia  (POST /numbers/{id}/availability)");
  const avail = await agent("POST", `/api/agent/v1/numbers/${numRow.id}/availability`,
    { requested: "available" }, cred, { idempotency: randomUUID() });
  if (avail.status >= 400) die(`availability gagal (HTTP ${avail.status})`, avail.json ?? avail.text);
  let after = await prisma.partnerNumber.findUnique({
    where: { id: numRow.id }, select: { status: true },
  });
  if (after.status !== "AVAILABLE") die(`nomor belum AVAILABLE (status: ${after.status})`);
  ok(`Nomor sekarang ${C.ok("AVAILABLE")} — siap dijual (HTTP ${avail.status})`);

  // -- 3. Heartbeat ---------------------------------------------------------
  step("Agent API — heartbeat device  (POST /heartbeat)");
  const hb = await agent("POST", "/api/agent/v1/heartbeat",
    { metadata: { battery: 87, network: "wifi" }, capabilities: { sms: true, slots: 1 } }, cred);
  if (hb.status >= 400) die(`heartbeat gagal (HTTP ${hb.status})`, hb.json ?? hb.text);
  ok(`Heartbeat diterima (HTTP ${hb.status}) — device hidup & liveness tercatat`);

  // -- 4. Buyer reserves via the Internal API ------------------------------
  step("Internal API — buyer memesan nomor  (POST /orders/reserve, HMAC-signed)");
  const buyerOrderRef = `buyer-${randomUUID()}`;
  const buyerAccountRef = `acct-${randomUUID()}`;
  const reserve = await internal("POST", "/api/internal/v1/orders/reserve",
    { buyerOrderRef, buyerAccountRef, filter: FILTER, quoteVersion: 1 },
    { idempotency: `reserve-${randomUUID()}` });
  if (reserve.status >= 400) die(`reserve gagal (HTTP ${reserve.status})`, reserve.json ?? reserve.text);
  const order = await prisma.partnerOrder.findFirst({
    where: { buyerOrderRef },
    select: { id: true, status: true, partnerId: true },
  });
  if (!order) die("order tidak ditemukan di DB setelah reserve");
  const snap = await prisma.orderSnapshot.findUnique({
    where: { orderId: order.id },
    select: { basePriceIdr: true, retailPriceIdr: true, payoutIdr: true, platformMarginIdr: true },
  });
  const boundNumber = await prisma.partnerNumber.findUnique({
    where: { id: numRow.id }, select: { status: true, currentOrderId: true },
  });
  if (order.status !== "WAITING_SMS") die(`order status tak terduga: ${order.status}`);
  if (boundNumber.currentOrderId !== order.id) die("nomor tidak terikat ke order ini");
  ok(`Order ${C.bold(order.id.slice(0, 8) + "…")} dibuat, status ${C.ok("WAITING_SMS")} (HTTP ${reserve.status})`);
  info(`Nomor terpilih terikat & status jadi ${boundNumber.status}`);
  info(`Harga terkunci — retail ${rupiah(snap.retailPriceIdr)}, payout partner ${rupiah(snap.payoutIdr)}, margin platform ${rupiah(snap.platformMarginIdr)}`);

  // -- 5. Agent delivers the OTP SMS ---------------------------------------
  step("Agent API — device menerima SMS berisi OTP  (POST /sms)");
  const sms = await agent("POST", "/api/agent/v1/sms",
    { numberId: numRow.id, messageId: randomUUID(), sender: SMS_SENDER, body: SMS_BODY, receivedAt: Date.now() - 1000 },
    cred, { idempotency: randomUUID() });
  if (sms.status >= 400) die(`SMS ingest gagal (HTTP ${sms.status})`, sms.json ?? sms.text);
  const successOrder = await prisma.partnerOrder.findUnique({
    where: { id: order.id },
    select: { status: true, otpFingerprint: true, otpKeyVersion: true },
  });
  if (successOrder.status !== "SUCCESS") die(`order belum SUCCESS (status: ${successOrder.status})`);
  ok(`SMS cocok — OTP format asli "${OTP_WIRE}" ternormalisasi & order ${C.ok("SUCCESS")} (HTTP ${sms.status})`);
  info(`OTP disimpan terenkripsi (fingerprint ${String(successOrder.otpFingerprint).slice(0, 12)}…, key v${successOrder.otpKeyVersion}) — plaintext tak pernah tersimpan`);

  // -- 6. Verify the money + that the number is still held -----------------
  step("Verifikasi (DB) — earning, ledger, nomor masih ditahan");
  const earnings = await prisma.partnerEarning.findMany({
    where: { orderId: order.id }, select: { id: true, amountIdr: true, status: true },
  });
  if (earnings.length !== 1) die(`jumlah earning tak terduga: ${earnings.length}`);
  const earning = earnings[0];
  if (earning.amountIdr !== snap.payoutIdr) die(`nilai earning ${earning.amountIdr} != payout ${snap.payoutIdr}`);
  ok(`Tepat 1 earning ${C.ok(earning.status)} sebesar ${C.bold(rupiah(earning.amountIdr))} tercatat untuk partner`);

  const successTx = await prisma.ledgerTransaction.findFirst({
    where: { referenceType: "order", referenceId: order.id },
    select: { id: true, entries: { select: { amountIdrSigned: true } } },
  });
  if (!successTx) die("ledger event order-success tidak ditemukan");
  const sum = successTx.entries.reduce((t, e) => t + e.amountIdrSigned, 0);
  if (sum !== 0) die(`ledger tidak zero-sum (jumlah ${sum})`);
  ok(`Ledger double-entry order-success balance (${successTx.entries.length} entri, jumlah bertanda = 0)`);

  const heldNumber = await prisma.partnerNumber.findUnique({
    where: { id: numRow.id }, select: { status: true, currentOrderId: true },
  });
  if (heldNumber.status !== "BUSY" || heldNumber.currentOrderId !== order.id) {
    die(`nomor seharusnya masih ditahan untuk listening window (status ${heldNumber.status})`);
  }
  ok(`Nomor MASIH ${C.ok("BUSY")} & terikat ke order — window listening terbuka`);
  info("Nomor sengaja belum dilepas: buyer masih bisa minta kode baru, dan nomor tak bisa dijual ke buyer lain selama SMS susulan mungkin datang");

  // -- 7. Buyer asks for a NEW code: repeat OTP on the same order -----------
  step("Agent API — buyer minta kode baru, SMS kedua masuk  (POST /sms)");
  const sms2 = await agent("POST", "/api/agent/v1/sms",
    { numberId: numRow.id, messageId: randomUUID(), sender: SMS_SENDER, body: SMS_BODY2, receivedAt: Date.now() - 500 },
    cred, { idempotency: randomUUID() });
  if (sms2.status >= 400) die(`SMS kedua gagal (HTTP ${sms2.status})`, sms2.json ?? sms2.text);
  if (sms2.json?.data?.status !== "matched") {
    die("SMS kedua tidak cocok ke order yang sama", sms2.json?.data);
  }
  const repeatOrder = await prisma.partnerOrder.findUnique({
    where: { id: order.id },
    select: { status: true, otpFingerprint: true, completedAt: true },
  });
  if (repeatOrder.status !== "SUCCESS") die(`order berubah status: ${repeatOrder.status}`);
  if (repeatOrder.otpFingerprint === successOrder.otpFingerprint) {
    die("OTP tidak diperbarui oleh SMS kedua");
  }
  ok(`SMS kedua cocok ke order yang SAMA — OTP diperbarui ke "${OTP2_WIRE}" (HTTP ${sms2.status})`);

  // The buyer reads the refreshed code through the same status endpoint.
  const status2 = await internal("GET", `/api/internal/v1/orders/${order.id}`, undefined, {});
  if (status2.json?.data?.otp !== OTP2) {
    die(`status API belum mengirim OTP baru (dapat ${JSON.stringify(status2.json?.data?.otp)})`);
  }
  ok(`Buyer menerima kode baru ${C.bold(OTP2)} lewat status API — kode lama sudah tergantikan`);

  // Money is created exactly once per order: no second earning, no second event.
  const earningsAfterRepeat = await prisma.partnerEarning.count({ where: { orderId: order.id } });
  const ledgerAfterRepeat = await prisma.ledgerTransaction.count({
    where: { referenceType: "order", referenceId: order.id },
  });
  if (earningsAfterRepeat !== 1 || ledgerAfterRepeat !== 1) {
    die(`uang terduplikasi (earning ${earningsAfterRepeat}, ledger ${ledgerAfterRepeat})`);
  }
  ok(`Uang tetap sekali: 1 earning & 1 event ledger — kode ulang ${C.bold("tidak")} membayar partner dua kali`);

  // -- 8. Buyer taps "selesai": the hold is released -----------------------
  step("Internal API — buyer klik selesai  (POST /orders/{id}/complete, HMAC-signed)");
  const complete = await internal("POST", `/api/internal/v1/orders/${order.id}/complete`,
    { actorRef: "buyer-app" }, { idempotency: `complete-${randomUUID()}` });
  if (complete.status >= 400) die(`complete gagal (HTTP ${complete.status})`, complete.json ?? complete.text);
  const completedOrder = await prisma.partnerOrder.findUnique({
    where: { id: order.id }, select: { status: true, completedAt: true },
  });
  const releasedNumber = await prisma.partnerNumber.findUnique({
    where: { id: numRow.id }, select: { status: true, currentOrderId: true },
  });
  if (completedOrder.completedAt === null) die("completedAt belum distempel");
  if (releasedNumber.status !== "AVAILABLE" || releasedNumber.currentOrderId !== null) {
    die(`nomor tidak dilepas setelah complete (status ${releasedNumber.status})`);
  }
  ok(`Window ditutup (HTTP ${complete.status}) — order tetap ${C.ok("SUCCESS")}, nomor dilepas ke ${C.ok("AVAILABLE")} & siap dijual lagi`);

  // Completion is idempotent: a repeated tap changes nothing.
  const complete2 = await internal("POST", `/api/internal/v1/orders/${order.id}/complete`,
    { actorRef: "buyer-app" }, { idempotency: `complete-${randomUUID()}` });
  const afterSecond = await prisma.partnerOrder.findUnique({
    where: { id: order.id }, select: { completedAt: true },
  });
  if (complete2.status >= 400) die(`complete kedua gagal (HTTP ${complete2.status})`, complete2.json);
  if (afterSecond.completedAt.getTime() !== completedOrder.completedAt.getTime()) {
    die("complete kedua mengubah completedAt (tidak idempoten)");
  }
  ok("Klik selesai kedua kali aman — idempoten, tidak mengubah apa pun");

  const earningsFinal = await prisma.partnerEarning.findMany({
    where: { orderId: order.id }, select: { amountIdr: true, status: true },
  });
  if (earningsFinal.length !== 1 || earningsFinal[0].amountIdr !== snap.payoutIdr) {
    die(`earning berubah setelah complete: ${JSON.stringify(earningsFinal)}`);
  }
  ok(`Earning tak tersentuh oleh penutupan window: ${rupiah(earningsFinal[0].amountIdr)} (${earningsFinal[0].status})`);

  // -- Summary --------------------------------------------------------------
  console.log(`\n${C.bold("┌─ RINGKASAN ────────────────────────────────────────────────┐")}`);
  const rows = [
    ["Nomor supply", number],
    ["Order", order.id],
    ["Status akhir order", "SUCCESS (OTP terkirim)"],
    ["Retail (bayar buyer)", rupiah(snap.retailPriceIdr)],
    ["Payout partner", rupiah(snap.payoutIdr)],
    ["Margin platform", rupiah(snap.platformMarginIdr)],
    ["Earning tercatat", `${rupiah(earning.amountIdr)} (${earning.status})`],
    ["OTP pertama", OTP],
    ["OTP ulang (kode baru)", `${OTP2}  — order & earning sama`],
  ];
  for (const [k, v] of rows) console.log(`  ${C.dim(k.padEnd(22))} ${C.bold(v)}`);
  console.log(C.bold("└────────────────────────────────────────────────────────────┘"));
  console.log(`\n  ${C.ok("✓ SELURUH ALUR BERHASIL")} — device→tersedia→dipesan→OTP→kode ulang→selesai→earning, lewat API asli.`);
  console.log(C.dim(`  Earning ini tampil di portal: login ${BASE}/login  (owner@demo.test / Demo1234!) → menu Earning.`));
  console.log("");
}

main()
  .catch((e) => { console.error(C.bad(`\nGAGAL: ${e.message}`)); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
