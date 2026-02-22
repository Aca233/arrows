const fs = require('fs');
const file = 'c:/2/arrows/server.js';
let code = fs.readFileSync(file, 'utf-8');

// Find the start of the Update loop
const startIndex = code.indexOf('// Update loop (60 FPS)');
const endIndex = code.indexOf('const PORT = 3000;');

if (startIndex === -1 || endIndex === -1) {
    console.error('Could not find boundaries.');
    process.exit(1);
}

let topPart = code.substring(0, startIndex);
let loopPart = code.substring(startIndex, endIndex);
let bottomPart = code.substring(endIndex);

// Wrap the inside of the interval
// let lastTime = Date.now();
// setInterval(() => { ... }, 1000/60);
const intervalStart = loopPart.indexOf('setInterval(() => {');
if (intervalStart === -1) {
    console.error('Cannot find setInterval');
    process.exit(1);
}

// Locate the start of the interval body
const bodyStart = loopPart.indexOf('    // === 更新所有 Bot AI ===');
const emitEnd = loopPart.indexOf("    io.emit('state', gameState);") + "    io.emit('state', gameState);".length;

let preLoop = loopPart.substring(0, bodyStart);
let mainBody = loopPart.substring(bodyStart, emitEnd);
let postLoop = loopPart.substring(emitEnd);

// Replace gameState -> room
mainBody = mainBody.replace(/gameState/g, 'room');

// Replace io.emit -> io.to(room.id).emit
// Carefully replace io.emit, taking care not to replace io.to().emit
// To handle this, we can replace io.emit( -> io.to(room.id).emit(
mainBody = mainBody.replace(/io\.emit\(/g, "io.to(room.id).emit(");

// Replace botBrains -> room.botBrains
mainBody = mainBody.replace(/botBrains/g, 'room.botBrains');

// Update botCreateArrow call
mainBody = mainBody.replace(/botCreateArrow\)/g, 'botCreateArrow)'); // wait, the usage is brain.update(dt, room, botCreateArrow) -> botCreateArrow takes room as first args inside brain? No, BotBrain calls botCreateArrow(id, x, y...). Wait! BotBrain only knows about the functions passed to the callback.
// In `addBot`, we passed `botId`. The botCreateArrow in botAI.js takes ownerId.
// We should wrap botCreateArrow inside the loop or change BotBrain.
mainBody = mainBody.replace(/botCreateArrow\)/g, '(oid, x, y, dx, dy, speed, charge, lt) => botCreateArrow(room, oid, x, y, dx, dy, speed, charge, lt))');

// Update counters
mainBody = mainBody.replace(/trapIdCounter\+\+/g, 'room.counters.trap++');
mainBody = mainBody.replace(/beeIdCounter\+\+/g, 'room.counters.bee++');
mainBody = mainBody.replace(/buffIdCounter\+\+/g, 'room.counters.buff++');
mainBody = mainBody.replace(/monsterIdCounter\+\+/g, 'room.counters.monster++');
mainBody = mainBody.replace(/arrowIdCounter\+\+/g, 'room.counters.arrow++');
mainBody = mainBody.replace(/monsterSpawnCount/g, 'room.counters.monsterSpawn');

// Fix spawnSplitterChildren
mainBody = mainBody.replace(/spawnSplitterChildren\(monster\.x, monster\.y\)/g, 'spawnSplitterChildren(room, monster.x, monster.y)');

// Fix startNewRound()
mainBody = mainBody.replace(/startNewRound\(\)/g, 'startNewRound(room)');

// Indent mainBody by 4 spaces
let lines = mainBody.split('\n');
lines = lines.map(l => l.length > 0 ? '    ' + l : l);
mainBody = lines.join('\n');

// Wrap mainBody with floor loop
const wrapper = `    for (const roomId in rooms) {
        const room = rooms[roomId];

${mainBody}
    }`;

// Replace startNewRound function
let startFunctionStart = postLoop.indexOf('function startNewRound() {');
let startFunctionEnd = postLoop.indexOf('}', postLoop.lastIndexOf('brain.patrolTarget = brain._randomPatrolPoint();')) + 1; // approx end of startNewRound
// or just replace the string function startNewRound()
postLoop = postLoop.replace('function startNewRound() {', 'function startNewRound(room) {');
postLoop = postLoop.replace(/gameState/g, 'room');
postLoop = postLoop.replace(/botBrains/g, 'room.botBrains');


let newLoopPart = preLoop + wrapper + "\n\n" + postLoop.substring(postLoop.indexOf('}, 1000 / 60);'));

let finalCode = topPart + newLoopPart + bottomPart;
fs.writeFileSync(file, finalCode, 'utf-8');
console.log('Refactoring complete.');
