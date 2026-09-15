const express = require('express');
const session = require('express-session');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const app = express();
const db = require('./config/db');
require('dotenv').config();

// Penanganan Folder Upload Temporary
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
const upload = multer({ dest: 'uploads/' });

// Konfigurasi EJS & Public Folder
app.set('view engine', 'ejs');
app.use(express.static('public'));

// Middleware parsing body data
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Konfigurasi Session User
app.use(session({
    secret: 'perpus_smkn2_secret_key',
    resave: false,
    saveUninitialized: true
}));

// Middleware Proteksi Halaman
const checkAuth = (req, res, next) => {
    if (req.session.user) next();
    else res.redirect('/');
};

// 1. Halaman Login
app.get('/', (req, res) => res.render('login'));

// 2. Proses Login User / Admin
app.post('/login', (req, res) => {
    const { nis_nip, password } = req.body;
    db.query('SELECT * FROM users WHERE nis_nip = ? AND password = ?', [nis_nip, password], (err, results) => {
        if (err || results.length === 0) return res.send('<h3>NIS/NIP atau Password Salah! <a href="/">Coba lagi</a></h3>');
        req.session.user = results[0];
        res.redirect('/katalog');
    });
});

// 3. Proses Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// 4. Halaman Dashboard & Katalog Buku
app.get('/katalog', checkAuth, (req, res) => {
    const user = req.session.user;

    db.query('SELECT * FROM books', (err, books) => {
        if (err) return res.send('Gagal mengambil data buku.');

        const queryRiwayat = `
            SELECT p.id as pinjam_id, u.nama, u.kelas, b.judul, p.tanggal_pinjam, p.status 
            FROM peminjaman p 
            JOIN users u ON p.user_id = u.id 
            JOIN books b ON p.book_id = b.id
            ${user.role !== 'admin' ? 'WHERE p.user_id = ' + user.id : ''}
            ORDER BY p.id DESC
        `;

        db.query(queryRiwayat, (err, history) => {
            res.render('katalog', { books: books, user: user, history: history || [] });
        });
    });
});

// 5. SISWA/GURU: Ajukan Pinjam Online
app.post('/pinjam/:id', checkAuth, (req, res) => {
    const bookId = req.params.id;
    const userId = req.session.user.id;

    db.query('SELECT stok FROM books WHERE id = ?', [bookId], (err, results) => {
        if (err || results.length === 0 || results[0].stok <= 0) {
            return res.send('Stok buku tidak tersedia.');
        }

        db.query(
            'INSERT INTO peminjaman (user_id, book_id, status) VALUES (?, ?, "menunggu_persetujuan")', 
            [userId, bookId], 
            (err) => {
                if (err) return res.send('Gagal mengajukan peminjaman.');
                res.redirect('/katalog');
            }
        );
    });
});

// 6. SISWA/GURU: Ajukan Pengembalian Buku Online
app.post('/ajukan-kembali/:id', checkAuth, (req, res) => {
    const pinjamId = req.params.id;
    db.query('UPDATE peminjaman SET status = "proses_pengembalian" WHERE id = ?', [pinjamId], () => {
        res.redirect('/katalog');
    });
});

// 7. ADMIN: Setujui Peminjaman & Kurangi Stok
app.post('/admin/setujui-pinjam/:id', checkAuth, (req, res) => {
    if (req.session.user.role !== 'admin') return res.send('Akses ditolak!');
    const pinjamId = req.params.id;

    db.query('SELECT book_id FROM peminjaman WHERE id = ?', [pinjamId], (err, results) => {
        if (err || results.length === 0) return res.send('Data peminjaman tidak ditemukan.');
        const bookId = results[0].book_id;

        db.query('UPDATE peminjaman SET status = "dipinjam" WHERE id = ?', [pinjamId], () => {
            db.query('UPDATE books SET stok = stok - 1 WHERE id = ?', [bookId], () => {
                res.redirect('/katalog');
            });
        });
    });
});

// 8. ADMIN: Konfirmasi Pengembalian Buku & Tambah Stok
app.post('/admin/konfirmasi-kembali/:id', checkAuth, (req, res) => {
    if (req.session.user.role !== 'admin') return res.send('Akses ditolak!');
    const pinjamId = req.params.id;

    db.query('SELECT book_id FROM peminjaman WHERE id = ?', [pinjamId], (err, results) => {
        if (err || results.length === 0) return res.send('Data peminjaman tidak ditemukan.');
        const bookId = results[0].book_id;

        db.query('UPDATE peminjaman SET status = "dikembalikan" WHERE id = ?', [pinjamId], () => {
            db.query('UPDATE books SET stok = stok + 1 WHERE id = ?', [bookId], () => {
                res.redirect('/katalog');
            });
        });
    });
});

// 9. ADMIN: Tambah Koleksi Buku
app.post('/admin/tambah-buku', checkAuth, (req, res) => {
    if (req.session.user.role !== 'admin') return res.send('Akses ditolak!');
    const { judul, pengarang, stok } = req.body;
    db.query('INSERT INTO books (judul, pengarang, stok) VALUES (?, ?, ?)', [judul, pengarang, stok], () => {
        res.redirect('/katalog');
    });
});

// 10. ADMIN: Import Massal Data Guru & Siswa via Excel
app.post('/admin/import-users', checkAuth, upload.single('file_excel'), (req, res) => {
    if (req.session.user.role !== 'admin') return res.send('Akses ditolak!');
    if (!req.file) return res.send('Silakan pilih file Excel terlebih dahulu!');

    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        if (rows.length === 0) {
            fs.unlinkSync(req.file.path);
            return res.send('File Excel kosong!');
        }

        const values = rows.map(row => {
            const nisNipVal = row.nis_nip || row['nis,nip'] || '';

            return [
                String(nisNipVal).trim(),
                String(row.nama || '').trim(),
                String(row.password || '12345').trim(),
                String(row.role || 'siswa').toLowerCase().trim(),
                String(row.kelas || '-').trim()
            ];
        });

        const query = `
            INSERT INTO users (nis_nip, nama, password, role, kelas) 
            VALUES ? 
            ON DUPLICATE KEY UPDATE 
            nama=VALUES(nama), password=VALUES(password), role=VALUES(role), kelas=VALUES(kelas)
        `;

        db.query(query, [values], (err) => {
            fs.unlinkSync(req.file.path);
            if (err) {
                console.error(err);
                return res.send('Gagal mengimpor Excel. Pastikan data di dalam Excel sudah benar.');
            }
            res.redirect('/katalog');
        });
    } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.send('Terjadi kesalahan saat memproses file Excel.');
    }
});

// 11. ADMIN: Halaman Laporan Cetak
app.get('/admin/laporan', checkAuth, (req, res) => {
    if (req.session.user.role !== 'admin') return res.send('Akses ditolak!');

    const queryStatistik = `
        SELECT 
            (SELECT COUNT(*) FROM books) AS total_buku,
            (SELECT IFNULL(SUM(stok),0) FROM books) AS total_stok,
            (SELECT COUNT(*) FROM peminjaman) AS total_transaksi,
            (SELECT COUNT(*) FROM peminjaman WHERE status = 'dipinjam') AS dipinjam,
            (SELECT COUNT(*) FROM peminjaman WHERE status = 'dikembalikan') AS dikembalikan
    `;

    const queryDetail = `
        SELECT p.id, u.nama, u.kelas, b.judul, p.tanggal_pinjam, p.status 
        FROM peminjaman p 
        JOIN users u ON p.user_id = u.id 
        JOIN books b ON p.book_id = b.id
        ORDER BY p.id DESC
    `;

    db.query(queryStatistik, (err, stats) => {
        if (err) return res.send('Gagal mengambil statistik.');
        db.query(queryDetail, (err, history) => {
            if (err) return res.send('Gagal mengambil riwayat.');
            res.render('laporan', { 
                stats: stats[0], 
                history: history,
                user: req.session.user 
            });
        });
    });
});

// 12. SISWA / ADMIN: Batal / Hapus Peminjaman
app.post('/pinjam/delete/:id', checkAuth, (req, res) => {
    const pinjamId = req.params.id;
    const user = req.session.user;

    if (user.role === 'admin') {
        db.query('DELETE FROM peminjaman WHERE id = ?', [pinjamId], () => res.redirect('/katalog'));
    } else {
        db.query('DELETE FROM peminjaman WHERE id = ? AND user_id = ? AND status = "menunggu_persetujuan"', 
        [pinjamId, user.id], () => res.redirect('/katalog'));
    }
});

// 13. ADMIN: Edit Status Peminjaman Manual
app.post('/admin/edit-status/:id', checkAuth, (req, res) => {
    if (req.session.user.role !== 'admin') return res.send('Akses ditolak!');
    const pinjamId = req.params.id;
    const { status_baru } = req.body;

    db.query('UPDATE peminjaman SET status = ? WHERE id = ?', [status_baru, pinjamId], () => {
        res.redirect('/katalog');
    });
});

// 14. USER / ADMIN: Tampilan Cetak Kartu Anggota Perpustakaan
app.get('/kartu-anggota', checkAuth, (req, res) => {
    res.render('kartu', { user: req.session.user });
});

// Jalankan Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server aktif di http://localhost:${PORT}`));