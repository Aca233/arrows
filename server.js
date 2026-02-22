const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Player, Arrow, Monster, Wall, Portal, PoisonZone, TargetBee, BuffDrop, Trap, checkCollision, checkCircleRectCollision, resolveCircleRectCollision, WEAPONS } = require('./gameLogic');
const { BotBrain, getNextBotName } = require('./botAI');
const { loadMap, getMap, saveMap, listMaps } = require('./mapLoader');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json()); // 解析 JSON 请求体（编辑器 API 需要）
app.use(express.static(path.join(__dirname, 'public')));

// 将根目录下的 gameLogic.js 显式映射到前端可访问路径，避免返回 404 HTML 触发 MIME 错误
app.get('/gameLogic.js', (req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'gameLogic.js'));
});

// 无自定义图标时返回 204，避免 favicon.ico 404 噪音
app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

const rooms = {}; // { roomId: roomState }
const playerRooms = {}; // { socketId: roomId }
const VALID_MODES = new Set(['standard', 'dark_forest', 'sniper_duel']);

function normalizeMode(modeStr) {
    return VALID_MODES.has(modeStr) ? modeStr : 'standard';
}

function decoratePlayerName(name, talent) {
    let playerName = name || '特工';
    if (talent === 'paranoid') playerName += ' [偏执]';
    else if (talent === 'fantasy') playerName += ' [幻想]';
    else if (talent === 'insidious') playerName += ' [阴险]';
    else if (talent === 'clairvoyance') playerName += ' [明察]';
    return playerName;
}

function applyModeStats(player, mode) {
    if (!player) return;
    player.roomMode = mode;
    if (mode === 'sniper_duel') {
        player.baseSpeed = 350;
        player.speed = 350;
    } else {
        player.baseSpeed = 220;
        player.speed = 220;
    }
}

function createRoom(roomId, mode = 'standard') {
    return {
        id: roomId,
        mode: mode,
        players: {},
        arrows: {},
        monsters: {},
        walls: [],
        portals: [],
        poisonZones: [],
        bees: {},
        buffs: {},
        traps: {},
        round: 0,
        state: 'waiting', // waiting, playing, round_end
        countdown: 0,
        safeZone: { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2, radius: Math.max(GAME_WIDTH, GAME_HEIGHT) },
        safeZoneShrinkTimer: 0,
        botBrains: {},
        counters: {
            arrow: 0, monster: 0, bee: 0, buff: 0, trap: 0, monsterSpawn: 0, bot: 0
        }
    };
}

function spawnSplitterChildren(room, x, y) {
    for (let i = 0; i < 2; i++) {
        const monsterId = `monster_${room.counters.monster++}`;
        const newMonster = new Monster(monsterId, x + (Math.random() * 20 - 10), y + (Math.random() * 20 - 10), 'normal');
        newMonster.radius = 10;
        newMonster.baseSpeed = 150;
        newMonster.speed = 150;
        newMonster.color = '#00ff88';
        newMonster.hp = 1;
        newMonster.maxHp = 1;
        room.monsters[monsterId] = newMonster;
    }
}

/**
 * 添加一个 Bot 玩家到指定房间
 */
function addBot(room, difficulty = 'medium') {
    const botId = `bot_${room.counters.bot++}`;
    const botName = `🤖 ${getNextBotName()}`;
    const botColor = `hsl(${Math.random() * 360}, 70%, 60%)`;

    room.players[botId] = new Player(
        botId,
        Math.random() * (GAME_WIDTH - 40) + 20,
        Math.random() * (GAME_HEIGHT - 40) + 20,
        botName,
        botColor
    );
    room.players[botId].talent = 'none';
    room.players[botId].coinsEarned = 0;
    room.players[botId].isBot = true;
    applyModeStats(room.players[botId], room.mode);

    room.botBrains[botId] = new BotBrain(botId, difficulty);
    console.log(`[Room ${room.id}] Bot added: ${botName} (${difficulty}) [${botId}]`);
    return botId;
}

/**
 * 移除一个 Bot 玩家
 */
function removeBot(room, botId) {
    if (!botId) {
        // 移除最后一个 Bot
        const botIds = Object.keys(room.botBrains);
        if (botIds.length === 0) return;
        botId = botIds[botIds.length - 1];
    }
    if (room.botBrains[botId]) {
        const name = room.players[botId] ? room.players[botId].name : botId;
        delete room.botBrains[botId];
        delete room.players[botId];
        console.log(`[Room ${room.id}] Bot removed: ${name} [${botId}]`);
    }
}

/**
 * Bot 射击回调 — 在服务端直接创建箭矢
 */
function botCreateArrow(room, ownerId, x, y, dirX, dirY, speed, charge, lifeTime) {
    const arrowId = `arrow_${room.counters.arrow++}`;
    const arrow = new Arrow(arrowId, ownerId, x, y, dirX, dirY, speed);
    arrow.lifeTime = lifeTime;
    arrow.charge = charge;
    room.arrows[arrowId] = arrow;
}


const GAME_WIDTH = 2000;
const GAME_HEIGHT = 1200;

// === 编辑器 API 路由 ===
app.get('/api/maps', (req, res) => {
    res.json(listMaps());
});

app.get('/api/maps/:id', (req, res) => {
    const data = getMap(req.params.id);
    if (!data) return res.status(404).json({ error: '地图不存在' });
    res.json(data);
});

app.post('/api/maps/:id', (req, res) => {
    const mapData = req.body;
    mapData.id = req.params.id;
    if (saveMap(mapData)) {
        res.json({ success: true, message: '地图已保存' });
    } else {
        res.status(500).json({ error: '保存失败' });
    }
});

function getOrCreateRoom(modeStr, requestRoomId = '') {
    const normalizedMode = normalizeMode(modeStr);
    const normalizedRoomId = (requestRoomId || '').trim();

    if (normalizedRoomId) {
        if (rooms[normalizedRoomId]) {
            return rooms[normalizedRoomId];
        } else {
            const newRoom = createRoom(normalizedRoomId, normalizedMode);
            const mapData = loadMap(normalizedMode);
            if (mapData) {
                newRoom.walls = mapData.walls || [];
                newRoom.portals = mapData.portals || [];
                newRoom.poisonZones = mapData.poisonZones || [];
            }
            rooms[normalizedRoomId] = newRoom;
            console.log(`[Server] Created customized room: ${normalizedRoomId} mode: ${normalizedMode}`);
            return newRoom;
        }
    }

    for (const [id, r] of Object.entries(rooms)) {
        if (r.mode === normalizedMode && Object.keys(r.players).length < 20) {
            return r;
        }
    }

    const newRoomId = `room_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const newRoom = createRoom(newRoomId, normalizedMode);

    const mapData = loadMap(normalizedMode);
    if (mapData) {
        newRoom.walls = mapData.walls || [];
        newRoom.portals = mapData.portals || [];
        newRoom.poisonZones = mapData.poisonZones || [];
    }
    rooms[newRoomId] = newRoom;
    console.log(`[Server] Created new anonymous room: ${newRoomId} mode: ${normalizedMode}`);
    return newRoom;
}

io.on('connection', (socket) => {
    console.log(`[Server] Client connected: ${socket.id}`);

    socket.emit('init', socket.id);

    socket.on('join', (data = {}) => {
        const { roomId, name, mode, talent, weapon } = data;
        const normalizedMode = normalizeMode(mode);
        const requestedRoomId = (roomId || '').trim();
        const previousRoomId = playerRooms[socket.id];

        if (previousRoomId && rooms[previousRoomId] && previousRoomId !== requestedRoomId) {
            socket.leave(previousRoomId);
            delete rooms[previousRoomId].players[socket.id];

            const hasHumans = Object.keys(rooms[previousRoomId].players).some(pid => !pid.startsWith('bot_'));
            if (!hasHumans) {
                console.log(`[Server] Room ${previousRoomId} empty after switch. Destroying...`);
                delete rooms[previousRoomId];
            }
        }

        const room = getOrCreateRoom(normalizedMode, requestedRoomId);
        const effectiveMode = normalizeMode(room.mode);

        room.players[socket.id] = new Player(
            socket.id,
            Math.random() * (GAME_WIDTH - 40) + 20,
            Math.random() * (GAME_HEIGHT - 40) + 20,
            decoratePlayerName(name, talent),
            `hsl(${Math.random() * 360}, 100%, 50%)`
        );

        const player = room.players[socket.id];
        player.talent = talent || 'none';
        player.weapon = weapon || 'bow';
        player.coinsEarned = 0;
        applyModeStats(player, effectiveMode);

        playerRooms[socket.id] = room.id;
        socket.join(room.id);

        const humanCount = Object.keys(room.players).filter(id => !id.startsWith('bot_')).length;
        const totalCount = Object.keys(room.players).length;
        socket.emit('room_joined', {
            roomId: room.id,
            mode: effectiveMode,
            state: room.state,
            players: humanCount,
            total: totalCount
        });

        console.log(`[Room ${room.id}] Player joined: ${player.name} | Talent: ${player.talent} | Mode: ${effectiveMode}`);
    });

    socket.on('set_room_mode', (data = {}) => {
        const roomId = playerRooms[socket.id];
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (room.state !== 'waiting') return;

        const nextMode = normalizeMode(data.mode);
        room.mode = nextMode;

        const mapData = loadMap(nextMode);
        room.walls = mapData ? (mapData.walls || []) : [];
        room.portals = mapData ? (mapData.portals || []) : [];
        room.poisonZones = mapData ? (mapData.poisonZones || []) : [];

        for (const p of Object.values(room.players)) {
            applyModeStats(p, nextMode);
        }

        io.to(room.id).emit('room_joined', {
            roomId: room.id,
            mode: room.mode,
            state: room.state,
            players: Object.keys(room.players).filter(id => !id.startsWith('bot_')).length,
            total: Object.keys(room.players).length
        });
        io.to(room.id).emit('chat', `房间模式已切换为 [${nextMode}]`);
    });

    socket.on('start_room', () => {
        const roomId = playerRooms[socket.id];
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (room.state !== 'waiting') return;

        if (Object.keys(room.players).length < 1) return;

        startNewRound(room);
        io.to(room.id).emit('chat', `对局开始！模式: [${room.mode}]`);
    });

    socket.on('get_room_list', () => {
        const roomList = [];
        for (const [id, room] of Object.entries(rooms)) {
            const humanCount = Object.keys(room.players).filter(pid => !pid.startsWith('bot_')).length;
            const totalCount = Object.keys(room.players).length;
            roomList.push({
                roomId: room.id,
                mode: room.mode,
                state: room.state,
                humans: humanCount,
                total: totalCount
            });
        }
        socket.emit('room_list', roomList);
    });

    socket.on('skill', () => {
        const roomId = playerRooms[socket.id];
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (room.state !== 'playing') return;

        const player = room.players[socket.id];
        if (player && !player.isDead && player.talent === 'clairvoyance') {
            if (!player.radarOn && !player.radarCooldown) {
                player.radarOn = true;
                player.radarCooldown = 3;
                setTimeout(() => {
                    if (rooms[roomId] && rooms[roomId].players[socket.id]) {
                        rooms[roomId].players[socket.id].radarOn = false;
                    }
                }, 1000);
            }
        }
    });

    socket.on('charge_start', () => {
        const roomId = playerRooms[socket.id];
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (room.state !== 'playing') return;

        const player = room.players[socket.id];
        if (player && !player.isDead) {
            player.isCharging = true;
            player.speed = player.baseSpeed * 0.4;
        }
    });

    socket.on('charge_end', () => {
        const roomId = playerRooms[socket.id];
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (room.state !== 'playing') return;

        const player = room.players[socket.id];
        if (player && !player.isDead) {
            player.isCharging = false;
            if (player.buffExp <= 0) {
                player.speed = player.baseSpeed;
            }
        }
    });

    socket.on('input', (inputData) => {
        const roomId = playerRooms[socket.id];
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (room.state !== 'playing') return;

        const player = room.players[socket.id];
        if (player && !player.isDead) {
            player.vx = inputData.x * player.speed;
            player.vy = inputData.y * player.speed;
        }
    });

    socket.on('shoot', (targetData) => {
        const roomId = playerRooms[socket.id];
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (room.state !== 'playing') return;

        const player = room.players[socket.id];

        if (player && !player.isDead && player.talent) {
            const dx = targetData.x - player.x;
            const dy = targetData.y - player.y;

            const weaponStats = WEAPONS[player.weapon] || WEAPONS['bow'];
            const charge = Math.max(0, Math.min(targetData.charge || 0, 1));

            let amount = weaponStats.amount;
            let spreadAngle = weaponStats.spreadAngle;
            if (player.hasMultishot) {
                amount = Math.max(amount, 3);
                if (spreadAngle === 0) spreadAngle = Math.PI / 12;
            }

            let baseSpeed = weaponStats.speedBase + charge * weaponStats.speedMultiplier;
            if (player.talent === 'paranoid') {
                baseSpeed *= 0.8;
            }
            if (player.roomMode === 'sniper_duel') {
                baseSpeed *= 2;
            }

            const arrowLifeTime = weaponStats.lifeBase + charge * weaponStats.lifeMultiplier;
            let inaccuracy = (1 - charge) * weaponStats.inaccuracyBase;
            if (targetData.moving) {
                inaccuracy += weaponStats.movingInaccuracy;
            }

            let baseAngle = Math.atan2(dy, dx);

            for (let i = 0; i < amount; i++) {
                let currentAngle = baseAngle;
                if (amount > 1) {
                    currentAngle = baseAngle + (i - (amount - 1) / 2) * spreadAngle;
                }

                currentAngle += (Math.random() - 0.5) * inaccuracy * 2;

                let curDx = Math.cos(currentAngle);
                let curDy = Math.sin(currentAngle);

                const arrowId = `arrow_${room.counters.arrow++}`;
                const arrow = new Arrow(arrowId, socket.id, player.x, player.y, curDx, curDy, baseSpeed);
                arrow.lifeTime = arrowLifeTime;
                arrow.charge = charge;
                arrow.talent = player.talent;
                arrow.damage = weaponStats.damageBase + Math.floor(charge * weaponStats.damageMultiplier);
                arrow.pierce = weaponStats.pierce;

                if (player.talent === 'poison') arrow.color = '#00ff00';
                if (player.talent === 'lightning') arrow.color = '#00aaff';

                if (player.talent === 'paranoid') {
                    arrow.isParanoid = true;
                    arrow.radius = 8;
                }
                if (player.talent === 'fantasy') arrow.isFantasy = true;
                if (player.talent === 'insidious') arrow.isInsidious = true;
                if (player.talent === 'clairvoyance') arrow.speed *= 1.5;

                room.arrows[arrowId] = arrow;
            }
        }
    });

    // === Bot 管理事件 ===
    socket.on('add_bot', (data) => {
        const roomId = playerRooms[socket.id];
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        if (room.state !== 'waiting') return;

        const difficulty = (data && data.difficulty) || 'medium';
        addBot(room, difficulty);

        const humanCount = Object.keys(room.players).filter(id => !id.startsWith('bot_')).length;
        const totalCount = Object.keys(room.players).length;
        io.to(room.id).emit('room_joined', {
            roomId: room.id,
            mode: room.mode,
            state: room.state,
            players: humanCount,
            total: totalCount
        });
        io.to(room.id).emit('chat', `Bot 已加入房间 [${difficulty}]`);
    });

    socket.on('remove_bot', () => {
        const roomId = playerRooms[socket.id];
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        if (room.state !== 'waiting') return;

        removeBot(room);

        const humanCount = Object.keys(room.players).filter(id => !id.startsWith('bot_')).length;
        const totalCount = Object.keys(room.players).length;
        io.to(room.id).emit('room_joined', {
            roomId: room.id,
            mode: room.mode,
            state: room.state,
            players: humanCount,
            total: totalCount
        });
        io.to(room.id).emit('chat', `一个 Bot 已被移除`);
    });

    socket.on('disconnect', () => {
        console.log(`[Server] Player disconnected: ${socket.id}`);
        const roomId = playerRooms[socket.id];
        if (roomId && rooms[roomId]) {
            delete rooms[roomId].players[socket.id];

            // 房间内没有活人则清理房间
            const hasHumans = Object.keys(rooms[roomId].players).some(pid => !pid.startsWith('bot_'));
            if (!hasHumans) {
                console.log(`[Server] Room ${roomId} empty. Destroying...`);
                delete rooms[roomId];
            }
        }
        delete playerRooms[socket.id];
    });
});

// Update loop (60 FPS)
let lastTime = Date.now();
setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    for (const roomId in rooms) {
        const room = rooms[roomId];

        if (room.state === 'waiting') {
            io.to(room.id).emit('state', room);
            continue;
        }

        // === 更新所有 Bot AI ===
        for (const [botId, brain] of Object.entries(room.botBrains)) {
            const botPlayer = room.players[botId];
            if (botPlayer && !botPlayer.isDead) {
                brain.update(dt, room, (oid, x, y, dx, dy, speed, charge, lt) => botCreateArrow(room, oid, x, y, dx, dy, speed, charge, lt));
            }
        }

        if (room.state === 'round_end') {
            room.countdown -= dt;
            if (room.countdown <= 0) {
                // 给所有人结算硬币
                for (const [id, player] of Object.entries(room.players)) {
                    if (player.coinsEarned > 0) {
                        io.to(player.id).emit('earned_coins', player.coinsEarned);
                    }
                }
                startNewRound(room);
            }
        }

        let aliveCount = 0;
        let lastAlivePlayer = null;

        // === 缩圈机制 (Shrinking Safe Zone) ===
        if (room.state === 'playing') {
            room.safeZoneShrinkTimer += dt;
            // 前 30 秒不缩圈，然后历时 60 秒缩到极其窄的范围 (radius = 100)
            if (room.safeZoneShrinkTimer > 30) {
                const shrinkProgress = Math.min(1, (room.safeZoneShrinkTimer - 30) / 60);
                const initialRadius = Math.max(GAME_WIDTH, GAME_HEIGHT);
                const targetRadius = 100;
                room.safeZone.radius = initialRadius - (initialRadius - targetRadius) * shrinkProgress;
            }
        }

        // Update players
        for (const [id, player] of Object.entries(room.players)) {
            if (!player.isDead) {
                aliveCount++;
                lastAlivePlayer = player;

                // Update radar cooldown
                if (player.radarCooldown > 0) {
                    player.radarCooldown -= dt;
                    if (player.radarCooldown < 0) player.radarCooldown = 0;
                }

                // === 护盾恢复天赋 ===
                if (player.talent === 'shield' && !player.hasShield) {
                    player.shieldTimer -= dt;
                    if (player.shieldTimer <= 0) {
                        player.hasShield = true;
                        player.shieldTimer = 0;
                        io.to(room.id).emit('text', { x: player.x, y: player.y - 30, text: '护盾就绪!', color: '#00ffff' });
                    }
                }

                // === 毒药伤害 (DoT) ===
                if (player.poisonTicks > 0) {
                    player.poisonTimer -= dt;
                    if (player.poisonTimer <= 0) {
                        player.poisonTicks--;
                        player.poisonTimer = 1.0;

                        if (player.hasShield) {
                            player.hasShield = false;
                            player.shieldTimer = 15;
                            io.to(room.id).emit('text', { x: player.x, y: player.y - 20, text: '护盾抵消毒伤', color: '#00ffff' });
                        } else {
                            player.hp -= 1;
                            io.to(player.id).emit('shake', 0.5);
                            io.to(room.id).emit('effect', { type: 'pickup', x: player.x, y: player.y, color: '#0f0' }); // 用绿色粒子代表毒伤
                            io.to(player.id).emit('text', { x: player.x, y: player.y - 20, text: '-1 中毒', color: '#0f0' });

                            if (player.hp <= 0) {
                                player.isDead = true;
                                player.hp = 0;
                                player.lives--;
                                player.respawnTimer = player.lives > 0 ? 5 : 0;
                                io.to(room.id).emit('effect', { type: 'kill', x: player.x, y: player.y, color: player.color });
                                io.to(player.id).emit('shake', 1.5);
                                if (player.lives <= 0) {
                                    io.to(player.id).emit('text', { x: player.x, y: player.y, text: '毒发身亡!', color: '#ff0000' });
                                }
                            }
                        }
                    }
                }

                // === 新增：固定毒雾区域伤害 ===
                if (room.poisonZones && room.poisonZones.length > 0) {
                    for (const pZone of room.poisonZones) {
                        const dist = Math.hypot(player.x - pZone.x, player.y - pZone.y);
                        if (dist < pZone.radius + player.radius) {
                            // 每 0.5 秒积累一次伤害判定
                            player.poisonZoneAccumulator = (player.poisonZoneAccumulator || 0) + dt;
                            if (player.poisonZoneAccumulator >= 1.0) { // 1秒扣1血
                                player.poisonZoneAccumulator = 0;
                                if (player.hasShield) {
                                    player.hasShield = false;
                                    player.shieldTimer = 15;
                                    io.to(player.id).emit('text', { x: player.x, y: player.y - 20, text: '护盾抵消区域毒气', color: '#00ffff' });
                                } else {
                                    player.hp -= pZone.dps; // dps默认1
                                    io.to(player.id).emit('shake', 0.5);
                                    io.to(room.id).emit('effect', { type: 'pickup', x: player.x, y: player.y, color: '#0f0' });
                                    io.to(player.id).emit('text', { x: player.x, y: player.y - 20, text: '-1 沼气池', color: '#0f0' });

                                    if (player.hp <= 0) {
                                        player.isDead = true;
                                        player.hp = 0;
                                        player.lives--;
                                        player.respawnTimer = player.lives > 0 ? 5 : 0;
                                        io.to(room.id).emit('effect', { type: 'kill', x: player.x, y: player.y, color: player.color });
                                        io.to(player.id).emit('shake', 1.5);
                                        if (player.lives <= 0) {
                                            io.to(player.id).emit('text', { x: player.x, y: player.y, text: '毒气攻心!', color: '#ff0000' });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // === 新增：传送门交互 ===
                if (room.portals && room.portals.length > 0) {
                    if ((player.portalCooldown || 0) > 0) {
                        player.portalCooldown -= dt;
                    } else {
                        for (const portal of room.portals) {
                            const dist = Math.hypot(player.x - portal.x, player.y - portal.y);
                            if (dist < portal.radius) {
                                const targetPortal = room.portals.find(p => p.id === portal.targetId);
                                if (targetPortal) {
                                    player.x = targetPortal.x;
                                    player.y = targetPortal.y;
                                    player.portalCooldown = 1.0; // 冷却1秒，防止无限来回传
                                    io.to(room.id).emit('effect', { type: 'pickup', x: portal.x, y: portal.y, color: '#8800ff' });
                                    io.to(room.id).emit('effect', { type: 'pickup', x: targetPortal.x, y: targetPortal.y, color: '#8800ff' });
                                    break;
                                }
                            }
                        }
                    }
                }

                // === 缩圈 (Safe Zone) 区域外伤害 ===
                if (room.safeZone) {
                    const distToCenter = Math.hypot(player.x - room.safeZone.x, player.y - room.safeZone.y);
                    if (distToCenter > room.safeZone.radius) {
                        player.safeZoneAccumulator = (player.safeZoneAccumulator || 0) + dt;
                        if (player.safeZoneAccumulator >= 1.0) { // 每秒由于身在毒圈而扣血
                            player.safeZoneAccumulator -= 1.0;
                            if (player.hasShield) {
                                player.hasShield = false;
                                player.shieldTimer = 15;
                                io.to(player.id).emit('text', { x: player.x, y: player.y - 20, text: '护盾抵御毒气', color: '#00ffff' });
                            } else {
                                player.hp -= 1; // 毒圈伤害也是1
                                io.to(player.id).emit('shake', 0.5);
                                io.to(room.id).emit('effect', { type: 'pickup', x: player.x, y: player.y, color: '#8800ff' });
                                io.to(player.id).emit('text', { x: player.x, y: player.y - 20, text: '-1 毒圈', color: '#8800ff' });

                                if (player.hp <= 0) {
                                    player.isDead = true;
                                    player.hp = 0;
                                    player.lives--;
                                    player.respawnTimer = player.lives > 0 ? 5 : 0;
                                    io.to(room.id).emit('effect', { type: 'kill', x: player.x, y: player.y, color: player.color });
                                    io.to(player.id).emit('shake', 1.5);
                                    if (player.lives <= 0) {
                                        io.to(player.id).emit('text', { x: player.x, y: player.y, text: '死于毒圈!', color: '#ff0000' });
                                    }
                                }
                            }
                        }
                    } else {
                        player.safeZoneAccumulator = 0; // 回到安全区重置积累
                    }
                }

                // 玩家与墙壁的阻挡
                for (const wall of room.walls) {
                    resolveCircleRectCollision(player, wall);
                }

                player.updatePosition(dt);
            } else {
                // === 重生倒计时 ===
                if (player.lives > 0 && player.respawnTimer > 0) {
                    player.respawnTimer -= dt;
                    if (player.respawnTimer <= 0) {
                        // 重生
                        player.respawnTimer = 0;
                        player.isDead = false;
                        player.hp = player.maxHp;
                        player.x = Math.random() * (GAME_WIDTH - 100) + 50;
                        player.y = Math.random() * (GAME_HEIGHT - 100) + 50;
                        player.vx = 0;
                        player.vy = 0;
                        player.buffExp = 0;
                        player.hasMultishot = false;
                        player.speed = player.baseSpeed;
                        // 重生无敌帧：2秒
                        player.invincible = true;
                        const respawnId = id;
                        setTimeout(() => {
                            if (room.players[respawnId]) {
                                room.players[respawnId].invincible = false;
                            }
                        }, 2000);
                        io.to(room.id).emit('effect', { type: 'pickup', x: player.x, y: player.y, color: 'white' });
                        io.to(room.id).emit('text', { x: player.x, y: player.y - 30, text: `${player.name} 重生!`, color: '#0ff' });
                    }
                }
            }
        }

        // 如果大于1人才算对局
        // 计算真人玩家数和总人数
        const humanPlayerCount = Object.keys(room.players).filter(id => !id.startsWith('bot_')).length;
        const totalPlayerCount = Object.keys(room.players).length;

        // 统计仍有生命次数的玩家数量（包括正在等待重生的）
        let playersWithLives = 0;
        let lastPlayerWithLives = null;
        for (const [id, player] of Object.entries(room.players)) {
            if (player.lives > 0 || !player.isDead) {
                playersWithLives++;
                lastPlayerWithLives = player;
            }
        }

        if (totalPlayerCount > 1 && room.state === 'playing') {
            if (playersWithLives <= 1) {
                room.state = 'round_end';
                room.countdown = 5; // 5秒后开启下一局
                if (lastPlayerWithLives) {
                    lastPlayerWithLives.score += 5; // 吃鸡奖励5分
                    lastPlayerWithLives.coinsEarned += 5;
                    io.to(room.id).emit('chat', `本局结束！幸存者: ${lastPlayerWithLives.name}`);
                } else {
                    io.to(room.id).emit('chat', `本局结束！平局，无人生还。`);
                }
            }
        }

        // === 群体协作分组：追踪同一目标的怪物自动分散 ===
        const targetGroups = {}; // { targetId: [monster1, monster2, ...] }
        const allMonsters = Object.values(room.monsters);
        const allArrowsList = Object.values(room.arrows);
        for (const monster of allMonsters) {
            if (monster.targetId) {
                if (!targetGroups[monster.targetId]) targetGroups[monster.targetId] = [];
                targetGroups[monster.targetId].push(monster);
            }
        }
        // 为每组中的怪物分配包围索引
        for (const [tid, group] of Object.entries(targetGroups)) {
            for (let i = 0; i < group.length; i++) {
                group[i].flankIndex = i;
                group[i].flankGroupSize = group.length;
            }
        }

        // Update monsters（传入完整参数）
        for (const [id, monster] of Object.entries(room.monsters)) {
            // 检测生命周期：超时自动消散
            if (monster.aliveTime >= monster.lifeTime) {
                io.to(room.id).emit('effect', { type: 'monster_fade', x: monster.x, y: monster.y, color: monster.color });
                delete room.monsters[id];
                continue;
            }

            monster.updatePosition(dt, room.players, room.walls, allMonsters, allArrowsList);

            // === Ranged 怪物射击 ===
            if (monster.type === 'ranged' && !monster.isBoss) {
                monster.shootTimer -= dt;
                if (monster.shootTimer <= 0) {
                    monster.shootTimer = 2.0 + Math.random(); // 2~3 秒随机
                    const target = room.players[monster.targetId];
                    if (target && !target.isDead) {
                        const dist = Math.hypot(target.x - monster.x, target.y - monster.y);
                        if (dist < 600) { // 在射程内
                            const angle = Math.atan2(target.y - monster.y, target.x - monster.x);
                            const finalAngle = angle + (Math.random() - 0.5) * 0.2; // 略微散布
                            const curDx = Math.cos(finalAngle);
                            const curDy = Math.sin(finalAngle);

                            const arrowId = `arrow_${room.counters.arrow++}`;
                            const mArrow = new Arrow(arrowId, `monster_${monster.id}`, monster.x, monster.y, curDx, curDy, 250);
                            mArrow.lifeTime = 2.4;
                            mArrow.color = '#ff00ff';
                            mArrow.isMonsterArrow = true; // 标记这是怪物的箭
                            mArrow.damage = 1;
                            room.arrows[arrowId] = mArrow;
                        }
                    }
                }
            }

            // === Healer 怪物群体加血 ===
            if (monster.type === 'healer' && !monster.isBoss) {
                monster.healTimer -= dt;
                if (monster.healTimer <= 0) {
                    monster.healTimer = 3.0; // 每3秒
                    let healedAny = false;
                    for (const [otherId, other] of Object.entries(room.monsters)) {
                        if (other.hp < other.maxHp) {
                            const dist = Math.hypot(other.x - monster.x, other.y - monster.y);
                            if (dist < 200) { // 治疗光环半径
                                other.hp = Math.min(other.hp + 1, other.maxHp);
                                healedAny = true;
                                io.to(room.id).emit('text', { x: other.x, y: other.y - 20, text: '+1 HP', color: '#0f0' });
                                io.to(room.id).emit('effect', { type: 'pickup', x: other.x, y: other.y, color: '#0f0' });
                            }
                        }
                    }
                    if (healedAny) {
                        io.to(room.id).emit('effect', { type: 'pickup', x: monster.x, y: monster.y, color: '#ffff00' });
                    }
                }
            }

            // === 怪物毒药伤害 (DoT) ===
            if (monster.poisonTicks > 0) {
                monster.poisonTimer -= dt;
                if (monster.poisonTimer <= 0) {
                    monster.poisonTicks--;
                    monster.poisonTimer = 1.0;
                    monster.hp -= 1;
                    io.to(room.id).emit('effect', { type: 'pickup', x: monster.x, y: monster.y, color: '#0f0' });

                    if (monster.hp <= 0) {
                        io.to(room.id).emit('effect', { type: 'kill', x: monster.x, y: monster.y, color: monster.color });
                        if (monster.type === 'splitter') spawnSplitterChildren(room, monster.x, monster.y);
                        delete room.monsters[id];
                        // 毒药击杀暂不记录确切得分，或者之后通过 poisonOwnerId 来颁发奖励
                        continue;
                    }
                }
            }

            // 怪物碰撞玩家：适1点伤害（而非秒杀）
            for (const [playerId, player] of Object.entries(room.players)) {
                if (!player.isDead && !player.invincible && checkCollision(monster, player)) {
                    if (player.hasShield) {
                        player.hasShield = false;
                        player.shieldTimer = 15;
                        io.to(player.id).emit('text', { x: player.x, y: player.y - 20, text: '护盾破碎!', color: '#00ffff' });
                        io.to(room.id).emit('effect', { type: 'pickup', x: player.x, y: player.y, color: '#00ffff' });

                        // 破盾提供极短暂无敌防止瞬间连击
                        player.invincible = true;
                        setTimeout(() => { if (room.players[playerId]) room.players[playerId].invincible = false; }, 800);
                    } else {
                        player.hp -= 1;
                        io.to(player.id).emit('shake', 0.8);
                        io.to(player.id).emit('text', { x: player.x, y: player.y - 20, text: '-1 亡灵播打', color: '#ff4444' });
                        io.to(room.id).emit('effect', { type: 'monster_hit', x: player.x, y: player.y, color: player.color });

                        if (player.hp <= 0) {
                            player.isDead = true;
                            player.hp = 0;
                            player.lives--;
                            player.respawnTimer = player.lives > 0 ? 5 : 0; // 还有命则5秒后重生
                            io.to(room.id).emit('effect', { type: 'kill', x: player.x, y: player.y, color: player.color });
                            io.to(player.id).emit('shake', 1.5);
                            if (player.lives <= 0) {
                                io.to(player.id).emit('text', { x: player.x, y: player.y, text: '生命耗尽!', color: '#ff0000' });
                            }
                        } else {
                            // 无敌帧：0.8秒内不受怪物伤害
                            player.invincible = true;
                            setTimeout(() => {
                                if (room.players[playerId]) {
                                    room.players[playerId].invincible = false;
                                }
                            }, 800);
                        }
                    }
                }
            }
        }

        // Update traps
        for (const [id, trap] of Object.entries(room.traps)) {
            trap.lifeTime -= dt;
            if (trap.lifeTime <= 0) {
                delete room.traps[id];
                continue;
            }

            if (trap.active) {
                for (const [playerId, player] of Object.entries(room.players)) {
                    // 不能炸到属于自己的地雷
                    if (!player.isDead && trap.ownerId !== playerId && checkCollision(trap, player)) {
                        if (player.hasShield) {
                            player.hasShield = false;
                            player.shieldTimer = 15;
                            io.to(player.id).emit('text', { x: player.x, y: player.y - 20, text: '护盾抵挡陷阱!', color: '#00ffff' });
                            io.to(room.id).emit('effect', { type: 'pickup', x: player.x, y: player.y, color: '#00ffff' });
                        } else {
                            // 陷阱—3点伤害（基本秒杀）
                            player.hp -= 3;
                            if (player.hp <= 0) {
                                player.hp = 0;
                                player.isDead = true;
                                player.lives--;
                                player.respawnTimer = player.lives > 0 ? 5 : 0;
                            }

                            io.to(room.id).emit('effect', { type: 'kill', x: player.x, y: player.y, color: player.color });
                            io.to(player.id).emit('shake', 1.5);

                            if (room.players[trap.ownerId]) {
                                room.players[trap.ownerId].score++;
                                io.to(trap.ownerId).emit('text', { x: trap.x, y: trap.y, text: '+1 阴险击杀', color: 'orange' });
                            }
                        }
                        delete room.traps[id];
                        break;
                    }
                }
            }
        }

        // 定时刷出奖励蜜蜂 (每隔10s随机刷出)
        if (Math.random() < 0.005 && Object.keys(room.bees).length < 2) {
            const bid = `bee_${room.counters.bee++}`;
            room.bees[bid] = new TargetBee(bid, Math.random() * (GAME_WIDTH - 100) + 50, Math.random() * (GAME_HEIGHT - 100) + 50);
        }

        // Update bees
        for (const [id, bee] of Object.entries(room.bees)) {
            bee.updatePosition(dt);
            if (bee.lifeTime <= 0) {
                delete room.bees[id];
            }
        }

        // Update buffs
        for (const [id, buff] of Object.entries(room.buffs)) {
            buff.lifeTime -= dt;
            if (buff.lifeTime <= 0) {
                delete room.buffs[id];
                continue;
            }

            // 玩家触碰 Buff
            for (const [playerId, player] of Object.entries(room.players)) {
                if (!player.isDead && checkCollision(buff, player)) {
                    let msg = '';
                    if (buff.type === 'sprint') {
                        player.buffExp = 3; // 持续3秒
                        player.speed = player.baseSpeed * 1.8;
                        msg = '疾行启动!';
                    } else if (buff.type === 'multishot') {
                        player.buffExp = 5; // 持续5秒
                        player.hasMultishot = true;
                        msg = '多重射击!';
                    }

                    io.to(room.id).emit('effect', { type: 'pickup', x: buff.x, y: buff.y, color: buff.color });
                    io.to(player.id).emit('text', { x: player.x, y: player.y, text: msg, color: '#0ff' });

                    delete room.buffs[id];
                    break;
                }
            }
        }

        // Update arrows
        for (const [id, arrow] of Object.entries(room.arrows)) {
            arrow.updatePosition(dt);

            let arrowHit = false;

            // 箭矢-玩家碰撞
            for (const [playerId, player] of Object.entries(room.players)) {
                if (!player.isDead && arrow.ownerId !== playerId && checkCollision(arrow, player) && !arrow.hitTargets.has(playerId)) {
                    // 标记该玩家已被此箭击中过
                    arrow.hitTargets.add(playerId);

                    const damage = arrow.damage || 1;
                    const charge = arrow.charge || 0;

                    if (player.hasShield) {
                        player.hasShield = false;
                        player.shieldTimer = 15;
                        io.to(player.id).emit('text', { x: player.x, y: player.y - 20, text: '护盾抵挡箭矢!', color: '#00ffff' });
                        io.to(room.id).emit('effect', { type: 'pickup', x: player.x, y: player.y, color: '#00ffff' });
                    } else {
                        player.hp -= damage;
                        io.to(player.id).emit('shake', 0.3 + charge * 0.5);

                        if (player.hp <= 0) {
                            // 玩家死亡
                            player.hp = 0;
                            player.isDead = true;
                            player.lives--;
                            player.respawnTimer = player.lives > 0 ? 5 : 0;
                            io.to(room.id).emit('effect', { type: 'kill', x: player.x, y: player.y, color: player.color });
                            io.to(player.id).emit('shake', 1.5);

                            if (room.players[arrow.ownerId]) {
                                room.players[arrow.ownerId].score++;
                                io.to(arrow.ownerId).emit('text', { x: player.x, y: player.y, text: '+1 击杀', color: 'yellow' });
                                io.to(arrow.ownerId).emit('shake', 0.5);
                            }
                            if (player.lives <= 0) {
                                io.to(player.id).emit('text', { x: player.x, y: player.y + 20, text: '生命耗尽!', color: '#ff0000' });
                            }
                        } else {
                            // 受伤未死
                            io.to(room.id).emit('effect', { type: 'player_hit', x: player.x, y: player.y, color: player.color, hp: player.hp, maxHp: player.maxHp });
                            if (room.players[arrow.ownerId]) {
                                io.to(arrow.ownerId).emit('text', { x: player.x, y: player.y - 20, text: `-${damage} (${player.hp}/${player.maxHp})`, color: 'orange' });
                            }
                        }
                    }

                    // === 追加天赋：毒箭 ===
                    if (arrow.talent === 'poison') {
                        player.poisonTicks = 3; // 持续3秒
                        player.poisonTimer = 1.0;
                        io.to(player.id).emit('text', { x: player.x, y: player.y - 40, text: '中毒!', color: '#0f0' });
                    }

                    arrow.pierce--;
                    if (arrow.pierce <= 0) {
                        arrowHit = true;
                    }
                    break; // 退层继续寻找可能穿透的下一个目标（下一次循环或者其他对象）
                }
            }

            if (arrowHit) {
                delete room.arrows[id];
                continue;
            }

            // 箭矢-怪物碰撞（要求箭不能是怪物发射的防友伤）
            if (!arrow.isMonsterArrow) {
                for (const [monsterId, monster] of Object.entries(room.monsters)) {
                    if (checkCollision(arrow, monster) && !arrow.hitTargets.has(monsterId)) {
                        // 标记该怪物已被此箭击中过
                        arrow.hitTargets.add(monsterId);
                        const damage = arrow.damage || 1;

                        monster.hp -= damage;
                        if (monster.hp <= 0) {
                            // 怪物死亡
                            io.to(room.id).emit('effect', { type: 'kill', x: monster.x, y: monster.y, color: monster.color });
                            if (monster.type === 'splitter') spawnSplitterChildren(room, monster.x, monster.y);

                            // === 恐慌传播：周围怪物短暂逃散 ===
                            for (const [otherId, other] of Object.entries(room.monsters)) {
                                if (otherId === monsterId) continue;
                                const pDist = Math.hypot(other.x - monster.x, other.y - monster.y);
                                if (pDist < 150) {
                                    const pAngle = Math.atan2(other.y - monster.y, other.x - monster.x);
                                    other.panicVx = Math.cos(pAngle) * 200;
                                    other.panicVy = Math.sin(pAngle) * 200;
                                    other.panicTimer = 0.5;
                                }
                            }

                            delete room.monsters[monsterId];
                            if (room.players[arrow.ownerId]) {
                                const scoreReward = monster.isBoss ? 5 : 1;
                                const coinReward = monster.isBoss ? 3 : 1;
                                room.players[arrow.ownerId].score += scoreReward;
                                room.players[arrow.ownerId].coinsEarned += coinReward;
                                const rewardText = monster.isBoss ? `+${scoreReward} Boss击杀 +${coinReward} 币` : `+${scoreReward} 斩尸 +${coinReward} 币`;
                                io.to(arrow.ownerId).emit('text', { x: monster.x, y: monster.y, text: rewardText, color: monster.isBoss ? '#ff0' : 'gold' });
                            }
                        } else {
                            // 怪物受伤但未死：显示受伤反馈
                            io.to(room.id).emit('effect', { type: 'monster_hit', x: monster.x, y: monster.y, color: monster.color, hp: monster.hp, maxHp: monster.maxHp });
                            if (room.players[arrow.ownerId]) {
                                io.to(arrow.ownerId).emit('text', { x: monster.x, y: monster.y - 20, text: `命中! (${monster.hp}/${monster.maxHp})`, color: 'orange' });
                            }
                        }

                        // === 追加天赋：毒箭 ===
                        if (arrow.talent === 'poison') {
                            monster.poisonTicks = 3; // 持续3秒
                            monster.poisonTimer = 1.0;
                        }

                        // === 连锁闪电 ===
                        if (arrow.talent === 'lightning') {
                            // 找最近的一个敌人进行弹射伤害
                            let nearest = null;
                            let minDist = 250;
                            // 查找其他怪物
                            for (const [cId, m] of Object.entries(room.monsters)) {
                                if (cId === monsterId) continue;
                                const dist = Math.hypot(m.x - monster.x, m.y - monster.y);
                                if (dist < minDist) { minDist = dist; nearest = m; }
                            }
                            if (nearest) {
                                nearest.hp -= 1;
                                // 产生弹射特效线段和伤害字样
                                io.to(room.id).emit('lightning_strike', { x1: monster.x, y1: monster.y, x2: nearest.x, y2: nearest.y });
                                if (nearest.hp <= 0) {
                                    io.to(room.id).emit('effect', { type: 'kill', x: nearest.x, y: nearest.y, color: nearest.color });
                                    delete room.monsters[nearest.id];
                                } else {
                                    io.to(room.id).emit('effect', { type: 'monster_hit', x: nearest.x, y: nearest.y, color: nearest.color });
                                }
                            }
                        }

                        arrow.pierce--;
                        if (arrow.pierce <= 0) {
                            arrowHit = true;
                        }
                        break;
                    }
                }
            }

            // Check collision with bees
            if (!arrowHit) {
                for (const [beeId, bee] of Object.entries(room.bees)) {
                    if (checkCollision(arrow, bee)) {
                        // Bee killed -> Spawn Buff
                        const types = ['sprint', 'multishot'];
                        const bType = types[Math.floor(Math.random() * types.length)];
                        const buffId = `buff_${room.counters.buff++}`;
                        room.buffs[buffId] = new BuffDrop(buffId, bee.x, bee.y, bType);

                        delete room.bees[beeId];
                        if (room.players[arrow.ownerId]) {
                            room.players[arrow.ownerId].score += 2; // 射中奖励2分
                        }
                        arrowHit = true;
                        break;
                    }
                }
            }

            // 检查墙体碰撞
            if (!arrowHit) {
                for (let i = 0; i < room.walls.length; i++) {
                    const wall = room.walls[i];
                    if (checkCircleRectCollision(arrow, wall)) {
                        arrowHit = true; // 视同箭矢阻断

                        if (wall.isDestructible) {
                            const damage = arrow.damage || 1;
                            wall.hp -= damage;
                            io.to(room.id).emit('effect', { type: 'monster_hit', x: arrow.x, y: arrow.y, color: '#8b4513' }); // 棕色木屑
                            if (wall.hp <= 0) {
                                io.to(room.id).emit('effect', { type: 'kill', x: wall.x + wall.w / 2, y: wall.y + wall.h / 2, color: '#8b4513' });
                                // 移除墙体
                                room.walls.splice(i, 1);
                            }
                        } else {
                            // 不可破坏的墙体只阻挡并弹粒子
                            io.to(room.id).emit('effect', { type: 'wall_hit', x: arrow.x, y: arrow.y, color: 'cyan' });
                        }

                        arrow.isDead = true;
                        break;
                    }
                }
            }

            if (arrowHit && !arrow.isDead) {
                delete room.arrows[id];
            } else if (arrow.isDead) {
                // Arrow didn't hit anything and died -> spawn monster OR trap
                if (arrow.isInsidious) {
                    // 生成陷阱
                    const trapId = `trap_${room.counters.trap++}`;
                    room.traps[trapId] = new Trap(trapId, arrow.ownerId, arrow.x, arrow.y);
                } else if (!arrow.isParanoid) {
                    // 仅当非狙击模式才生成怪物惩罚
                    if (room.players[arrow.ownerId] && room.players[arrow.ownerId].roomMode !== 'sniper_duel') {
                        const types = ['normal', 'normal', 'normal', 'ranged', 'splitter', 'healer'];
                        const randomType = types[Math.floor(Math.random() * types.length)];

                        const monsterId = `monster_${room.counters.monster++}`;
                        const monster = new Monster(monsterId, arrow.x, arrow.y, randomType);
                        room.counters.monsterSpawn++;

                        // === DDA 动态难度调节 ===
                        const monsterCount = Object.keys(room.monsters).length;
                        const alivePlayerCount = Object.values(room.players).filter(p => !p.isDead).length || 1;
                        const difficultyRatio = monsterCount / alivePlayerCount;
                        let speedMod = 1.0;
                        if (difficultyRatio > 3) speedMod = 0.8;  // 怪物过多，降速
                        else if (difficultyRatio < 1) speedMod = 1.3; // 怪物较少，加速

                        // === Boss 概率判定：每 10 只怪有 30% 概率生成 Boss ===
                        if (room.counters.monsterSpawn % 10 === 0 && Math.random() < 0.3) {
                            monster.isBoss = true;
                            monster.radius = 30;
                            monster.baseSpeed = 70 * speedMod;
                            monster.speed = monster.baseSpeed;
                            monster.hp = 3;
                            monster.maxHp = 3;
                            monster.color = '#ff6600';
                            monster.senseRadius = 600; // Boss 感知范围更大
                            monster.lifeTime = 30; // Boss 存活更久
                        } else {
                            monster.baseSpeed = 100 * speedMod;
                            monster.speed = monster.baseSpeed;
                        }

                        if (arrow.isFantasy) {
                            monster.radius = Math.random() * 20 + 5;
                            monster.speed = (Math.random() * 150 + 50) * speedMod;
                            monster.baseSpeed = monster.speed;
                            const colors = ['#f0f', '#0ff', '#f00', '#0f0', '#ff0', 'white'];
                            monster.color = colors[Math.floor(Math.random() * colors.length)];
                        }

                        room.monsters[monsterId] = monster;
                    }
                }
                delete room.arrows[id];
            }
        }

        // Broadcast state
        io.to(room.id).emit('state', room);
    }

}, 1000 / 60);

function startNewRound(room) {
    room.state = 'playing';
    room.round++;
    room.arrows = {};
    room.monsters = {};
    room.bees = {};
    room.buffs = {};
    room.traps = {};
    room.safeZone = { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2, radius: Math.max(GAME_WIDTH, GAME_HEIGHT) };
    room.safeZoneShrinkTimer = 0;

    for (const [id, player] of Object.entries(room.players)) {
        applyModeStats(player, room.mode);
        player.isDead = false;
        player.x = Math.random() * (GAME_WIDTH - 40) + 20;
        player.y = Math.random() * (GAME_HEIGHT - 40) + 20;
        player.buffExp = 0;
        player.hasMultishot = false;
        player.speed = player.baseSpeed;
        player.coinsEarned = 0; // 清除上局赚的
        player.hp = player.maxHp; // 恢复满血
        player.invincible = false;
        player.lives = player.maxLives; // 重置生命次数
        player.respawnTimer = 0;

        // 重置异常状态
        player.poisonTicks = 0;
        player.poisonTimer = 0;

        // 重置护盾天赋初始状态
        if (player.talent === 'shield') {
            player.hasShield = true;
            player.shieldTimer = 0;
        } else {
            player.hasShield = false;
        }
    }

    // 重置所有 Bot AI 状态
    for (const [botId, brain] of Object.entries(room.botBrains)) {
        brain.state = 'PATROL';
        brain.targetPlayerId = null;
        brain.isCharging = false;
        brain.shootCooldown = 1.0;
        brain.evadeTimer = 0;
        brain.patrolTarget = brain._randomPatrolPoint();
    }
}

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`Server listening on ${HOST}:${PORT}`);
});
