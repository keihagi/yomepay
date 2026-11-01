// Tickets, random instructions and simple checks on submitted evidence.
import crypto from 'node:crypto';
import { L } from './i18n.js';

const HANDS = [['右手', 'right'], ['左手', 'left']];
const FINGERS = [['1本', '1 finger'], ['2本', '2 fingers'], ['3本', '3 fingers'], ['4本', '4 fingers'], ['5本（パー）', '5 fingers (open hand)']];
const pick = a => a[crypto.randomInt(a.length)];

/** How long a ticket stays usable. The window is decided by when it was issued. Writing takes longer. */
export const ticketTtlMs = requires => (requires.includes('text') ? 60 : 15) * 60e3;

/**
 * A random instruction that has to appear in the photo/video, so old footage cannot be reused.
 * Goals without a photo or video get none.
 */
export function instructionFor(requires) {
  const [h, f] = [pick(HANDS), pick(FINGERS)];
  const hand = L(`${h[0]}の指を${f[0]}立てる`, `hold up ${f[1]} on your ${h[1]} hand`);
  const place = requires.includes('location');
  if (requires.includes('video')) return L(`録画の最初に、${hand}のをカメラに見せてから始める`, `At the start of the recording, ${hand} to the camera, then begin`);
  if (requires.includes('photo')) return L(`${hand}。その手と${place ? 'その場所の様子' : 'やったことの様子'}が一緒に写るように撮る`,
    `${hand[0].toUpperCase()}${hand.slice(1)}. Take the photo with that hand and ${place ? 'the place' : 'what you did'} in the same shot`);
  return null;
}

/** Distance in meters between two lat/lng points. */
export function distanceM(a, b) {
  const R = 6371000, rad = x => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Whether a phone's position counts as "at the place". Poor GPS accuracy gets some slack, capped at 150 m. */
export function atPlace(place, pos, radiusM = 200) {
  const d = distanceM(place, pos);
  return { distanceM: Math.round(d), inside: d <= radiusM + Math.min(Number(pos.accuracy) || 0, 150) };
}

const grams = s => {
  const t = String(s).replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
};
/** 0..1 overlap of character 3-grams. Used to flag memos copied from earlier ones. */
export function similarity(a, b) {
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const g of A) if (B.has(g)) both++;
  return both / (A.size + B.size - both);
}
