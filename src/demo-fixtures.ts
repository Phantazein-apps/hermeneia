// Hermeneia — demo mode fixture data
//
// Authored with relative timestamps (daysAgo/hoursAgo, resolved once at
// import time) so "this week" / "unread" / deep-history queries all work
// correctly regardless of what day demo mode actually runs on.

import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

export function daysAgo(n: number, hourOfDay = 12): string {
  const d = new Date(NOW - n * DAY_MS);
  d.setUTCHours(hourOfDay, (n * 7) % 60, 0, 0);
  return d.toISOString();
}

export function hoursAgo(h: number): string {
  return new Date(NOW - h * 60 * 60 * 1000).toISOString();
}

/** Path to the bundled sample "photo" — a small real (non-fake-bytes) PNG,
 *  so download_media has actual pixels to return in demo mode. */
export const DEMO_PHOTO_PATH = join(__dirname, "..", "assets", "demo", "sample-photo.png");

export interface FixtureContact {
  id: string; // jid
  lid: string | null;
  phoneJid: string | null;
  name: string | null;
  notify: string | null;
  verifiedName: string | null;
}

export const CONTACTS: FixtureContact[] = [
  { id: "34600100001@s.whatsapp.net", lid: null, phoneJid: null, name: "Mom", notify: "Mom ❤️", verifiedName: null },
  { id: "34600100002@s.whatsapp.net", lid: null, phoneJid: null, name: "Tyler Chen", notify: "Tyler", verifiedName: null },
  { id: "34600100003@s.whatsapp.net", lid: null, phoneJid: null, name: "María García", notify: "Maria", verifiedName: null },
  // push-name-only — no saved contact name, WhatsApp shows the push name
  { id: "34600100004@s.whatsapp.net", lid: null, phoneJid: null, name: null, notify: "Alex R.", verifiedName: null },
  // phone-number-only — no saved name, no push name either
  { id: "34600100005@s.whatsapp.net", lid: null, phoneJid: null, name: null, notify: null, verifiedName: null },
  { id: "34600100006@s.whatsapp.net", lid: null, phoneJid: null, name: "Diego Fernández", notify: "Diego", verifiedName: null },
  { id: "34600100007@s.whatsapp.net", lid: null, phoneJid: null, name: "Sam", notify: "Sam", verifiedName: null },
  { id: "34600100008@s.whatsapp.net", lid: null, phoneJid: null, name: "Abuela", notify: "Abuela ❤️", verifiedName: null },
];

const JID = {
  mom: CONTACTS[0].id,
  tyler: CONTACTS[1].id,
  maria: CONTACTS[2].id,
  alex: CONTACTS[3].id,
  unknown: CONTACTS[4].id,
  diego: CONTACTS[5].id,
  sam: CONTACTS[6].id,
  abuela: CONTACTS[7].id,
};

export const COMMUNITY_JID = "120363000000000001@g.us";
export const FAMILY_GROUP_JID = "120363000000000002@g.us";
export const WORK_GROUP_JID = "120363000000000003@g.us";

export interface FixtureChat {
  jid: string;
  name: string | null;
  lastMessageTime: string;
  unreadCount: number;
  archived: boolean;
  parentGroupJid?: string;
  isParentGroup?: boolean;
}

export const CHATS: FixtureChat[] = [
  { jid: JID.tyler, name: "Tyler Chen", lastMessageTime: hoursAgo(2), unreadCount: 2, archived: false },
  { jid: JID.maria, name: "María García", lastMessageTime: hoursAgo(5), unreadCount: 1, archived: false },
  // Community parent — a container group; not one of the "6 chats", but its
  // own row so Family's parent_group_jid resolves to something real.
  { jid: COMMUNITY_JID, name: "García Family", lastMessageTime: daysAgo(30), unreadCount: 0, archived: false, isParentGroup: true },
  { jid: FAMILY_GROUP_JID, name: "Family 👨‍👩‍👧", lastMessageTime: daysAgo(1), unreadCount: 0, archived: false, parentGroupJid: COMMUNITY_JID },
  { jid: WORK_GROUP_JID, name: "Acme Launch 🚀", lastMessageTime: hoursAgo(3), unreadCount: 3, archived: false },
  { jid: JID.abuela, name: "Abuela", lastMessageTime: daysAgo(38), unreadCount: 0, archived: true },
  { jid: JID.sam, name: "Sam", lastMessageTime: daysAgo(730), unreadCount: 0, archived: false },
];

export interface FixtureMessage {
  id: string;
  chatJid: string;
  sender: string; // jid of sender, or "me"
  content: string;
  timestamp: string;
  isFromMe: boolean;
  mediaType?: string | null;
  mediaInfo?: Record<string, unknown> | null;
}

let msgCounter = 0;
const nextId = () => `demo-msg-${++msgCounter}`;

function convo(
  chatJid: string,
  entries: Array<{ from: "me" | string; text: string; d?: number; h?: number; media?: FixtureMessage["mediaType"]; mediaInfo?: FixtureMessage["mediaInfo"] }>
): FixtureMessage[] {
  return entries.map((e) => ({
    id: nextId(),
    chatJid,
    sender: e.from === "me" ? "me" : e.from,
    content: e.text,
    timestamp: e.h !== undefined ? hoursAgo(e.h) : daysAgo(e.d ?? 0),
    isFromMe: e.from === "me",
    mediaType: e.media ?? null,
    mediaInfo: e.mediaInfo ?? null,
  }));
}

// The one message id that has a real bundled image behind it.
export let DEMO_PHOTO_MESSAGE_ID = "";

function tylerFiller(): FixtureMessage[] {
  const lines = [
    "yo, you around this weekend?",
    "lol same",
    "did you see the game last night 😅",
    "no way",
    "sending you the link in a sec",
    "👍",
    "haha exactly",
    "how's the new place btw",
    "still unpacking boxes, it's chaos",
    "same energy honestly",
    "ok brb",
    "back",
    "coffee tomorrow?",
    "yeah let's do 10am",
    "perfect, usual spot?",
    "yep 🙌",
  ];
  const msgs: FixtureMessage[] = [];
  for (let i = 0; i < lines.length; i++) {
    msgs.push(
      ...convo(JID.tyler, [{ from: i % 2 === 0 ? JID.tyler : "me", text: lines[i], d: 9 - Math.floor(i / 2) }])
    );
  }
  const photo = convo(JID.tyler, [
    { from: JID.tyler, text: "check this out", h: 26, media: "image", mediaInfo: { mimetype: "image/png", filename: "sample-photo.png" } },
  ])[0];
  DEMO_PHOTO_MESSAGE_ID = photo.id;
  msgs.push(photo);
  msgs.push(...convo(JID.tyler, [
    { from: "me", text: "haha nice, where was this", h: 25 },
    { from: JID.tyler, text: "just the usual spot", h: 24 },
    { from: JID.tyler, text: "unread one", h: 3 },
    { from: JID.tyler, text: "unread two — you around?", h: 2 },
  ]));
  return msgs;
}

function mariaFiller(): FixtureMessage[] {
  const msgs: FixtureMessage[] = [];
  const lines = [
    "hola! qué tal el finde?",
    "muy bien, ¿y tú?",
    "todo tranquilo por aquí",
    "genial jaja",
    "oye, ¿confirmamos lo del viaje?",
    "sí sí, dame un segundo",
    "aquí va el Airbnb que encontré 👇",
  ];
  for (let i = 0; i < lines.length - 1; i++) {
    msgs.push(...convo(JID.maria, [{ from: i % 2 === 0 ? JID.maria : "me", text: lines[i], d: 6 - Math.floor(i / 2) }]));
  }
  msgs.push(
    ...convo(JID.maria, [
      { from: JID.maria, text: "aquí está — here's the Airbnb https://airbnb.com/rooms/demo123456 🏠", d: 2 },
      { from: "me", text: "se ve genial, lo reservo", h: 40 },
      { from: JID.maria, text: "perfecto! avísame cuando esté confirmado", h: 30 },
      { from: JID.maria, text: "unread — ¿ya lo reservaste?", h: 5 },
    ])
  );
  return msgs;
}

function familyFiller(): FixtureMessage[] {
  const msgs: FixtureMessage[] = [];
  const lines: Array<[string, string, number]> = [
    [JID.mom, "buenos días familia ☀️", 13],
    ["me", "morning mom!", 13],
    [JID.abuela, "¿cuándo venís a comer? 🍲", 11],
    ["me", "este domingo, abuela", 11],
    [JID.mom, "perfecto, aviso a todos", 10],
    [JID.abuela, "qué ganas de veros a todos 🥰", 9],
    ["me", "yo también!", 9],
    [JID.mom, "no olvidéis el postre jaja", 7],
    [JID.abuela, "yo traigo la tarta 🎂", 6],
    ["me", "perfecto, yo llevo vino", 6],
    [JID.mom, "aquí va el itinerario del finde", 4],
  ];
  for (const [from, text, d] of lines) {
    msgs.push(...convo(FAMILY_GROUP_JID, [{ from, text, d }]));
  }
  msgs.push(
    ...convo(FAMILY_GROUP_JID, [
      { from: JID.mom, text: "itinerario adjunto 📄", d: 3, media: "document", mediaInfo: { mimetype: "application/pdf", filename: "itinerario-familia.pdf" } },
      { from: JID.abuela, text: "recibido, gracias!", d: 2 },
      { from: "me", text: "perfecto, nos vemos el domingo 👋", d: 1 },
    ])
  );
  return msgs;
}

function workFiller(): FixtureMessage[] {
  const msgs: FixtureMessage[] = [];
  const lines: Array<[string, string, number]> = [
    [JID.diego, "morning team — launch checklist attached below", 5],
    ["me", "looks good, reviewing now", 5],
    [JID.alex, "left a couple comments on the doc", 4],
    [JID.diego, "thanks, addressing those today", 4],
    ["me", "QA pass done on my end ✅", 3],
    [JID.alex, "same here, all green", 3],
  ];
  for (const [from, text, d] of lines) {
    msgs.push(...convo(WORK_GROUP_JID, [{ from, text, d }]));
  }
  msgs.push(
    ...convo(WORK_GROUP_JID, [
      { from: JID.diego, text: "", d: 2, media: "ptt", mediaInfo: { mimetype: "audio/ogg; codecs=opus", filename: "voice-message.ogg", seconds: 14 } },
      { from: JID.alex, text: "got it, sounds good", h: 20 },
      { from: JID.diego, text: "unread — final go/no-go call at 3pm, join if you can", h: 3 },
      { from: JID.alex, text: "unread — I'll be there", h: 2 },
    ])
  );
  return msgs;
}

function abuelaFiller(): FixtureMessage[] {
  const msgs: FixtureMessage[] = [];
  const lines: Array<[string, string, number]> = [
    [JID.abuela, "hola mi amor, ¿cómo estás? 💕", 42],
    ["me", "muy bien abuela, ¿y tú?", 42],
    [JID.abuela, "aquí, disfrutando del jardín 🌷", 41],
    ["me", "qué bien! te quiero mucho", 40],
    [JID.abuela, "y yo a ti muchísimo 🥰", 39],
    [JID.abuela, "avísame cuando puedas visitarme", 38],
  ];
  for (const [from, text, d] of lines) {
    msgs.push(...convo(JID.abuela, [{ from, text, d }]));
  }
  return msgs;
}

function samFiller(): FixtureMessage[] {
  // Old, quiet chat — exercises deep history (~2 years back), nothing since.
  const msgs: FixtureMessage[] = [];
  const lines: Array<[string, string, number]> = [
    [JID.sam, "hey! long time no talk", 900],
    ["me", "I know, it's been forever", 899],
    [JID.sam, "we should catch up sometime", 895],
    ["me", "for sure, let's find a date", 890],
    [JID.sam, "how's everything going", 850],
    ["me", "good, busy but good. you?", 848],
    [JID.sam, "same here, work's been a lot", 820],
    ["me", "haha yeah I get that", 818],
    [JID.sam, "let's not wait another year to talk 😂", 750],
    ["me", "deal", 748],
    [JID.sam, "talk soon!", 731],
    ["me", "for sure!", 730],
  ];
  for (const [from, text, d] of lines) {
    msgs.push(...convo(JID.sam, [{ from, text, d }]));
  }
  return msgs;
}

export const MESSAGES: FixtureMessage[] = [
  ...tylerFiller(),
  ...mariaFiller(),
  ...familyFiller(),
  ...workFiller(),
  ...abuelaFiller(),
  ...samFiller(),
];

export const CANNED_REPLY =
  "Demo reply — Hermeneia is in demo mode, no real messages were sent 👋";
