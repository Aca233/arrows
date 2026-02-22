// c:\2\arrows\gameLogic.js

const GAME_WIDTH = 2000;
const GAME_HEIGHT = 1200;
class Player {
    constructor(id, x, y, name, color) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.name = name || 'Player';
        this.color = color || 'blue';
        this.radius = 15;
        this.baseSpeed = 220;
        this.speed = 220; // 稍微提速
        this.vx = 0;
        this.vy = 0;
        this.score = 0;
        this.isDead = false;
        this.respawnTimer = 0;
        this.lives = 3;        // 每局3条命，耗尽则永死
        this.maxLives = 3;
        this.talent = 'none'; // 新增存放天赋标志
        this.weapon = 'bow';  // 默认武器

        // 血量系统
        this.hp = 3;
        this.maxHp = 3;

        // 增益状态
        this.buffExp = 0;
        this.hasMultishot = false;

        // 新天赋衍生状态
        this.hasShield = false;
        this.shieldTimer = 0;
        this.predictionError = 0;

        // 中毒状态
        this.poisonTicks = 0;
        this.poisonTimer = 0;
    }

    updatePosition(dt) {
        if (this.isDead) return;

        // Buff 倒计时
        if (this.buffExp > 0) {
            this.buffExp -= dt;
            if (this.buffExp <= 0) {
                // Buff 结束归位
                this.speed = this.baseSpeed;
                this.hasMultishot = false;
            }
        }

        this.x += this.vx * dt;
        this.y += this.vy * dt;

        // Boundaries
        this.x = Math.max(this.radius, Math.min(this.x, GAME_WIDTH - this.radius));
        this.y = Math.max(this.radius, Math.min(this.y, GAME_HEIGHT - this.radius));
    }
}

class Arrow {
    constructor(id, ownerId, x, y, vx, vy, speed) {
        this.id = id;
        this.ownerId = ownerId;
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.speed = speed || 400; // pixels per second
        this.radius = 3;
        this.color = 'white';
        this.talent = 'none'; // Inherits the shooter's talent

        // Weapon specific properties
        this.damage = 1;
        this.pierce = 1; // 默认穿透1个目标即销毁
        this.hitTargets = new Set(); // 记录已命中的目标ID，防止重复伤害

        // Normalize velocity
        const len = Math.sqrt(vx * vx + vy * vy);
        if (len > 0) {
            this.vx = (vx / len) * this.speed;
            this.vy = (vy / len) * this.speed;
        }

        this.lifeTime = 1.5; // seconds
        this.isDead = false;
    }

    updatePosition(dt) {
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.lifeTime -= dt;

        if (this.lifeTime <= 0 || this.x < 0 || this.x > GAME_WIDTH || this.y < 0 || this.y > GAME_HEIGHT) {
            this.isDead = true;
        }
    }
}

class Monster {
    constructor(id, x, y, type = 'normal') {
        this.id = id;
        this.x = x;
        this.y = y;
        this.type = type;

        this.radius = 15;
        this.baseSpeed = 100;
        this.color = 'red';
        this.hp = 1;
        this.maxHp = 1;

        if (type === 'ranged') {
            this.color = '#ff00ff'; // 品红
            this.baseSpeed = 70;
            this.radius = 14;
            this.shootTimer = 2.0;
        } else if (type === 'splitter') {
            this.color = '#00ff88'; // 绿
            this.radius = 22;
            this.baseSpeed = 80;
            this.hp = 2;
            this.maxHp = 2;
        } else if (type === 'healer') {
            this.color = '#ffff00'; // 黄
            this.baseSpeed = 85;
            this.radius = 16;
            this.hp = 2;
            this.maxHp = 2;
            this.healTimer = 3.0; // 每 3 秒加血
        }

        this.speed = this.baseSpeed;
        this.targetId = null;

        // === FSM 状态机 ===
        this.state = 'idle'; // 'idle' | 'chase' | 'flank' | 'rage'
        this.stateTimer = 0;
        this.senseRadius = 400; // 感知半径
        this.aliveTime = 0; // 存活计时
        this.lifeTime = 5; // 生命周期（秒），Boss 会在 server 中覆盖为更长
        this.rageTriggered = false;

        // === 绕行相关 ===
        this.flankDir = 0; // 绕行侧向角度（+1 右 / -1 左）
        this.flankTimer = 0;

        // === 游荡方向 ===
        this.wanderAngle = Math.random() * Math.PI * 2;
        this.wanderChangeTimer = 2 + Math.random() * 3;

        // === 避箭闪避 ===
        this.dodgeVx = 0;
        this.dodgeVy = 0;
        this.dodgeTimer = 0;

        // === 恐慌传播 ===
        this.panicVx = 0;
        this.panicVy = 0;
        this.panicTimer = 0;

        // === Boss 系统 ===
        this.isBoss = false;
        // 如果 type 没有赋予多余 hp，保持原有
        this.dashCooldown = 0;
        this.dashTimer = 0;
        this.isDashing = false;
        this.dashVx = 0;
        this.dashVy = 0;

        // === 群体协作索引（由外部 server 循环赋值） ===
        this.flankIndex = 0;
        this.flankGroupSize = 1;
    }

    // 预判玩家位置：根据玩家当前速度预测未来 lookAhead 秒后的坐标
    _predictTarget(target, lookAhead) {
        return {
            x: target.x + (target.vx || 0) * lookAhead,
            y: target.y + (target.vy || 0) * lookAhead
        };
    }

    // 群体包围：计算本怪物应该从哪个方向接近目标
    _flankOffset(target) {
        if (this.flankGroupSize <= 1) return { x: 0, y: 0 };
        // 均匀分布在目标周围：每个怪物占据 360° / groupSize 的扇区
        const angleStep = (Math.PI * 2) / this.flankGroupSize;
        const angle = angleStep * this.flankIndex;
        const offsetDist = 60; // 包围半径偏移
        return {
            x: Math.cos(angle) * offsetDist,
            y: Math.sin(angle) * offsetDist
        };
    }

    updatePosition(dt, players, walls, allMonsters, arrows) {
        this.aliveTime += dt;
        walls = walls || [];
        allMonsters = allMonsters || [];
        arrows = arrows || [];

        // === Boss 冲刺更新 ===
        if (this.isBoss) {
            if (this.dashCooldown > 0) this.dashCooldown -= dt;
            if (this.isDashing) {
                this.dashTimer -= dt;
                this.x += this.dashVx * dt;
                this.y += this.dashVy * dt;
                if (this.dashTimer <= 0) {
                    this.isDashing = false;
                    this.speed = this.baseSpeed;
                }
                // 冲刺期间不执行其他AI逻辑，直接返回边界限制
                this.x = Math.max(this.radius, Math.min(this.x, GAME_WIDTH - this.radius));
                this.y = Math.max(this.radius, Math.min(this.y, GAME_HEIGHT - this.radius));
                return;
            }
        }

        // === 恐慌位移 ===
        if (this.panicTimer > 0) {
            this.panicTimer -= dt;
            this.x += this.panicVx * dt;
            this.y += this.panicVy * dt;
            this.x = Math.max(this.radius, Math.min(this.x, GAME_WIDTH - this.radius));
            this.y = Math.max(this.radius, Math.min(this.y, GAME_HEIGHT - this.radius));
            return; // 恐慌中不执行其他逻辑
        }

        // === 避箭闪避位移 ===
        if (this.dodgeTimer > 0) {
            this.dodgeTimer -= dt;
            this.x += this.dodgeVx * dt;
            this.y += this.dodgeVy * dt;
        }

        // === 避箭检测：检测飞向自己的箭矢 ===
        for (const arrow of arrows) {
            // 计算箭矢到怪物的距离
            const adx = this.x - arrow.x;
            const ady = this.y - arrow.y;
            const dist = Math.hypot(adx, ady);
            if (dist > 150 || dist < 10) continue; // 太远或太近都不管

            // 检测箭矢是否飞向自己（点积判定）
            const dot = adx * arrow.vx + ady * arrow.vy;
            if (dot > 0 && this.dodgeTimer <= 0 && Math.random() < 0.3) {
                // 30% 概率闪避：向箭矢飞行方向的垂直方向移动
                const perpX = -arrow.vy;
                const perpY = arrow.vx;
                const pLen = Math.hypot(perpX, perpY);
                if (pLen > 0) {
                    const dir = Math.random() > 0.5 ? 1 : -1;
                    this.dodgeVx = (perpX / pLen) * this.speed * 2.5 * dir;
                    this.dodgeVy = (perpY / pLen) * this.speed * 2.5 * dir;
                    this.dodgeTimer = 0.25; // 闪避持续 0.25 秒
                }
            }
        }

        // === RAGE 暴怒触发 ===
        if (!this.rageTriggered && this.aliveTime > 15) {
            this.rageTriggered = true;
            this.state = 'rage';
            this.baseSpeed *= 1.5;
            this.speed = this.baseSpeed;
            this.color = this.isBoss ? '#ff4400' : '#ff0000';
            this.radius += 2; // 体积略增
        }

        // === 寻找最近活着的玩家 ===
        let minDist = Infinity;
        let target = null;
        for (const [id, player] of Object.entries(players)) {
            if (player.isDead) continue;
            const dist = Math.hypot(player.x - this.x, player.y - this.y);
            if (dist < minDist) {
                minDist = dist;
                target = player;
            }
        }

        // === 状态机切换 ===
        if (!target || minDist > this.senseRadius) {
            // 无目标或超出感知范围 → IDLE
            if (this.state !== 'rage') this.state = 'idle';
            this.targetId = null;
        } else {
            this.targetId = target.id;
            // 检测直线路径是否被墙体阻挡
            const blocked = raycastWall(this.x, this.y, target.x, target.y, walls);
            if (blocked && this.state !== 'rage') {
                this.state = 'flank';
            } else if (this.state !== 'rage') {
                this.state = 'chase';
            }
        }

        // === 根据状态执行行为 ===
        let moveX = 0;
        let moveY = 0;

        switch (this.state) {
            case 'idle': {
                // 随机游荡
                this.wanderChangeTimer -= dt;
                if (this.wanderChangeTimer <= 0) {
                    this.wanderAngle = Math.random() * Math.PI * 2;
                    this.wanderChangeTimer = 2 + Math.random() * 3;
                }
                moveX = Math.cos(this.wanderAngle) * this.speed * 0.3;
                moveY = Math.sin(this.wanderAngle) * this.speed * 0.3;
                break;
            }
            case 'chase': {
                if (target) {
                    // 预判目标位置（超前 0.5 秒）
                    const predicted = this._predictTarget(target, 0.5);
                    // 群体协作偏移
                    const offset = this._flankOffset(target);
                    const goalX = predicted.x + offset.x;
                    const goalY = predicted.y + offset.y;

                    const dx = goalX - this.x;
                    const dy = goalY - this.y;
                    const len = Math.hypot(dx, dy);
                    if (len > 0) {
                        moveX = (dx / len) * this.speed;
                        moveY = (dy / len) * this.speed;
                    }

                    // === Boss 冲刺判定 ===
                    if (this.isBoss && this.dashCooldown <= 0 && minDist < 300 && minDist > 80) {
                        this.isDashing = true;
                        this.dashTimer = 0.4; // 冲刺持续 0.4 秒
                        this.dashCooldown = 5; // 5 秒冷却
                        const dashSpeed = this.baseSpeed * 5;
                        const dxT = target.x - this.x;
                        const dyT = target.y - this.y;
                        const dLen = Math.hypot(dxT, dyT);
                        if (dLen > 0) {
                            this.dashVx = (dxT / dLen) * dashSpeed;
                            this.dashVy = (dyT / dLen) * dashSpeed;
                        }
                    }
                }
                break;
            }
            case 'flank': {
                if (target) {
                    // 射线投射被阻挡，向侧面移动绕行
                    this.flankTimer -= dt;
                    if (this.flankTimer <= 0) {
                        // 决定绕行方向：计算目标在墙的哪一侧，优先选择更近的侧向
                        const dx = target.x - this.x;
                        const dy = target.y - this.y;
                        const angle = Math.atan2(dy, dx);
                        // 交替选择左右绕行
                        this.flankDir = this.flankDir === 0 ? (Math.random() > 0.5 ? 1 : -1) : -this.flankDir;
                        this.flankTimer = 0.8; // 每 0.8 秒重新判定绕行方向
                    }

                    const dx = target.x - this.x;
                    const dy = target.y - this.y;
                    const angle = Math.atan2(dy, dx);
                    // 侧向偏移 60° 绕行
                    const flankAngle = angle + this.flankDir * (Math.PI / 3);
                    moveX = Math.cos(flankAngle) * this.speed;
                    moveY = Math.sin(flankAngle) * this.speed;
                }
                break;
            }
            case 'rage': {
                if (target) {
                    // 暴怒状态：直线高速追踪，忽视墙壁阻挡（强行追击）
                    const predicted = this._predictTarget(target, 0.3);
                    const offset = this._flankOffset(target);
                    const goalX = predicted.x + offset.x;
                    const goalY = predicted.y + offset.y;

                    const dx = goalX - this.x;
                    const dy = goalY - this.y;
                    const len = Math.hypot(dx, dy);
                    if (len > 0) {
                        moveX = (dx / len) * this.speed;
                        moveY = (dy / len) * this.speed;
                    }

                    // Boss 暴怒冲刺冷却更短
                    if (this.isBoss && this.dashCooldown <= 0 && minDist < 400) {
                        this.isDashing = true;
                        this.dashTimer = 0.5;
                        this.dashCooldown = 3; // 暴怒时 3 秒冷却
                        const dashSpeed = this.baseSpeed * 6;
                        const dxT = target.x - this.x;
                        const dyT = target.y - this.y;
                        const dLen = Math.hypot(dxT, dyT);
                        if (dLen > 0) {
                            this.dashVx = (dxT / dLen) * dashSpeed;
                            this.dashVy = (dyT / dLen) * dashSpeed;
                        }
                    }
                } else {
                    // 暴怒但无目标时快速游荡
                    this.wanderChangeTimer -= dt;
                    if (this.wanderChangeTimer <= 0) {
                        this.wanderAngle = Math.random() * Math.PI * 2;
                        this.wanderChangeTimer = 1;
                    }
                    moveX = Math.cos(this.wanderAngle) * this.speed * 0.6;
                    moveY = Math.sin(this.wanderAngle) * this.speed * 0.6;
                }
                break;
            }
        }

        // 施加移动
        this.x += moveX * dt;
        this.y += moveY * dt;

        // 与墙体碰撞推挤
        for (const wall of walls) {
            resolveCircleRectCollision(this, wall);
        }

        // 边界限制
        this.x = Math.max(this.radius, Math.min(this.x, GAME_WIDTH - this.radius));
        this.y = Math.max(this.radius, Math.min(this.y, GAME_HEIGHT - this.radius));
    }
}

// 射线投射：检测从 (x1,y1) 到 (x2,y2) 的直线是否被任何墙体遮挡
function raycastWall(x1, y1, x2, y2, walls) {
    for (const wall of walls) {
        // 检测线段与 AABB 矩形的相交
        if (lineIntersectsRect(x1, y1, x2, y2, wall.x, wall.y, wall.w, wall.h)) {
            return true;
        }
    }
    return false;
}

// 线段与矩形（AABB）相交检测
function lineIntersectsRect(x1, y1, x2, y2, rx, ry, rw, rh) {
    // 检测线段与矩形四条边的相交
    return lineIntersectsLine(x1, y1, x2, y2, rx, ry, rx + rw, ry) ||          // 上边
        lineIntersectsLine(x1, y1, x2, y2, rx, ry + rh, rx + rw, ry + rh) || // 下边
        lineIntersectsLine(x1, y1, x2, y2, rx, ry, rx, ry + rh) ||           // 左边
        lineIntersectsLine(x1, y1, x2, y2, rx + rw, ry, rx + rw, ry + rh);   // 右边
}

// 两条线段相交检测（基于叉积）
function lineIntersectsLine(x1, y1, x2, y2, x3, y3, x4, y4) {
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-10) return false; // 平行
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// 新增障碍墙体类
class Wall {
    constructor(id, x, y, w, h, isDestructible = false, hp = 0) {
        this.id = id;
        // top-left 原点
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
        this.isDestructible = isDestructible;
        this.hp = hp;
        this.maxHp = hp;
    }
}

// === 新增：传送门 ===
class Portal {
    constructor(id, x, y, targetId, radius = 30) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.targetId = targetId; // 目标传送门的 ID
        this.radius = radius;
    }
}

// === 新增：持续毒雾区域 ===
class PoisonZone {
    constructor(id, x, y, radius = 100, dps = 1) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.radius = radius;
        this.dps = dps; // Damage per second
    }
}

// 场内打靶奖励目标（如：蜜蜂）
class TargetBee {
    constructor(id, x, y) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.radius = 8;
        this.color = 'yellow';
        this.vx = (Math.random() - 0.5) * 100;
        this.vy = (Math.random() - 0.5) * 100;
        this.lifeTime = 15; // 存活 15 秒没被打中则飞走
    }

    updatePosition(dt) {
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.lifeTime -= dt;
        // 碰到边界反弹
        if (this.x < 0 || this.x > GAME_WIDTH) this.vx *= -1;
        if (this.y < 0 || this.y > GAME_HEIGHT) this.vy *= -1;
    }
}

// 掉落的增益Buff球
class BuffDrop {
    constructor(id, x, y, type) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.radius = 10;
        this.type = type; // 'sprint' or 'multishot'
        this.color = type === 'sprint' ? 'cyan' : 'orange';
        this.lifeTime = 10; // 存在时间
    }
}

// “阴险”天赋制造的地雷陷阱
class Trap {
    constructor(id, ownerId, x, y) {
        this.id = id;
        this.ownerId = ownerId;
        this.x = x;
        this.y = y;
        this.radius = 12; // 触发半径
        this.lifeTime = 30; // 陷阱存在30秒
        this.active = false; // 生成后0.5s激活
        setTimeout(() => this.active = true, 500);
    }
}

// 两圆碰撞
function checkCollision(obj1, obj2) {
    const dist = Math.hypot(obj1.x - obj2.x, obj1.y - obj2.y);
    return dist < (obj1.radius + obj2.radius);
}

// 圆与矩形碰撞 (AABB - Circle)
function checkCircleRectCollision(circle, rect) {
    // 寻找矩形上距离圆形最近的点
    let closestX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.w));
    let closestY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.h));

    // 计算这点和圆心距离
    let distanceX = circle.x - closestX;
    let distanceY = circle.y - closestY;

    return (distanceX * distanceX + distanceY * distanceY) < (circle.radius * circle.radius);
}

// 处理圆与矩形的推挤并修正位置
function resolveCircleRectCollision(circle, rect) {
    let closestX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.w));
    let closestY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.h));

    let distanceX = circle.x - closestX;
    let distanceY = circle.y - closestY;
    let distanceSq = distanceX * distanceX + distanceY * distanceY;

    if (distanceSq < circle.radius * circle.radius) {
        let distance = Math.sqrt(distanceSq);
        // 若圆心就在矩形内部，防止除 0 以及赋予惩罚弹力
        if (distance === 0) {
            circle.x -= circle.radius;
            return;
        }
        let overlap = circle.radius - distance;
        circle.x += (distanceX / distance) * overlap;
        circle.y += (distanceY / distance) * overlap;
    }
}

const WEAPONS = {
    'bow': {
        name: '普通长弓',
        maxChargeMs: 1000,
        amount: 1,
        spreadAngle: 0,
        speedBase: 250,
        speedMultiplier: 500,
        lifeBase: 0.5,
        lifeMultiplier: 1.6,
        damageBase: 1,
        damageMultiplier: 2, // max 3
        pierce: 1,
        inaccuracyBase: Math.PI / 12,
        movingInaccuracy: Math.PI / 18
    },
    'shortbow': {
        name: '速射短弓',
        maxChargeMs: 400,
        amount: 1,
        spreadAngle: 0,
        speedBase: 420,
        speedMultiplier: 360,
        lifeBase: 0.32,
        lifeMultiplier: 0.52,
        damageBase: 1,
        damageMultiplier: 1, // max 2
        pierce: 1,
        inaccuracyBase: Math.PI / 10,
        movingInaccuracy: Math.PI / 18
    },
    'crossbow': {
        name: '穿透十字弩',
        maxChargeMs: 1500,
        amount: 1,
        spreadAngle: 0,
        speedBase: 460,
        speedMultiplier: 920,
        lifeBase: 0.9,
        lifeMultiplier: 1.7,
        damageBase: 2,
        damageMultiplier: 3, // max 5
        pierce: 3, // 可以穿透3个目标
        inaccuracyBase: Math.PI / 18,
        movingInaccuracy: Math.PI / 12 // 移动时惩罚大
    },
    'dart': {
        name: '散射飞镖',
        maxChargeMs: 0, // 无蓄力，点击即射
        amount: 3,
        spreadAngle: Math.PI / 8,
        speedBase: 550,
        speedMultiplier: 0,
        lifeBase: 0.45,
        lifeMultiplier: 0,
        damageBase: 1,
        damageMultiplier: 0, // 固定1血
        pierce: 1,
        inaccuracyBase: 0,
        movingInaccuracy: 0
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        Player, Arrow, Monster, Wall, TargetBee, BuffDrop, Trap, Portal, PoisonZone,
        checkCollision, checkCircleRectCollision, resolveCircleRectCollision, raycastWall, WEAPONS
    };
} else {
    // Browser environment
    window.Player = Player;
    window.Arrow = Arrow;
    window.Monster = Monster;
    window.Portal = Portal;
    window.PoisonZone = PoisonZone;
    window.WEAPONS = WEAPONS;
    // Expose other utilities if needed
}
