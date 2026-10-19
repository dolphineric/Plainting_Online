'use strict';
// 儲存層：
//  - 有設定環境變數 MONGODB_URI 時 → 存到 MongoDB（雲端部署用，伺服器重啟資料也不會消失）
//  - 沒有設定時 → 存成本機 JSON 檔（data/ 資料夾，適合在自己電腦上開發測試）
const fs = require('fs');
const path = require('path');

async function createStore() {
  const store = process.env.MONGODB_URI
    ? new MongoStore(process.env.MONGODB_URI, process.env.MONGODB_DB || 'painting_online')
    : new FileStore(process.env.DATA_DIR || path.join(__dirname, 'data'));
  await store.init();
  return store;
}

// 讓同一個房間的寫入依序執行，避免「新增後馬上復原」之類的順序錯亂
class SerialQueue {
  constructor() {
    this.tails = new Map();
  }

  run(key, task) {
    const prev = this.tails.get(key) || Promise.resolve();
    const next = prev.then(task).catch((err) => console.error(`[store] 房間 ${key} 寫入失敗：`, err));
    this.tails.set(key, next);
    next.then(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }

  wait(key) {
    return this.tails.get(key) || Promise.resolve();
  }

  drain() {
    return Promise.all([...this.tails.values()]);
  }
}

// ---------- 本機 JSON 檔 ----------
class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.kind = `本機檔案 (${dir})`;
    this.queue = new SerialQueue();
    this.timers = new Map(); // roomId -> 延遲寫入計時器
    this.dirty = new Map(); // roomId -> room
  }

  async init() {
    await fs.promises.mkdir(this.dir, { recursive: true });
  }

  file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  async load(id) {
    await this.queue.wait(id);
    try {
      const data = JSON.parse(await fs.promises.readFile(this.file(id), 'utf8'));
      return {
        meta: { id, passwordHash: data.passwordHash || null, createdAt: data.createdAt, updatedAt: data.updatedAt },
        ops: Array.isArray(data.ops) ? data.ops : [],
      };
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  createRoom(room) {
    return this.writeNow(room);
  }

  saveMeta(room) {
    this.schedule(room);
  }

  addOp(room) {
    this.schedule(room);
  }

  removeOp(room) {
    this.schedule(room);
  }

  clearOps(room) {
    this.schedule(room);
  }

  // 畫圖時事件很密集，合併成每秒最多寫一次檔
  schedule(room) {
    this.dirty.set(room.id, room);
    if (this.timers.has(room.id)) return;
    this.timers.set(
      room.id,
      setTimeout(() => {
        this.timers.delete(room.id);
        this.dirty.delete(room.id);
        this.writeNow(room);
      }, 1000)
    );
  }

  writeNow(room) {
    return this.queue.run(room.id, async () => {
      const data = JSON.stringify({
        id: room.id,
        passwordHash: room.passwordHash,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
        ops: room.ops,
      });
      const target = this.file(room.id);
      await fs.promises.writeFile(`${target}.tmp`, data);
      await fs.promises.rename(`${target}.tmp`, target);
    });
  }

  async cleanup(cutoff, activeIds) {
    let removed = 0;
    for (const name of await fs.promises.readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (activeIds.has(id) || this.dirty.has(id)) continue;
      const file = path.join(this.dir, name);
      const { mtimeMs } = await fs.promises.stat(file);
      if (mtimeMs < cutoff) {
        await fs.promises.unlink(file);
        removed++;
      }
    }
    return removed;
  }

  async close() {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      this.writeNow(this.dirty.get(id));
    }
    this.timers.clear();
    this.dirty.clear();
    await this.queue.drain();
  }
}

// ---------- MongoDB ----------
// rooms 集合：每個房間一筆（房號、密碼雜湊、時間）
// ops   集合：每一筆畫或每張圖片一筆，依 seq 排序重播
class MongoStore {
  constructor(uri, dbName) {
    this.uri = uri;
    this.dbName = dbName;
    this.kind = 'MongoDB';
    this.queue = new SerialQueue();
    this.seq = new Map(); // roomId -> 下一個序號
    this.touchedAt = new Map(); // roomId -> 上次更新 updatedAt 的時間
  }

  async init() {
    const { MongoClient } = require('mongodb');
    this.client = new MongoClient(this.uri);
    await this.client.connect();
    const db = this.client.db(this.dbName);
    this.rooms = db.collection('rooms');
    this.ops = db.collection('ops');
    await Promise.all([
      this.ops.createIndex({ roomId: 1, seq: 1 }),
      this.ops.createIndex({ roomId: 1, id: 1 }),
      this.rooms.createIndex({ updatedAt: 1 }),
    ]);
  }

  async load(id) {
    await this.queue.wait(id);
    const meta = await this.rooms.findOne({ _id: id });
    if (!meta) return null;
    const docs = await this.ops.find({ roomId: id }, { projection: { seq: 1, op: 1 } }).sort({ seq: 1 }).toArray();
    this.seq.set(id, docs.length ? docs[docs.length - 1].seq + 1 : 0);
    return {
      meta: { id, passwordHash: meta.passwordHash || null, createdAt: meta.createdAt, updatedAt: meta.updatedAt },
      ops: docs.map((d) => d.op),
    };
  }

  createRoom(room) {
    this.seq.set(room.id, 0);
    return this.queue.run(room.id, () =>
      this.rooms.insertOne({
        _id: room.id,
        passwordHash: room.passwordHash,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
      })
    );
  }

  saveMeta(room) {
    this.touchedAt.set(room.id, Date.now());
    this.queue.run(room.id, () =>
      this.rooms.updateOne({ _id: room.id }, { $set: { passwordHash: room.passwordHash, updatedAt: room.updatedAt } })
    );
  }

  addOp(room, op) {
    const seq = this.seq.get(room.id) ?? 0;
    this.seq.set(room.id, seq + 1);
    this.queue.run(room.id, () => this.ops.insertOne({ roomId: room.id, seq, id: op.id, op }));
    this.touch(room);
  }

  removeOp(room, opId) {
    this.queue.run(room.id, () => this.ops.deleteOne({ roomId: room.id, id: opId }));
    this.touch(room);
  }

  clearOps(room) {
    this.queue.run(room.id, () => this.ops.deleteMany({ roomId: room.id }));
    this.touch(room);
  }

  // updatedAt 只用來判斷房間多久沒人用，每分鐘更新一次就夠了
  touch(room) {
    if (Date.now() - (this.touchedAt.get(room.id) || 0) < 60_000) return;
    this.saveMeta(room);
  }

  async cleanup(cutoff, activeIds) {
    const old = await this.rooms.find({ updatedAt: { $lt: cutoff } }, { projection: { _id: 1 } }).toArray();
    const ids = old.map((d) => d._id).filter((id) => !activeIds.has(id));
    if (!ids.length) return 0;
    await this.ops.deleteMany({ roomId: { $in: ids } });
    await this.rooms.deleteMany({ _id: { $in: ids } });
    return ids.length;
  }

  async close() {
    await this.queue.drain();
    await this.client.close();
  }
}

module.exports = { createStore };
