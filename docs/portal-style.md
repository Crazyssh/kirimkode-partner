# Portal Style Guide — dark Modal.com theme, HeroSMS layout

Berlaku untuk semua halaman di `src/app/(portal)/` dan `/login`. Area admin
(`src/app/(admin)/`) tetap light dan TIDAK memakai panduan ini.

## Token (didefinisikan di `tailwind.config.ts`)

| Token | Nilai | Pakai untuk |
|---|---|---|
| `surface` | `#121412` | Latar halaman |
| `surface-raised` | `#191C18` | Panel/kartu |
| `surface-overlay` | `#20241F` | Hover row, elemen menonjol |
| `surface-inset` | `#0D0F0D` | Sidebar, input, track tab |
| `line` / `line-strong` | `#272B25` / `#343A31` | Border hairline / border input & hover |
| `ink` / `ink-muted` / `ink-faint` | `#EDF2EA` / `#9FAA9A` / `#6A7565` | Teks utama / sekunder / hint |
| `brand` / `brand-soft` / `brand-deep` | `#80EE64` / `#BFF9B4` / `#10A550` | CTA, nilai uang positif, status aktif |
| `accent-coral` / `accent-pink` / `accent-blue` | `#FF8E63` / `#FF7EB0` / `#4B73FF` | Aksen kategorikal hemat |

Font: `font-sans` (Inter) untuk teks, `font-mono` (JetBrains Mono) untuk angka,
ID, label uppercase kecil. Teks di atas `bg-brand` selalu `text-[#0C120A]`.

## Komponen bersama (`(portal)/_components/`)

- `PageHeader` — `title`, `subtitle?`, children = slot kanan (badge/chip/aksi).
- `Panel` / `PanelHeading` — kontainer kartu; `padded={false}` untuk tabel.
- `PillTabs` — tab pil ala HeroSMS; tabs `{label, href, active}`.
- `HeroBanner` — strip gradien hijau (dashboard, offers); `title`, `description?`, children = aksi kanan.
- `StatCard` — `label`, `value`, `hint?`, `accent?` (nilai hijau untuk uang).
- `StatusPill` — `label`, `tone: neutral|positive|warning|danger|info` (ada dot).
- `EmptyState`, `FeedbackBanner`, `SubmitButton` (primary = brand solid), `PartnerStatusBadge`.
- `icons.tsx` — ikon SVG inline (`IconGrid`, `IconCpu`, `IconSim`, `IconTag`,
  `IconCart`, `IconCoins`, `IconBank`, `IconUsers`, `IconKey`, `IconLogout`,
  `IconCalendar`, `IconSearch`, `IconChevronRight`, `IconArrowRight`, `IconX`, `IconInfo`).

## Resep kelas (copy-paste)

Tabel (dalam `<Panel padded={false}>`):

```
<table className="w-full text-sm">
  thead: <tr className="border-b border-line">
    th: "px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted"
  tbody tr: "border-b border-line/60 transition-colors last:border-0 hover:bg-white/[0.03]"
  td: "px-4 py-3 text-ink-muted"  (kolom utama: text-ink; angka/ID: font-mono tabular-nums)
</table>
```

Input/select/textarea:

```
"w-full rounded-lg border border-line-strong bg-surface-inset px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
```

Label form: `"mb-1 block text-xs font-medium text-ink-muted"`.

Baris filter (ala HeroSMS di atas tabel):

```
<div className="mb-4 flex flex-wrap items-center gap-2">
  {/* filter kiri, chip kanan: */}
  <span className="ml-auto flex items-center gap-2 rounded-full border border-line bg-surface-raised px-3 py-1.5 font-mono text-xs text-ink-muted">
    <IconCalendar className="h-3.5 w-3.5" /> {tanggal}
  </span>
</div>
```

Link aksi teks: `"font-medium text-brand hover:text-brand-soft"`.
Divider antar section: `"mt-8"` pada `<section>`; jangan pakai `<hr>`.

## Aturan

1. JANGAN mengubah logika: server action, query, props data, redirect, copy
   error — semua tetap. Ini reskin + tata letak saja.
2. Jangan pakai kelas `slate-*`, `bg-white`, `text-black`, `blue-600` di dalam
   portal — selalu token di atas.
3. Copy tetap bahasa Indonesia.
4. Jangan edit komponen bersama di `_components/` (kecuali komponen milik
   halamanmu sendiri, mis. `device-forms.tsx`).
5. Struktur halaman: `PageHeader` → banner (bila ada) → filter/tabs → konten
   (`Panel` berisi tabel ATAU `EmptyState`) → form dalam `Panel` + `PanelHeading`.
