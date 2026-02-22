const fs = require('fs');
let lines = fs.readFileSync('server.js', 'utf8').split('\n');
let start = lines.findIndex(l => l.includes('app.post('));
let end = lines.findIndex(l => l.includes('socket.on(\\'skill\\''));

const replacement = `app.post('/api/maps/:id', (req, res) => {
    const mapData = req.body;
    mapData.id = req.params.id;
    if (saveMap(mapData)) {
        res.json({ success: true, message: '地图已保存' });
    } else {
        res.status(500).json({ error: '保存失败' });
    }
});

function getOrCreateRoom(modeStr, requestRoomId = '') {
    if (requestRoomId) {
        if (rooms[requestRoomId]) {
            return rooms[requestRoomId];
        } else {
            const newRoom = createRoom(requestRoomId, modeStr);
            const mapData = loadMap('standard');
            if (mapData && mapData.walls.length > 0) {
                newRoom.walls = mapData.walls;
                newRoom.portals = mapData.portals || [];
                newRoom.poisonZones = mapData.poisonZones || [];
            }
            rooms[requestRoomId] = newRoom;
            console.log(\`[Server] Created customized room: \${requestRoomId} mode: \${modeStr}\`);
            return newRoom;
        }
    }

    for (const [id, r] of Object.entries(rooms)) {
        if (r.mode === modeStr && Object.keys(r.players).length < 20) {
            return r;
        }
    }
    
    const newRoomId = \`room_\${Date.now()}_\${Math.floor(Math.random() * 1000)}\`;
    const newRoom = createRoom(newRoomId, modeStr);
    
    const mapData = loadMap('standard');
    if (mapData && mapData.walls.length > 0) {
        newRoom.walls = mapData.walls;
        newRoom.portals = mapData.portals || [];
        newRoom.poisonZones = mapData.poisonZones || [];
    }
    rooms[newRoomId] = newRoom;
    console.log(\`[Server] Created new anonymous room: \${newRoomId} mode: \${modeStr}\`);
    return newRoom;
}

io.on('connection', (socket) => {
    console.log(\`[Server] Client connected: \${socket.id}\`);

    socket.emit('init', socket.id);

    socket.on('join', (data) => {
        const { roomId, name, mode, talent, weapon } = data;
        let playerName = name || \`Player_\${socket.id.substring(0, 4)}\`;

        if (talent === 'paranoid') playerName += ' [偏执]';
        else if (talent === 'fantasy') playerName += ' [幻想]';
        else if (talent === 'insidious') playerName += ' [阴险]';
        else if (talent === 'clairvoyance') playerName += ' [明察]';

        const roomMode = mode || 'standard';
        const room = getOrCreateRoom(roomMode, roomId);
        
        playerRooms[socket.id] = room.id;
        socket.join(room.id);
        socket.emit('room_joined', room.id);

        room.players[socket.id] = new Player(
            socket.id,
            Math.random() * (GAME_WIDTH - 40) + 20,
            Math.random() * (GAME_HEIGHT - 40) + 20,
            playerName,
            \`hsl(\${Math.random() * 360}, 100%, 50%)\`
        );

        const player = room.players[socket.id];
        player.roomMode = roomMode;
        player.talent = talent || 'none';
        player.weapon = weapon || 'bow';
        player.coinsEarned = 0;

        if (roomMode === 'sniper_duel') {
            player.baseSpeed = 350;
            player.speed = 350;
        }

        console.log(\`[Room \${room.id}] Player joined: \${playerName} | Talent: \${talent}\`);
    });

    `;

lines.splice(start, end - start, replacement);
fs.writeFileSync('server.js', lines.join('\\n'));
console.log('Fixed server.js');
