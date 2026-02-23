// c:\2\arrows\botAI.js
// AI 玩家（Bot）决策引擎
// Bot 在服务端运行，直接操作 Player 实体，不走 Socket 通信

const GAME_WIDTH = 2000;
const GAME_HEIGHT = 1200;

// === 难度预设 ===
const DIFFICULTY_PRESETS = {
    easy: {
        sightRange: 400,        // 视距（像素）
        aimAccuracy: Math.PI / 12, // ±15° 散布
        reactionDelay: 0.5,     // 反应延迟（秒）
        shootChargeMin: 0.5,    // 最短蓄力时间
        shootChargeMax: 1.0,    // 最长蓄力时间
        dodgeChance: 0.3,       // 闪避概率
        shootCooldownMin: 1.5,  // 射击冷却最小
        shootCooldownMax: 2.5,  // 射击冷却最大
        predictLookAhead: 0.3,  // 预判提前量（秒）
    },
    medium: {
        sightRange: 550,
        aimAccuracy: Math.PI / 22,  // ±8°
        reactionDelay: 0.3,
        shootChargeMin: 0.7,
        shootChargeMax: 1.5,
        dodgeChance: 0.55,
        shootCooldownMin: 1.0,
        shootCooldownMax: 2.0,
        predictLookAhead: 0.5,
    },
    hard: {
        sightRange: 700,
        aimAccuracy: Math.PI / 60,  // ±3°
        reactionDelay: 0.15,
        shootChargeMin: 1.0,
        shootChargeMax: 1.8,
        dodgeChance: 0.8,
        shootCooldownMin: 0.8,
        shootCooldownMax: 1.5,
        predictLookAhead: 0.7,
    }
};

// 工具函数
function randomRange(min, max) {
    return min + Math.random() * (max - min);
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(val, max));
}

function distanceBetween(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * BotBrain — Bot 决策核心
 * 每个 Bot 对应一个 BotBrain 实例，持有其 Player 引用
 */
class BotBrain {
    /**
     * @param {string} playerId - 对应 Player 的 id
     * @param {string} difficulty - 'easy' | 'medium' | 'hard'
     */
    constructor(playerId, difficulty = 'medium') {
        this.playerId = playerId;
        this.params = { ...DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.medium };

        // === FSM 状态 ===
        this.state = 'PATROL';   // PATROL | ENGAGE | SHOOT | EVADE | LOOT
        this.stateTimer = 0;

        // === 巡逻相关 ===
        this.patrolTarget = this._randomPatrolPoint();
        this.patrolWaitTimer = 0;

        // === 射击相关 ===
        this.targetPlayerId = null;
        this.targetType = 'player'; // 'player' | 'monster'
        this.chargeStartTime = 0;
        this.targetChargeDuration = 0;
        this.shootCooldown = 1.0; // 开局 1 秒冷却
        this.isCharging = false;

        // === 闪避相关 ===
        this.evadeVx = 0;
        this.evadeVy = 0;
        this.evadeTimer = 0;

        // === 拾取相关 ===
        this.lootTargetId = null;
        this.lootType = null; // 'buff' | 'bee'

        // === 反应延迟 ===
        this.reactionTimer = 0;
        this.pendingState = null;

        // === 通用计时器 ===
        this.thinkTimer = 0; // 每隔一段时间重新评估决策
    }

    /**
     * 主更新方法 — 每帧调用
     * @param {number} dt - 帧间隔（秒）
     * @param {object} gameState - 完整游戏状态
     * @param {function} createArrowFn - 创建箭矢的回调函数
     */
    update(dt, gameState, createArrowFn) {
        const player = gameState.players[this.playerId];
        if (!player || player.isDead) return;

        // 更新冷却
        if (this.shootCooldown > 0) this.shootCooldown -= dt;
        if (this.evadeTimer > 0) this.evadeTimer -= dt;
        this.thinkTimer -= dt;

        // 处理反应延迟
        if (this.reactionTimer > 0) {
            this.reactionTimer -= dt;
            if (this.reactionTimer <= 0 && this.pendingState) {
                this.state = this.pendingState;
                this.pendingState = null;
            }
        }

        // === 威胁检测（最高优先级，覆盖反应延迟） ===
        const threat = this._detectThreat(player, gameState);
        if (threat && this.state !== 'EVADE') {
            // 直接进入闪避，不走反应延迟（生存本能）
            this._startEvade(player, threat);
        }

        // === 闪避位移 ===
        if (this.evadeTimer > 0) {
            player.inputVx = this.evadeVx;
            player.inputVy = this.evadeVy;
            // 闪避期间不执行其他逻辑
            return;
        } else if (this.state === 'EVADE') {
            // 闪避结束，回到巡逻
            this.state = 'PATROL';
            this.isCharging = false;
        }

        // === 每 0.3 秒重新评估决策 ===
        if (this.thinkTimer <= 0 && this.state !== 'SHOOT') {
            this.thinkTimer = 0.3;
            this._evaluate(player, gameState);
        }

        // === 根据状态执行行为 ===
        switch (this.state) {
            case 'PATROL':
                this._doPatrol(dt, player, gameState);
                break;
            case 'ENGAGE':
                this._doEngage(dt, player, gameState);
                break;
            case 'SHOOT':
                this._doShoot(dt, player, gameState, createArrowFn);
                break;
            case 'LOOT':
                this._doLoot(dt, player, gameState);
                break;
            case 'ESCAPE':
                this._doEscape(dt, player, gameState);
                break;
        }
    }

    // ============================================================
    //  状态评估 — 决定当前应处于什么状态
    // ============================================================
    _evaluate(player, gameState) {
        // 优先级：EVADE(已在上面处理) > ESCAPE(濒死) > ENGAGE(玩家) > ENGAGE(怪物) > LOOT > PATROL

        // 生死攸关：如果血量极低，优先找草丛隐藏或找跳板逃生
        if (player.hp <= 1 || (player.hp / player.maxHp <= 0.35)) {
            const escapeRoute = this._findEscapeRoute(player, gameState);
            if (escapeRoute) {
                this.state = 'ESCAPE';
                this.escapeTarget = escapeRoute;
                return;
            }
        }

        // 寻找最近的敌方玩家
        const nearestEnemy = this._findNearestEnemy(player, gameState);
        if (nearestEnemy && nearestEnemy.dist < this.params.sightRange) {
            if (this.state !== 'ENGAGE' || this.targetType !== 'player') {
                this._switchStateDelayed('ENGAGE');
            }
            this.targetPlayerId = nearestEnemy.player.id;
            this.targetType = 'player';
            return;
        }

        // 寻找最近的亡灵怪物（作为攻击目标）
        const nearestMonster = this._findNearestMonster(player, gameState);
        if (nearestMonster && nearestMonster.dist < this.params.sightRange * 0.6) {
            if (this.state !== 'ENGAGE' || this.targetType !== 'monster') {
                this._switchStateDelayed('ENGAGE');
            }
            this.targetPlayerId = nearestMonster.monster.id;
            this.targetType = 'monster';
            return;
        }

        // 寻找附近的增益道具
        const nearestLoot = this._findNearestLoot(player, gameState);
        if (nearestLoot && nearestLoot.dist < this.params.sightRange * 0.8) {
            this.state = 'LOOT';
            this.lootTargetId = nearestLoot.id;
            this.lootType = nearestLoot.type;
            return;
        }

        // 无特殊情况则巡逻
        if (this.state !== 'PATROL') {
            this.state = 'PATROL';
            this.targetPlayerId = null;
        }
    }

    // ============================================================
    //  PATROL — 随机巡逻
    // ============================================================
    _doPatrol(dt, player, gameState) {
        this.isCharging = false;
        player.speed = player.baseSpeed;

        // 到达巡逻点附近，等一下再选新目标
        const distToTarget = distanceBetween(player, this.patrolTarget);
        if (distToTarget < 50) {
            this.patrolWaitTimer -= dt;
            player.inputVx = 0;
            player.inputVy = 0;
            if (this.patrolWaitTimer <= 0) {
                this.patrolTarget = this._randomPatrolPoint();
                this.patrolWaitTimer = randomRange(0.5, 2.0);
            }
            return;
        }

        // 向巡逻点移动
        const dx = this.patrolTarget.x - player.x;
        const dy = this.patrolTarget.y - player.y;
        const len = Math.hypot(dx, dy);
        if (len > 0) {
            player.inputVx = (dx / len) * player.speed * 0.6; // 巡逻时不全速
            player.inputVy = (dy / len) * player.speed * 0.6;
        }
    }

    // ============================================================
    //  ENGAGE — 接敌移动
    // ============================================================
    _doEngage(dt, player, gameState) {
        this.isCharging = false;
        player.speed = player.baseSpeed;

        // 根据目标类型获取目标实体
        const target = this._getTarget(gameState);
        if (!target) {
            this.state = 'PATROL';
            this.targetPlayerId = null;
            return;
        }

        const dist = distanceBetween(player, target);
        // 怪物射程比玩家略近（怪物体积大更容易命中）
        const shootRange = this.targetType === 'monster'
            ? this.params.sightRange * 0.5
            : this.params.sightRange * 0.7;

        // 进入射击范围且冷却已好
        if (dist < shootRange && this.shootCooldown <= 0) {
            this.state = 'SHOOT';
            this.chargeStartTime = 0;
            // 射怪物时蓄力更短（不需要太高精度）
            this.targetChargeDuration = this.targetType === 'monster'
                ? randomRange(0.3, 0.7)
                : randomRange(this.params.shootChargeMin, this.params.shootChargeMax);
            this.isCharging = true;
            player.speed = player.baseSpeed * 0.4; // 蓄力减速
            return;
        }

        // 向目标移动
        const predicted = this._predictPosition(target, 0.3);
        const dx = predicted.x - player.x;
        const dy = predicted.y - player.y;
        const len = Math.hypot(dx, dy);
        if (len > 0) {
            const jitter = (Math.random() - 0.5) * 0.3;
            const angle = Math.atan2(dy, dx) + jitter;
            player.inputVx = Math.cos(angle) * player.speed;
            player.inputVy = Math.sin(angle) * player.speed;
        }
    }

    // ============================================================
    //  SHOOT — 蓄力射击
    // ============================================================
    _doShoot(dt, player, gameState, createArrowFn) {
        // 根据目标类型获取目标实体
        const target = this._getTarget(gameState);
        if (!target) {
            // 目标消失，取消射击
            this.state = 'PATROL';
            this.isCharging = false;
            player.speed = player.baseSpeed;
            return;
        }

        // 蓄力倒计时
        this.chargeStartTime += dt;

        // 蓄力期间微调朝向（轻微移动跟踪）
        const dx = target.x - player.x;
        const dy = target.y - player.y;
        const len = Math.hypot(dx, dy);
        const dist = len; // Use len as dist
        if (dist > 50) {
            // 蓄力时缓慢移动 (如 15% 速度)
            player.inputVx = (dx / len) * player.speed * 0.15;
            player.inputVy = (dy / len) * player.speed * 0.15;
        } else {
            player.inputVx = 0;
            player.inputVy = 0;
        }

        // 蓄力完成 → 开火
        if (this.chargeStartTime >= this.targetChargeDuration) {
            // 计算射击方向：预判目标位置
            const predicted = this._predictPosition(target, this.params.predictLookAhead);
            const aimDx = predicted.x - player.x;
            const aimDy = predicted.y - player.y;
            let angle = Math.atan2(aimDy, aimDx);

            // 添加随机散布（模拟人类不精确性）
            const scatter = (Math.random() - 0.5) * 2 * this.params.aimAccuracy;
            angle += scatter;

            // 计算蓄力比例（0~1）
            const charge = clamp(this.targetChargeDuration / 2.0, 0, 1);

            // 计算箭速
            const arrowSpeed = 400 + charge * 800;
            const arrowLifeTime = 0.6 + charge * 1.9;

            // 通过回调创建箭矢
            createArrowFn(
                this.playerId,
                player.x,
                player.y,
                Math.cos(angle),
                Math.sin(angle),
                arrowSpeed,
                charge,
                arrowLifeTime
            );

            // 射击完成，进入冷却
            this.state = 'PATROL';
            this.isCharging = false;
            this.shootCooldown = randomRange(
                this.params.shootCooldownMin,
                this.params.shootCooldownMax
            );
            player.speed = player.baseSpeed;
        }
    }

    // ============================================================
    //  EVADE — 闪避威胁
    // ============================================================
    _startEvade(player, threat) {
        if (Math.random() > this.params.dodgeChance) return; // 概率不闪避

        this.state = 'EVADE';
        this.isCharging = false;

        // 计算闪避方向：垂直于威胁方向
        const dx = threat.x - player.x;
        const dy = threat.y - player.y;
        const len = Math.hypot(dx, dy);
        if (len > 0) {
            // 选择随机的垂直方向
            const dir = Math.random() > 0.5 ? 1 : -1;
            this.evadeVx = (-dy / len) * player.baseSpeed * 2.0 * dir;
            this.evadeVy = (dx / len) * player.baseSpeed * 2.0 * dir;
        }
        this.evadeTimer = randomRange(0.2, 0.4);
        player.speed = player.baseSpeed;
    }

    // ============================================================
    //  LOOT — 拾取增益/射击蜜蜂
    // ============================================================
    _doLoot(dt, player, gameState) {
        this.isCharging = false;
        player.speed = player.baseSpeed;

        let target = null;
        if (this.lootType === 'buff') {
            target = gameState.buffs[this.lootTargetId];
        } else if (this.lootType === 'bee') {
            target = gameState.bees[this.lootTargetId];
        }

        if (!target) {
            // 目标已消失
            this.state = 'PATROL';
            this.lootTargetId = null;
            return;
        }

        const dist = distanceBetween(player, target);

        // 如果是蜜蜂且距离足够近，尝试射击
        if (this.lootType === 'bee' && dist < 250 && this.shootCooldown <= 0) {
            // 直接瞄准蜜蜂射击（不需要长蓄力）
            const aimDx = target.x - player.x;
            const aimDy = target.y - player.y;
            const angle = Math.atan2(aimDy, aimDx) + (Math.random() - 0.5) * this.params.aimAccuracy;
            // 无需蓄力射击蜜蜂，不在这里处理（会在 ENGAGE 中对待）
            // 改为向蜜蜂靠近
        }

        // 向目标移动
        const dx = target.x - player.x;
        const dy = target.y - player.y;
        const len = Math.hypot(dx, dy);
        if (dist > 30) { // 稍微留点距离，防止鬼畜
            player.inputVx = (dx / len) * player.speed;
            player.inputVy = (dy / len) * player.speed;
        } else {
            player.inputVx = 0;
            player.inputVy = 0;
        }
        // 如果太远了就放弃
        if (dist > this.params.sightRange) {
            this.state = 'PATROL';
            this.lootTargetId = null;
        }
    }

    // ============================================================
    //  ESCAPE — 逃往跳板或草丛
    // ============================================================
    _findEscapeRoute(player, gameState) {
        let best = null;
        let minDist = this.params.sightRange * 1.5; // 可以稍微找远点

        if (gameState.bushes && Array.isArray(gameState.bushes)) {
            for (const bush of gameState.bushes) {
                const dist = distanceBetween(player, bush);
                if (dist < minDist) {
                    minDist = dist;
                    best = { x: bush.x, y: bush.y, type: 'bush' };
                }
            }
        }

        if (gameState.jumpPads && Array.isArray(gameState.jumpPads)) {
            for (const pad of gameState.jumpPads) {
                const dist = distanceBetween(player, pad);
                if (dist < minDist) {
                    minDist = dist;
                    best = { x: pad.x, y: pad.y, type: 'pad' };
                }
            }
        }
        return best;
    }

    _doEscape(dt, player, gameState) {
        this.isCharging = false;
        player.speed = player.baseSpeed;

        if (!this.escapeTarget) {
            this.state = 'PATROL';
            return;
        }

        const dx = this.escapeTarget.x - player.x;
        const dy = this.escapeTarget.y - player.y;
        const dist = Math.hypot(dx, dy);

        if (dist < (this.escapeTarget.type === 'bush' ? 20 : 10)) {
            player.inputVx = 0;
            player.inputVy = 0;

            // 躲在草丛里苟一会儿
            this.escapeWaitTimer = (this.escapeWaitTimer || 0) + dt;
            if (this.escapeWaitTimer > 4.0 || player.hp >= player.maxHp) {
                this.escapeWaitTimer = 0;
                this.escapeTarget = null;
                this.state = 'PATROL';
            }
        } else {
            this.escapeWaitTimer = 0;
            player.inputVx = (dx / dist) * player.speed;
            player.inputVy = (dy / dist) * player.speed;
        }
    }

    // ============================================================
    //  辅助方法
    // ============================================================

    /** 检测飞向自己的箭矢或靠近的怪物 */
    _detectThreat(player, gameState) {
        // 检测箭矢威胁
        for (const arrow of Object.values(gameState.arrows)) {
            if (arrow.ownerId === this.playerId) continue; // 不躲自己的箭
            const adx = player.x - arrow.x;
            const ady = player.y - arrow.y;
            const dist = Math.hypot(adx, ady);
            if (dist > 200 || dist < 15) continue;

            // 点积判定：箭矢是否飞向自己
            const dot = adx * arrow.vx + ady * arrow.vy;
            if (dot > 0) {
                return { x: arrow.x, y: arrow.y, type: 'arrow' };
            }
        }

        // 检测怪物威胁
        for (const monster of Object.values(gameState.monsters)) {
            const dist = distanceBetween(player, monster);
            if (dist < 120) {
                return { x: monster.x, y: monster.y, type: 'monster' };
            }
        }

        return null;
    }

    /** 寻找最近的存活敌方玩家 */
    _findNearestEnemy(player, gameState) {
        let nearest = null;
        let minDist = Infinity;

        for (const [id, other] of Object.entries(gameState.players)) {
            if (id === this.playerId || other.isDead || other.isInvisible) continue;
            const dist = distanceBetween(player, other);
            if (dist < minDist) {
                minDist = dist;
                nearest = { player: other, dist };
            }
        }
        return nearest;
    }

    /** 寻找最近的亡灵怪物 */
    _findNearestMonster(player, gameState) {
        let nearest = null;
        let minDist = Infinity;

        for (const [id, monster] of Object.entries(gameState.monsters)) {
            const dist = distanceBetween(player, monster);
            if (dist < minDist) {
                minDist = dist;
                nearest = { monster, dist };
            }
        }
        return nearest;
    }

    /**
     * 根据 targetType 和 targetPlayerId 获取目标实体
     * 返回目标对象或 null（目标已死亡/不存在）
     */
    _getTarget(gameState) {
        if (this.targetType === 'monster') {
            return gameState.monsters[this.targetPlayerId] || null;
        }
        const p = gameState.players[this.targetPlayerId];
        return (p && !p.isDead && !p.isInvisible) ? p : null;
    }

    /** 寻找最近的可拾取物品（Buff 或 蜜蜂） */
    _findNearestLoot(player, gameState) {
        let nearest = null;
        let minDist = Infinity;

        // 检查 Buff
        for (const [id, buff] of Object.entries(gameState.buffs)) {
            const dist = distanceBetween(player, buff);
            if (dist < minDist) {
                minDist = dist;
                nearest = { id, dist, type: 'buff' };
            }
        }

        // 检查蜜蜂
        for (const [id, bee] of Object.entries(gameState.bees)) {
            const dist = distanceBetween(player, bee);
            if (dist < minDist) {
                minDist = dist;
                nearest = { id, dist, type: 'bee' };
            }
        }

        return nearest;
    }

    /** 预判目标未来位置 */
    _predictPosition(target, lookAhead) {
        return {
            x: target.x + (target.vx || 0) * lookAhead,
            y: target.y + (target.vy || 0) * lookAhead
        };
    }

    /** 生成随机巡逻点 */
    _randomPatrolPoint() {
        return {
            x: randomRange(100, GAME_WIDTH - 100),
            y: randomRange(100, GAME_HEIGHT - 100)
        };
    }

    /** 带反应延迟的状态切换 */
    _switchStateDelayed(newState) {
        if (this.params.reactionDelay > 0) {
            this.pendingState = newState;
            this.reactionTimer = this.params.reactionDelay;
        } else {
            this.state = newState;
        }
    }
}

// === Bot 名称池（用于随机生成名字） ===
const BOT_NAMES = [
    '骷髅弓手', '幻影射手', '暗影猎人', '星辰使者',
    '风暴之眼', '月光弩手', '雷鸣箭客', '寒冰猎手',
    '烈焰射手', '虚空行者', '极光狙击', '暮光守望',
    '黎明猎者', '深渊之箭', '天穹射手', '破晓弓骑',
];

let botNameIndex = 0;

/** 获取下一个 Bot 名称 */
function getNextBotName() {
    const name = BOT_NAMES[botNameIndex % BOT_NAMES.length];
    botNameIndex++;
    return name;
}

module.exports = {
    BotBrain,
    DIFFICULTY_PRESETS,
    getNextBotName
};
