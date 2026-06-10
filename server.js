const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
// Limit diperbesar agar kebal menerima file SHP raksasa
app.use(express.json({limit: '50mb'})); 
app.use(express.urlencoded({limit: '50mb', extended: true}));

// KONEKSI DATABASE
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'db_rangga3',
    password: '123', // Ganti jika password pgAdmin Anda berbeda
    port: 5432,
});

// 1. ENDPOINT SIMPAN FITUR MANUAL (DIGITASI)
app.post('/api/save-feature', async (req, res) => {
    const { tabel, geometry, attr } = req.body;
    try {
        let query, values;
        
        if (tabel === 'jalan') {
            query = `INSERT INTO jalan (id_jalan, nama_jalan, geom) VALUES ($1, $2, ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))) RETURNING id_jalan as id`;
            values = [attr.id, attr.nama_jalan, JSON.stringify(geometry)];
        } else if (tabel === 'landuse') {
            query = `INSERT INTO landuse (id_landuse, penggunaan, geom) VALUES ($1, $2, ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))) RETURNING id_landuse as id`;
            values = [attr.id, attr.penggunaan, JSON.stringify(geometry)];
        } else if (tabel === 'wilayah') {
            query = `INSERT INTO wilayah (id_wilayah, nama_kabupaten, nama_bupati, geom) VALUES ($1, $2, $3, ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))) RETURNING id_wilayah as id`;
            values = [attr.id, attr.nama_kabupaten, attr.nama_bupati, JSON.stringify(geometry)];
        } else if (tabel === 'tower') {
            query = `INSERT INTO tower (id_tower, id_provider, geom) VALUES ($1, $2, ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))) RETURNING id_tower as id`;
            values = [attr.id, attr.id_provider, JSON.stringify(geometry)];
        } else if (['shp_titik', 'shp_garis', 'shp_poligon'].includes(tabel)) {
            query = `INSERT INTO ${tabel} (nama_layer, pengupload, geom) VALUES ($1, 'Admin', ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))) RETURNING id`;
            values = [attr.nama_layer, JSON.stringify(geometry)];
        } else {
            return res.status(400).json({ error: "Tabel tidak didukung atau tidak ditemukan" });
        }

        const result = await pool.query(query, values);
        res.json({ status: 'Success', id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. ENDPOINT SIMPAN SHAPEFILE (PERBAIKAN MULTIPOLYGON)
app.post('/api/save-shp', async (req, res) => {
    const { nama_layer, pengupload, features, geom_type } = req.body;
    const client = await pool.connect(); 
    
    try {
        let successCount = 0;
        await client.query('BEGIN'); 

        for (let f of features) {
            if (!f.geometry) continue;
            
            let geomType = f.geometry.type || '';
            let targetTabel = '';

            if (geom_type && geom_type !== 'auto') {
                if (geom_type === 'Polygon' && (geomType.includes('Polygon') || geomType.includes('MultiPolygon'))) {
                    targetTabel = 'shp_poligon';
                } else if (geom_type === 'LineString' && (geomType.includes('LineString') || geomType.includes('MultiLineString'))) {
                    targetTabel = 'shp_garis';
                } else if (geom_type === 'Point' && (geomType.includes('Point') || geomType.includes('MultiPoint'))) {
                    targetTabel = 'shp_titik';
                }
            } else {
                if (geomType.includes('Polygon') || geomType.includes('MultiPolygon')) targetTabel = 'shp_poligon';
                else if (geomType.includes('LineString') || geomType.includes('MultiLineString')) targetTabel = 'shp_garis';
                else if (geomType.includes('Point') || geomType.includes('MultiPoint')) targetTabel = 'shp_titik';
            }

            if (targetTabel === '') continue;

            let query = `INSERT INTO ${targetTabel} (nama_layer, pengupload, properties, geom) 
                         VALUES ($1, $2, $3, ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)))`;

            await client.query(query, [nama_layer, pengupload, JSON.stringify(f.properties), JSON.stringify(f.geometry)]);
            successCount++;
        }
        
        if(successCount === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "File tidak mengandung data yang sesuai dengan tipe geometri yang dipilih." });
        }
        
        await client.query('COMMIT');
        res.json({ status: 'Success', message: `${successCount} fitur berhasil disimpan` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error Simpan SHP:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 3. ENDPOINT QUERY CONSOLE
app.post('/api/run-query', async (req, res) => {
    try {
        const queryText = req.body.query;
        const upperQuery = queryText.toUpperCase();
        if (upperQuery.includes('DROP') || upperQuery.includes('TRUNCATE') || upperQuery.includes('ALTER')) {
            return res.status(403).json({ error: 'Aksi terlarang! Query tidak diizinkan demi keamanan.' });
        }

        const result = await pool.query(queryText);
        res.json({ status: 'Success', data: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. ENDPOINT HAPUS DATA FITUR
app.post('/api/delete-feature', async (req, res) => {
    const { tabel, id } = req.body;
    const tabelValid = ['jalan', 'landuse', 'tower', 'wilayah', 'shp_titik', 'shp_garis', 'shp_poligon'];
    if (!tabelValid.includes(tabel)) return res.status(400).json({ error: 'Tabel tidak valid' });

    try {
        const pkKolom = tabel.startsWith('shp_') ? 'id' : 'id_' + tabel;
        await pool.query(`DELETE FROM ${tabel} WHERE ${pkKolom} = $1`, [id]);
        res.json({ status: 'Success', message: `Data dihapus` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. ENDPOINT EXPORT GEOJSON
app.get('/api/export-geojson/:tabel', async (req, res) => {
    const { tabel } = req.params;
    const tabelValid = ['jalan', 'landuse', 'tower', 'wilayah', 'shp_titik', 'shp_garis', 'shp_poligon'];
    if (!tabelValid.includes(tabel)) return res.status(400).send('Tabel tidak valid');

    try {
        const query = `
            SELECT jsonb_build_object(
                'type',     'FeatureCollection',
                'features', COALESCE(jsonb_agg(features.feature), '[]'::jsonb)
            ) as geojson
            FROM (
                SELECT jsonb_build_object(
                    'type',       'Feature',
                    'geometry',   ST_AsGeoJSON(geom)::jsonb,
                    'properties', to_jsonb(inputs) - 'geom'
                ) as feature
                FROM ${tabel} inputs
            ) features;
        `;

        const result = await pool.query(query);
        const geojsonData = result.rows[0].geojson;

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=${tabel}_export.geojson`);
        res.send(geojsonData);
    } catch (err) {
        console.error("Export Error:", err);
        res.status(500).send("Gagal mengekspor data: " + err.message);
    }
});

// 6. ENDPOINT EXPORT KML (ArcGIS/Google Earth Compatible)
app.get('/api/export-kml/:tabel', async (req, res) => {
    const { tabel } = req.params;
    const tabelValid = ['jalan', 'landuse', 'tower', 'wilayah', 'shp_titik', 'shp_garis', 'shp_poligon'];
    if (!tabelValid.includes(tabel)) return res.status(400).send('Tabel tidak valid');

    try {
        // Query untuk menghasilkan KML dari PostGIS
        const query = `
            SELECT
                '<?xml version="1.0" encoding="UTF-8"?>
                <kml xmlns="http://www.opengis.net/kml/2.2">
                <Document><name>' || '${tabel}' || '</name>' ||
                COALESCE(string_agg(
                    '<Placemark>' ||
                    '<name>Feature ' || ROW_NUMBER() OVER() || '</name>' ||
                    '<description><![CDATA[' || 
                        (SELECT string_agg(key || ': ' || value, '<br/>') 
                         FROM jsonb_each_text(to_jsonb(inputs) - 'geom')) || 
                    ']]></description>' ||
                    ST_AsKML(geom) ||
                    '</Placemark>', ''
                ), '') ||
                '</Document></kml>' AS kml_data
            FROM ${tabel} inputs;
        `;

        const result = await pool.query(query);
        const kmlData = result.rows[0].kml_data;

        res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
        res.setHeader('Content-Disposition', `attachment; filename=${tabel}_export.kml`);
        res.send(kmlData);

    } catch (err) {
        console.error("Export KML Error:", err);
        res.status(500).send("Gagal mengekspor data ke KML: " + err.message);
    }
});

app.listen(3000, () => console.log('Server WebGIS berjalan di http://localhost:3000'));