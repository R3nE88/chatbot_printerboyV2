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

    // Evento: nuevo QR
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

        // Reiniciar correctamente la sesión al cambiar a 'escanea'
        if (connection === 'close') {
            const reason = Boom.boomify(lastDisconnect?.error)?.output?.statusCode;

            if (reason !== DisconnectReason.loggedOut) {
                console.log(`🔁 [${sucursalId}] Reconectando...`);
                sesiones[sucursalId].status = 'escanea';
                io.emit('estado', { sucursal: sucursalId, status: 'escanea' });
                sock.ev.removeAllListeners(); // Eliminar listeners previos para evitar conflictos
                iniciarSesion(sucursalId); // Intentar reconectar y generar QR
            } else {
                console.log(`🔌 [${sucursalId}] Sesión cerrada, eliminando credenciales y generando nuevo QR.`);
                sesiones[sucursalId].status = 'escanea';
                io.emit('estado', { sucursal: sucursalId, status: 'escanea' });

                // Eliminar carpeta de autenticación
                const authDir = path.join(__dirname, 'auth', sucursalId);
                fsExtra.remove(authDir, (err) => {
                    if (err) {
                        console.error(`❌ Error al eliminar la carpeta de autenticación para ${sucursalId}:`, err);
                    } else {
                        console.log(`✅ Carpeta de autenticación eliminada para ${sucursalId}.`);
                        iniciarSesion(sucursalId); // Forzar generación de nuevo QR
                    }
                });
            }
        }
    });

    // Guardar credenciales cuando cambian
    sock.ev.on('creds.update', saveCreds);

    // Emitir mensajes recibidos desde las sucursales
    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
            const mensaje = msg.message?.conversation || 'Archivo Multimedia';
            const nombre = msg.pushName || 'Desconocido'; // Obtener el nombre del remitente
            const hora = new Date(msg.messageTimestamp * 1000).toLocaleTimeString(); // Convertir la marca de tiempo a hora legible

            console.log(`📩 [${sucursalId}] Mensaje recibido de ${nombre}: ${mensaje} a las ${hora}`);
            io.emit('mensaje', { sucursal: sucursalId, mensaje, nombre, hora });
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
