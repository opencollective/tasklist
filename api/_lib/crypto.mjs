/* Extracted VERBATIM from the first <script> block of index.html — the app's
   hand-written, test-vectored secp256k1/BIP-340/bech32 nostr crypto.
   Do not edit here; if index.html's crypto changes, re-extract. */
(function (root) {
'use strict';
const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
const mod = (a, m) => ((a % m) + m) % m;
function modpow(b, e, m) {
b = mod(b, m);
let r = 1n;
while (e > 0n) {
if (e & 1n) r = (r * b) % m;
b = (b * b) % m;
e >>= 1n;
}
return r;
}
const inv = (a, m) => modpow(mod(a, m), m - 2n, m); // Fermat (m prime)
const IDENT = { x: 1n, y: 1n, z: 0n };
function jDouble(pt) {
if (pt.z === 0n) return pt;
const { x: X1, y: Y1, z: Z1 } = pt;
const A = mod(X1 * X1, P);
const B = mod(Y1 * Y1, P);
const C = mod(B * B, P);
let D = mod((X1 + B) * (X1 + B) - A - C, P);
D = mod(2n * D, P);
const E = mod(3n * A, P);
const F = mod(E * E, P);
const X3 = mod(F - 2n * D, P);
const Y3 = mod(E * (D - X3) - 8n * C, P);
const Z3 = mod(2n * Y1 * Z1, P);
return { x: X3, y: Y3, z: Z3 };
}
function jAdd(p1, p2) {
if (p1.z === 0n) return p2;
if (p2.z === 0n) return p1;
const Z1Z1 = mod(p1.z * p1.z, P);
const Z2Z2 = mod(p2.z * p2.z, P);
const U1 = mod(p1.x * Z2Z2, P);
const U2 = mod(p2.x * Z1Z1, P);
const S1 = mod(p1.y * p2.z * Z2Z2, P);
const S2 = mod(p2.y * p1.z * Z1Z1, P);
const H = mod(U2 - U1, P);
const R = mod(S2 - S1, P);
if (H === 0n) {
if (R === 0n) return jDouble(p1); // same point
return IDENT; // inverse points
}
const HH = mod(H * H, P);
const HHH = mod(H * HH, P);
const V = mod(U1 * HH, P);
const X3 = mod(R * R - HHH - 2n * V, P);
const Y3 = mod(R * (V - X3) - S1 * HHH, P);
const Z3 = mod(H * p1.z * p2.z, P);
return { x: X3, y: Y3, z: Z3 };
}
function jMulG(k) {
let acc = IDENT;
const base = { x: Gx, y: Gy, z: 1n };
k = mod(k, N);
for (let i = 255; i >= 0; i--) {
acc = jDouble(acc);
if ((k >> BigInt(i)) & 1n) acc = jAdd(acc, base);
}
return acc;
}
function toAffine(pt) {
if (pt.z === 0n) throw new Error('point at infinity');
const zi = inv(pt.z, P);
const zi2 = mod(zi * zi, P);
return { x: mod(pt.x * zi2, P), y: mod(pt.y * zi2 * zi, P) };
}
function bytesToHex(b) {
let s = '';
for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
return s;
}
function hexToBytes(h) {
const out = new Uint8Array(h.length / 2);
for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
return out;
}
function bytesToBig(b) {
let r = 0n;
for (let i = 0; i < b.length; i++) r = (r << 8n) | BigInt(b[i]);
return r;
}
function bigTo32(x) {
const out = new Uint8Array(32);
for (let i = 31; i >= 0; i--) {
out[i] = Number(x & 0xffn);
x >>= 8n;
}
return out;
}
function concatBytes(...arrs) {
const len = arrs.reduce((a, b) => a + b.length, 0);
const out = new Uint8Array(len);
let o = 0;
for (const a of arrs) { out.set(a, o); o += a.length; }
return out;
}
const utf8 = (s) => new TextEncoder().encode(s);
const subtle = (root.crypto || require('crypto').webcrypto).subtle;
async function sha256(bytes) {
return new Uint8Array(await subtle.digest('SHA-256', bytes));
}
const tagHashCache = {};
async function taggedHash(tag, ...data) {
if (!tagHashCache[tag]) tagHashCache[tag] = await sha256(utf8(tag));
const th = tagHashCache[tag];
return sha256(concatBytes(th, th, ...data));
}
function generateSecretKey() {
while (true) {
const b = new Uint8Array(32);
(root.crypto || require('crypto').webcrypto).getRandomValues(b);
const d = bytesToBig(b);
if (d > 0n && d < N) return b;
}
}
function getPublicKeyPoint(skBytes) {
const d = bytesToBig(skBytes);
if (d <= 0n || d >= N) throw new Error('invalid secret key');
return toAffine(jMulG(d));
}
function getPublicKey(skBytes) {
return bytesToHex(bigTo32(getPublicKeyPoint(skBytes).x));
}
async function schnorrSign(msg32, skBytes, auxRand) {
const d0 = bytesToBig(skBytes);
if (d0 <= 0n || d0 >= N) throw new Error('invalid secret key');
const Ppt = toAffine(jMulG(d0));
const d = (Ppt.y & 1n) === 0n ? d0 : N - d0;
const aux = auxRand || (() => {
const b = new Uint8Array(32);
(root.crypto || require('crypto').webcrypto).getRandomValues(b);
return b;
})();
const t = d ^ bytesToBig(await taggedHash('BIP0340/aux', aux));
const rand = await taggedHash('BIP0340/nonce', bigTo32(t), bigTo32(Ppt.x), msg32);
const k0 = mod(bytesToBig(rand), N);
if (k0 === 0n) throw new Error('bad nonce');
const Rpt = toAffine(jMulG(k0));
const k = (Rpt.y & 1n) === 0n ? k0 : N - k0;
const e = mod(
bytesToBig(await taggedHash('BIP0340/challenge', bigTo32(Rpt.x), bigTo32(Ppt.x), msg32)),
N
);
return concatBytes(bigTo32(Rpt.x), bigTo32(mod(k + e * d, N)));
}
const B32C = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function b32polymod(values) {
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
let chk = 1;
for (const v of values) {
const top = chk >> 25;
chk = ((chk & 0x1ffffff) << 5) ^ v;
for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
}
return chk;
}
function b32hrpExpand(hrp) {
const out = [];
for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
out.push(0);
for (const c of hrp) out.push(c.charCodeAt(0) & 31);
return out;
}
function bech32Encode(hrp, data8) {
const d5 = [];
let acc = 0, bits = 0;
for (const b of data8) {
acc = (acc << 8) | b;
bits += 8;
while (bits >= 5) {
bits -= 5;
d5.push((acc >> bits) & 31);
}
}
if (bits > 0) d5.push((acc << (5 - bits)) & 31);
const values = b32hrpExpand(hrp).concat(d5).concat([0, 0, 0, 0, 0, 0]);
const polymod = b32polymod(values) ^ 1;
const chk = [];
for (let i = 0; i < 6; i++) chk.push((polymod >> (5 * (5 - i))) & 31);
return hrp + '1' + d5.concat(chk).map((v) => B32C[v]).join('');
}
const nsecEncode = (skBytes) => bech32Encode('nsec', skBytes);
const npubEncode = (pkHex) => bech32Encode('npub', hexToBytes(pkHex));
async function finalizeEvent(evt, skBytes) {
const pubkey = getPublicKey(skBytes);
const e = {
pubkey,
created_at: evt.created_at,
kind: evt.kind,
tags: evt.tags || [],
content: evt.content || '',
};
const ser = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
const idBytes = await sha256(utf8(ser));
e.id = bytesToHex(idBytes);
e.sig = bytesToHex(await schnorrSign(idBytes, skBytes));
return e;
}
root.NostrCrypto = {
generateSecretKey,
getPublicKey,
schnorrSign,
finalizeEvent,
sha256,
taggedHash,
bytesToHex,
hexToBytes,
nsecEncode,
npubEncode,
};
})(typeof window !== 'undefined' ? window : globalThis);
export default globalThis.NostrCrypto;
