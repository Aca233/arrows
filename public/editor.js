// editor.js — 地图编辑器核心逻辑

(function () {
    'use strict';

    // === DOM 元素引用 ===
    const canvas = document.getElementById('editorCanvas');
    const ctx = canvas.getContext('2d');
    const container = document.getElementById('canvas-container');

    // 工具栏
    const toolBtns = document.querySelectorAll('.tool-btn');
    const gridSnapCheckbox = document.getElementById('grid-snap');
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    const btnSave = document.getElementById('btn-save');
    const btnExport = document.getElementById('btn-export');
    const btnImport = document.getElementById('btn-import');
    const fileImport = document.getElementById('file-import');

    // 侧边面板
    const mapListEl = document.getElementById('map-list');
    const newMapIdInput = document.getElementById('new-map-id');
    const btnNewMap = document.getElementById('btn-new-map');
    const mapNameInput = document.getElementById('map-name');
    const mapWidthInput = document.getElementById('map-width');
    const mapHeightInput = document.getElementById('map-height');

    // 墙体属性
    const wallPropsPanel = document.getElementById('wall-props');
    const wallXInput = document.getElementById('wall-x');
    const wallYInput = document.getElementById('wall-y');
    const wallWInput = document.getElementById('wall-w');
    const wallHInput = document.getElementById('wall-h');
    const btnDeleteWall = document.getElementById('btn-delete-wall');

    // 传送门属性
    const portalListEl = document.getElementById('portal-list');
    const portalIdInput = document.getElementById('portal-id');
    const portalXInput = document.getElementById('portal-x');
    const portalYInput = document.getElementById('portal-y');
    const portalRadiusInput = document.getElementById('portal-radius');
    const portalTargetInput = document.getElementById('portal-target');
    const btnUpsertPortal = document.getElementById('btn-upsert-portal');
    const btnDeletePortal = document.getElementById('btn-delete-portal');
    const btnQuickAddPortal = document.getElementById('btn-quick-add-portal');

    // 毒区属性
    const poisonListEl = document.getElementById('poison-list');
    const poisonIdInput = document.getElementById('poison-id');
    const poisonXInput = document.getElementById('poison-x');
    const poisonYInput = document.getElementById('poison-y');
    const poisonRadiusInput = document.getElementById('poison-radius');
    const poisonDpsInput = document.getElementById('poison-dps');
    const btnUpsertPoison = document.getElementById('btn-upsert-poison');
    const btnDeletePoison = document.getElementById('btn-delete-poison');
    const btnQuickAddPoison = document.getElementById('btn-quick-add-poison');

    // 状态栏
    const statusCoords = document.getElementById('status-coords');
    const statusTool = document.getElementById('status-tool');
    const statusMsg = document.getElementById('status-msg');
    const statWalls = document.getElementById('stat-walls');
    const statPortals = document.getElementById('stat-portals');
    const statPoisonZones = document.getElementById('stat-poison-zones');
    const statZoom = document.getElementById('stat-zoom');

    // === 编辑器状态 ===
    const editor = {
        // 当前地图数据
        mapId: null,
        mapName: '未命名',
        mapWidth: 2000,
        mapHeight: 1200,
        walls: [],
        portals: [],
        poisonZones: [],
        spawnZones: [],

        // 交互状态
        tool: 'place',          // 'place' | 'select' | 'delete'
        selectedWallIdx: -1,    // 当前选中的墙体索引
        selectedPortalId: '',
        selectedPoisonId: '',
        gridSize: 20,           // 网格吸附尺寸
        snapEnabled: true,
        quickPlaceMode: '',     // '' | 'portal' | 'poison'
        pendingPortalId: '',    // 快速放置传送门时，记录待配对的前一个门

        // 视口（平移和缩放）
        viewX: 0,
        viewY: 0,
        zoom: 0.5,

        // 拖拽状态
        isDragging: false,
        dragType: '',           // 'place' | 'move' | 'resize' | 'pan'
        dragStartX: 0,
        dragStartY: 0,
        dragOffsetX: 0,
        dragOffsetY: 0,
        resizeHandle: '',       // 'nw' | 'ne' | 'sw' | 'se'
        placeStartX: 0,
        placeStartY: 0,

        // 操作历史
        history: [],
        historyIndex: -1,
        maxHistory: 50,

        // 墙体 ID 计数器
        wallIdCounter: 0
    };

    // === 初始化 ===
    function init() {
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        // 工具切换
        toolBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                editor.tool = btn.dataset.tool;
                toolBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                editor.selectedWallIdx = -1;
                updateWallProps();
                updateStatusTool();
            });
        });

        // 网格吸附
        gridSnapCheckbox.addEventListener('change', () => {
            editor.snapEnabled = gridSnapCheckbox.checked;
        });

        // 按钮事件
        btnUndo.addEventListener('click', undo);
        btnRedo.addEventListener('click', redo);
        btnSave.addEventListener('click', saveToServer);
        btnExport.addEventListener('click', exportJSON);
        btnImport.addEventListener('click', () => fileImport.click());
        fileImport.addEventListener('change', importJSON);
        btnNewMap.addEventListener('click', createNewMap);
        btnDeleteWall.addEventListener('click', deleteSelectedWall);
        btnUpsertPortal.addEventListener('click', upsertPortal);
        btnDeletePortal.addEventListener('click', deleteSelectedPortal);
        btnUpsertPoison.addEventListener('click', upsertPoisonZone);
        btnDeletePoison.addEventListener('click', deleteSelectedPoisonZone);
        btnQuickAddPortal.addEventListener('click', () => {
            const enabling = editor.quickPlaceMode !== 'portal';
            editor.quickPlaceMode = enabling ? 'portal' : '';
            editor.pendingPortalId = enabling ? findUnlinkedPortalId() : '';
            syncQuickPlaceButtons();
            if (!enabling) {
                showStatus('已关闭快速放置');
            } else if (editor.pendingPortalId) {
                showStatus(`快速放置传送门：下一次点击会自动与 ${editor.pendingPortalId} 配对`);
            } else {
                showStatus('快速放置传送门：连续点击两次自动成对互联');
            }
        });
        btnQuickAddPoison.addEventListener('click', () => {
            const enabling = editor.quickPlaceMode !== 'poison';
            editor.quickPlaceMode = enabling ? 'poison' : '';
            editor.pendingPortalId = '';
            syncQuickPlaceButtons();
            showStatus(enabling ? '快速放置毒区：点击画布即可放置' : '已关闭快速放置');
        });

        // 墙体属性输入
        [wallXInput, wallYInput, wallWInput, wallHInput].forEach(input => {
            input.addEventListener('change', applyWallProps);
        });

        // 地图属性输入
        mapNameInput.addEventListener('change', () => {
            editor.mapName = mapNameInput.value;
        });
        mapWidthInput.addEventListener('change', () => {
            editor.mapWidth = parseInt(mapWidthInput.value) || 2000;
            render();
        });
        mapHeightInput.addEventListener('change', () => {
            editor.mapHeight = parseInt(mapHeightInput.value) || 1200;
            render();
        });

        // Canvas 鼠标事件
        canvas.addEventListener('mousedown', onMouseDown);
        canvas.addEventListener('mousemove', onMouseMove);
        canvas.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });

        // 键盘快捷键
        window.addEventListener('keydown', onKeyDown);

        // 加载地图列表
        loadMapList();

        // 初始视口居中
        centerView();
        updatePortalPanel();
        updatePoisonPanel();
        updateStats();
        updateStatusTool();
        syncQuickPlaceButtons();
        render();
    }

    // === Canvas 尺寸管理 ===
    function resizeCanvas() {
        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        render();
    }

    // === 坐标转换 ===
    function screenToWorld(sx, sy) {
        const dpr = window.devicePixelRatio || 1;
        return {
            x: (sx * dpr - editor.viewX) / editor.zoom,
            y: (sy * dpr - editor.viewY) / editor.zoom
        };
    }

    function worldToScreen(wx, wy) {
        const dpr = window.devicePixelRatio || 1;
        return {
            x: (wx * editor.zoom + editor.viewX) / dpr,
            y: (wy * editor.zoom + editor.viewY) / dpr
        };
    }

    function snapToGrid(val) {
        if (!editor.snapEnabled) return val;
        return Math.round(val / editor.gridSize) * editor.gridSize;
    }

    // === 视口居中 ===
    function centerView() {
        const dpr = window.devicePixelRatio || 1;
        const cw = canvas.width;
        const ch = canvas.height;
        // 计算适合画布的缩放
        const scaleX = (cw * 0.85) / editor.mapWidth;
        const scaleY = (ch * 0.85) / editor.mapHeight;
        editor.zoom = Math.min(scaleX, scaleY);
        // 居中
        editor.viewX = (cw - editor.mapWidth * editor.zoom) / 2;
        editor.viewY = (ch - editor.mapHeight * editor.zoom) / 2;
        updateZoomStat();
    }

    // === 鼠标事件 ===
    function onMouseDown(e) {
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const world = screenToWorld(sx, sy);

        // 中键或 Space+左键 拖拽画布
        if (e.button === 1) {
            e.preventDefault();
            editor.isDragging = true;
            editor.dragType = 'pan';
            editor.dragStartX = sx;
            editor.dragStartY = sy;
            editor.dragOffsetX = editor.viewX;
            editor.dragOffsetY = editor.viewY;
            canvas.style.cursor = 'grabbing';
            return;
        }

        if (e.button !== 0) return;

        const wx = world.x;
        const wy = world.y;

        if (editor.quickPlaceMode === 'portal') {
            quickPlacePortal(wx, wy);
            return;
        }

        if (editor.quickPlaceMode === 'poison') {
            quickPlacePoisonZone(wx, wy);
            return;
        }

        if (editor.tool === 'place') {
            // 开始放置新墙体
            const snappedX = snapToGrid(wx);
            const snappedY = snapToGrid(wy);
            editor.isDragging = true;
            editor.dragType = 'place';
            editor.placeStartX = snappedX;
            editor.placeStartY = snappedY;

        } else if (editor.tool === 'select') {
            // 画布选择优先针对墙体，清除侧栏实体选择
            editor.selectedPortalId = '';
            editor.selectedPoisonId = '';
            updatePortalPanel();
            updatePoisonPanel();

            // 尝试选中墙体
            const hitIdx = hitTestWall(wx, wy);
            const handleInfo = editor.selectedWallIdx >= 0 ? hitTestHandle(wx, wy, editor.walls[editor.selectedWallIdx]) : null;

            if (handleInfo) {
                // 拖拽调整大小
                editor.isDragging = true;
                editor.dragType = 'resize';
                editor.resizeHandle = handleInfo;
                editor.dragStartX = wx;
                editor.dragStartY = wy;
                const w = editor.walls[editor.selectedWallIdx];
                editor.dragOffsetX = w.x;
                editor.dragOffsetY = w.y;
                editor.dragOrigW = w.w;
                editor.dragOrigH = w.h;
            } else if (hitIdx >= 0) {
                editor.selectedWallIdx = hitIdx;
                updateWallProps();
                // 开始拖拽移动
                editor.isDragging = true;
                editor.dragType = 'move';
                editor.dragStartX = wx;
                editor.dragStartY = wy;
                const w = editor.walls[hitIdx];
                editor.dragOffsetX = w.x;
                editor.dragOffsetY = w.y;
            } else {
                editor.selectedWallIdx = -1;
                updateWallProps();
            }
            render();

        } else if (editor.tool === 'delete') {
            // 点击删除
            const hitIdx = hitTestWall(wx, wy);
            if (hitIdx >= 0) {
                pushHistory();
                editor.walls.splice(hitIdx, 1);
                if (editor.selectedWallIdx === hitIdx) {
                    editor.selectedWallIdx = -1;
                    updateWallProps();
                }
                updateStats();
                render();
                showStatus('墙体已删除');
            }
        }
    }

    function onMouseMove(e) {
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const world = screenToWorld(sx, sy);

        // 更新状态栏坐标
        statusCoords.textContent = `X: ${Math.round(world.x)}, Y: ${Math.round(world.y)}`;

        if (!editor.isDragging) {
            // 更新光标样式
            if (editor.tool === 'select') {
                if (editor.selectedWallIdx >= 0 && hitTestHandle(world.x, world.y, editor.walls[editor.selectedWallIdx])) {
                    canvas.style.cursor = 'nwse-resize';
                } else if (hitTestWall(world.x, world.y) >= 0) {
                    canvas.style.cursor = 'move';
                } else {
                    canvas.style.cursor = 'default';
                }
            } else if (editor.tool === 'place') {
                canvas.style.cursor = 'crosshair';
            } else if (editor.tool === 'delete') {
                canvas.style.cursor = 'pointer';
            }
            return;
        }

        const dpr = window.devicePixelRatio || 1;

        if (editor.dragType === 'pan') {
            editor.viewX = editor.dragOffsetX + (sx - editor.dragStartX) * dpr;
            editor.viewY = editor.dragOffsetY + (sy - editor.dragStartY) * dpr;
            render();
            return;
        }

        if (editor.dragType === 'place') {
            // 实时预览放置中的墙体
            render();
            const snappedX = snapToGrid(world.x);
            const snappedY = snapToGrid(world.y);
            const x = Math.min(editor.placeStartX, snappedX);
            const y = Math.min(editor.placeStartY, snappedY);
            const w = Math.abs(snappedX - editor.placeStartX);
            const h = Math.abs(snappedY - editor.placeStartY);
            if (w > 2 || h > 2) {
                drawWallPreview(x, y, w, h);
            }
            return;
        }

        if (editor.dragType === 'move') {
            const dx = world.x - editor.dragStartX;
            const dy = world.y - editor.dragStartY;
            const wall = editor.walls[editor.selectedWallIdx];
            wall.x = snapToGrid(editor.dragOffsetX + dx);
            wall.y = snapToGrid(editor.dragOffsetY + dy);
            updateWallProps();
            render();
            return;
        }

        if (editor.dragType === 'resize') {
            const wall = editor.walls[editor.selectedWallIdx];
            const dx = world.x - editor.dragStartX;
            const dy = world.y - editor.dragStartY;
            const h = editor.resizeHandle;

            let newX = editor.dragOffsetX;
            let newY = editor.dragOffsetY;
            let newW = editor.dragOrigW;
            let newH = editor.dragOrigH;

            if (h.includes('e')) newW = snapToGrid(Math.max(10, editor.dragOrigW + dx));
            if (h.includes('w')) {
                newW = snapToGrid(Math.max(10, editor.dragOrigW - dx));
                newX = snapToGrid(editor.dragOffsetX + dx);
            }
            if (h.includes('s')) newH = snapToGrid(Math.max(10, editor.dragOrigH + dy));
            if (h.includes('n')) {
                newH = snapToGrid(Math.max(10, editor.dragOrigH - dy));
                newY = snapToGrid(editor.dragOffsetY + dy);
            }

            wall.x = newX;
            wall.y = newY;
            wall.w = newW;
            wall.h = newH;
            updateWallProps();
            render();
        }
    }

    function onMouseUp(e) {
        if (!editor.isDragging) return;

        if (editor.dragType === 'place') {
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const world = screenToWorld(sx, sy);
            const snappedX = snapToGrid(world.x);
            const snappedY = snapToGrid(world.y);

            const x = Math.min(editor.placeStartX, snappedX);
            const y = Math.min(editor.placeStartY, snappedY);
            const w = Math.abs(snappedX - editor.placeStartX);
            const h = Math.abs(snappedY - editor.placeStartY);

            if (w >= 10 && h >= 10) {
                pushHistory();
                editor.wallIdCounter++;
                editor.walls.push({
                    id: `w${editor.wallIdCounter}`,
                    x: x, y: y, w: w, h: h
                });
                updateStats();
                showStatus(`墙体已放置: ${w}×${h}`);
            }
        } else if (editor.dragType === 'move' || editor.dragType === 'resize') {
            pushHistory();
        }

        editor.isDragging = false;
        editor.dragType = '';
        canvas.style.cursor = editor.tool === 'place' ? 'crosshair' : 'default';
        render();
    }

    function onWheel(e) {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const mouseX = (e.clientX - rect.left) * dpr;
        const mouseY = (e.clientY - rect.top) * dpr;

        const oldZoom = editor.zoom;
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        editor.zoom = Math.max(0.1, Math.min(5, editor.zoom * zoomFactor));

        // 缩放以鼠标为中心
        editor.viewX = mouseX - (mouseX - editor.viewX) * (editor.zoom / oldZoom);
        editor.viewY = mouseY - (mouseY - editor.viewY) * (editor.zoom / oldZoom);

        updateZoomStat();
        render();
    }

    // === 键盘快捷键 ===
    function onKeyDown(e) {
        // 不在输入框中时才响应
        if (e.target.tagName === 'INPUT') return;

        if (e.ctrlKey && e.key === 'z') {
            e.preventDefault();
            undo();
        } else if (e.ctrlKey && e.key === 'y') {
            e.preventDefault();
            redo();
        } else if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            saveToServer();
        } else if (e.key === 'p' || e.key === 'P') {
            setTool('place');
        } else if (e.key === 'v' || e.key === 'V') {
            setTool('select');
        } else if (e.key === 'x' || e.key === 'X') {
            setTool('delete');
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            if (editor.selectedWallIdx >= 0) {
                deleteSelectedWall();
            } else if (editor.selectedPortalId) {
                deleteSelectedPortal();
            } else if (editor.selectedPoisonId) {
                deleteSelectedPoisonZone();
            }
        } else if (e.key === 'Escape') {
            editor.selectedWallIdx = -1;
            editor.selectedPortalId = '';
            editor.selectedPoisonId = '';
            editor.pendingPortalId = '';
            updateWallProps();
            updatePortalPanel();
            updatePoisonPanel();
            syncQuickPlaceButtons();
            render();
        }
    }

    function setTool(tool) {
        editor.tool = tool;
        toolBtns.forEach(b => {
            b.classList.toggle('active', b.dataset.tool === tool);
        });
        editor.selectedWallIdx = -1;
        updateWallProps();
        updateStatusTool();
    }

    function syncQuickPlaceButtons() {
        if (btnQuickAddPortal) {
            btnQuickAddPortal.classList.toggle('primary', editor.quickPlaceMode === 'portal');
        }
        if (btnQuickAddPoison) {
            btnQuickAddPoison.classList.toggle('primary', editor.quickPlaceMode === 'poison');
        }
    }

    function findUnlinkedPortalId(excludeId = '') {
        for (const p of editor.portals) {
            if (excludeId && p.id === excludeId) continue;
            const target = editor.portals.find(tp => tp.id === p.targetId);
            if (!p.targetId || !target) return p.id;
        }
        return '';
    }

    function quickPlacePortal(wx, wy) {
        pushHistory();

        // 先决定“锚点门”（已有未配对门），再创建新门并自动互联
        const anchorId = editor.pendingPortalId || findUnlinkedPortalId();

        const id = normalizeEntityId('', 'p', editor.portals);
        const portal = {
            id,
            x: snapToGrid(wx),
            y: snapToGrid(wy),
            radius: Math.max(10, parseInt(portalRadiusInput.value) || 40),
            targetId: ''
        };
        editor.portals.push(portal);

        const anchor = anchorId ? editor.portals.find(p => p.id === anchorId) : null;
        if (anchor && anchor.id !== id) {
            anchor.targetId = id;
            portal.targetId = anchor.id;
            editor.pendingPortalId = '';
            showStatus(`快速放置传送门对: ${anchor.id} ⇄ ${id}`);
        } else {
            editor.pendingPortalId = id;
            showStatus(`快速放置传送门: ${id}（再点一次自动配对）`);
        }

        editor.selectedPortalId = id;
        editor.selectedPoisonId = '';
        editor.selectedWallIdx = -1;
        updateWallProps();
        updatePortalPanel();
        updatePoisonPanel();
        updateStats();
        render();
    }

    function quickPlacePoisonZone(wx, wy) {
        pushHistory();
        const id = normalizeEntityId('', 'pz', editor.poisonZones);
        const zone = {
            id,
            x: snapToGrid(wx),
            y: snapToGrid(wy),
            radius: Math.max(20, parseInt(poisonRadiusInput.value) || 120),
            dps: Math.max(1, parseInt(poisonDpsInput.value) || 1)
        };
        editor.poisonZones.push(zone);
        editor.selectedPoisonId = id;
        editor.selectedPortalId = '';
        editor.selectedWallIdx = -1;
        updateWallProps();
        updatePoisonPanel();
        updatePortalPanel();
        updateStats();
        render();
        showStatus(`快速放置毒区: ${id}`);
    }

    function normalizeEntityId(raw, fallbackPrefix, arr) {
        let id = (raw || '').trim();
        if (!id) {
            let next = 1;
            while (arr.some(item => item.id === `${fallbackPrefix}${next}`)) next++;
            id = `${fallbackPrefix}${next}`;
        }
        return id;
    }

    function renderEntityList(listEl, arr, selectedId, labelFn, onClick) {
        listEl.innerHTML = '';
        arr.forEach(item => {
            const div = document.createElement('div');
            div.className = 'entity-item' + (item.id === selectedId ? ' active' : '');
            div.innerHTML = `<span>${labelFn(item)}</span><span class="entity-meta">${item.id}</span>`;
            div.addEventListener('click', () => onClick(item.id));
            listEl.appendChild(div);
        });
    }

    function updatePortalPanel() {
        renderEntityList(
            portalListEl,
            editor.portals,
            editor.selectedPortalId,
            p => `(${Math.round(p.x)}, ${Math.round(p.y)}) r=${Math.round(p.radius || 30)} → ${p.targetId || '?'}`,
            selectPortal
        );

        const p = editor.portals.find(item => item.id === editor.selectedPortalId);
        if (p) {
            portalIdInput.value = p.id || '';
            portalXInput.value = Math.round(p.x || 0);
            portalYInput.value = Math.round(p.y || 0);
            portalRadiusInput.value = Math.max(10, Math.round(p.radius || 30));
            portalTargetInput.value = p.targetId || '';
        } else {
            portalIdInput.value = '';
            portalXInput.value = '';
            portalYInput.value = '';
            portalRadiusInput.value = 40;
            portalTargetInput.value = '';
        }
    }

    function updatePoisonPanel() {
        renderEntityList(
            poisonListEl,
            editor.poisonZones,
            editor.selectedPoisonId,
            z => `(${Math.round(z.x)}, ${Math.round(z.y)}) r=${Math.round(z.radius || 100)} dps=${z.dps || 1}`,
            selectPoisonZone
        );

        const z = editor.poisonZones.find(item => item.id === editor.selectedPoisonId);
        if (z) {
            poisonIdInput.value = z.id || '';
            poisonXInput.value = Math.round(z.x || 0);
            poisonYInput.value = Math.round(z.y || 0);
            poisonRadiusInput.value = Math.max(20, Math.round(z.radius || 100));
            poisonDpsInput.value = Math.max(1, Math.round(z.dps || 1));
        } else {
            poisonIdInput.value = '';
            poisonXInput.value = '';
            poisonYInput.value = '';
            poisonRadiusInput.value = 120;
            poisonDpsInput.value = 1;
        }
    }

    function selectPortal(id) {
        editor.selectedPortalId = id;
        editor.selectedPoisonId = '';
        editor.selectedWallIdx = -1;
        updateWallProps();
        updatePortalPanel();
        updatePoisonPanel();
    }

    function selectPoisonZone(id) {
        editor.selectedPoisonId = id;
        editor.selectedPortalId = '';
        editor.selectedWallIdx = -1;
        updateWallProps();
        updatePortalPanel();
        updatePoisonPanel();
    }

    function upsertPortal() {
        const x = parseInt(portalXInput.value);
        const y = parseInt(portalYInput.value);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            showStatus('传送门坐标无效');
            return;
        }

        const id = normalizeEntityId(portalIdInput.value, 'p', editor.portals);
        const radius = Math.max(10, parseInt(portalRadiusInput.value) || 40);
        const targetId = (portalTargetInput.value || '').trim();

        pushHistory();
        const idx = editor.portals.findIndex(p => p.id === id);
        const item = { id, x: snapToGrid(x), y: snapToGrid(y), radius, targetId };
        if (idx >= 0) editor.portals[idx] = item;
        else editor.portals.push(item);

        editor.selectedPortalId = id;
        editor.selectedPoisonId = '';
        updatePortalPanel();
        updatePoisonPanel();
        updateStats();
        render();
        showStatus(`传送门已保存: ${id}`);
    }

    function deleteSelectedPortal() {
        if (!editor.selectedPortalId) return;
        pushHistory();
        const deletingId = editor.selectedPortalId;
        editor.portals = editor.portals.filter(p => p.id !== deletingId);
        editor.portals.forEach(p => {
            if (p.targetId === deletingId) p.targetId = '';
        });
        if (editor.pendingPortalId === deletingId) {
            editor.pendingPortalId = '';
        }
        editor.selectedPortalId = '';
        updatePortalPanel();
        updateStats();
        render();
        showStatus('传送门已删除');
    }

    function upsertPoisonZone() {
        const x = parseInt(poisonXInput.value);
        const y = parseInt(poisonYInput.value);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            showStatus('毒区坐标无效');
            return;
        }

        const id = normalizeEntityId(poisonIdInput.value, 'pz', editor.poisonZones);
        const radius = Math.max(20, parseInt(poisonRadiusInput.value) || 120);
        const dps = Math.max(1, parseInt(poisonDpsInput.value) || 1);

        pushHistory();
        const idx = editor.poisonZones.findIndex(z => z.id === id);
        const item = { id, x: snapToGrid(x), y: snapToGrid(y), radius, dps };
        if (idx >= 0) editor.poisonZones[idx] = item;
        else editor.poisonZones.push(item);

        editor.selectedPoisonId = id;
        editor.selectedPortalId = '';
        updatePoisonPanel();
        updatePortalPanel();
        updateStats();
        render();
        showStatus(`毒区已保存: ${id}`);
    }

    function deleteSelectedPoisonZone() {
        if (!editor.selectedPoisonId) return;
        pushHistory();
        editor.poisonZones = editor.poisonZones.filter(z => z.id !== editor.selectedPoisonId);
        editor.selectedPoisonId = '';
        updatePoisonPanel();
        updateStats();
        render();
        showStatus('毒区已删除');
    }

    // === 碰撞检测 ===
    function hitTestWall(wx, wy) {
        // 从后往前检测（后绘制的在上层）
        for (let i = editor.walls.length - 1; i >= 0; i--) {
            const w = editor.walls[i];
            if (wx >= w.x && wx <= w.x + w.w && wy >= w.y && wy <= w.y + w.h) {
                return i;
            }
        }
        return -1;
    }

    function hitTestHandle(wx, wy, wall) {
        if (!wall) return null;
        const handleSize = 8 / editor.zoom; // 屏幕空间固定大小
        const handles = {
            nw: { x: wall.x, y: wall.y },
            ne: { x: wall.x + wall.w, y: wall.y },
            sw: { x: wall.x, y: wall.y + wall.h },
            se: { x: wall.x + wall.w, y: wall.y + wall.h }
        };

        for (const [key, pos] of Object.entries(handles)) {
            if (Math.abs(wx - pos.x) < handleSize && Math.abs(wy - pos.y) < handleSize) {
                return key;
            }
        }
        return null;
    }

    // === 操作历史 ===
    function pushHistory() {
        // 截断未来的历史
        editor.history = editor.history.slice(0, editor.historyIndex + 1);
        // 深拷贝当前墙体状态
        editor.history.push({
            walls: JSON.parse(JSON.stringify(editor.walls)),
            portals: JSON.parse(JSON.stringify(editor.portals)),
            poisonZones: JSON.parse(JSON.stringify(editor.poisonZones))
        });
        if (editor.history.length > editor.maxHistory) {
            editor.history.shift();
        }
        editor.historyIndex = editor.history.length - 1;
    }

    function restoreHistory(index) {
        const state = editor.history[index];
        if (!state) return;

        if (Array.isArray(state)) {
            // 兼容旧历史格式（仅 walls）
            editor.walls = JSON.parse(JSON.stringify(state));
            editor.portals = [];
            editor.poisonZones = [];
        } else {
            editor.walls = JSON.parse(JSON.stringify(state.walls || []));
            editor.portals = JSON.parse(JSON.stringify(state.portals || []));
            editor.poisonZones = JSON.parse(JSON.stringify(state.poisonZones || []));
        }

        editor.selectedWallIdx = -1;
        editor.selectedPortalId = '';
        editor.selectedPoisonId = '';
        editor.pendingPortalId = '';
        updateWallProps();
        updatePortalPanel();
        updatePoisonPanel();
        updateStats();
        render();
    }

    function undo() {
        if (editor.historyIndex <= 0) return;
        editor.historyIndex--;
        restoreHistory(editor.historyIndex);
        showStatus('已撤销');
    }

    function redo() {
        if (editor.historyIndex >= editor.history.length - 1) return;
        editor.historyIndex++;
        restoreHistory(editor.historyIndex);
        showStatus('已重做');
    }

    // === 渲染 ===
    function render() {
        const dpr = window.devicePixelRatio || 1;
        const cw = canvas.width;
        const ch = canvas.height;

        ctx.save();
        ctx.clearRect(0, 0, cw, ch);

        // 背景
        ctx.fillStyle = '#080c14';
        ctx.fillRect(0, 0, cw, ch);

        // 应用视口变换
        ctx.save();
        ctx.translate(editor.viewX, editor.viewY);
        ctx.scale(editor.zoom, editor.zoom);

        // 绘制地图背景
        const bgGrad = ctx.createRadialGradient(
            editor.mapWidth / 2, editor.mapHeight / 2, 0,
            editor.mapWidth / 2, editor.mapHeight / 2,
            Math.max(editor.mapWidth, editor.mapHeight) * 0.8
        );
        bgGrad.addColorStop(0, '#10141f');
        bgGrad.addColorStop(1, '#020305');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, editor.mapWidth, editor.mapHeight);

        // 绘制网格
        ctx.strokeStyle = 'rgba(0, 255, 255, 0.05)';
        ctx.lineWidth = 1 / editor.zoom;
        ctx.beginPath();
        for (let x = 0; x <= editor.mapWidth; x += editor.gridSize) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, editor.mapHeight);
        }
        for (let y = 0; y <= editor.mapHeight; y += editor.gridSize) {
            ctx.moveTo(0, y);
            ctx.lineTo(editor.mapWidth, y);
        }
        ctx.stroke();

        // 大网格（100px）
        ctx.strokeStyle = 'rgba(0, 255, 255, 0.12)';
        ctx.lineWidth = 1 / editor.zoom;
        ctx.beginPath();
        for (let x = 0; x <= editor.mapWidth; x += 100) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, editor.mapHeight);
        }
        for (let y = 0; y <= editor.mapHeight; y += 100) {
            ctx.moveTo(0, y);
            ctx.lineTo(editor.mapWidth, y);
        }
        ctx.stroke();

        // 绘制地图边界
        ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)';
        ctx.lineWidth = 2 / editor.zoom;
        ctx.strokeRect(0, 0, editor.mapWidth, editor.mapHeight);

        // 绘制毒区（在墙体下方）
        editor.poisonZones.forEach((z) => {
            const isSelected = z.id === editor.selectedPoisonId;
            const radius = Math.max(20, z.radius || 100);

            ctx.beginPath();
            ctx.arc(z.x, z.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = isSelected ? 'rgba(0, 255, 128, 0.26)' : 'rgba(0, 255, 128, 0.16)';
            ctx.fill();

            ctx.beginPath();
            ctx.arc(z.x, z.y, radius, 0, Math.PI * 2);
            ctx.strokeStyle = isSelected ? 'rgba(60, 255, 180, 1)' : 'rgba(60, 255, 180, 0.75)';
            ctx.lineWidth = (isSelected ? 3 : 2) / editor.zoom;
            ctx.stroke();

            ctx.fillStyle = isSelected ? '#7fffd4' : 'rgba(127, 255, 212, 0.8)';
            ctx.font = `${11 / editor.zoom}px Inter`;
            ctx.textAlign = 'center';
            ctx.fillText(`${z.id} dps:${z.dps || 1}`, z.x, z.y + 4 / editor.zoom);
        });

        // 绘制传送门（在墙体下方）
        editor.portals.forEach((p) => {
            const isSelected = p.id === editor.selectedPortalId;
            const radius = Math.max(10, p.radius || 30);

            ctx.beginPath();
            ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = isSelected ? 'rgba(140, 60, 255, 0.32)' : 'rgba(140, 60, 255, 0.2)';
            ctx.fill();

            ctx.beginPath();
            ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
            ctx.strokeStyle = isSelected ? '#d2b4ff' : 'rgba(210, 180, 255, 0.9)';
            ctx.lineWidth = (isSelected ? 3 : 2) / editor.zoom;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(p.x, p.y, radius * 0.45, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.lineWidth = 1.5 / editor.zoom;
            ctx.stroke();

            ctx.fillStyle = '#e7ddff';
            ctx.font = `${10 / editor.zoom}px Inter`;
            ctx.textAlign = 'center';
            ctx.fillText(`${p.id}→${p.targetId || '?'}`, p.x, p.y - radius - 6 / editor.zoom);

            const target = editor.portals.find(tp => tp.id === p.targetId);
            if (target) {
                ctx.beginPath();
                ctx.setLineDash([5 / editor.zoom, 4 / editor.zoom]);
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(target.x, target.y);
                ctx.strokeStyle = 'rgba(210, 180, 255, 0.35)';
                ctx.lineWidth = 1 / editor.zoom;
                ctx.stroke();
                ctx.setLineDash([]);
            }
        });

        // 绘制墙体
        editor.walls.forEach((wall, idx) => {
            const isSelected = idx === editor.selectedWallIdx;

            // 墙体填充
            ctx.fillStyle = isSelected ? 'rgba(0, 255, 255, 0.25)' : '#111';
            ctx.fillRect(wall.x, wall.y, wall.w, wall.h);

            // 墙体边框
            ctx.strokeStyle = isSelected ? '#0ff' : 'rgba(0, 255, 255, 0.6)';
            ctx.lineWidth = (isSelected ? 3 : 1.5) / editor.zoom;
            ctx.strokeRect(wall.x, wall.y, wall.w, wall.h);

            // 内阴影效果
            ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.fillRect(wall.x, wall.y + wall.h - 4, wall.w, 4);

            // 墙体ID标签
            ctx.fillStyle = isSelected ? '#0ff' : 'rgba(255, 255, 255, 0.5)';
            ctx.font = `${12 / editor.zoom}px Inter`;
            ctx.textAlign = 'center';
            ctx.fillText(wall.id, wall.x + wall.w / 2, wall.y + wall.h / 2 + 4 / editor.zoom);

            // 选中时绘制调整手柄
            if (isSelected) {
                const handleSize = 6 / editor.zoom;
                const handles = [
                    { x: wall.x, y: wall.y },
                    { x: wall.x + wall.w, y: wall.y },
                    { x: wall.x, y: wall.y + wall.h },
                    { x: wall.x + wall.w, y: wall.y + wall.h }
                ];
                handles.forEach(h => {
                    ctx.fillStyle = '#0ff';
                    ctx.fillRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 1 / editor.zoom;
                    ctx.strokeRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
                });

                // 尺寸标签
                ctx.fillStyle = 'rgba(0, 255, 255, 0.8)';
                ctx.font = `${10 / editor.zoom}px Inter`;
                ctx.textAlign = 'center';
                ctx.fillText(`${wall.w} × ${wall.h}`, wall.x + wall.w / 2, wall.y - 8 / editor.zoom);
            }
        });

        // 绘制坐标刻度
        ctx.fillStyle = 'rgba(0, 255, 255, 0.3)';
        ctx.font = `${9 / editor.zoom}px Inter`;
        ctx.textAlign = 'center';
        for (let x = 0; x <= editor.mapWidth; x += 200) {
            ctx.fillText(x, x, -6 / editor.zoom);
        }
        ctx.textAlign = 'right';
        for (let y = 0; y <= editor.mapHeight; y += 200) {
            ctx.fillText(y, -8 / editor.zoom, y + 3 / editor.zoom);
        }

        ctx.restore(); // 恢复视口变换
        ctx.restore();
    }

    function drawWallPreview(x, y, w, h) {
        ctx.save();
        ctx.translate(editor.viewX, editor.viewY);
        ctx.scale(editor.zoom, editor.zoom);

        ctx.fillStyle = 'rgba(0, 255, 255, 0.15)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(0, 255, 255, 0.8)';
        ctx.lineWidth = 2 / editor.zoom;
        ctx.setLineDash([6 / editor.zoom, 4 / editor.zoom]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);

        // 尺寸标签
        ctx.fillStyle = '#0ff';
        ctx.font = `${11 / editor.zoom}px Inter`;
        ctx.textAlign = 'center';
        ctx.fillText(`${w} × ${h}`, x + w / 2, y + h / 2 + 4 / editor.zoom);

        ctx.restore();
    }

    // === 属性面板更新 ===
    function updateWallProps() {
        if (editor.selectedWallIdx >= 0 && editor.selectedWallIdx < editor.walls.length) {
            const w = editor.walls[editor.selectedWallIdx];
            wallPropsPanel.style.display = 'block';
            wallXInput.value = Math.round(w.x);
            wallYInput.value = Math.round(w.y);
            wallWInput.value = Math.round(w.w);
            wallHInput.value = Math.round(w.h);
        } else {
            wallPropsPanel.style.display = 'none';
        }
    }

    function applyWallProps() {
        if (editor.selectedWallIdx < 0) return;
        pushHistory();
        const w = editor.walls[editor.selectedWallIdx];
        w.x = parseInt(wallXInput.value) || 0;
        w.y = parseInt(wallYInput.value) || 0;
        w.w = Math.max(10, parseInt(wallWInput.value) || 10);
        w.h = Math.max(10, parseInt(wallHInput.value) || 10);
        render();
    }

    function deleteSelectedWall() {
        if (editor.selectedWallIdx < 0) return;
        pushHistory();
        editor.walls.splice(editor.selectedWallIdx, 1);
        editor.selectedWallIdx = -1;
        updateWallProps();
        updateStats();
        render();
        showStatus('墙体已删除');
    }

    // === 统计更新 ===
    function updateStats() {
        statWalls.textContent = editor.walls.length;
        statPortals.textContent = editor.portals.length;
        statPoisonZones.textContent = editor.poisonZones.length;
    }

    function updateZoomStat() {
        statZoom.textContent = Math.round(editor.zoom * 100) + '%';
    }

    function updateStatusTool() {
        const toolNames = { place: '放置', select: '选择', delete: '删除' };
        statusTool.textContent = `工具: ${toolNames[editor.tool] || editor.tool}`;
    }

    function showStatus(msg) {
        statusMsg.textContent = msg;
        setTimeout(() => {
            if (statusMsg.textContent === msg) statusMsg.textContent = '';
        }, 3000);
    }

    // === 地图列表 ===
    async function loadMapList() {
        try {
            const res = await fetch('/api/maps');
            const maps = await res.json();
            renderMapList(maps);
            // 默认加载第一个
            if (maps.length > 0 && !editor.mapId) {
                loadMapFromServer(maps[0].id);
            }
        } catch (err) {
            console.error('加载地图列表失败:', err);
            showStatus('加载地图列表失败');
        }
    }

    function renderMapList(maps) {
        mapListEl.innerHTML = '';
        maps.forEach(m => {
            const div = document.createElement('div');
            div.className = 'map-item' + (m.id === editor.mapId ? ' active' : '');
            div.innerHTML = `<span>${m.name}</span><span class="map-id">${m.id}</span>`;
            div.addEventListener('click', () => loadMapFromServer(m.id));
            mapListEl.appendChild(div);
        });
    }

    async function loadMapFromServer(mapId) {
        try {
            const res = await fetch(`/api/maps/${mapId}`);
            if (!res.ok) throw new Error('地图不存在');
            const data = await res.json();
            applyMapData(data);
            showStatus(`已加载: ${data.name}`);
        } catch (err) {
            console.error('加载地图失败:', err);
            showStatus('加载地图失败');
        }
    }

    function applyMapData(data) {
        editor.mapId = data.id;
        editor.mapName = data.name || data.id;
        editor.mapWidth = data.width || 2000;
        editor.mapHeight = data.height || 1200;
        editor.walls = (data.walls || []).map(w => ({ ...w }));
        editor.portals = (data.portals || []).map(p => ({
            id: p.id,
            x: Math.round(p.x || 0),
            y: Math.round(p.y || 0),
            radius: Math.max(10, Math.round(p.radius || 30)),
            targetId: p.targetId || ''
        }));
        editor.poisonZones = (data.poisonZones || []).map(z => ({
            id: z.id,
            x: Math.round(z.x || 0),
            y: Math.round(z.y || 0),
            radius: Math.max(20, Math.round(z.radius || 100)),
            dps: Math.max(1, Math.round(z.dps || 1))
        }));
        editor.spawnZones = data.spawnZones || [];
        editor.selectedWallIdx = -1;
        editor.selectedPortalId = '';
        editor.selectedPoisonId = '';
        editor.pendingPortalId = '';

        // 更新 UI
        mapNameInput.value = editor.mapName;
        mapWidthInput.value = editor.mapWidth;
        mapHeightInput.value = editor.mapHeight;

        // 更新墙体ID计数器
        let maxId = 0;
        editor.walls.forEach(w => {
            const num = parseInt((w.id || '').replace(/\D/g, '')) || 0;
            if (num > maxId) maxId = num;
        });
        editor.wallIdCounter = maxId;

        // 重置历史
        editor.history = [{
            walls: JSON.parse(JSON.stringify(editor.walls)),
            portals: JSON.parse(JSON.stringify(editor.portals)),
            poisonZones: JSON.parse(JSON.stringify(editor.poisonZones))
        }];
        editor.historyIndex = 0;

        updateWallProps();
        updatePortalPanel();
        updatePoisonPanel();
        updateStats();
        syncQuickPlaceButtons();
        centerView();
        render();
        loadMapList(); // 刷新列表高亮
    }

    // === 保存/导出/导入 ===
    async function saveToServer() {
        if (!editor.mapId) {
            showStatus('请先选择或创建一个地图');
            return;
        }

        const mapData = {
            name: editor.mapName,
            id: editor.mapId,
            width: editor.mapWidth,
            height: editor.mapHeight,
            walls: editor.walls,
            portals: editor.portals,
            poisonZones: editor.poisonZones,
            spawnZones: editor.spawnZones
        };

        try {
            const res = await fetch(`/api/maps/${editor.mapId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(mapData)
            });
            const result = await res.json();
            if (result.success) {
                showStatus(`✅ 地图已保存: ${editor.mapName}`);
            } else {
                showStatus('❌ 保存失败: ' + (result.error || '未知错误'));
            }
        } catch (err) {
            console.error('保存失败:', err);
            showStatus('❌ 保存失败');
        }
    }

    function exportJSON() {
        const mapData = {
            name: editor.mapName,
            id: editor.mapId || 'untitled',
            width: editor.mapWidth,
            height: editor.mapHeight,
            walls: editor.walls,
            portals: editor.portals,
            poisonZones: editor.poisonZones,
            spawnZones: editor.spawnZones
        };

        const blob = new Blob([JSON.stringify(mapData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${editor.mapId || 'map'}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showStatus('地图已导出为 JSON');
    }

    function importJSON(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const data = JSON.parse(event.target.result);
                applyMapData(data);
                showStatus(`已导入: ${data.name || data.id}`);
            } catch (err) {
                showStatus('导入失败: JSON 解析错误');
            }
        };
        reader.readAsText(file);
        // 重置 file input，允许再次选择相同文件
        fileImport.value = '';
    }

    function createNewMap() {
        const newId = newMapIdInput.value.trim();
        if (!newId) {
            showStatus('请输入地图ID');
            return;
        }
        // 检查是否只包含字母、数字和下划线
        if (!/^[a-zA-Z0-9_]+$/.test(newId)) {
            showStatus('地图ID只能包含字母、数字和下划线');
            return;
        }

        applyMapData({
            id: newId,
            name: newId,
            width: 2000,
            height: 1200,
            walls: [],
            portals: [],
            poisonZones: [],
            spawnZones: []
        });
        newMapIdInput.value = '';
        showStatus(`新地图已创建: ${newId}`);
    }

    // === 启动 ===
    init();
})();
