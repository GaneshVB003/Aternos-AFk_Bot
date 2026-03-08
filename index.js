const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const mineflayer = require('mineflayer');
const pvp = require('mineflayer-pvp').plugin;
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const armorManager = require('mineflayer-armor-manager');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, '')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'main.html')));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Web server on port ${PORT}`));

// ---- Self-ping to prevent Render spin-down ----
// Render automatically sets RENDER_EXTERNAL_URL — no config needed
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';
if (RENDER_URL) {
  setInterval(() => {
    http.get(`${RENDER_URL}/health`, (res) => {
      console.log(`📡 Self-ping OK: ${res.statusCode}`);
    }).on('error', (err) => {
      console.error('📡 Self-ping failed:', err.message);
    });
  }, 14 * 60 * 1000); // every 14 minutes
  console.log(`📡 Self-ping active → ${RENDER_URL}`);
}

// ---- Bot config ----
const BOT_CONFIG = {
  host: 'mongombo.aternos.me',
  port: 50532,
  username: 'iamheretokeepserveronline',
  version: false,
  auth: 'offline'
};

const LOGIN_PASSWORD = 'bot1122033';

let bot = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let manualStop = false;
let afkMoveInterval = null;
let afkLookInterval = null;
let afkSneakInterval = null;

const MAX_RECONNECT = 15;
const BASE_DELAY = 10000;

function emitStatus(msg) {
  console.log('[STATUS]', msg);
  io.emit('bot_status', msg);
}

// ---- AFK Prevention ----
function startAFK() {
  stopAFK();
  // Walk in random direction every 30s
  afkMoveInterval = setInterval(() => {
    if (!bot || !bot.entity) return;
    const dirs = ['forward', 'back', 'left', 'right'];
    const dir = dirs[Math.floor(Math.random() * dirs.length)];
    bot.setControlState(dir, true);
    setTimeout(() => { if (bot) bot.setControlState(dir, false); }, 1000 + Math.random() * 500);
  }, 30000);

  // Look around + swing arm every 15s
  afkLookInterval = setInterval(() => {
    if (!bot || !bot.entity) return;
    bot.look((Math.random() * Math.PI * 2) - Math.PI, (Math.random() * 0.6) - 0.3, true);
    bot.swingArm();
  }, 15000);

  // Sneak toggle every 45s
  afkSneakInterval = setInterval(() => {
    if (!bot || !bot.entity) return;
    bot.setControlState('sneak', true);
    setTimeout(() => { if (bot) bot.setControlState('sneak', false); }, 800);
  }, 45000);
}

function stopAFK() {
  if (afkMoveInterval)  { clearInterval(afkMoveInterval);  afkMoveInterval = null; }
  if (afkLookInterval)  { clearInterval(afkLookInterval);  afkLookInterval = null; }
  if (afkSneakInterval) { clearInterval(afkSneakInterval); afkSneakInterval = null; }
}

// ---- Bot lifecycle ----
function stopBot() {
  manualStop = true;
  stopAFK();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (bot) { try { bot.removeAllListeners(); bot.end(); } catch (_) {} bot = null; }
  reconnectAttempts = 0;
  emitStatus('🛑 Bot stopped.');
}

function startBot() {
  if (bot) { emitStatus('⚠️ Already running.'); return; }
  manualStop = false;
  reconnectAttempts = 0;
  createBot();
}

function reconnectBot() {
  emitStatus('🔁 Reconnecting...');
  stopAFK();
  manualStop = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (bot) { try { bot.removeAllListeners(); bot.end(); } catch (_) {} bot = null; }
  manualStop = false;
  setTimeout(createBot, 1500);
}

function scheduleReconnect() {
  if (manualStop) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (reconnectAttempts >= MAX_RECONNECT) { emitStatus('❗ Max reconnects reached.'); return; }
  const delay = BASE_DELAY * Math.pow(2, reconnectAttempts);
  reconnectAttempts++;
  emitStatus(`⏳ Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; createBot(); }, delay);
}

// ---- Create bot ----
function createBot() {
  if (manualStop) return;
  if (bot) { try { bot.removeAllListeners(); bot.end(); } catch (_) {} bot = null; }

  emitStatus('🔄 Connecting...');
  try {
    bot = mineflayer.createBot(BOT_CONFIG);
  } catch (err) {
    emitStatus(`❌ Failed: ${err.message}`);
    scheduleReconnect();
    return;
  }

  try { bot.loadPlugin(pvp); }          catch (e) { console.error('pvp:', e.message); }
  try { bot.loadPlugin(armorManager); } catch (e) { console.error('armor:', e.message); }
  try { bot.loadPlugin(pathfinder); }   catch (e) { console.error('pathfinder:', e.message); }

  let guardPos = null;

  bot.on('messagestr', (msg) => {
    const lower = msg.toLowerCase();
    if (lower.includes('/register') || lower.includes('please register')) {
      bot.chat(`/register ${LOGIN_PASSWORD} ${LOGIN_PASSWORD}`);
      emitStatus('📝 Sent /register');
    } else if (lower.includes('/login') || lower.includes('please login') || lower.includes('log in')) {
      bot.chat(`/login ${LOGIN_PASSWORD}`);
      emitStatus('🔑 Sent /login');
    }
  });

  bot.once('spawn', () => {
    emitStatus(`✅ Spawned as ${bot.username} (v${bot.version})`);
    reconnectAttempts = 0;
    setTimeout(() => { if (bot) bot.chat(`/login ${LOGIN_PASSWORD}`); }, 2000);
    startAFK();
  });

  bot.on('health', () => {
    if (!bot || bot.food >= 18) return;
    const food = bot.inventory.items().find(item =>
      ['bread','apple','cooked_beef','cooked_chicken','cooked_porkchop',
       'cooked_mutton','cooked_salmon','cooked_cod','carrot','baked_potato']
      .some(n => item.name.includes(n))
    );
    if (food) bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {});
  });

  bot.on('playerCollect', (collector) => {
    if (!bot || collector.username !== bot.username) return;
    setTimeout(() => {
      if (!bot) return;
      const sword = bot.inventory.items().find(i => i.name.includes('sword'));
      if (sword) bot.equip(sword, 'hand').catch(() => {});
    }, 200);
    setTimeout(() => {
      if (!bot) return;
      const shield = bot.inventory.items().find(i => i.name.includes('shield'));
      if (shield) bot.equip(shield, 'off-hand').catch(() => {});
    }, 400);
  });

  function guardArea(pos) {
    guardPos = pos.clone();
    emitStatus(`🛡️ Guarding ${Math.floor(guardPos.x)}, ${Math.floor(guardPos.y)}, ${Math.floor(guardPos.z)}`);
    moveToGuardPos();
  }

  function stopGuarding() {
    guardPos = null;
    if (bot.pvp) bot.pvp.stop();
    if (bot.pathfinder) bot.pathfinder.setGoal(null);
    emitStatus('🛑 Guard stopped.');
  }

  function moveToGuardPos() {
    if (!bot || !guardPos) return;
    try {
      const movements = new Movements(bot);
      movements.allowSprinting = true;
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(new goals.GoalNear(guardPos.x, guardPos.y, guardPos.z, 2));
    } catch (e) { console.error('pathfinder:', e.message); }
  }

  bot.on('stoppedAttacking', () => { if (guardPos) moveToGuardPos(); });

  bot.on('physicsTick', () => {
    if (!bot || !guardPos || !bot.pvp) return;
    const mob = bot.nearestEntity(e =>
      e.type === 'mob' &&
      e.mobType !== 'Armor Stand' &&
      e.position.distanceTo(bot.entity.position) < 16
    );
    if (mob) bot.pvp.attack(mob);
  });

  bot.on('chat', (username, message) => {
    if (!bot || username === bot.username) return;
    const player = bot.players[username];
    if (message === 'guard') {
      if (!player?.entity) { bot.chat(`Can't see you, ${username}!`); return; }
      bot.chat('🛡️ Guarding!'); guardArea(player.entity.position);
    } else if (message === 'stop') {
      bot.chat('🛑 Stopped.'); stopGuarding();
    } else if (message === 'come') {
      if (!player?.entity) { bot.chat(`Can't see you!`); return; }
      guardArea(player.entity.position);
    } else if (message === 'pos') {
      const p = bot.entity.position;
      bot.chat(`${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}`);
    } else if (message === 'health') {
      bot.chat(`HP: ${Math.floor(bot.health)}/20  Food: ${bot.food}/20`);
    }
  });

  bot.on('error', (err) => {
    console.error('⚠️ Error:', err.message);
    emitStatus(`⚠️ ${err.message}`);
  });

  bot.on('kicked', (reason) => {
    let msg = reason;
    try { msg = JSON.parse(reason).text || reason; } catch (_) {}
    emitStatus(`👢 Kicked: ${msg}`);
    stopAFK(); bot = null; scheduleReconnect();
  });

  bot.on('end', (reason) => {
    emitStatus(`🔌 Disconnected${reason ? ': ' + reason : ''}`);
    stopAFK(); bot = null; scheduleReconnect();
  });
}

// ---- Socket.IO ----
io.on('connection', (socket) => {
  socket.emit('bot_status', bot ? `✅ Running as ${bot.username}` : '🛑 Stopped.');
  socket.on('control_bot', (cmd) => {
    if (cmd === 'start') startBot();
    else if (cmd === 'stop') stopBot();
    else if (cmd === 'reconnect') reconnectBot();
  });
});

process.on('uncaughtException', (err) => console.error('🔥', err.message));
process.on('unhandledRejection', (r) => console.error('⚠️', r));
