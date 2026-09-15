const mysql = require('mysql2');

const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'perpus_smkn2'
});

db.connect((err) => {
    if (err) {
        console.error('Koneksi Database Gagal: ', err.message);
    } else {
        console.log('Terhubung ke Database MySQL XAMPP!');
    }
});

module.exports = db;