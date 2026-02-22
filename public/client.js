const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreBoard = document.getElementById('score-board');

let myId = null;
let gameState = { players: {}, arrows: {}, monsters: {}, walls: [], bees: {}, buffs: {}, traps: {} };
let targetState = null;
let currentMode = 'standard';

// 特效组件集合
const particles = [];
const floatingTexts = [];
let screenShake = 0;
let currentRoomId = '';

// === 摄像机系统 ===
let camX = 0;  // 摄像机左上角在世界中的 X
let camY = 0;  // 摄像机左上角在世界中的 Y
const CAM_LERP = 5;  // 摄像机平滑跟踪系数
const WORLD_W = 2000; // 世界宽度（与服务端同步）
const WORLD_H = 1200; // 世界高度（与服务端同步）
let spectateTarget = null; // 死亡后观战的目标玩家 id

const keys = {
    w: false,
    a: false,
    s: false,
    d: false,
    ' ': false // 空格用于“明察”技能扫描
};

socket.on('init', (id) => {
    myId = id;
});

socket.on('room_joined', (roomInfo) => {
    if (typeof roomInfo === 'string') {
        currentRoomId = roomInfo;
        return;
    }

    if (roomInfo && typeof roomInfo === 'object') {
        currentRoomId = roomInfo.roomId || '';
        if (roomInfo.mode) {
            currentMode = roomInfo.mode;
        }
    }
});

// 本地经济系统与存档
let myCoins = parseInt(localStorage.getItem('arrows_coins') || '0');
let unlockedTalents = JSON.parse(localStorage.getItem('arrows_talents') || '["none", "paranoid"]');
let selectedTalent = 'none';

let unlockedWeapons = JSON.parse(localStorage.getItem('arrows_weapons') || '["bow"]');
let selectedWeapon = 'bow';

function getMaxChargeMs() {
    const weaponCfg = window.WEAPONS && window.WEAPONS[selectedWeapon];
    if (weaponCfg && typeof weaponCfg.maxChargeMs === 'number') {
        return weaponCfg.maxChargeMs;
    }
    // Fallback：配置未加载时保证基础可用
    return selectedWeapon === 'dart' ? 0 : 1000;
}

function updateLobbyUI() {
    document.getElementById('coin-count').innerText = myCoins;
    const talentBtns = document.querySelectorAll('#talent-selection .talent-btn');
    talentBtns.forEach(btn => {
        const tStr = btn.getAttribute('data-talent');
        const talentCosts = {
            'paranoid': 50, 'fantasy': 50, 'insidious': 50, 'clairvoyance': 50,
            'shield': 100, 'poison': 100, 'lightning': 150
        };
        const cost = talentCosts[tStr] || 50;

        if (!unlockedTalents.includes(tStr)) {
            // 用图标标明需要购买
            if (!btn.innerText.includes('🔒')) {
                btn.innerText = `🔒 ${cost}币解锁 | ` + btn.innerText;
                btn.style.opacity = '0.6';
            }
        } else {
            btn.innerText = btn.innerText.replace(/🔒 \d+币解锁 \| /, '');
            btn.style.opacity = '1';
        }
    });

    const weaponBtns = document.querySelectorAll('#weapon-selection .weapon-btn');
    weaponBtns.forEach(btn => {
        const wStr = btn.getAttribute('data-weapon');
        const weaponCosts = {
            'shortbow': 80,
            'crossbow': 150,
            'dart': 200
        };
        const cost = weaponCosts[wStr] || 0;

        if (!unlockedWeapons.includes(wStr)) {
            if (!btn.innerText.includes('🔒')) {
                btn.innerText = `🔒 ${cost}币解锁 | ` + btn.innerText;
                btn.style.opacity = '0.6';
            }
        } else {
            btn.innerText = btn.innerText.replace(/🔒 \d+币解锁 \| /, '');
            btn.style.opacity = '1';
        }
    });
}

// 页面加载完成后为大厅天赋按钮绑定交互
document.addEventListener('DOMContentLoaded', () => {
    updateLobbyUI();

    const talentBtns = document.querySelectorAll('#talent-selection .talent-btn');
    talentBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (window.initAudio) window.initAudio();
            if (window.SoundFX) SoundFX.ding();

            const targetTalent = e.target.getAttribute('data-talent');

            const talentCosts = {
                'paranoid': 50,
                'fantasy': 50,
                'insidious': 50,
                'clairvoyance': 50,
                'shield': 100,
                'poison': 100,
                'lightning': 150
            };
            const cost = talentCosts[targetTalent] || 50;

            // 检查是否受锁
            if (!unlockedTalents.includes(targetTalent)) {
                if (myCoins >= cost) {
                    if (confirm(`是否花费 ${cost} 枚对战硬币永久解锁该天赋？`)) {
                        myCoins -= cost;
                        unlockedTalents.push(targetTalent);
                        localStorage.setItem('arrows_coins', myCoins.toString());
                        localStorage.setItem('arrows_talents', JSON.stringify(unlockedTalents));
                        updateLobbyUI();
                        if (window.SoundFX) SoundFX.pickupBuff(); // 用升级音效替代
                    } else {
                        return;
                    }
                } else {
                    alert(`硬币不足！需要 ${cost} 枚硬币解锁该天赋。努力多杀敌或吃鸭吧！`);
                    return;
                }
            }

            talentBtns.forEach(b => b.classList.remove('selected-talent'));
            e.target.classList.add('selected-talent');
            selectedTalent = targetTalent;
        });
    });

    const weaponBtns = document.querySelectorAll('#weapon-selection .weapon-btn');
    weaponBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (window.initAudio) window.initAudio();
            if (window.SoundFX) SoundFX.ding();

            const targetWeapon = e.target.getAttribute('data-weapon');
            const weaponCosts = {
                'shortbow': 80,
                'crossbow': 150,
                'dart': 200
            };
            const cost = weaponCosts[targetWeapon] || 0;

            if (!unlockedWeapons.includes(targetWeapon)) {
                if (myCoins >= cost) {
                    if (confirm(`是否花费 ${cost} 枚对战硬币永久解锁该武器？`)) {
                        myCoins -= cost;
                        unlockedWeapons.push(targetWeapon);
                        localStorage.setItem('arrows_coins', myCoins.toString());
                        localStorage.setItem('arrows_weapons', JSON.stringify(unlockedWeapons));
                        updateLobbyUI();
                        if (window.SoundFX) SoundFX.pickupBuff();
                    } else {
                        return;
                    }
                } else {
                    alert(`硬币不足！需要 ${cost} 枚硬币解锁该武器。`);
                    return;
                }
            }

            weaponBtns.forEach(b => b.classList.remove('selected-weapon'));
            e.target.classList.add('selected-weapon');
            selectedWeapon = targetWeapon;
        });
    });
});

// 从大厅加入游戏
window.joinGame = function (mode) {
    if (window.initAudio) window.initAudio();
    if (window.SoundFX) SoundFX.ding();

    const nameInputEl = document.getElementById('player-name-input');
    const nameInput = nameInputEl && nameInputEl.value ? nameInputEl.value.trim() : '';
    const playerName = nameInput || '特工';

    const roomInput = document.getElementById('room-id-input');
    const roomIdInput = roomInput ? roomInput.value.trim() : '';

    const requestedMode = mode || 'standard';
    currentMode = requestedMode;

    // 向服务器请求加入指定模式，并带上刚通过备战界面挑选的天赋、武器及房号
    socket.emit('join', { roomId: roomIdInput, name: playerName, mode: requestedMode, talent: selectedTalent, weapon: selectedWeapon });

    // 隐藏大厅，显示游戏画面
    const lobbyPanel = document.getElementById('lobby-panel');
    const gameContainer = document.getElementById('game-container');
    if (lobbyPanel) lobbyPanel.style.display = 'none';
    if (gameContainer) gameContainer.style.display = 'flex';
};

// === Bot 管理函数 ===
window.addBot = function (difficulty) {
    socket.emit('add_bot', { difficulty: difficulty || 'medium' });
};

window.removeBot = function () {
    socket.emit('remove_bot');
};

socket.on('state', (state) => {
    if (!state || typeof state !== 'object') return;

    if (state.mode) {
        currentMode = state.mode;
    }
    if (!currentRoomId && state.id) {
        currentRoomId = state.id;
    }

    targetState = state;
    if (Object.keys(gameState.players).length === 0) {
        gameState = JSON.parse(JSON.stringify(state));
    }
    updateScoreBoard();
});

// 处理服务器下发结算金币
socket.on('earned_coins', (amount) => {
    myCoins += amount;
    localStorage.setItem('arrows_coins', myCoins.toString());
    updateLobbyUI();
    // 战斗结束大厅提示弹窗
    setTimeout(() => {
        alert(`对局结算！你获得了 ${amount} 枚对战硬币。`);
    }, 1000);
});

// 处理服务器下发的战斗反馈特效
socket.on('effect', (data) => {
    if (data.type === 'kill') {
        spawnParticles(data.x, data.y, data.color || 'red', 40);
        if (window.SoundFX) {
            if (data.color === 'red' || data.color === 'magenta') {
                SoundFX.killMonster(); // 假设红色倾向于怪物
            } else {
                SoundFX.playerDeath();
            }
        }
    } else if (data.type === 'pickup') {
        spawnParticles(data.x, data.y, data.color || 'cyan', 20);
        if (window.SoundFX) SoundFX.pickupBuff();
    } else if (data.type === 'player_hit') {
        spawnParticles(data.x, data.y, data.color || '#ff6666', 26);
        spawnParticles(data.x, data.y, 'white', 8);
        if (window.SoundFX) SoundFX.hitConfirm();
    } else if (data.type === 'monster_hit') {
        spawnParticles(data.x, data.y, data.color || 'orange', 24);
        if (window.SoundFX) SoundFX.hitConfirm();
    } else if (data.type === 'wall_hit') {
        spawnParticles(data.x, data.y, data.color || 'cyan', 14);
        if (window.SoundFX) SoundFX.hitWall();
    }
});

let lightnings = [];
socket.on('lightning_strike', (data) => {
    lightnings.push({
        x1: data.x1, y1: data.y1,
        x2: data.x2, y2: data.y2,
        life: 0.3
    });
});

socket.on('shake', (intensity) => {
    triggerShake(intensity);
});

socket.on('text', (data) => {
    spawnFloatingText(data.x, data.y, data.text, data.color);
});

socket.on('chat', (msg) => {
    const chatDiv = document.createElement('div');
    chatDiv.style.position = 'absolute';
    chatDiv.style.top = '80px';
    chatDiv.style.left = '50%';
    chatDiv.style.transform = 'translateX(-50%)';
    chatDiv.style.background = 'rgba(0,0,0,0.7)';
    chatDiv.style.color = 'yellow';
    chatDiv.style.padding = '10px 20px';
    chatDiv.style.borderRadius = '5px';
    chatDiv.style.fontSize = '18px';
    chatDiv.style.zIndex = '1000';
    chatDiv.innerText = msg;
    document.body.appendChild(chatDiv);

    // 3秒后消失
    setTimeout(() => {
        chatDiv.remove();
    }, 3000);
});

window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (keys.hasOwnProperty(key)) {
        keys[key] = true;
        sendInput();
    }
});

window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (keys.hasOwnProperty(key)) {
        keys[key] = false;
        sendInput();
    }
});

// 监听窗口大小并全屏显示
let VIEW_WIDTH = window.innerWidth;
let VIEW_HEIGHT = window.innerHeight;

function resizeCanvas() {
    let newWidth = window.innerWidth;
    let newHeight = window.innerHeight;

    VIEW_WIDTH = newWidth;
    VIEW_HEIGHT = newHeight;

    canvas.style.width = newWidth + 'px';
    canvas.style.height = newHeight + 'px';

    // 考虑高分屏清晰度 (DPR)
    const dpr = window.devicePixelRatio || 1;
    canvas.width = newWidth * dpr;
    canvas.height = newHeight * dpr;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas(); // 初始化执行

// 蓄力射击状态
let chargeStartTime = 0;
let isCharging = false;
let chargeMouseX = 0;
let chargeMouseY = 0;
const TILE_SIZE = 40; // 视觉上的散布角（平滑插值用）
let visualSpread = 0; // 视觉上的散布角（平滑插值用）

canvas.addEventListener('mousedown', (e) => {
    if (window.initAudio) window.initAudio(); // 用户必须交互一次才能在浏览器播音
    // 按下鼠标开始蓄力
    chargeStartTime = Date.now();
    isCharging = true;
    socket.emit('charge_start'); // 通知服务端开始蓄力（减速）
});

// 鼠标移动时实时更新目标坐标（转换为世界坐标）
canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const screenX = (e.clientX - rect.left) * (canvas.width / window.devicePixelRatio / rect.width);
    const screenY = (e.clientY - rect.top) * (canvas.height / window.devicePixelRatio / rect.height);
    // 屏幕坐标 + 摄像机偏移 = 世界坐标
    chargeMouseX = screenX + camX;
    chargeMouseY = screenY + camY;
});

canvas.addEventListener('mouseup', (e) => {
    if (!isCharging) return;
    isCharging = false;
    socket.emit('charge_end'); // 通知服务端蓄力结束（恢复速度）

    const rect = canvas.getBoundingClientRect();
    const screenX = (e.clientX - rect.left) * (canvas.width / window.devicePixelRatio / rect.width);
    const screenY = (e.clientY - rect.top) * (canvas.height / window.devicePixelRatio / rect.height);
    // 屏幕坐标 + 摄像机偏移 = 世界坐标
    const x = screenX + camX;
    const y = screenY + camY;

    // 飞镖无需蓄力直接满状态发射，其它按配置判断
    let chargeRatio = 1;
    const maxMs = getMaxChargeMs();
    if (maxMs > 0) {
        const chargeMs = Math.min(Date.now() - chargeStartTime, maxMs);
        chargeRatio = chargeMs / maxMs;
    }

    // 判断当前是否在移动（WASD 有任意按键按下）
    const isMoving = keys.w || keys.a || keys.s || keys.d;

    const me = gameState.players[myId];
    if (me) {
        playLocalShootFeedback(me.x, me.y, x, y, chargeRatio);
    }

    if (window.SoundFX) SoundFX.shoot();
    socket.emit('shoot', { x, y, charge: chargeRatio, moving: isMoving });
});

// === 移动端触控/双摇杆逻辑 ===
const touchControls = document.getElementById('touch-controls');
const leftStick = document.getElementById('left-stick');
const rightStick = document.getElementById('right-stick');
const leftBase = document.getElementById('left-stick-base');
const leftKnob = document.getElementById('left-stick-knob');
const rightBase = document.getElementById('right-stick-base');
const rightKnob = document.getElementById('right-stick-knob');

let leftTouchId = null;
let rightTouchId = null;
let leftCenter = { x: 0, y: 0 };
let rightCenter = { x: 0, y: 0 };
const maxStickDist = 50;

// 检测是否支持触控
if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
    touchControls.style.display = 'flex';
}

function handleTouchStart(e, isLeft) {
    if (window.initAudio) window.initAudio();
    for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (isLeft && leftTouchId === null) {
            leftTouchId = touch.identifier;
            leftCenter = { x: touch.clientX, y: touch.clientY };
            leftBase.style.display = 'block';
            leftBase.style.left = leftCenter.x + 'px';
            leftBase.style.top = leftCenter.y + 'px';
            leftKnob.style.transform = 'translate(-50%, -50%)';
        } else if (!isLeft && rightTouchId === null) {
            rightTouchId = touch.identifier;
            rightCenter = { x: touch.clientX, y: touch.clientY };
            rightBase.style.display = 'block';
            rightBase.style.left = rightCenter.x + 'px';
            rightBase.style.top = rightCenter.y + 'px';
            rightKnob.style.transform = 'translate(-50%, -50%)';

            // 开始蓄力
            chargeStartTime = Date.now();
            isCharging = true;
            socket.emit('charge_start');
        }
    }
}

function handleTouchMove(e) {
    e.preventDefault(); // 防止滚动
    for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier === leftTouchId) {
            let dx = touch.clientX - leftCenter.x;
            let dy = touch.clientY - leftCenter.y;
            const dist = Math.hypot(dx, dy);
            if (dist > maxStickDist) {
                dx = (dx / dist) * maxStickDist;
                dy = (dy / dist) * maxStickDist;
            }
            leftKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

            // 映射到 WASD (死区 15px)
            keys.w = dy < -15;
            keys.s = dy > 15;
            keys.a = dx < -15;
            keys.d = dx > 15;
            sendInput();

        } else if (touch.identifier === rightTouchId) {
            let dx = touch.clientX - rightCenter.x;
            let dy = touch.clientY - rightCenter.y;
            const dist = Math.hypot(dx, dy);
            if (dist > maxStickDist) {
                dx = (dx / dist) * maxStickDist;
                dy = (dy / dist) * maxStickDist;
            }
            rightKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

            // 更新瞄准坐标 (转换成相对屏幕中心的偏移，加到玩家世界坐标上)
            const me = gameState.players[myId];
            if (me) {
                // 仅用摇杆方向作为射击方向的指示
                const angle = Math.atan2(dy, dx);
                // 给一个足够远的虚拟鼠标位置，使其瞄准线能画全
                chargeMouseX = me.x + Math.cos(angle) * 1000;
                chargeMouseY = me.y + Math.sin(angle) * 1000;
            }
        }
    }
}

function handleTouchEnd(e) {
    for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier === leftTouchId) {
            leftTouchId = null;
            leftBase.style.display = 'none';
            keys.w = keys.a = keys.s = keys.d = false;
            sendInput();
        } else if (touch.identifier === rightTouchId) {
            rightTouchId = null;
            rightBase.style.display = 'none';

            // 结束蓄力并射击
            if (isCharging) {
                isCharging = false;
                socket.emit('charge_end');

                // 飞镖无需蓄力直接满状态发射，其它按配置判断
                let chargeRatio = 1;
                const maxMs = getMaxChargeMs();
                if (maxMs > 0) {
                    const chargeMs = Math.min(Date.now() - chargeStartTime, maxMs);
                    chargeRatio = chargeMs / maxMs;
                }
                const isMoving = keys.w || keys.a || keys.s || keys.d;

                // 获取最后手指的偏向
                let dx = touch.clientX - rightCenter.x;
                let dy = touch.clientY - rightCenter.y;
                // 如果基本没滑动就松开，向正前方射或丢弃，这里给正右方默认
                if (Math.hypot(dx, dy) < 10) { dx = 1; dy = 0; }
                const angle = Math.atan2(dy, dx);
                const me = gameState.players[myId];
                if (me) {
                    const x = me.x + Math.cos(angle) * 1000;
                    const y = me.y + Math.sin(angle) * 1000;
                    playLocalShootFeedback(me.x, me.y, x, y, chargeRatio);
                    if (window.SoundFX) SoundFX.shoot();
                    socket.emit('shoot', { x, y, charge: chargeRatio, moving: isMoving });
                }
            }
        }
    }
}

leftStick.addEventListener('touchstart', (e) => handleTouchStart(e, true), { passive: false });
rightStick.addEventListener('touchstart', (e) => handleTouchStart(e, false), { passive: false });
touchControls.addEventListener('touchmove', handleTouchMove, { passive: false });
touchControls.addEventListener('touchend', handleTouchEnd, { passive: false });
touchControls.addEventListener('touchcancel', handleTouchEnd, { passive: false });


// === 死亡观战：左右箭头切换观战目标 ===
window.addEventListener('keydown', (e) => {
    const me = gameState.players[myId];
    if (!me || !me.isDead) return;
    const alivePlayers = Object.values(gameState.players).filter(p => !p.isDead);
    if (alivePlayers.length === 0) return;

    let currentIdx = alivePlayers.findIndex(p => p.id === spectateTarget);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (e.key === 'ArrowRight') {
            currentIdx = (currentIdx + 1) % alivePlayers.length;
        } else {
            currentIdx = (currentIdx - 1 + alivePlayers.length) % alivePlayers.length;
        }
        spectateTarget = alivePlayers[currentIdx].id;
    }
});

function sendInput() {
    let dx = 0;
    let dy = 0;
    if (keys.w) dy -= 1;
    if (keys.s) dy += 1;
    if (keys.a) dx -= 1;
    if (keys.d) dx += 1;

    // 如果是明察且按下了空格，向服务端发信号
    if (keys[' ']) {
        socket.emit('skill');
    }

    // Normalize if moving diagonally
    if (dx !== 0 && dy !== 0) {
        const len = Math.sqrt(dx * dx + dy * dy);
        dx /= len;
        dy /= len;
    }

    socket.emit('input', { x: dx, y: dy });
}

function updateScoreBoard() {
    let html = '<strong>积分板</strong><br>';
    const stateSrc = targetState || gameState;
    if (!stateSrc || !stateSrc.players) return;
    const players = Object.values(stateSrc.players).sort((a, b) => b.score - a.score);
    players.forEach(p => {
        const isBot = p.id && p.id.startsWith('bot_');
        const isMe = myId === p.id;
        const tag = isMe ? '(你)' : (isBot ? '' : '');
        html += `<div class="score-entry"><span style="color:${p.color}">${p.name} ${tag}:</span> <span>${p.score}</span></div>`;
    });
    scoreBoard.innerHTML = html;
}

// 产生碎裂爆炸粒子
function spawnParticles(x, y, color, count) {
    for (let i = 0; i < count; i++) {
        particles.push({
            x: x,
            y: y,
            vx: (Math.random() - 0.5) * 300,
            vy: (Math.random() - 0.5) * 300,
            life: 1.0,
            color: color,
            size: Math.random() * 3 + 1
        });
    }
}

// 产生飘字提示
function spawnFloatingText(x, y, text, color) {
    floatingTexts.push({
        x: x,
        y: y,
        text: text,
        color: color,
        life: 1.5,
        vy: -30 // 向上飘动
    });
}

// 引发全局屏幕震动
function triggerShake(intensity) {
    screenShake = intensity;
}

// 本地开火即时反馈：降低“按下到命中回包”之间的空窗感
function playLocalShootFeedback(fromX, fromY, toX, toY, chargeRatio) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    const burst = 6 + Math.floor(chargeRatio * 8);

    for (let i = 0; i < burst; i++) {
        const jitter = (Math.random() - 0.5) * 0.8;
        const speed = 160 + Math.random() * 220;
        const dist = 8 + Math.random() * 10;
        particles.push({
            x: fromX + Math.cos(angle) * dist,
            y: fromY + Math.sin(angle) * dist,
            vx: Math.cos(angle + jitter) * speed,
            vy: Math.sin(angle + jitter) * speed,
            life: 0.18 + Math.random() * 0.15,
            color: 'rgba(255, 240, 180, 0.9)',
            size: 1.5 + Math.random() * 1.8
        });
    }

    // 轻微后坐力震屏
    triggerShake(Math.max(screenShake, 0.05 + chargeRatio * 0.08));
}

let bgOffset = 0;
let lastDrawTime = Date.now();

function draw() {
    const now = Date.now();
    const dt = (now - lastDrawTime) / 1000;
    lastDrawTime = now;

    if (targetState) {
        const lerpFactor = Math.min(1, dt * 15); // 平滑插值系数
        const lerpObj = (curr, targ) => {
            if (!targ) return;
            for (let id in targ) {
                if (!curr[id]) {
                    curr[id] = { ...targ[id] };
                } else {
                    let cx = curr[id].x;
                    let cy = curr[id].y;
                    Object.assign(curr[id], targ[id]);
                    curr[id].x = cx + (targ[id].x - cx) * lerpFactor;
                    curr[id].y = cy + (targ[id].y - cy) * lerpFactor;
                }
            }
            for (let id in curr) {
                if (!targ[id]) delete curr[id];
            }
        };

        lerpObj(gameState.players, targetState.players);
        lerpObj(gameState.monsters, targetState.monsters);
        lerpObj(gameState.bees, targetState.bees);
        lerpObj(gameState.arrows, targetState.arrows);

        gameState.buffs = targetState.buffs;
        gameState.traps = targetState.traps;
        gameState.walls = targetState.walls;
        gameState.portals = targetState.portals;
        gameState.poisonZones = targetState.poisonZones;
        gameState.safeZone = targetState.safeZone;
        gameState.state = targetState.state;
        gameState.countdown = targetState.countdown;
    }

    // === 摄像机跟踪更新 ===
    const me = gameState.players[myId];
    let camTargetX, camTargetY;
    if (me && !me.isDead) {
        // 存活时跟踪自己
        camTargetX = me.x - VIEW_WIDTH / 2;
        camTargetY = me.y - VIEW_HEIGHT / 2;
        spectateTarget = null;
    } else {
        // 死亡后观战其他玩家
        const alivePlayers = Object.values(gameState.players).filter(p => !p.isDead);
        if (alivePlayers.length > 0) {
            // 确保观战目标仍然存活
            let target = alivePlayers.find(p => p.id === spectateTarget);
            if (!target) {
                target = alivePlayers[0];
                spectateTarget = target.id;
            }
            camTargetX = target.x - VIEW_WIDTH / 2;
            camTargetY = target.y - VIEW_HEIGHT / 2;
        } else {
            // 没有存活玩家，看地图中心
            camTargetX = WORLD_W / 2 - VIEW_WIDTH / 2;
            camTargetY = WORLD_H / 2 - VIEW_HEIGHT / 2;
        }
    }
    // 边界限制：摄像机不超出世界边界
    camTargetX = Math.max(0, Math.min(camTargetX, WORLD_W - VIEW_WIDTH));
    camTargetY = Math.max(0, Math.min(camTargetY, WORLD_H - VIEW_HEIGHT));
    // 如果窗口比世界大，居中显示
    if (VIEW_WIDTH >= WORLD_W) camTargetX = (WORLD_W - VIEW_WIDTH) / 2;
    if (VIEW_HEIGHT >= WORLD_H) camTargetY = (WORLD_H - VIEW_HEIGHT) / 2;
    // 平滑插值跟踪
    camX += (camTargetX - camX) * Math.min(1, dt * CAM_LERP);
    camY += (camTargetY - camY) * Math.min(1, dt * CAM_LERP);

    // 缓动时间记录用于动态背景
    bgOffset += 0.5;

    // 开启高清比例缩放
    ctx.save();
    const dpr = window.devicePixelRatio || 1;
    ctx.scale(dpr, dpr);

    // 清空背景
    ctx.clearRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

    // 应用屏幕震荡偏移
    ctx.save();
    if (screenShake > 0) {
        const dx = (Math.random() - 0.5) * screenShake * 10;
        const dy = (Math.random() - 0.5) * screenShake * 10;
        ctx.translate(dx, dy);
        screenShake -= dt * 3; // 摇晃衰减
        if (screenShake < 0) screenShake = 0;
    }

    // === 应用摄像机变换：将世界坐标转换为屏幕坐标 ===
    ctx.save();
    ctx.translate(-camX, -camY);

    // 创建深空渐变背景 (Radial Gradient)
    const centerX = WORLD_W / 2;
    const centerY = WORLD_H / 2;
    const bgGrad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, Math.max(WORLD_W, WORLD_H) * 0.8);
    bgGrad.addColorStop(0, '#10141f'); // 深蓝空
    bgGrad.addColorStop(1, '#020305'); // 极暗边缘
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);

    // 绘制具有呼吸感的科技网格
    ctx.save();
    ctx.strokeStyle = `rgba(0, 255, 255, ${0.05 + 0.02 * Math.sin(Date.now() / 100)})`;
    ctx.lineWidth = 1;

    // 画网格 (使用批量绘制途径降低数百倍的 GPU / Draw Call 负担，同时去除了网格的高斯模糊)
    ctx.beginPath();
    for (let i = (bgOffset % 40) - 40; i < WORLD_W; i += 40) {
        ctx.moveTo(i, 0);
        ctx.lineTo(i, WORLD_H);
    }
    for (let i = (bgOffset % 40) - 40; i < WORLD_H; i += 40) {
        ctx.moveTo(0, i);
        ctx.lineTo(WORLD_W, i);
    }
    ctx.stroke();
    ctx.restore();

    // === 新增：缩圈机制（安全区域）的视觉效果 ===
    if (gameState.state === 'playing' && gameState.safeZone) {
        ctx.save();
        const sz = gameState.safeZone;

        // 我们用一个非常大的矩形盖住全局，并在安全区域位置用「反向抠图」或叠加来高亮。
        // 为了性能，我们简单地画一个带有向内渐变的红色警告圈：
        ctx.beginPath();
        ctx.arc(sz.x, sz.y, sz.radius, 0, Math.PI * 2);

        // 安全区边缘高亮
        ctx.strokeStyle = `rgba(255, 50, 50, ${0.4 + 0.2 * Math.sin(Date.now() / 150)})`;
        ctx.lineWidth = 10;
        ctx.stroke();

        // 用遮罩处理圈外（毒气）
        ctx.beginPath();
        ctx.rect(-1000, -1000, WORLD_W + 2000, WORLD_H + 2000); // 包含整个世界的超大矩形
        ctx.arc(sz.x, sz.y, sz.radius, 0, Math.PI * 2, true); // 逆时针画圆，形成镂空抠图
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 0, 0, 0.15)'; // 圈外覆上一层红蒙层
        ctx.fill();

        ctx.restore();
    }

    // Draw walls
    if (gameState.walls) {
        ctx.fillStyle = '#111';
        ctx.strokeStyle = '#0ff';
        ctx.lineWidth = 2;
        ctx.shadowColor = 'cyan';
        ctx.shadowBlur = 10;

        ctx.shadowBlur = 10;

        // Draw poison zones (underneath walls)
        if (gameState.poisonZones) {
            gameState.poisonZones.forEach(pz => {
                ctx.beginPath();
                ctx.arc(pz.x, pz.y, pz.radius, 0, Math.PI * 2);
                const pulse = 0.5 + 0.2 * Math.sin(Date.now() / 200);
                ctx.fillStyle = `rgba(50, 205, 50, ${0.15 * pulse})`; // 半透明毒绿色
                ctx.fill();

                // 毒气内环波纹
                ctx.beginPath();
                ctx.arc(pz.x, pz.y, pz.radius * (0.5 + 0.5 * Math.sin(Date.now() / 500)), 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(50, 205, 50, ${0.3 * pulse})`;
                ctx.lineWidth = 2;
                ctx.stroke();

                // 标志
                ctx.fillStyle = 'rgba(50, 205, 50, 0.4)';
                ctx.font = '24px Arial';
                ctx.textAlign = 'center';
                ctx.fillText('☣', pz.x, pz.y + 8);
            });
        }

        // Draw portals (underneath walls)
        if (gameState.portals) {
            gameState.portals.forEach(p => {
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);

                // 传送门漩涡特效
                const time = Date.now() / 300;
                const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius);
                grad.addColorStop(0, `hsl(${(time * 50) % 360}, 100%, 70%)`);
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = grad;
                ctx.fill();

                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(time);
                ctx.strokeStyle = `hsl(${(time * 50 + 180) % 360}, 100%, 50%)`;
                ctx.lineWidth = 3;
                ctx.setLineDash([10, 10]);
                ctx.beginPath();
                ctx.arc(0, 0, p.radius - 2, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            });
        }

        for (const wall of gameState.walls) {
            // 背景根据是否可破坏决定颜色（可破坏稍微偏木质/黄色调）
            if (wall.isDestructible) {
                ctx.fillStyle = '#6b4c3a'; // 木质色
                ctx.strokeStyle = '#8b6550';
            } else {
                ctx.fillStyle = '#111'; // 普通墙
                ctx.strokeStyle = 'cyan';
            }

            ctx.shadowColor = wall.isDestructible ? '#ffaa00' : 'cyan';

            ctx.fillRect(wall.x, wall.y, wall.w, wall.h);
            ctx.strokeRect(wall.x, wall.y, wall.w, wall.h);

            // 添加内阴影立体感
            ctx.shadowBlur = 0; // 关闭阴影绘制内饰
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(wall.x, wall.y + wall.h - 5, wall.w, 5);

            // 绘制裂纹 (如果受损)
            if (wall.isDestructible && wall.hp < wall.maxHp) {
                const damageRatio = 1 - (wall.hp / wall.maxHp);
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                // 在墙体中间画上表示龟裂的随机折线
                let curX = wall.x + wall.w * 0.2;
                let curY = wall.y + wall.h * 0.2;
                ctx.moveTo(curX, curY);
                for (let i = 0; i < 3 * damageRatio; i++) {
                    curX += wall.w * 0.2;
                    curY += (Math.random() - 0.5) * wall.h * 0.4;
                    ctx.lineTo(curX, curY);
                }
                ctx.stroke();
            }

            ctx.fillStyle = '#111'; // reset
            ctx.shadowColor = 'cyan';
            ctx.shadowBlur = 10;
        }
        ctx.shadowBlur = 0; // 重置
    }

    // Draw monsters（智能AI增强可视化）
    Object.values(gameState.monsters).forEach(m => {
        // Boss 冲刺拖影特效
        if (m.isBoss && m.isDashing) {
            for (let t = 1; t <= 3; t++) {
                ctx.beginPath();
                ctx.arc(m.x - (m.dashVx || 0) * 0.02 * t, m.y - (m.dashVy || 0) * 0.02 * t, m.radius * (1 - t * 0.15), 0, Math.PI * 2);
                ctx.fillStyle = `rgba(255, 102, 0, ${0.3 - t * 0.08})`;
                ctx.fill();
            }
        }

        // 怪物主体
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.radius, 0, Math.PI * 2);

        // RAGE 状态颜色脉冲
        if (m.state === 'rage') {
            const pulse = 0.7 + 0.3 * Math.sin(Date.now() / 100);
            ctx.fillStyle = m.isBoss ? `rgba(255, 68, 0, ${pulse})` : `rgba(255, 0, 0, ${pulse})`;
            ctx.shadowColor = '#f00';
            ctx.shadowBlur = 25;
        } else {
            ctx.fillStyle = m.color;
            ctx.shadowColor = m.color;
            ctx.shadowBlur = 15;
        }
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.strokeStyle = m.isBoss ? '#ff0' : '#222';
        ctx.lineWidth = m.isBoss ? 3 : 2;
        ctx.stroke();

        // Boss 皇冠图标
        if (m.isBoss) {
            ctx.fillStyle = '#ffcc00';
            ctx.font = `${m.radius}px Arial`;
            ctx.textAlign = 'center';
            ctx.fillText('👑', m.x, m.y - m.radius - 4);
        }

        // 怪物独眼（非Boss）
        if (!m.isBoss) {
            ctx.beginPath();
            ctx.arc(m.x, m.y - m.radius * 0.2, m.radius * 0.5, 0, Math.PI * 2);
            ctx.fillStyle = 'white';
            ctx.fill();

            // 黑色瞳孔
            ctx.beginPath();
            ctx.arc(m.x + Math.sin(bgOffset * 0.1), m.y - m.radius * 0.2 + Math.cos(bgOffset * 0.1), m.radius * 0.2, 0, Math.PI * 2);
            ctx.fillStyle = 'black';
            ctx.fill();
        } else {
            // Boss 双眼
            const eyeOffset = m.radius * 0.3;
            for (const side of [-1, 1]) {
                ctx.beginPath();
                ctx.arc(m.x + side * eyeOffset, m.y - m.radius * 0.15, m.radius * 0.25, 0, Math.PI * 2);
                ctx.fillStyle = '#ff0';
                ctx.fill();
                ctx.beginPath();
                ctx.arc(m.x + side * eyeOffset, m.y - m.radius * 0.15, m.radius * 0.1, 0, Math.PI * 2);
                ctx.fillStyle = '#800';
                ctx.fill();
            }
        }

        // Boss 血条 UI
        if (m.isBoss && m.maxHp > 1) {
            const barW = m.radius * 2.5;
            const barH = 5;
            const barX = m.x - barW / 2;
            const barY = m.y + m.radius + 8;
            // 背景
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(barX, barY, barW, barH);
            // 血量
            const hpRatio = m.hp / m.maxHp;
            const hpColor = hpRatio > 0.5 ? '#0f0' : (hpRatio > 0.25 ? '#ff0' : '#f00');
            ctx.fillStyle = hpColor;
            ctx.fillRect(barX, barY, barW * hpRatio, barH);
            // 外框
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 1;
            ctx.strokeRect(barX, barY, barW, barH);
        }

        // 状态标签
        ctx.fillStyle = 'white';
        ctx.font = '10px Inter';
        ctx.textAlign = 'center';
        let label = '亡灵';
        if (m.isBoss) label = 'BOSS';
        if (m.state === 'rage') label = m.isBoss ? '💀 BOSS 暴怒' : '💀 暴怒';
        if (m.isDashing) label = '⚡ 冲刺';

        // 毒素特效标签
        if (m.poisonTicks > 0) {
            label = '🤢 中毒 ' + label;
            ctx.fillStyle = '#0f0';
            // 毒素气泡跟随
            if (Math.random() < 0.2) {
                particles.push({
                    x: m.x + (Math.random() - 0.5) * m.radius,
                    y: m.y - m.radius,
                    vx: 0, vy: -30, life: 0.5, color: '#0f0', size: 2
                });
            }
        }
        ctx.fillText(label, m.x, m.y + m.radius + (m.isBoss && m.maxHp > 1 ? 22 : 12));
    });

    // Draw target bees
    if (gameState.bees) {
        Object.values(gameState.bees).forEach(b => {
            // 蜜蜂身体
            ctx.beginPath();
            ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
            ctx.fillStyle = b.color;
            ctx.fill();
            ctx.strokeStyle = '#222';
            ctx.lineWidth = 2;
            ctx.stroke();

            // 动态高频振翅
            const wingOffset = Math.sin(Date.now() / 20) * 5;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';

            // 左翼
            ctx.beginPath();
            ctx.ellipse(b.x - 6, b.y - 4 + wingOffset, 6, 3, Math.PI / 6, 0, Math.PI * 2);
            ctx.fill();
            // 右翼
            ctx.beginPath();
            ctx.ellipse(b.x + 6, b.y - 4 + wingOffset, 6, 3, -Math.PI / 6, 0, Math.PI * 2);
            ctx.fill();

            // 蜜蜂条纹
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(b.x - b.radius, b.y);
            ctx.lineTo(b.x + b.radius, b.y);
            ctx.stroke();
        });
    }

    // Draw buff drops
    if (gameState.buffs) {
        Object.values(gameState.buffs).forEach(bf => {
            ctx.beginPath();
            ctx.arc(bf.x, bf.y, bf.radius, 0, Math.PI * 2);
            ctx.fillStyle = bf.color;
            ctx.fill();

            // Outer pulse
            ctx.beginPath();
            ctx.arc(bf.x, bf.y, bf.radius + Math.sin(Date.now() / 150) * 3 + 3, 0, Math.PI * 2);
            ctx.strokeStyle = bf.color;
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = 'white';
            ctx.font = 'bold 10px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(bf.type === 'sprint' ? '疾步' : '散射', bf.x, bf.y + 3);
        });
    }

    // Draw arrows
    Object.values(gameState.arrows).forEach(a => {
        // 残影拖拽特效
        ctx.beginPath();
        let tailX = a.x - (a.vx / a.speed) * (a.isParanoid ? 15 : 25);
        let tailY = a.y - (a.vy / a.speed) * (a.isParanoid ? 15 : 25);

        // 箭矢渐变身躯
        let arrowColor = a.color || (a.isParanoid ? 'orange' : (a.isFantasy ? 'magenta' : 'white'));
        let grad = ctx.createLinearGradient(a.x, a.y, tailX, tailY);
        grad.addColorStop(0, arrowColor);
        grad.addColorStop(1, 'transparent');

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(tailX, tailY);
        ctx.lineCap = 'round';
        ctx.strokeStyle = grad;
        ctx.lineWidth = a.isParanoid ? 6 : 3;
        ctx.stroke();

        // 箭头亮点（带有发光）
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.isParanoid ? 3 : 1.5, 0, Math.PI * 2);
        ctx.fillStyle = 'white';
        ctx.shadowColor = arrowColor;
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0; // 重置
    });

    // Draw traps (only visible to owner or spectators)
    if (gameState.traps) {
        Object.values(gameState.traps).forEach(t => {
            if (t.ownerId === myId) {
                ctx.beginPath();
                ctx.arc(t.x, t.y, t.radius, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(255, 0, 0, 0.3)';
                ctx.fill();
                ctx.strokeStyle = t.active ? 'red' : 'gray';
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.fillStyle = 'red';
                ctx.font = '10px Arial';
                ctx.textAlign = 'center';
                ctx.fillText('陷', t.x, t.y + 3);
            }
        });
    }

    // 绘制视野盲区黑雾（黑暗森林模式或者明察天赋共享逻辑）
    if (me && (currentMode === 'dark_forest' || me.talent === 'clairvoyance')) {
        let sightRadius = currentMode === 'dark_forest' ? 120 : 160;
        if (me.talent === 'clairvoyance') sightRadius += 50;

        const radGrad = ctx.createRadialGradient(me.x, me.y, 10, me.x, me.y, sightRadius + (me.radarOn ? 150 : 0));
        radGrad.addColorStop(0, 'rgba(0,0,0,0)');
        radGrad.addColorStop(1, 'rgba(0,0,0,0.98)'); // 极暗

        ctx.fillStyle = radGrad;
        ctx.fillRect(0, 0, WORLD_W, WORLD_H);

        // 如果开启了雷达，画个扫描波圈
        if (me.radarOn) {
            ctx.beginPath();
            ctx.arc(me.x, me.y, 250, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0, 255, 255, 0.4)';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    }

    // Draw players
    Object.values(gameState.players).forEach(p => {
        // 在黑暗森林中，如果不是且本人距离过远且几乎没有在移动（潜伏），则不可见被剔除渲染
        if (currentMode === 'dark_forest' && p.id !== myId && me) {
            const dist = Math.hypot(me.x - p.x, me.y - p.y);
            // 这里我们采用极简的客户端预测遮挡方案：只有跑动/靠近才画出身体
            if (dist > 150 && Math.abs(p.vx) < 1 && Math.abs(p.vy) < 1) {
                return; // 跳过渲染该玩家
            }
        }

        if (!p.isDead) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 20;
            ctx.fill();
            ctx.shadowBlur = 0;

            // Bot 橙色描边，自己白色描边，其他玩家深色描边
            const isBot = p.id && p.id.startsWith('bot_');
            if (p.id === myId) {
                ctx.strokeStyle = 'white';
                ctx.lineWidth = 3;
            } else if (isBot) {
                ctx.strokeStyle = '#ffa500';
                ctx.lineWidth = 2;
            } else {
                ctx.strokeStyle = '#222';
                ctx.lineWidth = 2;
            }
            if (p.poisonTicks > 0) {
                ctx.strokeStyle = '#0f0'; // 中毒绿边包围
            }
            ctx.stroke();

            // 护盾环绕特效
            if (p.hasShield) {
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.radius + 6 + Math.sin(Date.now() / 100) * 2, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(0, 255, 255, 0.8)';
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 5]);
                ctx.shadowColor = '#0ff';
                ctx.shadowBlur = 10;
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.setLineDash([]);
            }

            ctx.fillStyle = 'white';
            ctx.font = '12px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(p.name, p.x, p.y - p.radius - 12);

            // === 玩家血条 ===
            if (p.maxHp && p.maxHp > 0) {
                const barW = p.radius * 2.2;
                const barH = 4;
                const barX = p.x - barW / 2;
                const barY = p.y - p.radius - 8;
                const hpRatio = (p.hp || 0) / p.maxHp;

                // 背景
                ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
                ctx.fillRect(barX, barY, barW, barH);
                // 血量颜色
                const hpColor = hpRatio > 0.6 ? '#0f0' : (hpRatio > 0.3 ? '#ff0' : '#f00');
                ctx.fillStyle = hpColor;
                ctx.fillRect(barX, barY, barW * hpRatio, barH);
                // 外框
                ctx.strokeStyle = 'rgba(255,255,255,0.5)';
                ctx.lineWidth = 0.5;
                ctx.strokeRect(barX, barY, barW, barH);

                // === 生命次数图标 ===
                if (p.maxLives && p.maxLives > 0) {
                    ctx.font = '8px Arial';
                    ctx.textAlign = 'left';
                    let livesStr = '';
                    for (let li = 0; li < (p.lives || 0); li++) livesStr += '❤';
                    ctx.fillStyle = '#ff6666';
                    ctx.fillText(livesStr, barX, barY - 2);
                }
            }

            // 无敌帧闪烁效果（重生后金色光环更醒目）
            if (p.invincible) {
                ctx.beginPath();
                const pulseR = p.radius + 4 + Math.sin(Date.now() / 50) * 2;
                ctx.arc(p.x, p.y, pulseR, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(255, 215, 0, ${0.4 + 0.3 * Math.sin(Date.now() / 50)})`;
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        } else if (p.id === myId) {
            // 死亡提示改为在 UI 层绘制（见下方 UI 叠加层）
        }
    });

    // 绘制蓄力进度环 + 真实射程瞄准线 + 散射锥（在世界坐标系中）
    if (isCharging && me && !me.isDead) {
        let chargeRatio = 1;
        const maxMs = getMaxChargeMs();
        if (maxMs > 0) {
            const chargeMs = Math.min(Date.now() - chargeStartTime, maxMs);
            chargeRatio = chargeMs / maxMs;
        }

        const chargeRadius = me.radius + 8;

        // === 进度弧线 ===
        ctx.beginPath();
        ctx.arc(me.x, me.y, chargeRadius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * chargeRatio);
        const arcColor = chargeRatio >= 1
            ? `hsl(${(Date.now() / 5) % 360}, 100%, 60%)`
            : `hsl(${120 * chargeRatio}, 100%, 50%)`;
        ctx.strokeStyle = arcColor;
        ctx.lineWidth = 3;
        ctx.shadowColor = arcColor;
        ctx.shadowBlur = 12;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // 满蓄外圈脉冲
        if (chargeRatio >= 1) {
            ctx.beginPath();
            const pulseR = chargeRadius + 5 + Math.sin(Date.now() / 80) * 3;
            ctx.arc(me.x, me.y, pulseR, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255, 215, 0, 0.5)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // === 计算与服务端一致的真实射程 ===
        const weaponStats = window.WEAPONS && window.WEAPONS[selectedWeapon] ? window.WEAPONS[selectedWeapon] : null;
        let arrowSpeed = 200 + chargeRatio * 400;
        let arrowLife = 0.6 + chargeRatio * 1.9;
        let inaccuracyBase = Math.PI / 12;
        let movingInacc = Math.PI / 18;

        if (weaponStats) {
            arrowSpeed = weaponStats.speedBase + chargeRatio * weaponStats.speedMultiplier;
            arrowLife = weaponStats.lifeBase + chargeRatio * weaponStats.lifeMultiplier;
            inaccuracyBase = weaponStats.inaccuracyBase;
            movingInacc = weaponStats.movingInaccuracy;
        }

        if (selectedTalent === 'paranoid') {
            arrowSpeed *= 0.8;
        }
        if (currentMode === 'sniper_duel') {
            arrowSpeed *= 2;
        }

        const realRange = arrowSpeed * arrowLife;      // 实际飞行距离（像素）
        // 散布半角（与 server.js inaccuracy 同步）
        const currentlyMoving = keys.w || keys.a || keys.s || keys.d;
        let targetSpread = (1 - chargeRatio) * inaccuracyBase;
        if (currentlyMoving) targetSpread += movingInacc;
        // 平滑插值：散布锐线逐1秒内渐变，不是瞬间跳变
        visualSpread += (targetSpread - visualSpread) * Math.min(1, dt * 5);
        const spreadHalf = visualSpread;

        const aimAngle = Math.atan2(chargeMouseY - me.y, chargeMouseX - me.x);
        // 补偿客户端 lerp 插值滞后：箭矢视觉位置永远落后真实位置约 speed/lerpCoeff 像素
        // lerpCoeff = 15（draw 函数中 dt * 15），箭矢消亡时视觉还没到终点
        const lerpLag = arrowSpeed / 15;
        const displayRange = Math.max(20, realRange - lerpLag);

        // === 散射锥形区域（半透明扇形填充） ===
        if (spreadHalf > 0.01) {
            ctx.beginPath();
            ctx.moveTo(me.x, me.y);
            ctx.arc(me.x, me.y, displayRange, aimAngle - spreadHalf, aimAngle + spreadHalf);
            ctx.closePath();
            ctx.fillStyle = `rgba(255, 100, 100, ${0.06 + (1 - chargeRatio) * 0.08})`;
            ctx.fill();

            // 散射边界线
            ctx.beginPath();
            ctx.moveTo(me.x, me.y);
            ctx.lineTo(
                me.x + Math.cos(aimAngle - spreadHalf) * displayRange,
                me.y + Math.sin(aimAngle - spreadHalf) * displayRange
            );
            ctx.moveTo(me.x, me.y);
            ctx.lineTo(
                me.x + Math.cos(aimAngle + spreadHalf) * displayRange,
                me.y + Math.sin(aimAngle + spreadHalf) * displayRange
            );
            ctx.strokeStyle = `rgba(255, 100, 100, ${0.3 + (1 - chargeRatio) * 0.3})`;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 5]);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // === 主瞄准线（粗实线 + 发光，长度 = 真实射程） ===
        ctx.beginPath();
        ctx.moveTo(me.x, me.y);
        ctx.lineTo(
            me.x + Math.cos(aimAngle) * displayRange,
            me.y + Math.sin(aimAngle) * displayRange
        );
        // 渐变线：靠近角色是亮白，远端淡出
        const lineGrad = ctx.createLinearGradient(
            me.x, me.y,
            me.x + Math.cos(aimAngle) * displayRange,
            me.y + Math.sin(aimAngle) * displayRange
        );
        lineGrad.addColorStop(0, `rgba(255, 255, 255, ${0.6 + chargeRatio * 0.4})`);
        lineGrad.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
        ctx.strokeStyle = lineGrad;
        ctx.lineWidth = 2 + chargeRatio;
        ctx.shadowColor = arcColor;
        ctx.shadowBlur = 6;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // 末端十字准星标记
        const endX = me.x + Math.cos(aimAngle) * displayRange;
        const endY = me.y + Math.sin(aimAngle) * displayRange;
        const crossSize = 4 + chargeRatio * 3;
        ctx.beginPath();
        ctx.moveTo(endX - crossSize, endY);
        ctx.lineTo(endX + crossSize, endY);
        ctx.moveTo(endX, endY - crossSize);
        ctx.lineTo(endX, endY + crossSize);
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.4 + chargeRatio * 0.5})`;
        ctx.lineWidth = 1;
        ctx.stroke();

        // === 蓄力百分比文字 ===
        ctx.fillStyle = 'white';
        ctx.font = 'bold 11px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.floor(chargeRatio * 100)}%`, me.x, me.y + me.radius + 22);
    }
    // === 结束摄像机变换，后续绘制 UI 叠加层（屏幕坐标） ===
    ctx.restore(); // 恢复摄像机 translate

    // 死亡观战提示 + 重生倒计时
    if (me && me.isDead) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
        ctx.textAlign = 'center';

        if (me.lives > 0 && me.respawnTimer > 0) {
            // 还有命，显示重生倒计时
            ctx.fillStyle = '#0ff';
            ctx.font = 'bold 36px Inter';
            ctx.fillText(`重生倒计时: ${Math.ceil(me.respawnTimer)}s`, VIEW_WIDTH / 2, VIEW_HEIGHT / 2 - 15);
            ctx.fillStyle = '#aaa';
            ctx.font = '18px Inter';
            ctx.fillText(`剩余生命: ${'❤'.repeat(me.lives)} (${me.lives}/${me.maxLives})`, VIEW_WIDTH / 2, VIEW_HEIGHT / 2 + 20);
        } else if (me.lives <= 0) {
            // 命耗尽，永久死亡
            ctx.fillStyle = 'red';
            ctx.font = 'bold 32px Inter';
            ctx.fillText('生命耗尽!', VIEW_WIDTH / 2, VIEW_HEIGHT / 2 - 20);
            ctx.fillStyle = '#aaa';
            ctx.font = '18px Inter';
            ctx.fillText('← → 切换观战', VIEW_WIDTH / 2, VIEW_HEIGHT / 2 + 15);
            const specName = spectateTarget && gameState.players[spectateTarget]
                ? gameState.players[spectateTarget].name : '';
            if (specName) {
                ctx.fillStyle = 'white';
                ctx.fillText(`正在观战: ${specName}`, VIEW_WIDTH / 2, VIEW_HEIGHT / 2 + 40);
            }
        } else {
            // 回合结束时的死亡
            ctx.fillStyle = 'red';
            ctx.font = '28px Inter';
            ctx.fillText('你已阵亡，观战中...', VIEW_WIDTH / 2, VIEW_HEIGHT / 2);
        }
    }

    if (gameState.state === 'round_end') {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
        ctx.fillStyle = 'white';
        ctx.font = 'bold 40px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(`本局结束！下一局倒计时: ${Math.ceil(gameState.countdown)}s`, VIEW_WIDTH / 2, VIEW_HEIGHT / 2 - 50);
    }

    // 根据存活状态控制战歌
    if (me && !me.isDead && gameState.state === 'playing') {
        if (window.BGM) window.BGM.start();
    } else {
        if (window.BGM) window.BGM.stop();
    }

    // 绘制与更新环境粒子 (特地放在最上面一层覆盖人物)
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= dt;

        ctx.beginPath();
        ctx.arc(p.x - camX, p.y - camY, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 5;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;

        if (p.life <= 0) particles.splice(i, 1);
    }

    // 飘字绘制
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        const ft = floatingTexts[i];
        ft.y += ft.vy * dt;
        ft.life -= dt;

        ctx.fillStyle = ft.color;
        ctx.globalAlpha = Math.max(0, ft.life / 1.5); // 淡出
        ctx.font = 'bold 16px Inter';
        ctx.textAlign = 'center';
        ctx.shadowColor = 'black';
        ctx.shadowBlur = 3;
        ctx.fillText(ft.text, ft.x - camX, ft.y - camY);
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;

        if (ft.life <= 0) floatingTexts.splice(i, 1);
    }

    // 绘制闪电链特效
    for (let i = lightnings.length - 1; i >= 0; i--) {
        const l = lightnings[i];
        l.life -= dt;
        if (l.life <= 0) {
            lightnings.splice(i, 1);
            continue;
        }

        ctx.beginPath();
        ctx.moveTo(l.x1 - camX, l.y1 - camY);
        // 增加一点分叉抖动
        const midX = (l.x1 + l.x2) / 2 + (Math.random() - 0.5) * 40 - camX;
        const midY = (l.y1 + l.y2) / 2 + (Math.random() - 0.5) * 40 - camY;
        ctx.lineTo(midX, midY);
        ctx.lineTo(l.x2 - camX, l.y2 - camY);

        ctx.strokeStyle = `rgba(0, 170, 255, ${l.life / 0.3})`;
        ctx.lineWidth = 4 * (Math.random() * 0.5 + 0.5);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = '#00aaff';
        ctx.shadowBlur = 15;
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    // 恢复震荡偏移
    ctx.restore();

    // === 房间信息 ===
    if (currentRoomId && me && !me.isDead) {
        ctx.fillStyle = 'rgba(0, 20, 30, 0.7)';
        ctx.fillRect(10, 10, 260, 34);
        ctx.strokeStyle = 'rgba(0, 200, 255, 0.4)';
        ctx.lineWidth = 1;
        ctx.strokeRect(10, 10, 260, 34);
        ctx.fillStyle = '#0ff';
        ctx.font = 'bold 15px Inter';
        ctx.textAlign = 'left';
        ctx.shadowColor = '#0ff';
        ctx.shadowBlur = 5;
        ctx.fillText(`房号: ${currentRoomId}`, 20, 32);
        ctx.shadowBlur = 0;
    }

    // === 小地图 / 雷达 ===
    if (gameState.state === 'playing') {
        const MM_W = 200;
        const MM_H = 120;
        const MM_X = VIEW_WIDTH - MM_W - 20;
        const MM_Y = 20;
        const MM_SCALE_X = MM_W / WORLD_W;
        const MM_SCALE_Y = MM_H / WORLD_H;

        // 背景
        ctx.fillStyle = 'rgba(0, 20, 30, 0.7)';
        ctx.fillRect(MM_X, MM_Y, MM_W, MM_H);
        ctx.strokeStyle = 'rgba(0, 200, 255, 0.4)';
        ctx.lineWidth = 1;
        ctx.strokeRect(MM_X, MM_Y, MM_W, MM_H);

        const drawMMPoint = (x, y, color, size) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(MM_X + x * MM_SCALE_X, MM_Y + y * MM_SCALE_Y, size, 0, Math.PI * 2);
            ctx.fill();
        };

        // 1. 墙体 (暗灰)
        ctx.fillStyle = 'rgba(80, 80, 80, 0.6)';
        if (gameState.walls) {
            for (const wall of gameState.walls) {
                ctx.fillRect(MM_X + wall.x * MM_SCALE_X, MM_Y + wall.y * MM_SCALE_Y, wall.w * MM_SCALE_X, wall.h * MM_SCALE_Y);
            }
        }

        // 2. 环境元素
        if (gameState.traps) {
            for (const trap of Object.values(gameState.traps)) {
                if (trap.active) drawMMPoint(trap.x, trap.y, '#aa00ff', 1.5);
            }
        }
        if (gameState.bees) {
            for (const bee of Object.values(gameState.bees)) {
                drawMMPoint(bee.x, bee.y, 'yellow', 2);
            }
        }
        if (gameState.buffs) {
            for (const buff of Object.values(gameState.buffs)) {
                drawMMPoint(buff.x, buff.y, buff.type === 'sprint' ? '#00ffff' : '#ffaa00', 2);
            }
        }

        // 3. 怪物 (红/橙)
        if (gameState.monsters) {
            for (const m of Object.values(gameState.monsters)) {
                drawMMPoint(m.x, m.y, m.isBoss ? '#ff4400' : '#ff0000', m.isBoss ? 2.5 : 1.5);
            }
        }

        // 4. 其他玩家 (橙红/各自颜色)
        if (gameState.players) {
            for (const p of Object.values(gameState.players)) {
                if (p.isDead || p.id === myId) continue;
                drawMMPoint(p.x, p.y, p.id.startsWith('bot_') ? '#ff6600' : p.color, 2);
            }
        }

        // 5. 自己 (高亮绿) 及视野框
        if (me && !me.isDead) {
            drawMMPoint(me.x, me.y, '#00ff00', 3);
            const viewW = VIEW_WIDTH * MM_SCALE_X;
            const viewH = VIEW_HEIGHT * MM_SCALE_Y;
            const viewX = MM_X + camX * MM_SCALE_X;
            const viewY = MM_Y + camY * MM_SCALE_Y;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
            ctx.lineWidth = 1;
            ctx.strokeRect(viewX, viewY, viewW, viewH);
        }
    }

    // 恢复画面高清缩放
    ctx.restore();

    // 世界边界指示线（调试用，会在最终版中移除）
    // ctx.strokeStyle = 'rgba(255,0,0,0.3)'; ctx.strokeRect(-camX, -camY, WORLD_W, WORLD_H);

    requestAnimationFrame(draw);
}

requestAnimationFrame(draw);
