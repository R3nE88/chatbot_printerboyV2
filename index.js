const fs = require('fs');
const path = require('path');
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Server } = require('socket.io');
const http = require('http');
const Boom = require('@hapi/boom');
const fsExtra = require('fs-extra');

// === Cargar configuración de sucursales ===
const sucursales = JSON.parse(fs.readFileSync('./config/sucursales.json', 'utf-8'));

// === Inicializar servidor web y sockets ===
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Ruta para servir el archivo sucursales.json
app.get('/config/sucursales.json', (req, res) => {
    const filePath = path.join(__dirname, 'config', 'sucursales.json');
    res.sendFile(filePath);
});

// === Estado de cada sesión ===
const sesiones = {}; // { sucursal1: { sock, status, qr } }

// === Función para detectar dudas ===
function esMensajeDeDuda(text) {
  const texto = text.toLowerCase();
  return (
      texto.includes('hola') ||
      texto.includes('?') ||
      texto.includes('precio') ||
      texto.includes('canva') ||
      texto.includes('cuánto') ||
      texto.includes('cuanto') ||
      texto.includes('costo') ||
      texto.includes('tienen') ||
      texto.includes('hacen') ||
      texto.includes('pueden') ||
      texto.includes('horario') ||
      texto.includes('abren') ||
      texto.includes('cierran')
  );
}

// === Función para iniciar una sesión por sucursal ===
async function iniciarSesion(sucursalId) {
  const authDir = path.join(__dirname, 'auth', sucursalId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
  });

  sesiones[sucursalId] = { sock, status: 'cargando...', qr: null };
  io.emit('estado', { sucursal: sucursalId, status: 'cargando...' });

  sock.ev.on('connection.update', (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
          sesiones[sucursalId].qr = qr;
          sesiones[sucursalId].status = 'escanea';
          io.emit('qr', { sucursal: sucursalId, qr });
      }

      if (connection === 'open') {
          sesiones[sucursalId].status = 'conectado';
          sesiones[sucursalId].qr = null;
          console.log(`✅ [${sucursalId}] Conectado correctamente`);
          io.emit('estado', { sucursal: sucursalId, status: 'conectado' });
      }

      if (connection === 'close') {
          const reason = Boom.boomify(lastDisconnect?.error)?.output?.statusCode;
          if (reason !== DisconnectReason.loggedOut) {
              console.log(`🔁 [${sucursalId}] Reconectando...`);
              sesiones[sucursalId].status = 'escanea';
              io.emit('estado', { sucursal: sucursalId, status: 'escanea' });
              sock.ev.removeAllListeners();
              iniciarSesion(sucursalId);
          } else {
              console.log(`🔌 [${sucursalId}] Sesión cerrada, eliminando credenciales y generando nuevo QR.`);
              sesiones[sucursalId].status = 'escanea';
              io.emit('estado', { sucursal: sucursalId, status: 'escanea' });
              fsExtra.remove(authDir, (err) => {
                  if (err) {
                      console.error(`❌ Error al eliminar la carpeta de autenticación para ${sucursalId}:`, err);
                  } else {
                      console.log(`✅ Carpeta de autenticación eliminada para ${sucursalId}.`);
                      iniciarSesion(sucursalId);
                  }
              });
          }
      }
  });

  sock.ev.on('creds.update', saveCreds);

  function obtenerTextoDelMensaje(msg) {
      const m = msg.message;
      if (!m) return '';
      if (m.conversation) return m.conversation;
      if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
      if (m.imageMessage?.caption) return m.imageMessage.caption;
      if (m.videoMessage?.caption) return m.videoMessage.caption;
      if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId;
      if (m.listResponseMessage?.title) return m.listResponseMessage.title;
      return '';
  }

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
        // ❗️IGNORAR MENSAJES ENVIADOS POR EL BOT
        if (msg.key.fromMe) return;

        const mensaje = obtenerTextoDelMensaje(msg);
        if (!mensaje) return;

        if (esMensajeDeDuda(mensaje)) {
            const sucursal = sucursales.find(s => s.id === sucursalId);
            const nombreSucursal = sucursal?.nombre || sucursalId;
        
            const mensajeRedireccion = `¡Hola! Estás escribiendo a *${nombreSucursal}*. Este número es solo para enviar archivos. Para cotizaciones y preguntas, por favor escríbenos a nuestro número de atención: *653-176-7005 (Marketing)*`;        
            try {
                await sock.sendMessage(msg.key.remoteJid, { text: mensajeRedireccion });
                console.log(`🤖 [${sucursalId}] Mensaje de redirección enviado.`);
            } catch (error) {
                console.error(`❌ [${sucursalId}] Error al enviar mensaje automático:`, error);
            }
        }
    }
  });
}


// Emitir el estado actual de las sesiones al cliente cuando se conecta
io.on('connection', (socket) => {
    console.log('🟢 Cliente conectado al servidor de sockets');

    // Enviar el estado actual de todas las sucursales al cliente
    for (const [sucursalId, sesion] of Object.entries(sesiones)) {
        socket.emit('estado', { sucursal: sucursalId, status: sesion.status });

        // Si hay un QR disponible, enviarlo al cliente
        if (sesion.qr) {
            socket.emit('qr', { sucursal: sucursalId, qr: sesion.qr });
        }
    }

    // Escuchar mensajes desde el cliente y reenviarlos a la consola
    socket.on('mensaje', ({ sucursal, mensaje }) => {
        console.log(`📩 [${sucursal}] Mensaje recibido: ${mensaje}`);
        io.emit('mensaje', { sucursal, mensaje }); // Emitir el mensaje a todos los clientes conectados
    });
});

// === Iniciar todas las sucursales ===
(async () => {
    for (const sucursal of sucursales) {
        await iniciarSesion(sucursal.id);
    }

    // Iniciar servidor web
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`🚀 Servidor web iniciado en http://localhost:${PORT}`);
    });
})();