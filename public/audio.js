// c:\2\arrows\public\audio.js

const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioCtx;
let bgmInterval = null;

function initAudio() {
    if (!audioCtx) {
        audioCtx = new AudioContext();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

// 通用合成器发生器
function playTone(freq, type, duration, vol = 0.1, slideFreq = null) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);

    if (slideFreq) {
        osc.frequency.exponentialRampToValueAtTime(slideFreq, audioCtx.currentTime + duration);
    }

    gainNode.gain.setValueAtTime(vol, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + duration);
}

// 白噪声生成器 (用于爆炸, 撞击)
function playNoise(duration, vol = 0.1, isHeavy = false) {
    if (!audioCtx) return;
    const bufferSize = audioCtx.sampleRate * duration;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
        // 简易低通滤波感（偏向沉闷）
        if (isHeavy && i > 0) {
            data[i] = (data[i] + data[i - 1]) / 2;
        }
    }

    const noiseSource = audioCtx.createBufferSource();
    noiseSource.buffer = buffer;

    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(vol, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);

    // 如果需要更重的撞击感，可以加一个 BiquadFilter 滤掉高频
    if (isHeavy) {
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 800;
        noiseSource.connect(filter);
        filter.connect(gainNode);
    } else {
        noiseSource.connect(gainNode);
    }

    gainNode.connect(audioCtx.destination);
    noiseSource.start();
}

const SoundFX = {
    shoot: () => {
        // "Pew" 高频迅速降低到低频的合成声
        playTone(800, 'square', 0.15, 0.05, 100);
    },
    hitWall: () => {
        // 短促的撞击噪音
        playNoise(0.1, 0.1, true);
    },
    killMonster: () => {
        // 刺耳/数字碎裂感
        playNoise(0.2, 0.15);
        playTone(200, 'sawtooth', 0.2, 0.1, 50);
    },
    playerDeath: () => {
        // 长且沉重的爆炸低频
        playNoise(0.8, 0.4, true);
        playTone(150, 'square', 0.8, 0.3, 10);
    },
    pickupBuff: () => {
        // "Ding" 上升滑音
        playTone(400, 'sine', 0.1, 0.1, 800);
        setTimeout(() => playTone(800, 'sine', 0.2, 0.1, 1200), 100);
    },
    ding: () => {
        // 单次清脆提示音
        playTone(600, 'sine', 0.1, 0.05);
    }
};

window.initAudio = initAudio;
window.SoundFX = SoundFX;

// --- 赛博朋克合成序列发生器 ---
function startCyberBGM() {
    if (!audioCtx) return;
    if (bgmInterval) return; // 已经在播放

    // C 小三和弦的琶音序列 (C3, D#3, G3, C4)
    const notes = [130.81, 155.56, 196.00, 155.56, 130.81, 155.56, 261.63, 196.00];
    let step = 0;

    // 240 Beats Per Minute (每拍 250ms)
    bgmInterval = setInterval(() => {
        // 贝斯琶音 (Bass Arp)
        playTone(notes[step % notes.length], 'sawtooth', 0.2, 0.03);

        // 附加八低音层
        playTone(notes[step % notes.length] / 2, 'square', 0.25, 0.02);

        // 每 4 拍一下重底鼓 (Kick Drum)
        if (step % 4 === 0) {
            playNoise(0.15, 0.2, true);
        }

        // 每 8 拍一次反拍军鼓 (Snare)
        if (step % 8 === 4) {
            playNoise(0.2, 0.1, false);
        }

        step++;
    }, 250);
}

function stopBGM() {
    if (bgmInterval) {
        clearInterval(bgmInterval);
        bgmInterval = null;
    }
}

window.BGM = {
    start: startCyberBGM,
    stop: stopBGM
};
