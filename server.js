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
        value: 'Ve a Ajustes > Cartera > Permitir acceso a ubicacion > Cuando se use la app. Activa tambien Ubicacion exacta. Al acercarte al local recibiras una notificacion automatica en tu pantalla de bloqueo.'
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

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'geopass-passes',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

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
      lat,
      lng
    } = req.body;

    if (!tenant_id || !socio_id || !serial_number || !nombre) {
      return res.status(400).json({ error: 'Faltan campos requeridos: tenant_id, socio_id, serial_number, nombre' });
    }

    const authentication_token = uuidv4().replace(/-/g, '');

    const nivelTexto = {
      basico: 'Basico',
      bronce: 'Bronce',
      plata: 'Plata',
      oro: 'Oro',
      vip: 'VIP'
    }[nivel] || 'Basico';

    // Construir pass.json dinamico
    const passJsonData = JSON.parse(JSON.stringify(BASE_PASS_JSON));
    passJsonData.organizationName = nombre_marca;
    passJsonData.description = 'Tarjeta de fidelizacion ' + nombre_marca;

    // Actualizar backFields con nombre de marca
    passJsonData.storeCard.backFields[0].value =
      'Ve a Ajustes > Cartera > Permitir acceso a ubicacion > Cuando se use la app. Activa tambien Ubicacion exacta. Al acercarte a ' + nombre_marca + ' recibiras una notificacion automatica.';

    // Añadir geopush si hay coordenadas
    if (lat && lng) {
      passJsonData.locations = [
        {
          latitude: parseFloat(lat),
          longitude: parseFloat(lng),
          relevantText: nombre_marca + ' te espera'
        }
      ];
      console.log('Geopush location added: lat=' + lat + ' lng=' + lng);
    }

    // Escribir pass.json en disco
    fs.writeFileSync(PASS_JSON_PATH, JSON.stringify(passJsonData, null, 2));

    const pass = await PKPass.from(
      {
        model: MODEL_PATH,
        certificates: getCerts()
      },
      {
        serialNumber: serial_number,
        authenticationToken: authentication_token,
        webServiceURL: process.env.RAILWAY_PUBLIC_URL + '/wallet/'
      }
    );

    // Actualizar campos dinamicos
    pass.headerFields[0].value = nivelTexto;
    pass.primaryFields[0].label = nombre_marca;
    pass.primaryFields[0].value = nombre;
    pass.secondaryFields[0].value = puntos.toString();

    const buffer = await pass.getAsBuffer();

    // Restaurar pass.json original
    fs.writeFileSync(PASS_JSON_PATH, JSON.stringify(BASE_PASS_JSON, null, 2));

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
    try {
      fs.writeFileSync(PASS_JSON_PATH, JSON.stringify(BASE_PASS_JSON, null, 2));
    } catch (e) {}
    res.status(500).json({
      error: 'Error generando el pass',
      detail: error.message
    });
  }
});

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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('GeoPass passes service running on port ' + PORT);
  console.log('Pass Type ID: ' + (process.env.APPLE_PASS_TYPE_ID || 'pass.com.umanialabs.geopass'));
  console.log('Team ID: ' + (process.env.APPLE_TEAM_ID || '8JQ5CSFFX9'));
  console.log('Model path: ' + MODEL_PATH);
});
