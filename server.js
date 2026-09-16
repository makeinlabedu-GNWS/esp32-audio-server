const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SECRET_KEY = "Prakash1234";
let esp32Socket = null;
let activePhonesCount = 0;

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
    // ESP32 ko current stream status notify karein
    if (activePhonesCount > 0) {
      esp32Socket.send(JSON.stringify({ type: 'stream_cmd', state: 'start' }));
    } else {
      esp32Socket.send(JSON.stringify({ type: 'stream_cmd', state: 'stop' }));
    }

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'status', espConnected: true }));
      }
    });

    ws.on('close', () => {
      esp32Socket = null;
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'status', espConnected: false }));
        }
      });
    });
  } else if (role === 'phone') {
    ws.send(JSON.stringify({ type: 'status', espConnected: esp32Socket !== null }));

    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'phone_action') {
          if (parsed.action === 'start') {
            activePhonesCount++;
            if (activePhonesCount === 1 && esp32Socket && esp32Socket.readyState === WebSocket.OPEN) {
              esp32Socket.send(JSON.stringify({ type: 'stream_cmd', state: 'start' }));
            }
          } else if (parsed.action === 'stop') {
            if (activePhonesCount > 0) activePhonesCount--;
            if (activePhonesCount === 0 && esp32Socket && esp32Socket.readyState === WebSocket.OPEN) {
              esp32Socket.send(JSON.stringify({ type: 'stream_cmd', state: 'stop' }));
            }
          }
        }
      } catch(e) {}
    });

    ws.on('close', () => {
      if (ws.isStreaming) {
        if (activePhonesCount > 0) activePhonesCount--;
        if (activePhonesCount === 0 && esp32Socket && esp32Socket.readyState === WebSocket.OPEN) {
          esp32Socket.send(JSON.stringify({ type: 'stream_cmd', state: 'stop' }));
        }
      }
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
      <title>Live Audio Monitor</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; background: #121212; color: #fff; padding-top: 30px; }
        .card { background: #1e1e1e; margin: 0 auto; max-width: 350px; padding: 25px; border-radius: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
        .btn { padding: 16px 32px; font-size: 18px; border: none; border-radius: 30px; cursor: pointer; font-weight: bold; margin-top: 15px; }
        .btn-start { background: #00ff88; color: #000; }
        .btn-stop { background: #ff4444; color: #fff; }
        .status-box { font-size: 16px; margin: 10px 0; padding: 10px; border-radius: 8px; background: #2a2a2a; }
        .online { color: #00ff88; font-weight: bold; }
        .offline { color: #ff4444; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>🔒 Live Audio</h2>
        <div class="status-box">ESP32 Status: <span id="espStatus" class="offline">Checking...</span></div>
        <div class="status-box">Stream: <span id="streamStatus">Stopped</span></div>
        <button id="toggleBtn" class="btn btn-start" onclick="toggleStream()">▶ START AUDIO</button>
      </div>

      <script>
        let audioCtx = null;
        let ws = null;
        let isStreaming = false;
        let nextTime = 0;
        const GAIN_BOOST = 2.5;

        function toggleStream() {
          if (!isStreaming) {
            startStream();
          } else {
            stopStream();
          }
        }

        function startStream() {
          if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
          }
          if (audioCtx.state === 'suspended') {
            audioCtx.resume();
          }

          document.getElementById('streamStatus').innerText = "Connecting...";
          ws = new WebSocket('wss://' + location.host + '/?role=phone&key=${SECRET_KEY}');
          ws.binaryType = 'arraybuffer';

          ws.onopen = () => { 
            isStreaming = true;
            ws.isStreaming = true;
            ws.send(JSON.stringify({ type: 'phone_action', action: 'start' }));
            document.getElementById('streamStatus').innerText = "Streaming Live 🟢";
            const btn = document.getElementById('toggleBtn');
            btn.innerText = "⏹ STOP AUDIO";
            btn.className = "btn btn-stop";
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
            } else if (event.data instanceof ArrayBuffer && isStreaming) {
              playPCM(event.data);
            }
          };

          ws.onclose = () => { 
            stopStreamUI();
          };
        }

        function stopStream() {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'phone_action', action: 'stop' }));
            ws.close();
          }
          stopStreamUI();
        }

        function stopStreamUI() {
          isStreaming = false;
          document.getElementById('streamStatus').innerText = "Stopped 🔴";
          const btn = document.getElementById('toggleBtn');
          btn.innerText = "▶ START AUDIO";
          btn.className = "btn btn-start";
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
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('Server running on port ' + PORT));
