const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SECRET_KEY = "Prakash1234";
let esp32Socket = null;
let isAudioActive = false;

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
    // Notify phone that ESP32 is online
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'esp_status', online: true }));
      }
    });

    ws.on('close', () => {
      esp32Socket = null;
      isAudioActive = false;
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'esp_status', online: false }));
        }
      });
    });
  } else if (role === 'phone') {
    // Send immediate state to newly opened phone page
    ws.send(JSON.stringify({ 
      type: 'init_status', 
      espOnline: esp32Socket !== null,
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
        }
      } catch(e) {}
    });

    ws.on('close', () => {
      // If phone closes tab while audio was active
      if (isAudioActive) {
        isAudioActive = false;
        if (esp32Socket && esp32Socket.readyState === WebSocket.OPEN) {
          esp32Socket.send(JSON.stringify({ type: 'stream_cmd', state: 'stop' }));
        }
      }
    });
  }

  // Audio Data Relay from ESP32 to Phone
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
      <title>Secure Live Audio Controller</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; background: #121212; color: #fff; padding-top: 20px; }
        .card { background: #1e1e1e; margin: 0 auto; max-width: 360px; padding: 20px; border-radius: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
        .btn { padding: 16px 32px; font-size: 18px; border: none; border-radius: 30px; cursor: pointer; font-weight: bold; margin-top: 15px; width: 85%; }
        .btn-start { background: #00ff88; color: #000; }
        .btn-stop { background: #ff4444; color: #fff; }
        .status-box { font-size: 15px; margin: 8px 0; padding: 10px; border-radius: 8px; background: #2a2a2a; text-align: left; }
        .online { color: #00ff88; font-weight: bold; }
        .offline { color: #ff4444; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>🔒 Audio Dashboard</h2>
        <div class="status-box">Cloud Server: <span id="serverStatus" class="offline">Connecting...</span></div>
        <div class="status-box">ESP32 Wi-Fi: <span id="espStatus" class="offline">Disconnected</span></div>
        <div class="status-box">Audio Stream: <span id="streamStatus">Stopped</span></div>
        <button id="toggleBtn" class="btn btn-start" onclick="toggleAudio()">▶ START AUDIO</button>
      </div>

      <script>
        let audioCtx = null;
        let ws = null;
        let isPlaying = false;
        let nextTime = 0;
        const GAIN_BOOST = 2.5;

        function connectWebSocket() {
          ws = new WebSocket('wss://' + location.host + '/?role=phone&key=${SECRET_KEY}');
          ws.binaryType = 'arraybuffer';

          ws.onopen = () => {
            document.getElementById('serverStatus').innerText = "CONNECTED 🟢";
            document.getElementById('serverStatus').className = "online";
          };

          ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
              try {
                const data = JSON.parse(event.data);
                if (data.type === 'init_status') {
                  updateEspUI(data.espOnline);
                  if(data.audioActive) {
                    setAudioUI(true);
                  }
                } else if (data.type === 'esp_status') {
                  updateEspUI(data.online);
                }
              } catch(e){}
            } else if (event.data instanceof ArrayBuffer && isPlaying) {
              playPCM(event.data);
            }
          };

          ws.onclose = () => {
            document.getElementById('serverStatus').innerText = "DISCONNECTED 🔴";
            document.getElementById('serverStatus').className = "offline";
            updateEspUI(false);
            setAudioUI(false);
            setTimeout(connectWebSocket, 3000); // Auto reconnect to cloud
          };
        }

        function updateEspUI(online) {
          const el = document.getElementById('espStatus');
          if (online) {
            el.innerText = "CONNECTED 🟢";
            el.className = "online";
          } else {
            el.innerText = "DISCONNECTED 🔴";
            el.className = "offline";
          }
        }

        function setAudioUI(active) {
          isPlaying = active;
          const btn = document.getElementById('toggleBtn');
          const streamEl = document.getElementById('streamStatus');
          
          if (active) {
            streamEl.innerText = "STREAMING LIVE 🟢";
            btn.innerText = "⏹ STOP AUDIO";
            btn.className = "btn btn-stop";
          } else {
            streamEl.innerText = "STOPPED 🔴";
            btn.innerText = "▶ START AUDIO";
            btn.className = "btn btn-start";
          }
        }

        function toggleAudio() {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            alert("Server disconnected! Waiting for connection...");
            return;
          }

          if (!isPlaying) {
            if (!audioCtx) {
              audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            }
            if (audioCtx.state === 'suspended') {
              audioCtx.resume();
            }
            ws.send(JSON.stringify({ type: 'phone_action', action: 'start' }));
            setAudioUI(true);
          } else {
            ws.send(JSON.stringify({ type: 'phone_action', action: 'stop' }));
            setAudioUI(false);
          }
        }

        function playPCM(arrayBuffer) {
          if (!audioCtx) return;
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

          let currentTime = audioCtx.currentTime;
          if (nextTime < currentTime || (nextTime - currentTime) > 0.25) {
            nextTime = currentTime;
          }

          source.start(nextTime);
          nextTime += buffer.duration;
        }

        // Connect on Page Load
        connectWebSocket();
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('Server running on port ' + PORT));
