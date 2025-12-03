// SERVER.js - VERSIÓN COMPLETA Y CORREGIDA
const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const FLIGHT = {
  numero: 'QTR-0810',
  tipo: 'Sencillo',
  origen: 'Ciudad de México (MEX)',
  destino: 'Doha (DOH), Qatar',
  fecha: '08/10/25',
  hora: '20:00',
  lugarSalida: 'Terminal 2, Puerta 2'
};

// ---------- helpers ----------
function signToken(user) { 
  return jwt.sign({
    id: user.id, 
    username: user.username, 
    role: user.role || 'user'
  }, JWT_SECRET, { expiresIn: '12h' }); 
}

function verifyToken(token) { 
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch(e) {
    return null;
  }
}

function publicState(cb) {
  db.query(`
    SELECT id, clase, estado 
    FROM seats 
    ORDER BY 
      clase DESC,
      CAST(SUBSTRING(id, 2) AS UNSIGNED)
  `, (err, rows) => {
    if(err) return cb(err);
    cb(null, { flight: FLIGHT, seats: rows });
  });
}

// ---------- routes ----------
app.post('/register', async (req, res) => {
  const { username, email, password } = req.body || {};
  if(!username || !email || !password) {
    return res.status(400).json({ ok: false, error: 'Faltan datos' });
  }
  if(!email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'Correo inválido' });
  }
  
  try {
    const hashed = await bcrypt.hash(password, 10);
    db.query(
      'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)', 
      [username, email, hashed, 'user'], 
      (err) => {
        if(err) {
          console.error('Error en registro:', err);
          return res.status(500).json({ ok: false, error: err.code || err.message });
        }
        return res.json({ ok: true });
      }
    );
  } catch(e) {
    console.error('Error en bcrypt:', e);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if(!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }

  db.query(
    'SELECT id, username, email, password, role FROM users WHERE username = ?', 
    [username], 
    async (err, results) => {
      if(err) {
        console.error('Error en login DB:', err);
        return res.status(500).json({ error: 'Error de base de datos' });
      }
      
      if(!results || !results.length) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }
      
      const user = results[0];
      const match = await bcrypt.compare(password, user.password);
      if(!match) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }
      
      const token = signToken(user);
      res.json({ 
        token, 
        user: { 
          id: user.id, 
          username: user.username, 
          email: user.email, 
          role: user.role 
        } 
      });
    }
  );
});

app.get('/me', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/, '');
  
  if(!token) {
    return res.json({ user: null });
  }
  
  const payload = verifyToken(token);
  if(!payload) {
    return res.status(401).json({ user: null });
  }
  
  res.json({ 
    user: { 
      id: payload.id, 
      username: payload.username, 
      role: payload.role 
    } 
  });
});

app.get('/state', (req, res) => {
  publicState((err, state) => {
    if(err) {
      console.error('Error en /state:', err);
      return res.status(500).json({ error: 'Error de base de datos' });
    }
    res.json(state);
  });
});

// ---------- sockets ----------
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if(!token) { 
    socket.user = null; 
    return next(); 
  }
  
  const payload = verifyToken(token);
  if(!payload) { 
    socket.user = null; 
    return next(); 
  }
  
  socket.user = { 
    id: payload.id, 
    username: payload.username, 
    role: payload.role 
  };
  next();
});

io.on('connection', (socket) => {
  console.log('[IO] Conectado:', socket.id, 'Usuario:', socket.user ? socket.user.username : 'Anónimo');
  
  publicState((err, state) => { 
    if(!err) {
      socket.emit('state', state);
    }
  });

  socket.on('hold-seat', ({ seatId }) => {
    if(!seatId) {
      return socket.emit('action-error', {
        type: 'hold-seat', 
        reason: 'ID de asiento inválido'
      });
    }
    
    db.query('SELECT estado FROM seats WHERE id = ?', [seatId], (err, rows) => {
      if(err || !rows.length) {
        return socket.emit('action-error', {
          type: 'hold-seat', 
          reason: 'Error de base de datos'
        });
      }
      
      if(rows[0].estado !== 'libre') {
        return socket.emit('action-error', {
          type: 'hold-seat', 
          reason: 'Asiento no disponible'
        });
      }
      
      db.query('UPDATE seats SET estado = "retenido" WHERE id = ?', [seatId], (err2) => {
        if(err2) {
          return socket.emit('action-error', {
            type: 'hold-seat', 
            reason: 'Error al actualizar'
          });
        }
        
        publicState((e, s) => { 
          if(!e) io.emit('state', s); 
        });
      });
    });
  });

  socket.on('release-seat', ({ seatId }) => {
    if(!seatId) return;
    
    db.query('UPDATE seats SET estado = "libre" WHERE id = ?', [seatId], (err) => {
      publicState((e, s) => { 
        if(!e) io.emit('state', s); 
      });
    });
  });

  socket.on('confirm', ({ seats: selSeats, metodoPago, comprador }) => {
    if(!socket.user) {
      return socket.emit('action-error', {
        type: 'confirm', 
        reason: 'Debe iniciar sesión'
      });
    }
    
    if(!Array.isArray(selSeats) || selSeats.length === 0) {
      return socket.emit('action-error', {
        type: 'confirm', 
        reason: 'No hay asientos seleccionados'
      });
    }
    
    const ids = selSeats.map(s => s.seatId);
    const placeholders = ids.map(() => '?').join(',');
    
    db.getConnection((connErr, connection) => {
      if(connErr) {
        return socket.emit('action-error', {
          type: 'confirm', 
          reason: 'Error de conexión a BD'
        });
      }
      
      connection.beginTransaction((txErr) => {
        if(txErr) { 
          connection.release(); 
          return socket.emit('action-error', {
            type: 'confirm', 
            reason: 'Error en transacción'
          }); 
        }
        
        const selectSql = `SELECT id, clase, estado FROM seats WHERE id IN (${placeholders}) FOR UPDATE`;
        connection.query(selectSql, ids, (selErr, rows) => {
          if(selErr) {
            return connection.rollback(() => { 
              connection.release(); 
              socket.emit('action-error', {
                type: 'confirm', 
                reason: 'Error al seleccionar asientos'
              }); 
            });
          }
          
          if(rows.length !== ids.length) {
            return connection.rollback(() => { 
              connection.release(); 
              socket.emit('action-error', {
                type: 'confirm', 
                reason: 'Asiento inválido'
              }); 
            });
          }
          
          const invalid = rows.find(r => r.estado !== 'retenido');
          if(invalid) {
            return connection.rollback(() => { 
              connection.release(); 
              socket.emit('action-error', {
                type: 'confirm', 
                reason: `Asiento ${invalid.id} no disponible`
              }); 
            });
          }
          
          let total = 0;
          const detalle = [];
          rows.forEach((row, i) => {
            const categoria = selSeats[i].categoria || 'Adulto';
            const precio = row.clase === 'primera' ? 120000 : 65950;
            total += precio;
            detalle.push({ 
              seatId: row.id, 
              clase: row.clase, 
              categoria, 
              precio 
            });
          });
          
          const updateSql = `UPDATE seats SET estado = 'vendido' WHERE id IN (${placeholders})`;
          connection.query(updateSql, ids, (updErr) => {
            if(updErr) {
              return connection.rollback(() => { 
                connection.release(); 
                socket.emit('action-error', {
                  type: 'confirm', 
                  reason: 'Error al actualizar asientos'
                }); 
              });
            }
            
            connection.commit((cmErr) => {
              if(cmErr) {
                return connection.rollback(() => { 
                  connection.release(); 
                  socket.emit('action-error', {
                    type: 'confirm', 
                    reason: 'Error al confirmar transacción'
                  }); 
                });
              }
              
              connection.release();
              publicState((er, sst) => { 
                if(!er) io.emit('state', sst); 
              });
              
              socket.emit('receipt', { 
                numeroVuelo: FLIGHT.numero, 
                origen: FLIGHT.origen, 
                destino: FLIGHT.destino, 
                fecha: FLIGHT.fecha, 
                hora: FLIGHT.hora, 
                lugarSalida: FLIGHT.lugarSalida, 
                metodoPago, 
                comprador: comprador?.nombre || socket.user.username, 
                cantidadAsientos: selSeats.length, 
                detalle, 
                total 
              });
            });
          });
        });
      });
    });
  });

  socket.on('reset-seats', () => {
    if(!socket.user || socket.user.role !== 'admin') {
      return socket.emit('action-error', {
        type: 'reset', 
        reason: 'No autorizado'
      });
    }
    
    db.query('UPDATE seats SET estado = "libre"', (err) => {
      if(err) {
        console.error('Error al resetear asientos:', err);
      }
      publicState((e, s) => { 
        if(!e) io.emit('state', s); 
      });
    });
  });

  socket.on('disconnect', () => { 
    console.log('[IO] Desconectado:', socket.id); 
  });
});

// ---------- health check ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ---------- 404 handler ----------
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ---------- error handler ----------
app.use((err, req, res, next) => {
  console.error('Error del servidor:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ---------- start server ----------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor en http://localhost:${PORT}`);
  console.log(`Endpoints disponibles:`);
  console.log(`   GET  /health  - Estado del servidor`);
  console.log(`   GET  /state   - Estado del vuelo y asientos`);
  console.log(`   POST /login   - Iniciar sesión`);
  console.log(`   POST /register - Registrarse`);
  console.log(`   GET  /me      - Información del usuario`);
});