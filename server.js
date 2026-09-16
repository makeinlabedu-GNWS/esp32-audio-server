const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SECRET_KEY = "Prakash1234"; // AAPKA PASSCODE
let esp32Socket = null;

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
    console.log("ESP32 Connected");
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'status', espConnected: true }));
      }
    });

    ws.on('close', () => {
      esp32Socket = null;
      console.log("ESP32 Disconnected");
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'status', espConnected: false }));
        }
      });
    });
  } else if (role === 'phone') {
    ws.send(JSON.stringify({ type: 'status', espConnected: esp32Socket !== null }));
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
      <title>Real-Time Secure Audio</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; background: #121212; color: #fff; padding-top: 30px; }
        .card { background: #1e1e1e; margin: 0 auto; max-width: 350px; padding: 25px; border-radius: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
        .btn { padding: 16px 32px; font-size: 18px; background: #00ff88; color: #000; border: none; border-radius: 30px; cursor: pointer; font-weight: bold; margin-top: 15px; }
        .status-box { font-size: 16px; margin: 10px 0; padding: 10px; border-radius: 8px; background: #2a2a2a; }
        .online { color: #00ff88; font-weight: bold; }
        .offline { color: #ff4444; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>🔒 Live Audio Monitor</h2>
        <div class="status-box">ESP32 Status: <span id="espStatus" class="offline">Checking...</span></div>
        <div class="status-box">Stream: <span id="streamStatus">Stopped</span></div>
        <button class="btn" onclick="startStream()">▶ START AUDIO</button>
      </div>

      <script>
        let audioCtx = null;
        let nextTime = 0;
        const GAIN_BOOST = 4.0; // Loud volume multiplier

        function startStream() {
          if (!audioCtx) {
            // Force exact 16000Hz matching with ESP32 to fix slow pitch / deep voice issue
            audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
          }
          if (audioCtx.state === 'suspended') {
            audioCtx.resume();
          }

          document.getElementById('streamStatus').innerText = "Connecting...";
          const ws = new WebSocket('wss://' + location.host + '/?role=phone&key=${SECRET_KEY}');
          ws.binaryType = 'arraybuffer';

          ws.onopen = () => { 
            document.getElementById('streamStatus').innerText = "Streaming Live 🟢"; 
          };

          ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
              try {
                const data = JSON.parse(event.data);
                if (data.type === 'status') {
                  const statusEl = document.getElementById('espStatus');
                  if (data.espConnected) {
                    statusEl.innerText = "ONLINE 🟢";
                    statusEl.className = "online";
                  } else {
                    statusEl.innerText = "OFFLINE 🔴";
                    statusEl.className = "offline";
                  }
                }
              } catch(e){}
            } else if (event.data instanceof ArrayBuffer) {
              playPCMInstant(event.data);
            }
          };

          ws.onclose = () => { 
            document.getElementById('streamStatus').innerText = "Disconnected 🔴"; 
            document.getElementById('espStatus').innerText = "Offline";
          };
        }

        function playPCMInstant(arrayBuffer) {
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

          // Zero-delay optimization: Play instantly without queue buildup
          let currentTime = audioCtx.currentTime;
          if (nextTime < currentTime) {
            nextTime = currentTime;
          }
          
          source.start(nextTime);
          nextTime += buffer.duration;
        }
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('Server running on port ' + PORT));
