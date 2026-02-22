// mapLoader.js — 地图加载/保存模块
const fs = require('fs');
const path = require('path');
const { Wall, Portal, PoisonZone } = require('./gameLogic');

const MAPS_DIR = path.join(__dirname, 'maps');

/**
 * 加载指定地图，返回 Wall 实例数组
 * @param {string} mapId - 地图标识（如 'standard'）
 * @returns {object} 地图数据
 */
function loadMap(mapId) {
    const filePath = path.join(MAPS_DIR, `${mapId}.json`);
    if (!fs.existsSync(filePath)) {
        console.warn(`地图文件不存在: ${filePath}, 使用空地图`);
        return { walls: [], portals: [], poisonZones: [] };
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        return {
            walls: (data.walls || []).map(w => new Wall(w.id, w.x, w.y, w.w, w.h, w.isDestructible, w.hp)),
            portals: (data.portals || []).map(p => new Portal(p.id, p.x, p.y, p.targetId, p.radius)),
            poisonZones: (data.poisonZones || []).map(pz => new PoisonZone(pz.id, pz.x, pz.y, pz.radius, pz.dps))
        };
    } catch (err) {
        console.error(`加载地图失败 [${mapId}]:`, err.message);
        return { walls: [], portals: [], poisonZones: [] };
    }
}

/**
 * 获取地图的原始 JSON 数据
 * @param {string} mapId
 * @returns {object|null}
 */
function getMap(mapId) {
    const filePath = path.join(MAPS_DIR, `${mapId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
        console.error(`读取地图失败 [${mapId}]:`, err.message);
        return null;
    }
}

/**
 * 保存地图数据到 JSON 文件
 * @param {object} mapData - 包含 id, name, width, height, walls, spawnZones 的地图对象
 * @returns {boolean} 是否成功
 */
function saveMap(mapData) {
    if (!mapData || !mapData.id) {
        console.error('保存地图失败: 缺少 id 字段');
        return false;
    }

    // 基本校验
    const sanitized = {
        name: mapData.name || mapData.id,
        id: mapData.id,
        width: mapData.width || 2000,
        height: mapData.height || 1200,
        walls: (mapData.walls || []).map(w => ({
            id: w.id,
            x: Math.round(w.x),
            y: Math.round(w.y),
            w: Math.max(10, Math.round(w.w)),
            h: Math.max(10, Math.round(w.h)),
            isDestructible: !!w.isDestructible,
            hp: w.hp || 0
        })),
        portals: (mapData.portals || []).map(p => ({
            id: p.id,
            x: Math.round(p.x),
            y: Math.round(p.y),
            targetId: p.targetId,
            radius: p.radius || 30
        })),
        poisonZones: (mapData.poisonZones || []).map(pz => ({
            id: pz.id,
            x: Math.round(pz.x),
            y: Math.round(pz.y),
            radius: pz.radius || 100,
            dps: pz.dps || 1
        })),
        spawnZones: mapData.spawnZones || []
    };

    const filePath = path.join(MAPS_DIR, `${sanitized.id}.json`);
    try {
        // 确保 maps 目录存在
        if (!fs.existsSync(MAPS_DIR)) {
            fs.mkdirSync(MAPS_DIR, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(sanitized, null, 2), 'utf-8');
        console.log(`地图已保存: ${sanitized.name} -> ${filePath}`);
        return true;
    } catch (err) {
        console.error(`保存地图失败 [${sanitized.id}]:`, err.message);
        return false;
    }
}

/**
 * 列出所有可用地图
 * @returns {Array<{id: string, name: string}>}
 */
function listMaps() {
    if (!fs.existsSync(MAPS_DIR)) return [];
    try {
        const files = fs.readdirSync(MAPS_DIR).filter(f => f.endsWith('.json'));
        return files.map(f => {
            const id = f.replace('.json', '');
            try {
                const data = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf-8'));
                return { id, name: data.name || id };
            } catch {
                return { id, name: id };
            }
        });
    } catch (err) {
        console.error('列出地图失败:', err.message);
        return [];
    }
}

module.exports = { loadMap, getMap, saveMap, listMaps };
