'use strict';
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const { Server } = require('socket.io');
const { createStore } = require('./store');

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
// 房間超過幾天沒人使用就自動刪除（設為 0 表示永不刪除）
const ROOM_TTL_DAYS = process.env.ROOM_TTL_DAYS === undefined ? 30 : Number(process.env.ROOM_TTL_DAYS);
const CANVAS = { width: 1920, height: 1080 };
const MAX_IMAGE_CHARS = 8 * 1024 * 1024; // 圖片 dataURL 長度上限（約 6MB 的圖檔）
const MAX_STROKE_NUMBERS = 20000; // 單一筆畫最多的座標數（x、y 各算一個）
const MAX_NUMBERS_PER_MOVE = 4000;
const MAX_REDO = 100; // 每人最多能「下一步」幾次
const ROOM_ID_RE = /^[a-z0-9_-]{1,20}$/;
const OP_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10 * 1024 * 1024 });

let store;
const rooms = new Map(); // roomId -> 記憶體中的房間
const loading = new Map(); // roomId -> 載入中的 Promise（避免重複讀取）

// ---------- 小工具 ----------
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const toAck = (ack) => (typeof ack === 'function' ? ack : () => {});
const cleanName = (name) => String(name ?? '').trim().slice(0, 20) || '訪客';
const normalizeRoomId = (id) => {
  const v = String(id ?? '').trim().toLowerCase();
  return ROOM_ID_RE.test(v) ? v : null;
};

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 32);
  return `${salt}:${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (!stored) return true;
  const [salt, hash] = stored.split(':');
  const test = await scrypt(String(password ?? ''), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function newRoom({ id, passwordHash = null, createdAt = Date.now(), updatedAt = Date.now(), ops = [] }) {
  return {
    id,
    passwordHash,
    createdAt,
    updatedAt,
    ops, // 已完成的筆畫與圖片（依 seq 順序重播就是整張畫）
    nextSeq: normalizeSeq(ops),
    pending: new Map(), // opId -> { op, socketId }，正在畫、還沒放開滑鼠的筆畫
    redo: new Map(), // clientId -> 被復原的操作，可以「下一步」放回去（只存在記憶體）
    users: new Map(), // socketId -> { id, name }
    unloadTimer: null,
  };
}

// 每個操作都有遞增的序號 seq，「下一步」時依序號放回原本的圖層位置。
// 舊資料沒有序號就依現有順序補上。回傳下一個可用的序號。
function normalizeSeq(ops) {
  let next = 0;
  for (const op of ops) {
    if (!Number.isInteger(op.seq) || op.seq < next) op.seq = next;
    next = op.seq + 1;
  }
  return next;
}

async function getRoom(id) {
  if (rooms.has(id)) return rooms.get(id);
  if (!loading.has(id)) {
    const promise = store
      .load(id)
      .then((data) => {
        if (rooms.has(id)) return rooms.get(id);
        if (!data) return null;
        const room = newRoom({ ...data.meta, ops: data.ops });
        rooms.set(id, room);
        return room;
      })
      .finally(() => loading.delete(id));
    loading.set(id, promise);
  }
  return loading.get(id);
}

async function generateRoomId() {
  for (let i = 0; i < 30; i++) {
    const id = String(crypto.randomInt(100000, 1000000));
    if (!(await getRoom(id))) return id;
  }
  throw new Error('無法產生房號');
}

function cleanPoints(arr, max) {
  if (!Array.isArray(arr) || arr.length % 2 !== 0 || arr.length > max) return null;
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const n = Number(arr[i]);
    if (!Number.isFinite(n)) return null;
    const limit = i % 2 ? CANVAS.height : CANVAS.width;
    out[i] = Math.round(clamp(n, -500, limit + 500) * 10) / 10;
  }
  return out;
}

function sanitizeStroke(s, uid) {
  if (!s || typeof s !== 'object' || !OP_ID_RE.test(String(s.id))) return null;
  const pts = cleanPoints(s.pts, MAX_NUMBERS_PER_MOVE);
  if (!pts || pts.length < 2) return null;
  const tool = s.tool === 'eraser' ? 'eraser' : 'pen';
  return {
    id: String(s.id),
    uid,
    type: 'stroke',
    tool,
    color: tool === 'pen' && COLOR_RE.test(s.color) ? s.color.toLowerCase() : '#000000',
    size: Math.round(clamp(Number(s.size) || 6, 1, 200) * 10) / 10,
    opacity: tool === 'pen' ? Math.round(clamp(Number(s.opacity) || 1, 0.01, 1) * 100) / 100 : 1,
    pts,
  };
}

function sanitizeImage(s, uid) {
  if (!s || typeof s !== 'object' || !OP_ID_RE.test(String(s.id))) return null;
  if (typeof s.src !== 'string' || s.src.length > MAX_IMAGE_CHARS || !IMAGE_RE.test(s.src)) return null;
  const [x, y, w, h] = [s.x, s.y, s.w, s.h].map(Number);
  if (![x, y, w, h].every(Number.isFinite) || w < 1 || h < 1 || w > 20000 || h > 20000) return null;
  // background = 放在最底層的背景圖，橡皮擦擦不掉，擦掉上面的筆畫時會露出來
  const type = s.type === 'background' ? 'background' : 'image';
  return { id: String(s.id), uid, type, src: s.src, x: clamp(x, -20000, 20000), y: clamp(y, -20000, 20000), w, h };
}

// ---------- 房間操作 ----------
function roomSnapshot(room) {
  return {
    roomId: room.id,
    hasPassword: !!room.passwordHash,
    width: CANVAS.width,
    height: CANVAS.height,
    ops: room.ops,
    pending: [...room.pending.values()].map((e) => e.op),
    users: [...room.users.values()],
  };
}

function broadcastUsers(room) {
  io.to(room.id).emit('users', [...room.users.values()]);
}

function addOp(room, op) {
  op.seq = room.nextSeq++;
  room.ops.push(op);
  room.redo.delete(op.uid); // 畫了新東西，之前復原的就不能再「下一步」
  room.updatedAt = Date.now();
  store.addOp(room, op);
}

// 告訴這個使用者（可能開了多個連線）「上一步／下一步」按鈕能不能按
function emitHistory(room, uid) {
  const state = {
    canUndo: room.ops.findLastIndex((op) => op.uid === uid) !== -1,
    canRedo: !!room.redo.get(uid)?.length,
  };
  for (const [socketId, user] of room.users) {
    if (user.id === uid) io.to(socketId).emit('history', state);
  }
}

function commitStroke(room, opId) {
  const entry = room.pending.get(opId);
  if (!entry) return;
  room.pending.delete(opId);
  addOp(room, entry.op);
  // 畫的人也會收到，用來補上伺服器給的序號
  io.to(room.id).emit('stroke:end', { id: opId, seq: entry.op.seq });
  emitHistory(room, entry.op.uid);
}

function enterRoom(socket, room, payload) {
  leaveRoom(socket);
  // 若房間在等待期間被卸載，放回記憶體
  const current = rooms.get(room.id);
  if (current && current !== room) room = current;
  else if (!current) rooms.set(room.id, room);
  clearTimeout(room.unloadTimer);

  const clientId = CLIENT_ID_RE.test(String(payload.clientId)) ? String(payload.clientId) : crypto.randomUUID();
  socket.data.roomId = room.id;
  socket.data.clientId = clientId;
  socket.data.name = cleanName(payload.name);
  room.users.set(socket.id, { id: clientId, name: socket.data.name });
  room.updatedAt = Date.now();
  store.saveMeta(room);

  socket.join(room.id);
  socket.to(room.id).emit('user:joined', { name: socket.data.name });
  broadcastUsers(room);
  emitHistory(room, clientId);
  return room;
}

function leaveRoom(socket) {
  const room = rooms.get(socket.data.roomId);
  socket.data.roomId = null;
  if (!room) return;

  for (const [opId, entry] of room.pending) {
    if (entry.socketId === socket.id) commitStroke(room, opId);
  }
  room.users.delete(socket.id);
  socket.leave(room.id);
  socket.to(room.id).emit('user:left', { name: socket.data.name });
  broadcastUsers(room);

  // 沒人在房間 1 分鐘後就從記憶體移除（資料已存在 store 裡）
  if (room.users.size === 0) {
    clearTimeout(room.unloadTimer);
    room.unloadTimer = setTimeout(() => {
      if (room.users.size === 0 && rooms.get(room.id) === room) rooms.delete(room.id);
    }, 60_000);
  }
}

const currentRoom = (socket) => rooms.get(socket.data.roomId) || null;

// ---------- Socket 事件 ----------
io.on('connection', (socket) => {
  socket.data.failures = 0;
  socket.data.lockUntil = 0;

  socket.on('room:create', async (payload = {}, ack) => {
    const reply = toAck(ack);
    try {
      let id = null;
      if (String(payload.roomId ?? '').trim()) {
        id = normalizeRoomId(payload.roomId);
        if (!id) return reply({ ok: false, error: '房號只能使用英文、數字、底線或減號，最多 20 個字' });
        if (await getRoom(id)) return reply({ ok: false, error: '這個房號已經有人使用了，請換一個，或改用「加入房間」' });
      } else {
        id = await generateRoomId();
      }

      const password = String(payload.password ?? '');
      if (password.length > 100) return reply({ ok: false, error: '密碼太長了（最多 100 字）' });
      const passwordHash = password ? await hashPassword(password) : null;
      if (rooms.has(id)) return reply({ ok: false, error: '這個房號剛剛被別人建立了，請換一個' });

      let room = newRoom({ id, passwordHash });
      rooms.set(id, room);
      await store.createRoom(room);
      room = enterRoom(socket, room, payload);
      reply({ ok: true, ...roomSnapshot(room) });
    } catch (err) {
      console.error('room:create', err);
      reply({ ok: false, error: '伺服器發生錯誤，請稍後再試' });
    }
  });

  socket.on('room:join', async (payload = {}, ack) => {
    const reply = toAck(ack);
    try {
      const id = normalizeRoomId(payload.roomId);
      if (!id) return reply({ ok: false, error: '請輸入正確的房號', code: 'BAD_ID' });
      if (socket.data.lockUntil > Date.now()) {
        return reply({ ok: false, error: '密碼錯誤次數太多，請 1 分鐘後再試', code: 'LOCKED' });
      }

      let room = await getRoom(id);
      if (!room) return reply({ ok: false, error: '找不到這個房間，請確認房號，或建立新房間', code: 'NOT_FOUND' });

      if (!(await verifyPassword(payload.password, room.passwordHash))) {
        if (++socket.data.failures >= 8) {
          socket.data.failures = 0;
          socket.data.lockUntil = Date.now() + 60_000;
        }
        return reply({
          ok: false,
          error: payload.password ? '密碼錯誤' : '這個房間有設定密碼，請輸入密碼',
          code: 'BAD_PASSWORD',
        });
      }

      socket.data.failures = 0;
      room = enterRoom(socket, room, payload);
      reply({ ok: true, ...roomSnapshot(room) });
    } catch (err) {
      console.error('room:join', err);
      reply({ ok: false, error: '伺服器發生錯誤，請稍後再試' });
    }
  });

  socket.on('room:leave', () => leaveRoom(socket));

  socket.on('room:password', async (payload = {}, ack) => {
    const reply = toAck(ack);
    const room = currentRoom(socket);
    if (!room) return reply({ ok: false, error: '你不在房間裡' });
    const password = String(payload.password ?? '');
    if (password.length > 100) return reply({ ok: false, error: '密碼太長了（最多 100 字）' });
    try {
      room.passwordHash = password ? await hashPassword(password) : null;
      room.updatedAt = Date.now();
      store.saveMeta(room);
      io.to(room.id).emit('room:info', { hasPassword: !!room.passwordHash, by: socket.data.name });
      reply({ ok: true });
    } catch (err) {
      console.error('room:password', err);
      reply({ ok: false, error: '伺服器發生錯誤，請稍後再試' });
    }
  });

  socket.on('stroke:begin', (payload) => {
    const room = currentRoom(socket);
    if (!room) return;
    const op = sanitizeStroke(payload, socket.data.clientId);
    if (!op || room.pending.has(op.id)) return;
    room.pending.set(op.id, { op, socketId: socket.id });
    socket.to(room.id).emit('stroke:begin', { ...op, pts: op.pts.slice() });
  });

  socket.on('stroke:move', (payload) => {
    const room = currentRoom(socket);
    const entry = room && payload && room.pending.get(String(payload.id));
    if (!entry || entry.socketId !== socket.id) return;
    const pts = cleanPoints(payload.pts, MAX_NUMBERS_PER_MOVE);
    if (!pts || !pts.length || entry.op.pts.length + pts.length > MAX_STROKE_NUMBERS) return;
    entry.op.pts.push(...pts);
    socket.to(room.id).emit('stroke:move', { id: entry.op.id, pts });
  });

  socket.on('stroke:end', (payload) => {
    const room = currentRoom(socket);
    const entry = room && payload && room.pending.get(String(payload.id));
    if (!entry || entry.socketId !== socket.id) return;
    commitStroke(room, entry.op.id);
  });

  // 手機兩指縮放時，第一隻手指剛開始的筆畫要丟掉
  socket.on('stroke:cancel', (payload) => {
    const room = currentRoom(socket);
    const entry = room && payload && room.pending.get(String(payload.id));
    if (!entry || entry.socketId !== socket.id) return;
    room.pending.delete(entry.op.id);
    socket.to(room.id).emit('stroke:cancel', { id: entry.op.id });
  });

  socket.on('image:add', (payload, ack) => {
    const reply = toAck(ack);
    const room = currentRoom(socket);
    if (!room) return reply({ ok: false, error: '你不在房間裡' });
    const op = sanitizeImage(payload, socket.data.clientId);
    if (!op) return reply({ ok: false, error: '圖片格式不支援或檔案太大' });
    addOp(room, op);
    socket.to(room.id).emit('op:add', op);
    reply({ ok: true, op });
    emitHistory(room, op.uid);
  });

  // 上一步：移除「自己」最後一個筆畫或圖片，放進可以「下一步」的堆疊
  socket.on('op:undo', () => {
    const room = currentRoom(socket);
    if (!room) return;
    const uid = socket.data.clientId;
    const i = room.ops.findLastIndex((op) => op.uid === uid);
    if (i === -1) return;
    const [op] = room.ops.splice(i, 1);
    const stack = room.redo.get(uid) || [];
    stack.push(op);
    if (stack.length > MAX_REDO) stack.shift();
    room.redo.set(uid, stack);
    room.updatedAt = Date.now();
    store.removeOp(room, op.id);
    io.to(room.id).emit('op:remove', { id: op.id });
    emitHistory(room, uid);
  });

  // 下一步：把最近一次「上一步」移除的東西放回原本的圖層位置
  socket.on('op:redo', () => {
    const room = currentRoom(socket);
    if (!room) return;
    const uid = socket.data.clientId;
    const op = room.redo.get(uid)?.pop();
    if (!op) return;
    let i = room.ops.length;
    while (i > 0 && room.ops[i - 1].seq > op.seq) i--;
    room.ops.splice(i, 0, op);
    room.updatedAt = Date.now();
    store.insertOp(room, op);
    io.to(room.id).emit('op:insert', op);
    emitHistory(room, uid);
  });

  socket.on('canvas:clear', () => {
    const room = currentRoom(socket);
    if (!room) return;
    room.ops = [];
    room.redo.clear();
    room.updatedAt = Date.now();
    store.clearOps(room);
    io.to(room.id).emit('canvas:clear', { by: socket.data.name });
    io.to(room.id).emit('history', { canUndo: false, canRedo: false });
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

// ---------- 啟動與清理 ----------
async function cleanupOldRooms() {
  if (!(ROOM_TTL_DAYS > 0)) return;
  try {
    const cutoff = Date.now() - ROOM_TTL_DAYS * 24 * 60 * 60 * 1000;
    const removed = await store.cleanup(cutoff, new Set(rooms.keys()));
    if (removed) console.log(`已刪除 ${removed} 個超過 ${ROOM_TTL_DAYS} 天沒使用的房間`);
  } catch (err) {
    console.error('清理舊房間失敗：', err);
  }
}

async function shutdown() {
  console.log('正在儲存資料並關閉伺服器…');
  try {
    await store?.close();
  } finally {
    process.exit(0);
  }
}

(async () => {
  store = await createStore();
  await cleanupOldRooms();
  setInterval(cleanupOldRooms, 6 * 60 * 60 * 1000).unref();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.listen(PORT, () => {
    console.log(`共同畫板已啟動：http://localhost:${PORT}`);
    console.log(`儲存方式：${store.kind}`);
  });
})().catch((err) => {
  console.error('啟動失敗：', err);
  process.exit(1);
});
