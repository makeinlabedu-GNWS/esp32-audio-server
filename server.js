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
    ws.on('close', () => { esp32Socket = null; });
  } else if (role === 'phone') {
    if (esp32Socket) {
      esp32Socket.on('message', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });
    }
  }
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
      <title>Secure Receiver</title>
      <style>
        body { font-family: Arial; text-align: center; background: #121212; color: #fff; padding-top: 50px; }
        .btn { padding: 15px 30px; font-size: 18px; background: #00ff88; color: #000; border: none; border-radius: 25px; cursor: pointer; }
      </style>
    </head>
    <body>
      <h2>🔒 Secure Live Audio</h2>
      <p id="status">Status: Ready</p>
      <button class="btn" onclick="startStream()">LISTEN LIVE</button>
      <script>
        let audioCtx, nextTime = 0;
        function startStream() {
          document.getElementById('status').innerText = "Connecting...";
          audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
          const ws = new WebSocket('wss://' + location.host + '/?role=phone&key=${SECRET_KEY}');
          ws.binaryType = 'arraybuffer';
          ws.onopen = () => { document.getElementById('status').innerText = "Streaming Live 🟢"; };
          ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
              playPCM(new Int16Array(event.data));
            }
          };
          ws.onclose = () => { document.getElementById('status').innerText = "Disconnected 🔴"; };
        }
        function playPCM(pcmData) {
          const buffer = audioCtx.createBuffer(1, pcmData.length, 16000);
          const channelData = buffer.getChannelData(0);
          for (let i = 0; i < pcmData.length; i++) channelData[i] = pcmData[i] / 32768.0;
          const source = audioCtx.createBufferSource();
          source.buffer = buffer;
          source.connect(audioCtx.destination);
          if (nextTime < audioCtx.currentTime) nextTime = audioCtx.currentTime;
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
