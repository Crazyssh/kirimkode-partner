# Test support

Toolchain Partner Platform memakai suite Vitest non-watch yang terpisah:

- `npm run test:unit` untuk example/unit tests (`*.unit.test.ts`).
- `npm run test:property` untuk fast-check (`*.property.test.ts`).
- `npm run test:integration` untuk PostgreSQL/API (`*.integration.test.ts`).
- `npm test` untuk menjalankan ketiganya secara berurutan.

`fake-clock.ts` mengontrol `Date` dan timer Vitest secara deterministik. `generators.ts` menyediakan arbitrary domain bersama; property test harus menetapkan sekurangnya 100 run dan mencetak seed saat gagal.

## Disposable PostgreSQL

Set `PARTNER_TEST_DATABASE_ADMIN_URL` ke database admin PostgreSQL khusus test. Harness membuat database unik dengan namespace `kirimkode_partner_test_*`, menghentikan koneksinya, lalu menghapusnya di `finally`. Integration smoke dilewati bila variabel ini tidak tersedia; CI integration harus menyediakannya. Jangan arahkan variabel tersebut ke kredensial atau server produksi.
