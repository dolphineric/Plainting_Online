import { Board } from './board.js';
import { ColorPicker } from './color-picker.js';
import { $, $$, storage, toast, uid } from './util.js';

const MAX_IMAGE_SIDE = 1920; // 上傳的圖片長邊最多縮到這個大小
const MAX_IMAGE_CHARS = 7.5 * 1024 * 1024;

const socket = io();
// 每個分頁一個身分（重新整理不會變），「復原」只會復原自己這個分頁畫的東西
const clientId = (() => {
  try {
    let id = sessionStorage.getItem('paint.clientId');
    if (!id) sessionStorage.setItem('paint.clientId', (id = uid(16)));
    return id;
  } catch {
    return uid(16);
  }
})();

const state = {
  roomId: null,
  password: '', // 只存在記憶體，斷線重連時用
  board: null,
  picker: null,
  users: [],
};

// ====================== 大廳 ======================
const nickname = $('#nickname');
nickname.value = storage.get('paint.nickname') || `訪客${Math.floor(1000 + Math.random() * 9000)}`;
nickname.addEventListener('change', () => storage.set('paint.nickname', nickname.value.trim()));

function switchTab(tab) {
  for (const b of $$('.seg')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of $$('.tab-panel')) p.hidden = p.dataset.panel !== tab;
  showLobbyError('');
}
for (const b of $$('.seg')) b.addEventListener('click', () => switchTab(b.dataset.tab));

function showLobbyError(msg) {
  const el = $('#lobbyError');
  el.textContent = msg;
  el.hidden = !msg;
}

function setBusy(form, busy) {
  for (const el of form.elements) el.disabled = busy;
}

function request(event, payload, timeout = 70000) {
  return new Promise((resolve) => {
    socket.timeout(timeout).emit(event, payload, (err, res) => {
      resolve(err ? { ok: false, error: '連線逾時，請確認網路後再試一次' } : res);
    });
  });
}

function playerName() {
  const name = nickname.value.trim() || '訪客';
  storage.set('paint.nickname', name);
  return name;
}

$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const roomId = $('#joinRoomId').value.trim();
  const password = $('#joinPassword').value;
  setBusy(form, true);
  showLobbyError('');
  const res = await request('room:join', { roomId, password, name: playerName(), clientId });
  setBusy(form, false);
  if (!res.ok) {
    showLobbyError(res.error);
    if (res.code === 'BAD_PASSWORD') $('#joinPassword').select();
    return;
  }
  enterRoom(res, password);
});

$('#createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const password = $('#createPassword').value;
  setBusy(form, true);
  showLobbyError('');
  const res = await request('room:create', {
    roomId: $('#createRoomId').value.trim(),
    password,
    name: playerName(),
    clientId,
  });
  setBusy(form, false);
  if (!res.ok) return showLobbyError(res.error);
  enterRoom(res, password);
  toast(`房間 ${res.roomId} 建立成功！把房號${password ? '和密碼' : ''}分享給朋友吧`, 'success', 4000);
});

function renderRecentRooms() {
  const rooms = storage.get('paint.recentRooms', []);
  $('#recentWrap').hidden = !rooms.length;
  const box = $('#recentRooms');
  box.innerHTML = '';
  for (const id of rooms) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = id;
    chip.addEventListener('click', () => {
      switchTab('join');
      $('#joinRoomId').value = id;
      $('#joinPassword').value = '';
      $('#joinPassword').focus();
    });
    box.append(chip);
  }
}

function rememberRoom(id) {
  const rooms = storage.get('paint.recentRooms', []).filter((r) => r !== id);
  storage.set('paint.recentRooms', [id, ...rooms].slice(0, 6));
}

// ====================== 房間 ======================
function ensureBoard(width, height) {
  if (state.board) return state.board;
  const board = new Board($('#stage'), {
    width,
    height,
    onStrokeStart: (op) => {
      socket.emit('stroke:begin', op);
      if (op.tool === 'pen') state.picker.addRecent(op.color);
    },
    onStrokeMove: (id, pts) => socket.emit('stroke:move', { id, pts }),
    onStrokeEnd: (op) => socket.emit('stroke:end', { id: op.id }),
    onPick: (hex) => {
      state.picker.setColor(hex);
      selectTool('pen');
      toast(`已選取顏色 ${hex.toUpperCase()}`);
    },
  });
  state.board = board;
  state.picker = new ColorPicker($('#colorPicker'), {
    color: storage.get('paint.color') || '#1f2328',
    onChange: (hex) => {
      board.setBrush({ color: hex });
      storage.set('paint.color', hex);
      updateBrushPreview();
      if (board.tool !== 'pen') selectTool('pen');
    },
  });
  board.setBrush({ color: state.picker.hex });
  applyBrushInputs();
  selectTool('pen');
  return board;
}

function enterRoom(res, password) {
  state.roomId = res.roomId;
  state.password = password;
  rememberRoom(res.roomId);
  history.replaceState(null, '', `#room=${encodeURIComponent(res.roomId)}`);

  $('#lobby').hidden = true;
  $('#room').hidden = false;
  $('#roomIdLabel').textContent = res.roomId;
  document.title = `房間 ${res.roomId}｜線上共同畫板`;
  setLock(res.hasPassword);
  renderUsers(res.users);

  const board = ensureBoard(res.width, res.height);
  board.fit();
  board.load(res.ops, res.pending);
  board.setEnabled(socket.connected);
}

function leaveRoom(message) {
  socket.emit('room:leave');
  state.board?.finishPlacing(false);
  state.board?.load([]);
  state.roomId = null;
  state.password = '';
  history.replaceState(null, '', location.pathname);
  document.title = '線上共同畫板';
  $('#room').hidden = true;
  $('#lobby').hidden = false;
  $('#joinPassword').value = '';
  renderRecentRooms();
  if (message) {
    switchTab('join');
    showLobbyError(message);
  }
}

function setLock(hasPassword) {
  $('#lockIcon').toggleAttribute('hidden', !hasPassword); // SVG 元素沒有 .hidden 屬性
  $('#passwordBtn use').setAttribute('href', hasPassword ? '#i-lock' : '#i-unlock');
}

function renderUsers(users) {
  state.users = users;
  $('#userCount').textContent = users.length;
  const list = $('#userList');
  list.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'user-list-title';
  title.textContent = `在線上（${users.length}）`;
  list.append(title);
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'user-row';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = [...u.name][0] || '?';
    avatar.style.background = `hsl(${hashHue(u.id)} 65% 55%)`;
    const name = document.createElement('span');
    name.textContent = u.id === clientId ? `${u.name}（你）` : u.name;
    row.append(avatar, name);
    list.append(row);
  }
}

function hashHue(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// ---------- 工具列 ----------
function selectTool(tool) {
  state.board?.setTool(tool);
  for (const b of $$('.tool')) b.classList.toggle('active', b.dataset.tool === tool);
}
for (const b of $$('.tool')) b.addEventListener('click', () => selectTool(b.dataset.tool));

const sizeRange = $('#sizeRange');
const opacityRange = $('#opacityRange');
sizeRange.value = storage.get('paint.size') || 6;
opacityRange.value = storage.get('paint.opacity') || 100;

function applyBrushInputs() {
  const size = Number(sizeRange.value);
  const opacity = Number(opacityRange.value);
  $('#sizeOut').textContent = size;
  $('#opacityOut').textContent = `${opacity}%`;
  storage.set('paint.size', size);
  storage.set('paint.opacity', opacity);
  state.board?.setBrush({ size, opacity: opacity / 100 });
  updateBrushPreview();
}
sizeRange.addEventListener('input', applyBrushInputs);
opacityRange.addEventListener('input', applyBrushInputs);

function updateBrushPreview() {
  const dot = $('#brushPreview i');
  const d = Math.max(2, Math.min(28, Number(sizeRange.value) / 2));
  dot.style.width = dot.style.height = `${d}px`;
  dot.style.background = state.picker?.hex || '#000';
  dot.style.opacity = Number(opacityRange.value) / 100;
}

$('#undoBtn').addEventListener('click', () => socket.emit('op:undo'));

$('#clearBtn').addEventListener('click', async () => {
  const ok = await confirmDialog('清空整張畫布？', '房間裡所有人的筆畫和圖片都會被刪除，而且無法復原。建議先下載備份。');
  if (ok) socket.emit('canvas:clear');
});

$('#downloadBtn').addEventListener('click', async () => {
  const blob = await state.board.exportBlob();
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `畫作-${state.roomId}-${stamp}.png`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('#copyLinkBtn').addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}#room=${encodeURIComponent(state.roomId)}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('已複製邀請連結（密碼請另外告訴朋友）', 'success');
  } catch {
    window.prompt('複製這個連結傳給朋友：', link);
  }
});

$('#passwordBtn').addEventListener('click', () => {
  const dlg = $('#passwordDialog');
  $('#newPassword').value = '';
  dlg.returnValue = '';
  dlg.showModal();
});
for (const btn of $$('[data-close]')) btn.addEventListener('click', () => btn.closest('dialog').close('cancel'));
$('#passwordDialog').addEventListener('close', async () => {
  if ($('#passwordDialog').returnValue !== 'ok') return;
  const password = $('#newPassword').value;
  const res = await request('room:password', { password });
  if (!res.ok) return toast(res.error, 'error');
  state.password = password;
});

function confirmDialog(title, text) {
  const dlg = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

$('#leaveBtn').addEventListener('click', () => leaveRoom());

// 手機版：工具列可收合
$('#toolsToggle').addEventListener('click', () => {
  $('#room').classList.toggle('tools-collapsed');
  requestAnimationFrame(() => state.board?.fit());
});

// ---------- 上傳圖片 ----------
$('#uploadBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) addImageFile(file);
});

const stage = $('#stage');
stage.addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.items].some((i) => i.kind === 'file')) return;
  e.preventDefault();
  stage.classList.add('dragover');
});
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dragover');
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (file) addImageFile(file);
  else toast('請拖曳圖片檔', 'error');
});
document.addEventListener('paste', (e) => {
  if (!state.roomId || e.target.closest('input, textarea')) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) addImageFile(item.getAsFile());
});

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('無法讀取這張圖片'));
    img.src = src;
  });
}

// 縮小並壓縮圖片，避免檔案太大傳不上去
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const keepAlpha = /png|gif|webp|svg/.test(file.type);
    const paint = (whiteBg) => {
      ctx.clearRect(0, 0, w, h);
      if (whiteBg) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(img, 0, 0, w, h);
    };

    paint(!keepAlpha);
    let src = keepAlpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9);
    if (src.length > 3_000_000 && keepAlpha) {
      const webp = c.toDataURL('image/webp', 0.9);
      if (webp.startsWith('data:image/webp') && webp.length < src.length) src = webp;
    }
    if (src.length > 3_000_000) {
      paint(true);
      src = c.toDataURL('image/jpeg', 0.85);
    }
    if (src.length > MAX_IMAGE_CHARS) throw new Error('圖片太大了，請換一張小一點的');
    return src;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function addImageFile(file) {
  if (!state.roomId) return;
  if (!file.type.startsWith('image/')) return toast('只能上傳圖片檔', 'error');
  try {
    const src = await compressImage(file);
    const img = await loadImage(src);
    $('#placeBar').hidden = false;
    const rect = await state.board.placeImage(img);
    $('#placeBar').hidden = true;
    if (!rect) return;

    toast('圖片上傳中…');
    const res = await request('image:add', { id: uid(), src, ...rect }, 120000);
    if (!res.ok) return toast(res.error, 'error');
    state.board.addOp(res.op);
  } catch (err) {
    $('#placeBar').hidden = true;
    toast(err.message || '圖片處理失敗', 'error');
  }
}

$('#placeOkBtn').addEventListener('click', () => state.board.finishPlacing(true));
$('#placeCancelBtn').addEventListener('click', () => state.board.finishPlacing(false));
$('#placeFitBtn').addEventListener('click', () => state.board.fitPlacing());

// ---------- 鍵盤快捷鍵 ----------
document.addEventListener('keydown', (e) => {
  if (!state.roomId || document.querySelector('dialog[open]')) return;
  if (e.target.closest('input, textarea')) return;
  const board = state.board;

  if (board.placing) {
    if (e.key === 'Enter') board.finishPlacing(true);
    if (e.key === 'Escape') board.finishPlacing(false);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    socket.emit('op:undo');
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === 'b' || key === 'p') selectTool('pen');
  else if (key === 'e') selectTool('eraser');
  else if (key === 'i') selectTool('picker');
  else if (key === '[' || key === ']') {
    sizeRange.value = Number(sizeRange.value) + (key === ']' ? 2 : -2);
    applyBrushInputs();
  }
});

// ====================== 連線事件 ======================
function setConnection(online) {
  $('#connDot').classList.toggle('online', online);
  $('#connDot').title = online ? '已連線' : '連線中斷';
  $('#offlineOverlay').hidden = online || !state.roomId;
  state.board?.setEnabled(online);
  $('#lobbyStatus').textContent = online
    ? '● 已連線到伺服器'
    : '正在連線伺服器…（免費主機閒置後第一次開啟，可能需要等 30～60 秒喚醒）';
}

socket.on('connect', async () => {
  if (!state.roomId) return setConnection(true);
  // 斷線後自動回到原本的房間
  const res = await request('room:join', { roomId: state.roomId, password: state.password, name: playerName(), clientId });
  if (!res.ok) {
    setConnection(true);
    return leaveRoom(res.code === 'BAD_PASSWORD' ? '房間密碼已被變更，請重新輸入密碼' : res.error);
  }
  enterRoom(res, state.password);
  setConnection(true);
  toast('已重新連線', 'success');
});
socket.on('disconnect', () => setConnection(false));

socket.on('users', (users) => renderUsers(users));
socket.on('user:joined', ({ name }) => toast(`${name} 加入了房間`));
socket.on('user:left', ({ name }) => toast(`${name} 離開了房間`));
socket.on('stroke:begin', (op) => state.board?.remoteBegin(op));
socket.on('stroke:move', ({ id, pts }) => state.board?.remoteMove(id, pts));
socket.on('stroke:end', ({ id }) => state.board?.remoteEnd(id));
socket.on('op:add', (op) => state.board?.addOp(op));
socket.on('op:remove', ({ id }) => state.board?.removeOp(id));
socket.on('canvas:clear', ({ by }) => {
  state.board?.clear();
  toast(`${by} 清空了畫布`);
});
socket.on('room:info', ({ hasPassword, by }) => {
  setLock(hasPassword);
  toast(hasPassword ? `${by} 設定了房間密碼` : `${by} 取消了房間密碼`, 'success');
});

// ====================== 初始化 ======================
setConnection(socket.connected);
renderRecentRooms();

// 從邀請連結進來：#room=123456
const linkRoom = new URLSearchParams(location.hash.slice(1)).get('room');
if (linkRoom) {
  switchTab('join');
  $('#joinRoomId').value = linkRoom;
  // 先試著直接進入（沒有密碼的房間就不用多按一次）
  request('room:join', { roomId: linkRoom, password: '', name: playerName(), clientId }).then((res) => {
    if (res.ok) return enterRoom(res, '');
    showLobbyError(res.error);
    $(res.code === 'BAD_PASSWORD' ? '#joinPassword' : '#joinRoomId').focus();
  });
}
