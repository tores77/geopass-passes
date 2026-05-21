const express = require('express');
const { PKPass } = require('passkit-generator');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MODEL_PATH = path.join(__dirname, 'model', 'MyPass.pass');
const PASS_JSON_PATH = path.join(MODEL_PATH, 'pass.json');

function getCerts() {
  return {
    signerCert: Buffer.from(process.env.APPLE_CERT_BASE64, 'base64'),
    signerKey: Buffer.from(process.env.APPLE_KEY_BASE64, 'base64'),
    wwdr: Buffer.from(process.env.APPLE_WWDR_BASE64, 'base64'),
    signerKeyPassphrase: process.env.APPLE_CERT_PASSWORD
  };
}

const BASE_PASS_JSON = {
  formatVersion: 1,
  passTypeIdentifier: 'pass.com.umanialabs.geopass',
  teamIdentifier: '8JQ5CSFFX9',
  organizationName: 'GeoPass',
  description: 'Tarjeta de fidelizacion',
  backgroundColor: 'rgb(13, 13, 26)',
  foregroundColor: 'rgb(240, 240, 240)',
  labelColor: 'rgb(0, 229, 160)',
  storeCard: {
    headerFields: [
      { key: 'nivel', label: 'NIVEL', value: 'Basico' }
    ],
    primaryFields: [
      { key: 'nombre', label: 'GeoPass', value: 'Socio' }
    ],
    secondaryFields: [
      { key: 'puntos', label: 'PUNTOS', value: '0' }
    ],
    backFields: [
      {
        key: 'ubicacion',
        label: 'ACTIVAR NOTIFICACIONES DE PROXIMIDAD',
        value: 'Ve a Ajustes > Cartera > Permitir acceso a ubicacion > Cuando se use la app. Activa tambien Ubicacion exacta. Cuando pases cerca del local recibiras una notificacion automatica en tu pantalla de bloqueo.'
      },
      {
        key: 'notificaciones',
        label: 'SI LAS NOTIFICACIONES NO DESAPARECEN',
        value: 'Ve a Ajustes > Notificaciones > Cartera > desactiva Notificaciones importantes. Esto hara que las alertas de proximidad se comporten de forma normal.'
      },
      {
        key: 'puntos_info',
        label: 'COMO GANAR PUNTOS',
        value: 'Acumulas puntos con cada visita al local. Consulta tu saldo y nivel en el anverso de esta tarjeta en cualquier momento.'
      },
      {
        key: 'web',
        label: 'MAS INFORMACION',
        value: 'geopass.umanialabs.com'
      }
    ]
  }
};

// Helper: genera el pass.json con la config del tenant
function buildPassJson(config) {
  const {
    nombre_marca = 'GeoPass',
    color_primario,
    mensaje_geopush,
    lat,
    lng,
    radio_geopush = 150
  } = config;

  const passJson = JSON.parse(JSON.stringify(BASE_PASS_JSON));
  passJson.organizationName = nombre_marca;
  passJson.description = 'Tarjeta de fidelizacion ' + nombre_marca;

  // Color de fondo personalizado
  if (color_primario) {
    const hex = color_primario.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    passJson.backgroundColor = 'rgb(' + r + ', ' + g + ', ' + b + ')';
  }

  // Instruccion geopush personalizada
  passJson.storeCard.backFields[0].value =
    'Ve a Ajustes > Cartera > Permitir acceso a ubicacion > Cuando se use la app. Activa tambien Ubicacion exacta. Cuando pases cerca de ' + nombre_marca + ' recibiras una notificacion automatica.';

  // Geopush locations
  if (lat && lng) {
    passJson.locations = [
      {
        latitude: parseFloat(lat),
        longitude: parseFloat(lng),
        relevantText: (mensaje_geopush || nombre_marca + ' te espera').substring(0, 60),
        maxDistance: parseInt(radio_geopush) || 150
      }
    ];
  }

  return passJson;
}

// Helper: genera un PKPass buffer con la config dada
async function generatePassBuffer(config, socioData) {
  const {
    serial_number,
    nombre = 'Socio',
    puntos = 0,
    nivel = 'basico',
    authentication_token,
    nombre_marca = 'GeoPass'
  } = { ...config, ...socioData };

  const nivelTexto = {
    basico: 'Basico',
    bronce: 'Bronce',
    plata: 'Plata',
    oro: 'Oro',
    vip: 'VIP'
  }[nivel] || 'Basico';

  const passJsonData = buildPassJson(config);

  // Escribir pass.json en disco
  fs.writeFileSync(PASS_JSON_PATH, JSON.stringify(passJsonData, null, 2));

  const pass = await PKPass.from(
    {
      model: MODEL_PATH,
      certificates: getCerts()
    },
    {
      serialNumber: serial_number,
      authenticationToken: authentication_token || uuidv4().replace(/-/g, ''),
      webServiceURL: process.env.RAILWAY_PUBLIC_URL + '/wallet/'
    }
  );

  pass.headerFields[0].value = nivelTexto;
  pass.primaryFields[0].label = nombre_marca;
  pass.primaryFields[0].value = nombre;
  pass.secondaryFields[0].value = puntos.toString();

  const buffer = await pass.getAsBuffer();

  // Restaurar pass.json original
  fs.writeFileSync(PASS_JSON_PATH, JSON.stringify(BASE_PASS_JSON, null, 2));

  return buffer;
}

// ════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'geopass-passes',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// ════════════════════════════════════════════════════
// CREAR PASS INDIVIDUAL
// POST /passes/create
// ════════════════════════════════════════════════════
app.post('/passes/create', async (req, res) => {
  try {
    const {
      tenant_id,
      socio_id,
      serial_number,
      nombre,
      puntos = 0,
      nivel = 'basico',
      nombre_marca = 'GeoPass',
      color_primario,
      lat,
      lng,
      radio_geopush = 150,
      mensaje_geopush
    } = req.body;

    if (!tenant_id || !socio_id || !serial_number || !nombre) {
      return res.status(400).json({ error: 'Faltan campos requeridos: tenant_id, socio_id, serial_number, nombre' });
    }

    const authentication_token = uuidv4().replace(/-/g, '');

    const buffer = await generatePassBuffer(
      { nombre_marca, color_primario, lat, lng, radio_geopush, mensaje_geopush },
      { serial_number, nombre, puntos, nivel, authentication_token }
    );

    // Actualizar en Supabase
    await supabase
      .from('passes')
      .update({
        authentication_token,
        last_updated: new Date().toISOString()
      })
      .eq('serial_number', serial_number)
      .eq('tenant_id', tenant_id);

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'attachment; filename="' + serial_number + '.pkpass"',
      'Content-Length': buffer.length
    });

    res.send(buffer);

  } catch (error) {
    console.error('Error creando pass:', error.message);
    try { fs.writeFileSync(PASS_JSON_PATH, JSON.stringify(BASE_PASS_JSON, null, 2)); } catch (e) {}
    res.status(500).json({ error: 'Error generando el pass', detail: error.message });
  }
});

// ════════════════════════════════════════════════════
// ACTUALIZAR TEMPLATE DE UN TENANT COMPLETO
// POST /passes/update-template
// Regenera todos los passes activos de un tenant cuando
// el negocio cambia su configuracion de tarjeta
// ════════════════════════════════════════════════════
app.post('/passes/update-template', async (req, res) => {
  try {
    const {
      tenant_id,
      nombre_marca,
      color_primario,
      color_secundario,
      lat,
      lng,
      radio_geopush = 150,
      mensaje_geopush
    } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id es requerido' });
    }

    console.log('update-template: tenant_id=' + tenant_id + ' nombre_marca=' + nombre_marca);

    // Obtener todos los passes activos del tenant
    const { data: passes, error: passesError } = await supabase
      .from('passes')
      .select('serial_number, authentication_token, socios(nombre, puntos, nivel)')
      .eq('tenant_id', tenant_id)
      .eq('activo', true);

    if (passesError) {
      console.error('Error obteniendo passes:', passesError.message);
      return res.status(500).json({ error: 'Error obteniendo passes', detail: passesError.message });
    }

    if (!passes || passes.length === 0) {
      return res.json({ success: true, updated: 0, message: 'No hay passes activos para este tenant' });
    }

    const config = { nombre_marca, color_primario, color_secundario, lat, lng, radio_geopush, mensaje_geopush };
    let updated = 0;
    let errors = 0;

    // Regenerar cada pass secuencialmente para no sobrecargar Railway
    for (const p of passes) {
      try {
        const socio = p.socios || {};
        await generatePassBuffer(config, {
          serial_number: p.serial_number,
          nombre: socio.nombre || 'Socio',
          puntos: socio.puntos || 0,
          nivel: socio.nivel || 'basico',
          authentication_token: p.authentication_token,
          nombre_marca
        });

        // Actualizar last_updated en Supabase
        await supabase
          .from('passes')
          .update({ last_updated: new Date().toISOString() })
          .eq('serial_number', p.serial_number);

        updated++;
        console.log('Pass regenerado: ' + p.serial_number);
      } catch (err) {
        console.error('Error regenerando pass ' + p.serial_number + ':', err.message);
        errors++;
      }
    }

    res.json({
      success: true,
      tenant_id,
      updated,
      errors,
      total: passes.length,
      message: 'Template actualizado. ' + updated + ' passes regenerados.'
    });

  } catch (error) {
    console.error('Error en update-template:', error.message);
    try { fs.writeFileSync(PASS_JSON_PATH, JSON.stringify(BASE_PASS_JSON, null, 2)); } catch (e) {}
    res.status(500).json({ error: 'Error actualizando template', detail: error.message });
  }
});

// ════════════════════════════════════════════════════
// ACTUALIZAR PASS INDIVIDUAL (puntos/nivel)
// POST /passes/:serial_number/update
// ════════════════════════════════════════════════════
app.post('/passes/:serial_number/update', async (req, res) => {
  try {
    const { serial_number } = req.params;
    const { puntos, nivel } = req.body;

    await supabase
      .from('passes')
      .update({ last_updated: new Date().toISOString() })
      .eq('serial_number', serial_number);

    res.json({
      success: true,
      serial_number,
      puntos,
      nivel,
      updated_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error actualizando pass:', error.message);
    res.status(500).json({ error: 'Error actualizando el pass', detail: error.message });
  }
});

// ════════════════════════════════════════════════════
// APPLE WALLET WEB SERVICE ENDPOINTS
// ════════════════════════════════════════════════════
app.post('/wallet/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
  res.status(201).json({ status: 'registered' });
});

app.get('/wallet/v1/devices/:deviceId/registrations/:passTypeId', async (req, res) => {
  res.json({ serialNumbers: [], lastUpdated: new Date().toISOString() });
});

app.delete('/wallet/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
  res.status(200).json({ status: 'unregistered' });
});

app.post('/wallet/v1/log', (req, res) => {
  console.log('Apple Wallet log:', JSON.stringify(req.body));
  res.status(200).json({ status: 'logged' });
});

// ════════════════════════════════════════════════════
// ARRANCAR SERVIDOR
// ════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('GeoPass passes service running on port ' + PORT);
  console.log('Pass Type ID: ' + (process.env.APPLE_PASS_TYPE_ID || 'pass.com.umanialabs.geopass'));
  console.log('Team ID: ' + (process.env.APPLE_TEAM_ID || '8JQ5CSFFX9'));
  console.log('Model path: ' + MODEL_PATH);
});
