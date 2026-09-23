// Synthetic local DOM only. The row/fiber shape mirrors the reviewed
// nicolib/pc-watch selectors and resource props; this is not a real-site page.
export const liveHtml = String.raw`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>Niconico live sidebar fixture</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 20px; font: 14px/1.45 Arial, sans-serif; }
    #fixture-root { display: flex; gap: 20px; align-items: flex-start; }
    .fixture-panel { display: grid; gap: 6px; }
    .fixture-panel > h2 { margin: 0; font-size: 13px; font-weight: 700; }
    .niconico-sidebar {
      width: 320px; height: 270px; overflow: auto; padding: 10px;
      border: 1px solid currentColor; border-radius: 8px;
    }
    .niconico-sidebar[data-theme="light"] { color: #17212b; background: #f7f9fb; }
    .niconico-sidebar[data-theme="dark"] { color: #eef4ff; background: #17202c; }
    [data-comment-type="normal"] {
      display: grid; grid-template-columns: 30px minmax(0, 1fr) 28px;
      gap: 6px; align-items: start; padding: 7px 0;
      border-bottom: 1px solid color-mix(in srgb, currentColor 22%, transparent);
    }
    .comment-number { text-align: right; opacity: .64; }
    .user-summary-area { min-width: 0; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .content-area { min-width: 0; grid-column: 2; }
    .comment-text { overflow-wrap: anywhere; }
    .menu-button-wrapper { grid-column: 3; grid-row: 1 / span 2; }
    .menu-button-wrapper button { width: 26px; height: 24px; padding: 0; cursor: pointer; }
    .fixture-note { margin-top: 12px; opacity: .72; font-size: 12px; }
  </style>
</head>
<body>
  <main id="fixture-root" aria-label="Synthetic Niconico sidebar fixture">
    <section class="fixture-panel" data-panel="light">
      <h2>Light sidebar</h2>
      <div class="niconico-sidebar" data-sidebar="light" data-theme="light"></div>
    </section>
    <section class="fixture-panel" data-panel="dark">
      <h2>Dark sidebar</h2>
      <div class="niconico-sidebar" data-sidebar="dark" data-theme="dark"></div>
    </section>
  </main>
  <p class="fixture-note">Synthetic fixture: no network content or provider request.</p>
</body>
</html>`;

export const liveUrl = 'http://127.0.0.1:54321/niconico-live-sidebar.html';
