const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SECRET_KEY = "Prakash360";
let esp32Socket = null;
let isAudioActive = false;

function broadcastState() {
  const isEspOnline = (esp32Socket !== null && esp32Socket.readyState === WebSocket.OPEN);
  const payload = JSON.stringify({
    type: 'system_state',
    espOnline: isEspOnline,
    audioActive: isAudioActive
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client !== esp32Socket) {
      client.send(payload);
    }
  });
}

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace('/?', ''));
  const key = urlParams.get('key');
  const role = urlParams.get('role');

  if (key !== SECRET_KEY) {
    ws.send("AUTH_FAILED");
    ws.close();
    return;
  }

  if (role === 'esp32') {
    esp32Socket = ws;
    broadcastState();

    ws.on('close', () => {
      if (esp32Socket === ws) {
        esp32Socket = null;
        isAudioActive = false;
        broadcastState();
      }
    });

    ws.on('error', () => {
      if (esp32Socket === ws) {
        esp32Socket = null;
        isAudioActive = false;
        broadcastState();
      }
    });
  } else if (role === 'phone') {
    const isEspOnline = (esp32Socket !== null && esp32Socket.readyState === WebSocket.OPEN);
    ws.send(JSON.stringify({
      type: 'system_state',
      espOnline: isEspOnline,
      audioActive: isAudioActive
    }));

    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'phone_action') {
          if (parsed.action === 'start') {
            isAudioActive = true;
            if (esp32Socket && esp32Socket.readyState === WebSocket.OPEN) {
              esp32Socket.send(JSON.stringify({ type: 'stream_cmd', state: 'start' }));
            }
          } else if (parsed.action === 'stop') {
            isAudioActive = false;
            if (esp32Socket && esp32Socket.readyState === WebSocket.OPEN) {
              esp32Socket.send(JSON.stringify({ type: 'stream_cmd', state: 'stop' }));
            }
          }
          broadcastState();
        }
      } catch(e) {}
    });
  }

  ws.on('message', (data, isBinary) => {
    if (role === 'esp32' && isBinary) {
      wss.clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(data, { binary: true });
        }
      });
    }
  });
});

app.get('/', (req, res) => {
  const key = req.query.key;
  if (key !== SECRET_KEY) {
    return res.status(403).send("<h2>403 Unauthorized Access</h2>");
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Audio HUD Controller & Recorder</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; background: #121212; color: #fff; padding-top: 20px; }
        .card { background: #1e1e1e; margin: 0 auto; max-width: 360px; padding: 25px; border-radius: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
        .btn { padding: 14px 28px; font-size: 16px; border: none; border-radius: 30px; cursor: pointer; font-weight: bold; margin-top: 15px; width: 90%; transition: 0.2s; }
        .btn-start { background: #00ff88; color: #000; }
        .btn-stop { background: #ff4444; color: #fff; }
        .btn-rec { background: #ff9900; color: #000; }
        .btn-rec-stop { background: #e60000; color: #fff; }
        .status-box { font-size: 15px; margin: 8px 0; padding: 10px; border-radius: 8px; background: #2a2a2a; text-align: left; }
        .online { color: #00ff88; font-weight: bold; }
        .offline { color: #ff4444; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>🔒 Audio Controller</h2>
        <div class="status-box">Cloud Server: <span id="serverStatus" class="offline">Connecting...</span></div>
        <div class="status-box">ESP32 Device: <span id="espStatus" class="offline">OFFLINE 🔴</span></div>
        <div class="status-box">Audio State: <span id="streamStatus">Stopped 🔴</span></div>
        
        <button id="toggleBtn" class="btn btn-start" onclick="toggleAudio()">▶ START AUDIO</button>
        <button id="recBtn" class="btn btn-rec" onclick="toggleRecording()" style="display:none;">🎙️ START RECORDING</button>
      </div>

      <script>
        let audioCtx = null;
        let ws = null;
        let isPlaying = false;
        let nextTime = 0;
        const GAIN_BOOST = 2.5;

        let mediaStreamDest = null;
        let mediaRecorder = null;
        let recordedChunks = [];
        let isRecording = false;

        function connectWS() {
          const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
          ws = new WebSocket(protocol + location.host + '/?role=phone&key=${SECRET_KEY}');
          ws.binaryType = 'arraybuffer';

          ws.onopen = () => {
            document.getElementById('serverStatus').innerText = "CONNECTED 🟢";
            document.getElementById('serverStatus').className = "online";
          };

          ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
              try {
                const data = JSON.parse(event.data);
                if (data.type === 'system_state') {
                  updateUI(data.espOnline, data.audioActive);
                }
              } catch(e){}
            } else if (event.data instanceof ArrayBuffer && isPlaying) {
              playPCM(event.data);
            }
          };

          ws.onclose = () => {
            document.getElementById('serverStatus').innerText = "DISCONNECTED 🔴";
            document.getElementById('serverStatus').className = "offline";
            updateUI(false, false);
            setTimeout(connectWS, 2000);
          };
        }

        function updateUI(espOnline, audioActive) {
          const espEl = document.getElementById('espStatus');
          if (espOnline) {
            espEl.innerText = "ONLINE 🟢";
            espEl.className = "online";
          } else {
            espEl.innerText = "OFFLINE 🔴";
            espEl.className = "offline";
          }

          isPlaying = audioActive;
          const btn = document.getElementById('toggleBtn');
          const recBtn = document.getElementById('recBtn');
          const streamEl = document.getElementById('streamStatus');

          if (audioActive) {
            streamEl.innerText = "STREAMING LIVE 🟢";
            btn.innerText = "⏹ STOP AUDIO";
            btn.className = "btn btn-stop";
            recBtn.style.display = "inline-block";
          } else {
            streamEl.innerText = "Stopped 🔴";
            btn.innerText = "▶ START AUDIO";
            btn.className = "btn btn-start";
            recBtn.style.display = "none";
            if(isRecording) stopRecording();
          }
        }

        function toggleAudio() {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          if (!isPlaying) {
            if (!audioCtx) {
              audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
              mediaStreamDest = audioCtx.createMediaStreamDestination();
            }
            if (audioCtx.state === 'suspended') {
              audioCtx.resume();
            }
            ws.send(JSON.stringify({ type: 'phone_action', action: 'start' }));
          } else {
            ws.send(JSON.stringify({ type: 'phone_action', action: 'stop' }));
          }
        }

        function playPCM(arrayBuffer) {
          if (!audioCtx || !isPlaying) return;
          const pcm16 = new Int16Array(arrayBuffer);
          if (pcm16.length === 0) return;

          const buffer = audioCtx.createBuffer(1, pcm16.length, 16000);
          const channelData = buffer.getChannelData(0);

          for (let i = 0; i < pcm16.length; i++) {
            let sample = (pcm16[i] / 32768.0) * GAIN_BOOST;
            if (sample > 1.0) sample = 1.0;
            if (sample < -1.0) sample = -1.0;
            channelData[i] = sample;
          }

          const source = audioCtx.createBufferSource();
          source.buffer = buffer;
          
          source.connect(audioCtx.destination);
          if (mediaStreamDest) {
            source.connect(mediaStreamDest);
          }

          let currentTime = audioCtx.currentTime;
          if (nextTime < currentTime || (nextTime - currentTime) > 0.2) {
            nextTime = currentTime;
          }

          source.start(nextTime);
          nextTime += buffer.duration;
        }

        function toggleRecording() {
          if (!isRecording) {
            startRecording();
          } else {
            stopRecording();
          }
        }

        function startRecording() {
          if (!mediaStreamDest) return;
          recordedChunks = [];
          mediaRecorder = new MediaRecorder(mediaStreamDest.stream);

          mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              recordedChunks.push(e.data);
            }
          };

          mediaRecorder.onstop = saveAudioFile;

          mediaRecorder.start();
          isRecording = true;
          const recBtn = document.getElementById('recBtn');
          recBtn.innerText = "⏹ STOP & SAVE REC";
          recBtn.className = "btn btn-rec-stop";
        }

        function stopRecording() {
          if (mediaRecorder && isRecording) {
            mediaRecorder.stop();
            isRecording = false;
            const recBtn = document.getElementById('recBtn');
            recBtn.innerText = "🎙️ START RECORDING";
            recBtn.className = "btn btn-rec";
          }
        }

        function saveAudioFile() {
          const blob = new Blob(recordedChunks, { type: 'audio/webm' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          a.download = 'ESP32_Audio_Record_' + new Date().getTime() + '.webm';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
          }, 100);
        }

        connectWS();
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('Server running on port ' + PORT));
