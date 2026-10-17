// 国际象棋 H5 · 实时联机服务器
// 静态托管 public/ + WebSocket 房间管理；所有写操作（走子/悔棋/认输/和棋/重开）服务端权威校验
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Chess = require('./public/chess-engine.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const ROOM_TTL = 10 * 60 * 1000;

const rooms = new Map();
let pidCounter = 0;

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符 I O 0 1
  let id;
  do {
    id = '';
    for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(id));
  return id;
}

function makeRoom() {
  const id = genRoomId();
  const room = {
    id, game: Chess.initial(), snaps: [], moves: [],
    status: 'waiting', winner: null, result: null, inCheck: false,
    players: [], undoReq: null, drawReq: null, createdAt: Date.now()
  };
  rooms.set(id, room);
  return room;
}

function publicState(room) {
  const g = room.game;
  const last = room.moves.length ? room.moves[room.moves.length - 1] : null;
  return {
    id: room.id,
    g: { board: g.board, turn: g.turn, castling: g.castling, ep: g.ep }, // 前端据此生成合法着法
    moves: room.moves.map((m) => ({ san: m.san, by: m.by })),
    lastMove: last ? { from: last.from, to: last.to } : null,
    status: room.status, winner: room.winner, result: room.result, inCheck: room.inCheck,
    players: room.players.map((p) => ({ id: p.id, color: p.color, name: p.name, online: p.online })),
    undoPending: !!room.undoReq, undoFrom: room.undoReq ? room.undoReq.from : null,
    drawPending: !!room.drawReq, drawFrom: room.drawReq ? room.drawReq.from : null
  };
}

function send(ws, obj) { try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); } catch (e) {} }
function broadcast(room, obj) { room.players.forEach((p) => send(p.ws, obj)); }
function other(c) { return c === 'w' ? 'b' : 'w'; }

function handle(ws, d) {
  switch (d.type) {
    case 'create': {
      const room = makeRoom();
      const p = { id: ws.pid, ws, color: 'w', name: (d.name || '白方').slice(0, 8), online: true };
      room.players.push(p);
      ws.roomId = room.id; ws.color = 'w'; ws.name = p.name;
      send(ws, { type: 'created', roomId: room.id, you: 'w', pid: ws.pid, state: publicState(room) });
      break;
    }
    case 'join': {
      const room = rooms.get(String(d.roomId || '').toUpperCase());
      if (!room) { send(ws, { type: 'error', msg: '房间不存在，请检查房间号' }); return; }
      let slot = room.players.find((p) => !p.online);       // 断线重连回原座位
      if (slot) { slot.ws = ws; slot.online = true; ws.color = slot.color; ws.name = slot.name; }
      else if (room.players.length < 2) {
        const color = room.players.length === 0 ? 'w' : 'b';
        const p = { id: ws.pid, ws, color, name: (color === 'w' ? '白方' : '黑方'), online: true };
        room.players.push(p); ws.color = color; ws.name = p.name;
      } else { send(ws, { type: 'error', msg: '房间已满' }); return; }
      ws.roomId = room.id;
      if (room.players.length === 2 && room.status === 'waiting') room.status = 'playing';
      send(ws, { type: 'joined', you: ws.color, pid: ws.pid, state: publicState(room) });
      broadcast(room, { type: 'state', state: publicState(room) });
      break;
    }
    case 'move': {
      const room = rooms.get(ws.roomId);
      if (!room || room.status !== 'playing') return;
      const me = room.players.find((p) => p.id === ws.pid); if (!me) return;
      if (room.game.turn !== me.color) return;                       // 非当前回合
      const mv = Chess.findMove(room.game, d.from, d.to, d.promo);
      if (!mv) { send(ws, { type: 'error', msg: '非法着法' }); return; }
      const san = Chess.toSan(room.game, mv);
      room.snaps.push(Chess.clone(room.game));                       // 悔棋用快照
      room.game = Chess.apply(room.game, mv);
      room.moves.push({ san, from: mv.from, to: mv.to, by: me.color });
      const st = Chess.status(room.game);
      room.inCheck = st.inCheck;
      if (st.over) { room.status = 'over'; room.winner = st.winner; room.result = st.result; }
      broadcast(room, { type: 'state', state: publicState(room) });
      if (mv.cap) broadcast(room, { type: 'event', kind: 'capture' });
      else broadcast(room, { type: 'event', kind: 'move' });
      if (st.inCheck && !st.over) broadcast(room, { type: 'event', kind: 'check' });
      break;
    }
    case 'undo_request': {
      const room = rooms.get(ws.roomId);
      if (!room || room.status !== 'playing') return;
      const me = room.players.find((p) => p.id === ws.pid); if (!me) return;
      if (room.moves.length === 0) return;
      room.undoReq = { from: me.color };
      broadcast(room, { type: 'state', state: publicState(room) });
      break;
    }
    case 'undo_respond': {
      const room = rooms.get(ws.roomId); if (!room || !room.undoReq) return;
      if (d.accept && room.snaps.length) {                            // 悔一步
        room.game = room.snaps.pop();
        room.moves.pop();
        room.status = 'playing'; room.winner = null; room.result = null;
        room.inCheck = Chess.status(room.game).inCheck;
      }
      room.undoReq = null;
      broadcast(room, { type: 'state', state: publicState(room) });
      break;
    }
    case 'resign': {
      const room = rooms.get(ws.roomId);
      if (!room || room.status !== 'playing') return;
      const me = room.players.find((p) => p.id === ws.pid); if (!me) return;
      room.status = 'over'; room.winner = other(me.color); room.result = 'resign';
      broadcast(room, { type: 'state', state: publicState(room) });
      break;
    }
    case 'draw_offer': {
      const room = rooms.get(ws.roomId);
      if (!room || room.status !== 'playing') return;
      const me = room.players.find((p) => p.id === ws.pid); if (!me) return;
      room.drawReq = { from: me.color };
      broadcast(room, { type: 'state', state: publicState(room) });
      break;
    }
    case 'draw_respond': {
      const room = rooms.get(ws.roomId); if (!room || !room.drawReq) return;
      if (d.accept) { room.status = 'over'; room.winner = null; room.result = 'draw'; }
      room.drawReq = null;
      broadcast(room, { type: 'state', state: publicState(room) });
      break;
    }
    case 'restart': {
      const room = rooms.get(ws.roomId); if (!room) return;
      room.game = Chess.initial(); room.snaps = []; room.moves = [];
      room.status = 'playing'; room.winner = null; room.result = null; room.inCheck = false;
      room.undoReq = null; room.drawReq = null;
      room.players.forEach((p) => { p.color = other(p.color); p.ws.color = p.color; }); // 交换黑白
      broadcast(room, { type: 'state', state: publicState(room) });
      break;
    }
    case 'emoji':
    case 'chat': {
      const room = rooms.get(ws.roomId); if (!room) return;
      broadcast(room, { type: 'emoji', from: ws.color, name: ws.name, text: String(d.text || '').slice(0, 30) });
      break;
    }
    case 'name': {
      const room = rooms.get(ws.roomId); if (!room) return;
      ws.name = String(d.name || ws.name).slice(0, 8);
      const p = room.players.find((x) => x.ws === ws); if (p) p.name = ws.name;
      broadcast(room, { type: 'state', state: publicState(room) });
      break;
    }
  }
}

function leaveRoom(ws) {
  const room = rooms.get(ws.roomId); if (!room) return;
  const p = room.players.find((x) => x.ws === ws); if (p) p.online = false;
  if (room.players.every((pl) => !pl.online)) {
    setTimeout(() => { if (room.players.every((pl) => !pl.online)) rooms.delete(room.id); }, ROOM_TTL);
  } else {
    broadcast(room, { type: 'state', state: publicState(room) });
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.pid = 'P' + (++pidCounter) + crypto.randomBytes(2).toString('hex');
  ws.roomId = null; ws.color = null; ws.name = '玩家';
  ws.on('message', (raw) => {
    let d; try { d = JSON.parse(raw); } catch (e) { return; }
    handle(ws, d);
  });
  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log('国际象棋 H5 服务已启动： http://localhost:' + PORT + '  (WebSocket 同端口)');
});
