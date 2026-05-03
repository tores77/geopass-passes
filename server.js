// ─────────────────────────────────────────────────────────
// GEOPASS™ — MICROSERVICIO RAILWAY
// Generación y firma de Apple Wallet Passes (PKPass)
// Node.js + Express + passkit-generator
// Umania Labs · Abril 2026
// ─────────────────────────────────────────────────────────

// INSTRUCCIONES DE DEPLOY EN RAILWAY:
// 1. Crear nuevo repo GitHub: tores77/geopass-passes
// 2. Subir estos archivos al repo
// 3. En Railway: New Service → GitHub Repo → seleccionar tores77/geopass-passes
// 4. Añadir las variables de entorno listadas al final
// 5. Railway despliega automáticamente

// ─────────────────────────────────────────────────────────
// ESTRUCTURA DE ARCHIVOS DEL PROYECTO:
//
// geopass-passes/
// ├── package.json
// ├── server.js          ← este archivo
// ├── .gitignore
// └── certs/             ← NO subir a GitHub (solo en Railway via env vars)
//     ├── pass.pem
//     ├── pass.key
//     └── wwdr.pem
// ─────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════
// ARCHIVO 1: package.json
// ════════════════════════════════════════════════════════
/*
{
  "name": "geopass-passes",
  "version": "1.0.0",
  "description": "GeoPass PKPass microservice",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "passkit-generator": "^3.4.0",
    "node-apn": "^5.0.0",
    "@supabase/supabase-js": "^2.39.0",
    "dotenv": "^16.3.1",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
*/

// ════════════════════════════════════════════════════════
// ARCHIVO 2: .gitignore
// ════════════════════════════════════════════════════════
/*
node_modules/
.env
certs/
*.p12
*.pem
*.key
*.cer
*/

// ════════════════════════════════════════════════════════
// ARCHIVO 3: server.js — CÓDIGO PRINCIPAL
// ════════════════════════════════════════════════════════

const express = require('express');
const { PKPass } = require('passkit-generator');
const apn = require('node-apn');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());

// ─── Supabase client ──────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Certificados desde variables de entorno ─────────────
// Los certificados se almacenan como variables de entorno en Railway
// en formato base64 para evitar problemas con caracteres especiales
function getCerts() {
  return {
    signerCert: Buffer.from(process.env.APPLE_CERT_BASE64, 'base64').toString('utf8'),
    signerKey: Buffer.from(process.env.APPLE_KEY_BASE64, 'base64').toString('utf8'),
    wwdr: Buffer.from(process.env.APPLE_WWDR_BASE64, 'base64').toString('utf8'),
    signerKeyPassphrase: process.env.APPLE_CERT_PASSWORD
  };
}

// ─── APN Provider (para push updates al wallet) ──────────
function getApnProvider() {
  return new apn.Provider({
    cert: Buffer.from(process.env.APPLE_CERT_BASE64, 'base64').toString('utf8'),
    key: Buffer.from(process.env.APPLE_KEY_BASE64, 'base64').toString('utf8'),
    passphrase: process.env.APPLE_CERT_PASSWORD,
    production: false // cambiar a true en producción
  });
}

// ════════════════════════════════════════════════════════
// ENDPOINT 1: Health check
// GET /health
// ════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'geopass-passes',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// ════════════════════════════════════════════════════════
// ENDPOINT 2: Crear un nuevo pass
// POST /passes/create
// ════════════════════════════════════════════════════════
app.post('/passes/create', async (req, res) => {
  try {
    const {
      tenant_id,
      socio_id,
      serial_number,
      nombre,
      puntos,
      nivel,
      color_primario,
      logo_url,
      nombre_marca,
      pass_type_id
    } = req.body;

    // Validación básica
    if (!tenant_id || !socio_id || !serial_number || !nombre) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const authentication_token = uuidv4().replace(/-/g, '');

    // Definir el nivel en texto legible
    const nivelTexto = {
      basico: 'Básico',
      bronce: 'Bronce 🥉',
      plata: 'Plata 🥈',
      oro: 'Oro 🥇',
      vip: 'VIP 💎'
    }[nivel] || 'Básico';

    // Color de fondo basado en nivel
    const colorFondo = {
      basico: 'rgb(30, 30, 50)',
      bronce: 'rgb(80, 50, 20)',
      plata: 'rgb(60, 60, 80)',
      oro: 'rgb(80, 60, 10)',
      vip: 'rgb(20, 50, 80)'
    }[nivel] || 'rgb(13, 13, 26)';

    // Crear el pass con passkit-generator
    const pass = await PKPass.from(
      {
        model: {
          // Definición inline del modelo del pass
          passTypeIdentifier: pass_type_id || process.env.APPLE_PASS_TYPE_ID,
          teamIdentifier: process.env.APPLE_TEAM_ID,
          organizationName: nombre_marca || 'GeoPass™',
          description: `Tarjeta de fidelización ${nombre_marca}`,
          serialNumber: serial_number,
          authenticationToken: authentication_token,
          webServiceURL: `${process.env.RAILWAY_PUBLIC_URL}/wallet`,
          backgroundColor: colorFondo,
          foregroundColor: 'rgb(240, 240, 240)',
          labelColor: 'rgb(0, 229, 160)',
          // Geopush: coordenadas del local (se actualizan después)
          // locations: [] — se añaden cuando el tenant configura su dirección
        },
        certificates: getCerts()
      },
      {
        // Campos visibles en la tarjeta
        storeCard: {
          headerFields: [
            {
              key: 'nivel',
              label: 'NIVEL',
              value: nivelTexto,
              textAlignment: 'PKTextAlignmentRight'
            }
          ],
          primaryFields: [
            {
              key: 'nombre_marca',
              label: nombre_marca || 'GeoPass™',
              value: nombre
            }
          ],
          secondaryFields: [
            {
              key: 'puntos',
              label: 'PUNTOS',
              value: puntos.toString(),
              changeMessage: '¡Tienes %@ puntos!'
            }
          ],
          auxiliaryFields: [
            {
              key: 'socio',
              label: 'SOCIO',
              value: `#${socio_id.substring(0, 8).toUpperCase()}`
            }
          ],
          backFields: [
            {
              key: 'info',
              label: 'Programa de fidelización',
              value: `Acumula puntos con cada visita y compra. Powered by GeoPass™`
            },
            {
              key: 'web',
              label: 'Más información',
              value: 'geopass.umanialabs.com'
            }
          ]
        }
      }
    );

    // Guardar authentication_token en Supabase para futuros updates
    await supabase
      .from('passes')
      .update({
        authentication_token,
        last_updated: new Date().toISOString()
      })
      .eq('serial_number', serial_number)
      .eq('tenant_id', tenant_id);

    // Devolver el .pkpass como archivo binario
    const buffer = await pass.getAsBuffer();

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': `attachment; filename="${serial_number}.pkpass"`,
      'Content-Length': buffer.length
    });

    res.send(buffer);

  } catch (error) {
    console.error('Error creando pass:', error);
    res.status(500).json({
      error: 'Error generando el pass',
      detail: error.message
    });
  }
});

// ════════════════════════════════════════════════════════
// ENDPOINT 3: Descargar pass existente
// GET /passes/:serial_number
// ════════════════════════════════════════════════════════
app.get('/passes/:serial_number', async (req, res) => {
  try {
    const { serial_number } = req.params;

    // Obtener datos del pass desde Supabase
    const { data: passData, error: passError } = await supabase
      .from('passes')
      .select('*, socios(*), tenants(*)')
      .eq('serial_number', serial_number)
      .single();

    if (passError || !passData) {
      return res.status(404).json({ error: 'Pass no encontrado' });
    }

    const socio = passData.socios;
    const tenant = passData.tenants;

    const nivelTexto = {
      basico: 'Básico',
      bronce: 'Bronce 🥉',
      plata: 'Plata 🥈',
      oro: 'Oro 🥇',
      vip: 'VIP 💎'
    }[socio.nivel] || 'Básico';

    const pass = await PKPass.from(
      {
        model: {
          passTypeIdentifier: passData.pass_type_id,
          teamIdentifier: process.env.APPLE_TEAM_ID,
          organizationName: tenant.nombre_marca,
          description: `Tarjeta ${tenant.nombre_marca}`,
          serialNumber: serial_number,
          authenticationToken: passData.authentication_token,
          webServiceURL: `${process.env.RAILWAY_PUBLIC_URL}/wallet`,
          backgroundColor: 'rgb(13, 13, 26)',
          foregroundColor: 'rgb(240, 240, 240)',
          labelColor: 'rgb(0, 229, 160)'
        },
        certificates: getCerts()
      },
      {
        storeCard: {
          headerFields: [
            { key: 'nivel', label: 'NIVEL', value: nivelTexto }
          ],
          primaryFields: [
            { key: 'nombre_marca', label: tenant.nombre_marca, value: socio.nombre }
          ],
          secondaryFields: [
            { key: 'puntos', label: 'PUNTOS', value: socio.puntos.toString() }
          ]
        }
      }
    );

    const buffer = await pass.getAsBuffer();

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': `attachment; filename="${serial_number}.pkpass"`,
      'Content-Length': buffer.length
    });

    res.send(buffer);

  } catch (error) {
    console.error('Error descargando pass:', error);
    res.status(500).json({ error: 'Error descargando el pass', detail: error.message });
  }
});

// ════════════════════════════════════════════════════════
// ENDPOINT 4: Actualizar puntos en pass existente (+ push notification)
// POST /passes/:serial_number/update
// ════════════════════════════════════════════════════════
app.post('/passes/:serial_number/update', async (req, res) => {
  try {
    const { serial_number } = req.params;
    const { puntos, nivel, mensaje } = req.body;

    // Obtener datos del pass
    const { data: passData, error } = await supabase
      .from('passes')
      .select('authentication_token, tenant_id, socio_id')
      .eq('serial_number', serial_number)
      .single();

    if (error || !passData) {
      return res.status(404).json({ error: 'Pass no encontrado' });
    }

    // Actualizar last_updated en Supabase
    // (Apple hará GET al webServiceURL para obtener el pass actualizado)
    await supabase
      .from('passes')
      .update({ last_updated: new Date().toISOString() })
      .eq('serial_number', serial_number);

    // Enviar push notification via APN para que Apple sepa que hay update
    if (passData.authentication_token) {
      const provider = getApnProvider();
      const notification = new apn.Notification();
      notification.topic = `${process.env.APPLE_PASS_TYPE_ID}.voip`;

      // El push al wallet no lleva payload — solo notifica que hay cambios
      // Apple descarga el pass actualizado automáticamente
      await provider.send(notification, passData.authentication_token);
      provider.shutdown();
    }

    res.json({
      success: true,
      serial_number,
      puntos,
      nivel,
      updated_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error actualizando pass:', error);
    res.status(500).json({ error: 'Error actualizando el pass', detail: error.message });
  }
});

// ════════════════════════════════════════════════════════
// ENDPOINTS APPLE WALLET WEB SERVICE
// Requeridos por Apple para push updates
// ════════════════════════════════════════════════════════

// Registro de dispositivo
app.post('/wallet/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber',
  async (req, res) => {
    const { deviceId, serialNumber } = req.params;
    const { pushToken } = req.body;

    // Guardar pushToken del dispositivo para futuros updates
    await supabase
      .from('passes')
      .update({ authentication_token: pushToken })
      .eq('serial_number', serialNumber);

    res.status(201).json({ status: 'registered' });
  }
);

// Lista de passes actualizados
app.get('/wallet/v1/devices/:deviceId/registrations/:passTypeId',
  async (req, res) => {
    const { serialNumber } = req.query;
    res.json({ serialNumbers: [serialNumber], lastUpdated: new Date().toISOString() });
  }
);

// Desregistro de dispositivo
app.delete('/wallet/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber',
  async (req, res) => {
    res.status(200).json({ status: 'unregistered' });
  }
);

// Log de errores de Apple
app.post('/wallet/v1/log', (req, res) => {
  console.log('Apple Wallet log:', req.body);
  res.status(200).json({ status: 'logged' });
});

// ─── Arrancar servidor ───────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ GeoPass passes service running on port ${PORT}`);
  console.log(`   Pass Type ID: ${process.env.APPLE_PASS_TYPE_ID}`);
  console.log(`   Team ID: ${process.env.APPLE_TEAM_ID}`);
});

// ════════════════════════════════════════════════════════
// VARIABLES DE ENTORNO PARA RAILWAY
// Configurar en Railway → Settings → Variables
// ════════════════════════════════════════════════════════
/*
PORT=3001
NODE_ENV=production

# Apple Wallet
APPLE_PASS_TYPE_ID=pass.com.umanialabs.geopass
APPLE_TEAM_ID=8JQ5CSFFX9
APPLE_CERT_PASSWORD=<contraseña del .p12>

# Certificados en base64 (ver instrucciones abajo)
APPLE_CERT_BASE64=<base64 del pass.pem>
APPLE_KEY_BASE64=<base64 del pass.key>
APPLE_WWDR_BASE64=<base64 del wwdr.pem>

# Supabase
SUPABASE_URL=https://gwygivhoczmvudfzdsht.supabase.co
SUPABASE_SERVICE_KEY=<service_role key>

# URL pública de Railway (se obtiene después del primer deploy)
RAILWAY_PUBLIC_URL=https://geopass-passes.up.railway.app
*/

// ════════════════════════════════════════════════════════
// INSTRUCCIONES PARA CONVERTIR CERTIFICADOS A BASE64
// Ejecutar estos comandos en Terminal antes de subir a Railway
// ════════════════════════════════════════════════════════
/*
# 1. Convertir el .p12 a .pem + .key
openssl pkcs12 -in geopass-pass-cert.p12 -clcerts -nokeys -out pass.pem -legacy
openssl pkcs12 -in geopass-pass-cert.p12 -nocerts -nodes -out pass.key -legacy

# 2. Descargar el certificado WWDR de Apple
# URL: https://www.apple.com/certificateauthority/
# Descargar: "Apple Worldwide Developer Relations Certification Authority (G4)"
# Guardar como: wwdr.pem

# 3. Convertir a base64 para Railway
base64 -i pass.pem | tr -d '\n' > pass_b64.txt
base64 -i pass.key | tr -d '\n' > key_b64.txt
base64 -i wwdr.pem | tr -d '\n' > wwdr_b64.txt

# 4. Copiar el contenido de cada .txt como variable de entorno en Railway
*/
