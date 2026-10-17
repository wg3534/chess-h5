// 国际象棋规则引擎（UMD：Node 与浏览器共用同一份，保证前后端规则完全一致）
// 棋盘：64 长度数组，index = r*8+c；r=0 是第 8 行(黑方底线，屏幕上方)，r=7 是第 1 行(白方底线)
// 棋子：大写=白 (K Q R B N P)，小写=黑 (k q r b n p)，null=空
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Chess = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function inB(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
  function idx(r, c) { return r * 8 + c; }
  function isW(p) { return !!p && p >= 'A' && p <= 'Z'; }
  function other(c) { return c === 'w' ? 'b' : 'w'; }
  function sqName(r, c) { return 'abcdefgh'.charAt(c) + (8 - r); }
  function assign(t, o) { for (var k in o) t[k] = o[k]; return t; }

  var KNIGHT = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  var KINGD  = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  var BISHOP = [[-1,-1],[-1,1],[1,-1],[1,1]];
  var ROOKD  = [[-1,0],[1,0],[0,-1],[0,1]];

  function initialBoard() {
    var b = new Array(64).fill(null);
    var back = ['R','N','B','Q','K','B','N','R'];
    for (var c = 0; c < 8; c++) {
      b[idx(0,c)] = back[c].toLowerCase(); // 黑方底线 a8..h8
      b[idx(1,c)] = 'p';
      b[idx(6,c)] = 'P';
      b[idx(7,c)] = back[c];               // 白方底线 a1..h1
    }
    return b;
  }

  function key(s) {
    var cs = (s.castling.wK?'K':'') + (s.castling.wQ?'Q':'') + (s.castling.bK?'k':'') + (s.castling.bQ?'q':'');
    return s.board.map(function (p) { return p || '-'; }).join('') + '|' + s.turn + '|' + cs + '|' + (s.ep ? s.ep[0] + ',' + s.ep[1] : '-');
  }

  function initial() {
    var s = {
      board: initialBoard(), turn: 'w',
      castling: { wK: true, wQ: true, bK: true, bQ: true },
      ep: null, half: 0, full: 1, rep: {}
    };
    s.rep[key(s)] = 1;
    return s;
  }

  function clone(s) {
    return {
      board: s.board.slice(), turn: s.turn,
      castling: { wK: s.castling.wK, wQ: s.castling.wQ, bK: s.castling.bK, bQ: s.castling.bQ },
      ep: s.ep ? [s.ep[0], s.ep[1]] : null,
      half: s.half, full: s.full, rep: assign({}, s.rep)
    };
  }

  // 判断 (r,c) 是否被 by 方攻击
  function attacked(s, r, c, by) {
    var pd = by === 'w' ? 1 : -1;            // 攻击该格的兵所在行偏移
    var pp = by === 'w' ? 'P' : 'p';
    if (inB(r + pd, c - 1) && s.board[idx(r + pd, c - 1)] === pp) return true;
    if (inB(r + pd, c + 1) && s.board[idx(r + pd, c + 1)] === pp) return true;

    var np = by === 'w' ? 'N' : 'n', i, nr, nc;
    for (i = 0; i < 8; i++) { nr = r + KNIGHT[i][0]; nc = c + KNIGHT[i][1]; if (inB(nr, nc) && s.board[idx(nr, nc)] === np) return true; }

    var kp = by === 'w' ? 'K' : 'k';
    for (i = 0; i < 8; i++) { nr = r + KINGD[i][0]; nc = c + KINGD[i][1]; if (inB(nr, nc) && s.board[idx(nr, nc)] === kp) return true; }

    var rq = by === 'w' ? ['R','Q'] : ['r','q'];
    var bq = by === 'w' ? ['B','Q'] : ['b','q'];
    var dirs, d, rr, cc, p;
    for (i = 0; i < 4; i++) {
      d = ROOKD[i]; rr = r + d[0]; cc = c + d[1];
      while (inB(rr, cc)) { p = s.board[idx(rr, cc)]; if (p) { if (rq.indexOf(p) >= 0) return true; break; } rr += d[0]; cc += d[1]; }
    }
    for (i = 0; i < 4; i++) {
      d = BISHOP[i]; rr = r + d[0]; cc = c + d[1];
      while (inB(rr, cc)) { p = s.board[idx(rr, cc)]; if (p) { if (bq.indexOf(p) >= 0) return true; break; } rr += d[0]; cc += d[1]; }
    }
    return false;
  }

  function findKing(s, col) {
    var kp = col === 'w' ? 'K' : 'k';
    for (var i = 0; i < 64; i++) if (s.board[i] === kp) return [Math.floor(i / 8), i % 8];
    return null;
  }
  function inCheck(s, col) {
    var k = findKing(s, col);
    return k ? attacked(s, k[0], k[1], other(col)) : false;
  }

  function push(moves, from, to, piece, cap, extra) {
    var m = { from: from, to: to, piece: piece, cap: cap || null, promo: null, castle: null, ep: false, dip: false };
    if (extra) for (var k in extra) m[k] = extra[k];
    moves.push(m);
  }

  function step(s, moves, r, c, col, dirs) {
    var p = s.board[idx(r, c)];
    for (var i = 0; i < dirs.length; i++) {
      var tr = r + dirs[i][0], tc = c + dirs[i][1];
      if (!inB(tr, tc)) continue;
      var q = s.board[idx(tr, tc)];
      if (!q) { push(moves, [r,c], [tr,tc], p, null); continue; }
      if (isW(q) !== (col === 'w')) push(moves, [r,c], [tr,tc], p, q);
    }
  }

  function slide(s, moves, r, c, col, dirs) {
    var p = s.board[idx(r, c)];
    for (var i = 0; i < dirs.length; i++) {
      var d = dirs[i], tr = r + d[0], tc = c + d[1];
      while (inB(tr, tc)) {
        var q = s.board[idx(tr, tc)];
        if (!q) { push(moves, [r,c], [tr,tc], p, null); }
        else {
          if (isW(q) !== (col === 'w')) push(moves, [r,c], [tr,tc], p, q);
          break;
        }
        tr += d[0]; tc += d[1];
      }
    }
  }

  function pawnMoves(s, moves, r, c, col) {
    var p = s.board[idx(r, c)];
    var dir = col === 'w' ? -1 : 1;
    var start = col === 'w' ? 6 : 1;
    var last = col === 'w' ? 0 : 7;
    var promos = ['Q','R','B','N'];
    var tr = r + dir, tc, q;

    if (inB(tr, c) && !s.board[idx(tr, c)]) {
      if (tr === last) { for (var i = 0; i < 4; i++) push(moves, [r,c], [tr,c], p, null, { promo: promos[i] }); }
      else {
        push(moves, [r,c], [tr,c], p, null);
        if (r === start) {
          var tr2 = r + dir * 2;
          if (!s.board[idx(tr2, c)]) push(moves, [r,c], [tr2,c], p, null, { dip: true });
        }
      }
    }
    for (var dc = -1; dc <= 1; dc += 2) {
      tc = c + dc;
      if (!inB(tr, tc)) continue;
      q = s.board[idx(tr, tc)];
      if (q && isW(q) !== (col === 'w')) {
        if (tr === last) { for (var j = 0; j < 4; j++) push(moves, [r,c], [tr,tc], p, q, { promo: promos[j] }); }
        else push(moves, [r,c], [tr,tc], p, q);
      } else if (!q && s.ep && s.ep[0] === tr && s.ep[1] === tc) {
        // 吃过路兵：被吃的兵在本行、目标列
        push(moves, [r,c], [tr,tc], p, col === 'w' ? 'p' : 'P', { ep: true });
      }
    }
  }

  function castleMoves(s, moves, r, c, col) {
    var homeR = col === 'w' ? 7 : 0;
    if (r !== homeR || c !== 4) return;
    var enemy = other(col);
    if (inCheck(s, col)) return; // 被将时不能易位
    var p = s.board[idx(r, c)];
    // 王翼 (短易位 O-O)：f,g 空；经过 f、落点 g 不被攻击；h1 有车
    if ((col === 'w' ? s.castling.wK : s.castling.bK) &&
        !s.board[idx(r,5)] && !s.board[idx(r,6)] &&
        s.board[idx(r,7)] === (col === 'w' ? 'R' : 'r') &&
        !attacked(s, r, 5, enemy) && !attacked(s, r, 6, enemy)) {
      push(moves, [r,c], [r,6], p, null, { castle: 'K' });
    }
    // 后翼 (长易位 O-O-O)：b,c,d 空；经过 d、落点 c 不被攻击；a1 有车
    if ((col === 'w' ? s.castling.wQ : s.castling.bQ) &&
        !s.board[idx(r,1)] && !s.board[idx(r,2)] && !s.board[idx(r,3)] &&
        s.board[idx(r,0)] === (col === 'w' ? 'R' : 'r') &&
        !attacked(s, r, 3, enemy) && !attacked(s, r, 2, enemy)) {
      push(moves, [r,c], [r,2], p, null, { castle: 'Q' });
    }
  }

  function genPseudo(s, col) {
    var moves = [];
    for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) {
      var p = s.board[idx(r, c)];
      if (!p || isW(p) !== (col === 'w')) continue;
      var t = p.toUpperCase();
      if (t === 'P') pawnMoves(s, moves, r, c, col);
      else if (t === 'N') step(s, moves, r, c, col, KNIGHT);
      else if (t === 'K') { step(s, moves, r, c, col, KINGD); castleMoves(s, moves, r, c, col); }
      else if (t === 'B') slide(s, moves, r, c, col, BISHOP);
      else if (t === 'R') slide(s, moves, r, c, col, ROOKD);
      else if (t === 'Q') { slide(s, moves, r, c, col, BISHOP); slide(s, moves, r, c, col, ROOKD); }
    }
    return moves;
  }

  function apply(s, m) {
    var n = clone(s);
    var f = m.from, t = m.to;
    var p = n.board[idx(f[0], f[1])];
    var col = isW(p) ? 'w' : 'b';
    var tp = p.toUpperCase();

    n.board[idx(f[0], f[1])] = null;
    n.board[idx(t[0], t[1])] = m.promo ? (col === 'w' ? m.promo : m.promo.toLowerCase()) : p;

    if (m.ep) n.board[idx(f[0], t[1])] = null;                 // 吃过路兵：移除被吃的兵
    if (m.castle === 'K') { n.board[idx(f[0],5)] = n.board[idx(f[0],7)]; n.board[idx(f[0],7)] = null; }
    if (m.castle === 'Q') { n.board[idx(f[0],3)] = n.board[idx(f[0],0)]; n.board[idx(f[0],0)] = null; }

    // 易位权
    if (tp === 'K') { n.castling[col + 'K'] = false; n.castling[col + 'Q'] = false; }
    if (tp === 'R') {
      if (f[0] === 7 && f[1] === 7) n.castling.wK = false;
      if (f[0] === 7 && f[1] === 0) n.castling.wQ = false;
      if (f[0] === 0 && f[1] === 7) n.castling.bK = false;
      if (f[0] === 0 && f[1] === 0) n.castling.bQ = false;
    }
    // 车被吃（在其原位）
    if (t[0] === 7 && t[1] === 7) n.castling.wK = false;
    if (t[0] === 7 && t[1] === 0) n.castling.wQ = false;
    if (t[0] === 0 && t[1] === 7) n.castling.bK = false;
    if (t[0] === 0 && t[1] === 0) n.castling.bQ = false;

    n.ep = m.dip ? [(f[0] + t[0]) / 2, f[1]] : null;
    n.half = (tp === 'P' || m.cap) ? 0 : s.half + 1;
    if (col === 'b') n.full = s.full + 1;
    n.turn = other(col);

    var k = key(n);
    n.rep[k] = (n.rep[k] || 0) + 1;
    return n;
  }

  function legalMoves(s) {
    var col = s.turn, ps = genPseudo(s, col), out = [];
    for (var i = 0; i < ps.length; i++) {
      if (!inCheck(apply(s, ps[i]), col)) out.push(ps[i]);
    }
    return out;
  }

  function insufficient(s) {
    var minors = [];
    for (var i = 0; i < 64; i++) {
      var p = s.board[i]; if (!p) continue;
      var t = p.toUpperCase();
      if (t === 'K') continue;
      if (t === 'B') { minors.push({ t: 'B', shade: (Math.floor(i / 8) + i % 8) % 2 }); continue; }
      if (t === 'N') { minors.push({ t: 'N' }); continue; }
      return false; // 有兵/车/后 → 不属子力不足
    }
    if (minors.length === 0) return true;
    if (minors.length === 1) return true;
    if (minors.length === 2 && minors[0].t === 'B' && minors[1].t === 'B' && minors[0].shade === minors[1].shade) return true;
    return false;
  }

  function status(s) {
    var lm = legalMoves(s);
    var chk = inCheck(s, s.turn);
    if (lm.length === 0) {
      return chk
        ? { over: true, result: 'checkmate', winner: other(s.turn), inCheck: true }
        : { over: true, result: 'stalemate', winner: null, inCheck: false };
    }
    if (s.half >= 100) return { over: true, result: 'fifty', winner: null, inCheck: chk };
    for (var k in s.rep) if (s.rep[k] >= 3) return { over: true, result: 'repetition', winner: null, inCheck: chk };
    if (insufficient(s)) return { over: true, result: 'material', winner: null, inCheck: chk };
    return { over: false, result: chk ? 'check' : 'normal', winner: null, inCheck: chk };
  }

  function disambig(s, m) {
    var t = m.piece.toUpperCase(), moves = legalMoves(s), others = [], i, o;
    for (i = 0; i < moves.length; i++) {
      o = moves[i];
      if (o.piece.toUpperCase() !== t) continue;
      if (o.to[0] !== m.to[0] || o.to[1] !== m.to[1]) continue;
      if (isW(o.piece) !== isW(m.piece)) continue;
      // 跳过自身（按坐标比对，不能用对象引用：legalMoves 每次都生成新对象）
      if (o.from[0] === m.from[0] && o.from[1] === m.from[1]) continue;
      others.push(o);
    }
    if (others.length === 0) return '';
    var sameFile = false, sameRank = false;
    for (i = 0; i < others.length; i++) {
      if (others[i].from[1] === m.from[1]) sameFile = true;
      if (others[i].from[0] === m.from[0]) sameRank = true;
    }
    if (!sameFile) return 'abcdefgh'.charAt(m.from[1]);
    if (!sameRank) return String(8 - m.from[0]);
    return 'abcdefgh'.charAt(m.from[1]) + (8 - m.from[0]);
  }

  function suffix(s, m) {
    var st = status(apply(s, m));
    if (st.result === 'checkmate') return '#';
    if (st.inCheck) return '+';
    return '';
  }

  function toSan(s, m) {
    if (m.castle) return (m.castle === 'K' ? 'O-O' : 'O-O-O') + suffix(s, m);
    var t = m.piece.toUpperCase();
    var to = sqName(m.to[0], m.to[1]);
    var s2;
    if (t === 'P') {
      s2 = m.cap ? 'abcdefgh'.charAt(m.from[1]) + 'x' + to : to;
      if (m.promo) s2 += '=' + m.promo;
    } else {
      s2 = t + disambig(s, m) + (m.cap ? 'x' : '') + to;
    }
    return s2 + suffix(s, m);
  }

  // 按 from/to/(promo) 在合法着法里找到对应着法（服务端校验与前端提交共用）
  function findMove(s, from, to, promo) {
    var ms = legalMoves(s);
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      if (m.from[0] !== from[0] || m.from[1] !== from[1]) continue;
      if (m.to[0] !== to[0] || m.to[1] !== to[1]) continue;
      if (m.promo) { if (promo && String(promo).toUpperCase() === m.promo) return m; }
      else return m;
    }
    return null;
  }

  return {
    initial: initial, clone: clone, apply: apply, legalMoves: legalMoves,
    status: status, toSan: toSan, findMove: findMove, sqName: sqName,
    attacked: attacked, inCheck: inCheck, insufficient: insufficient,
    idx: idx, isW: isW, key: key, inB: inB
  };
});
