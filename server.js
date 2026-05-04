const express = require('express');
const { PKPass } = require('passkit-generator');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Ruta al modelo del pass
const MODEL_PATH = path.join(__dirname, 'model', 'MyPass.pass');

// Certificados desde variables de entorno en base64
function getCerts() {
  return {
    signerCert: Buffer.from(process.env.APPLE_CERT_BASE64, 'base64'),
    signerKey: Buffer.from(process.env.APPLE_KEY_BASE64, 'base64'),
    wwdr: Buffer.from(process.env.APPLE_WWDR_BASE64, 'base64'),
    signerKeyPassphrase: process.env.APPLE_CERT_PASSWORD
  };
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'geopass-passes',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Crear un nuevo pass
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
      lng,
      radio_metros = 150
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

    // Crear pass desde el modelo en disco
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

    // Añadir geopush si hay coordenadas
    if (lat && lng) {
      pass.props.locations = [
        {
          latitude: parseFloat(lat),
          longitude: parseFloat(lng),
          relevantText: nombre_marca + ' te espera'
        }
      ];
    }

    // Actualizar campos dinamicos
    pass.headerFields[0].value = nivelTexto;
    pass.primaryFields[0].label = nombre_marca;
    pass.primaryFields[0].value = nombre;
    pass.secondaryFields[0].value = puntos.toString();

    // Actualizar authentication_token en Supabase
    await supabase
      .from('passes')
      .update({
        authentication_token,
        last_updated: new Date().toISOString()
      })
      .eq('serial_number', serial_number)
      .eq('tenant_id', tenant_id);

    // Generar y devolver el .pkpass
    const buffer = await pass.getAsBuffer();

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'attachment; filename="' + serial_number + '.pkpass"',
      'Content-Length': buffer.length
    });

    res.send(buffer);

  } catch (error) {
    console.error('Error creando pass:', error.message);
    res.status(500).json({
      error: 'Error generando el pass',
      detail: error.message
    });
  }
});

// Actualizar pass existente
app.post('/passes/:serial_number/update', async (req, res) => {
  try {
    const { serial_number } = req.params;
    const { puntos, nivel, mensaje } = req.body;

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

// Apple Wallet Web Service endpoints
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

// Arrancar servidor
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('GeoPass passes service running on port ' + PORT);
  console.log('Pass Type ID: ' + process.env.APPLE_PASS_TYPE_ID);
  console.log('Team ID: ' + process.env.APPLE_TEAM_ID);
  console.log('Model path: ' + MODEL_PATH);
});
